import {expect} from "chai";
import {HanaDatabaseClient, isMultiStatement, statementKind} from "../tools/hana-client.mjs";

// The read-only guard of the existing-schema mode (docs/db-backends.md,
// "Existing schema, read-only").
//
// HANA_EXISTING_SCHEMA=1 runs over a schema an SAP system already holds. A
// write this runtime did not make is a corruption of somebody's system, so
// unless OSD_HANA_WRITE=1 every statement that is not a SELECT is refused
// before it reaches the driver: one chokepoint every DatabaseClient method
// passes through. The fake driver below records what reaches it -- the point
// of the test is that a refused statement reaches nothing at all, and that
// the refusal names the statement's kind, never its text: the text may carry
// data.
describe("the HANA read-only guard", () => {
  // what the client would reach on a real HANA. No prepare: query() then
  // takes the plain exec path, exactly like the older test doubles in
  // test/hana-dialect.mjs.
  const fakeDriver = () => {
    const seen = [];
    const client = {
      exec: (sql, cb) => { seen.push(sql); cb(undefined, [{A: 1}]); },
      commit: (cb) => { seen.push("<COMMIT>"); cb(undefined); },
      rollback: (cb) => { seen.push("<ROLLBACK>"); cb(undefined); },
    };
    return {seen, client};
  };

  it("refuses a write before it reaches the driver, kind in the message, never the text", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakeDriver();
    db.client = fake.client;
    let error;
    try {
      await db.execute(`INSERT INTO "ZOSD_H1_T" ("A") VALUES ('SECRETVALUE')`);
    } catch (e) { error = e; }
    expect(error?.code, "the refusal carries the HANA_READONLY code").to.equal("HANA_READONLY");
    expect(error.message, "the kind is named").to.include("INSERT");
    expect(error.message, "the statement text stays out").to.not.include("SECRETVALUE");
    expect(error.message, "and the table name with it").to.not.include("ZOSD_H1_T");
    expect(fake.seen, "nothing reached the driver").to.deep.equal([]);
  });

  it("refuses every non-SELECT kind, each named", async () => {
    for (const [sql, kind] of [
      [`UPDATE "T" SET "A" = 1`, "UPDATE"],
      [`DELETE FROM "T" WHERE "A" = 1`, "DELETE"],
      [`MERGE INTO "T" USING ...`, "MERGE"],
      [`UPSERT "T" VALUES (...)`, "UPSERT"],
      [`CREATE TABLE "T" ("A" INT)`, "CREATE"],
      [`DROP TABLE "T"`, "DROP"],
      [`ALTER TABLE "T" ADD ("B" INT)`, "ALTER"],
      [`TRUNCATE TABLE "T"`, "TRUNCATE"],
      [`CALL "ZOSD_H1_PROC"()`, "CALL"],
      // not on the task's list, refused by the default rule: everything that
      // is not an allowed kind is refused, by name
      [`GRANT SELECT ON "T" TO PUBLIC`, "GRANT"],
      [`WITH x AS (SELECT 1 FROM DUMMY) SELECT * FROM x`, "WITH"],
    ]) {
      const db = new HanaDatabaseClient({existingSchema: true});
      const fake = fakeDriver();
      db.client = fake.client;
      let error;
      try { await db.execute(sql); } catch (e) { error = e; }
      expect(error?.code, sql).to.equal("HANA_READONLY");
      expect(error.message, sql).to.include(kind);
      expect(fake.seen, sql).to.deep.equal([]);
    }
  });

  it("lets a SELECT through", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakeDriver();
    db.client = fake.client;
    const rows = await db.query(`SELECT "A" FROM "ZOSD_H1_T"`);
    expect(fake.seen.length).to.equal(1);
    expect(rows).to.deep.equal([{a: 1}]);
  });

  it("lets SET SCHEMA and the COMMIT/ROLLBACK bracket through", async () => {
    // SET SCHEMA is what connect() sends, and it is session control, not
    // data access. COMMIT and ROLLBACK are the LUW bracket the runtime
    // always calls (disconnect() commits): allowed, and a no-op while
    // nothing is open -- which is always, because the guard fires before a
    // refused statement could open one. Decided in the task's open question,
    // documented in docs/db-backends.md.
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakeDriver();
    db.client = fake.client;
    await db.execute(`SET SCHEMA "ZOSD_H1_S"`);
    await db.commit();
    await db.rollback();
    // commit() closed the bracket, so the rollback that follows finds
    // nothing open and is the no-op its early return already is
    expect(fake.seen).to.deep.equal([`SET SCHEMA "ZOSD_H1_S"`, "<COMMIT>"]);
  });

  it("does not let insert/update/delete swallow the refusal into subrc 4", async () => {
    // subrc 4 means "the row was not there" to an ABAP caller. A refusal is
    // not that, and hiding it would make a read-only run look like a run
    // whose rows simply never matched.
    for (const call of [
      (db) => db.insert({table: "ZOSD_H1_T", columns: ["A"], values: ["'x'"]}),
      (db) => db.update({table: "ZOSD_H1_T", set: [`"A" = 1`], where: `"A" = 2`}),
      (db) => db.delete({table: "ZOSD_H1_T", where: `"A" = 1`}),
    ]) {
      const db = new HanaDatabaseClient({existingSchema: true});
      const fake = fakeDriver();
      db.client = fake.client;
      let error;
      try { await call(db); } catch (e) { error = e; }
      expect(error?.code, "the refusal propagates").to.equal("HANA_READONLY");
      expect(fake.seen, "and nothing reaches the driver").to.deep.equal([]);
    }
  });

  it("leaves no transaction open behind a refusal", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakeDriver();
    db.client = fake.client;
    try { await db.execute(`INSERT INTO "T" ("A") VALUES (1)`); } catch { /* refused */ }
    await db.commit();
    expect(fake.seen, "commit() found nothing open and sent nothing").to.deep.equal([]);
  });

  it("the native channel is guarded too: a lowered write is refused", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakeDriver();
    db.client = fake.client;
    let error;
    try { await db.native({sql: `INSERT INTO "T" VALUES (1)`, expect: "none"}); } catch (e) { error = e; }
    expect(error?.code).to.equal("HANA_READONLY");
    expect(fake.seen).to.deep.equal([]);
  });

  // a driver with the prepared-statement path a real hdb client answers on,
  // for the tests that must prove the guard fires before prepare(). The
  // older fake above has no prepare, so query() takes the plain exec path
  // there -- both channels of this client need their own proof.
  const fakePrepDriver = () => {
    const seen = [];
    // the statement carries the result metadata a real prepare answers with:
    // defineRelation()'s materialised branch types its CREATE COLUMN TABLE
    // from it, so the with-params arm below reaches the guard that must
    // refuse it
    const stmt = {
      exec: (params, cb) => cb(undefined, []),
      drop: (cb) => cb(undefined),
      resultSetMetadata: [{columnName: "A", dataType: 3, length: 10, fraction: 0}],
    };
    const client = {
      exec: (sql, cb) => { seen.push(sql); cb(undefined, [{A: 1}]); },
      prepare: (sql, cb) => { seen.push(`prepare: ${sql}`); cb(undefined, stmt); },
      commit: (cb) => { seen.push("<COMMIT>"); cb(undefined); },
      rollback: (cb) => { seen.push("<ROLLBACK>"); cb(undefined); },
    };
    return {seen, client};
  };

  it("refuses a smuggled second statement: a top-level ; is kind multi", async () => {
    // the guard reads kinds, and a kind is the first word of the FIRST
    // statement -- `SELECT 1; DROP TABLE "T"` walked past it as a SELECT and
    // reached the driver (the critic round's smuggle probe measured it over
    // exec and prepare; HANA answers a multi-statement string with a syntax
    // error, but the promise is to refuse before the driver sees anything
    // at all). One statement per text on this channel: a text carrying a
    // top-level ; is refused whole, before its first word is even read.
    for (const [say, call, driver] of [
      ["exec", (db) => db.execute(`SELECT 1; DROP TABLE "ZOSD_H1_T"`), fakeDriver],
      ["exec, query()", (db) => db.query(`SELECT 1; DROP TABLE "ZOSD_H1_T"`), fakeDriver],
      ["prepare, query()", (db) => db.query(`SELECT 1; DROP TABLE "ZOSD_H1_T"`), fakePrepDriver],
      ["prepare, native()", (db) => db.native({sql: `SELECT 1; DROP TABLE "ZOSD_H1_T"`, expect: "none"}), fakePrepDriver],
    ]) {
      const db = new HanaDatabaseClient({existingSchema: true});
      const fake = driver();
      db.client = fake.client;
      let error;
      try { await call(db); } catch (e) { error = e; }
      expect(error?.code, say).to.equal("HANA_READONLY");
      expect(error.message, say).to.include("multi");
      expect(fake.seen, `${say}: nothing reached the driver`).to.deep.equal([]);
    }
  });

  it("a ; inside a literal, an identifier or a comment is not a second statement", () => {
    expect(isMultiStatement(`SELECT 'a;b' FROM "ZOSD_H1_T"`)).to.equal(false);
    expect(isMultiStatement(`SELECT "A;B" FROM "ZOSD_H1_T"`)).to.equal(false);
    expect(isMultiStatement(`SELECT 1 FROM "ZOSD_H1_T" -- a note; with a semicolon\n`)).to.equal(false);
    expect(isMultiStatement(`SELECT 1 FROM "ZOSD_H1_T" /* a note; with one */`)).to.equal(false);
    expect(isMultiStatement(`SELECT 1; DROP TABLE "T"`)).to.equal(true);
    expect(isMultiStatement(`SELECT 1 FROM "ZOSD_H1_T";`)).to.equal(true);
  });

  // One refusal test per method the first round left mutation-invisible
  // (the critic's table: removing #guard from any of these four left the
  // suite green). Each is verified below, under the exact mutation, to go
  // RED when its method's #guard call is removed.
  it("query() refuses a non-SELECT before it folds or prepares", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakePrepDriver();
    db.client = fake.client;
    let error;
    try { await db.query(`DELETE FROM "ZOSD_H1_T"`); } catch (e) { error = e; }
    expect(error?.code).to.equal("HANA_READONLY");
    expect(error.message).to.include("DELETE");
    expect(fake.seen, "nothing was folded through to the driver").to.deep.equal([]);
  });

  it("checkSelect() refuses a non-SELECT before it prepares", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakePrepDriver();
    db.client = fake.client;
    let error;
    try { await db.checkSelect(`INSERT INTO "ZOSD_H1_T" ("A") VALUES (1)`); } catch (e) { error = e; }
    expect(error?.code).to.equal("HANA_READONLY");
    expect(error.message).to.include("INSERT");
    expect(fake.seen).to.deep.equal([]);
  });

  it("defineRelation() refuses the CREATE VIEW of a plain relation", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakeDriver();
    db.client = fake.client;
    let error;
    try { await db.defineRelation({name: "zosd_h1_rel", sql: `SELECT "A" FROM "ZOSD_H1_T"`}); } catch (e) { error = e; }
    expect(error?.code).to.equal("HANA_READONLY");
    expect(error.message).to.include("CREATE");
    expect(fake.seen, "the CREATE VIEW never reached the driver").to.deep.equal([]);
  });

  it("defineRelation() refuses the CREATE COLUMN TABLE of a materialised relation", async () => {
    // both materialised branches build their statement as a CREATE COLUMN
    // TABLE -- straight from the body when it carries no values, typed from
    // the prepare's own metadata when it does -- each with its own #guard
    // call. Both stayed mutation-invisible until fix round 3 (the critic's
    // M3b: removing both left the suite green); the mutation harness
    // (../red-fix3-mutations.log) proves this test bites each guard alone
    // and both together. The body's own prepare may reach the driver in the
    // with-params arm -- that read is how HANA works the types out, and a
    // prepare writes nothing; the CREATE COLUMN TABLE must not.
    for (const [say, call, reached] of [
      ["no params", (db) => db.defineRelation({name: "zosd_h1_mat", sql: `SELECT "A" FROM "ZOSD_H1_T"`, materialise: "the divergence instrument"}), []],
      ["with params", (db) => db.defineRelation({name: "zosd_h1_mat", sql: `SELECT "A" FROM "ZOSD_H1_T" WHERE "B" = ?`, params: [{isNull: false, value: 1}], materialise: "the divergence instrument"}),
        [`prepare: SELECT "A" FROM "ZOSD_H1_T" WHERE "B" = ?`]],
    ]) {
      const db = new HanaDatabaseClient({existingSchema: true});
      const fake = fakePrepDriver();
      db.client = fake.client;
      let error;
      try { await call(db); } catch (e) { error = e; }
      expect(error?.code, say).to.equal("HANA_READONLY");
      expect(error.message, say).to.include("CREATE");
      expect(fake.seen, `${say}: only the body's prepare may reach the driver`).to.deep.equal(reached);
    }
  });

  it("dropRelation() refuses its DROP", async () => {
    const db = new HanaDatabaseClient({existingSchema: true});
    const fake = fakeDriver();
    db.client = fake.client;
    let error;
    try { await db.dropRelation({kind: "definition", ref: `"ZOSD_H1_S"."ZOSD_H1_REL"`}); } catch (e) { error = e; }
    expect(error?.code).to.equal("HANA_READONLY");
    expect(error.message).to.include("DROP");
    expect(fake.seen, "the DROP never reached the driver").to.deep.equal([]);
  });

  it("OSD_HANA_WRITE=1 lifts the guard", async () => {
    process.env.OSD_HANA_WRITE = "1";
    try {
      const db = new HanaDatabaseClient({existingSchema: true});
      const fake = fakeDriver();
      db.client = fake.client;
      await db.insert({table: "ZOSD_H1_T", columns: ["A"], values: ["'x'"]});
      expect(fake.seen[0]).to.include("INSERT INTO");
    } finally {
      delete process.env.OSD_HANA_WRITE;
    }
  });

  it("without the mode the guard is off: the ordinary client still builds its schema", async () => {
    // STG_DB=hana's own path issues CREATE TABLE and seeds; nothing of this
    // slice may change it.
    const db = new HanaDatabaseClient({});
    const fake = fakeDriver();
    db.client = fake.client;
    await db.execute(`CREATE TABLE "ZOSD_H1_T" ("A" INT)`);
    expect(fake.seen.length).to.equal(1);
  });

  it("statementKind reads the first word outside the literals", () => {
    expect(statementKind(`  select * from t`)).to.equal("SELECT");
    expect(statementKind(`SELECT * FROM "T" WHERE "A" = 'INSERT INTO'`)).to.equal("SELECT");
    expect(statementKind(`insert into t values ('x')`)).to.equal("INSERT");
    // a statement that begins inside a literal is not a statement of any
    // kind, and it is refused by that name rather than guessed at
    expect(statementKind(`'INSERT INTO "T" VALUES (1)'`)).to.equal("");
  });
});
