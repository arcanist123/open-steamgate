import {expect} from "chai";
import {createRequire} from "node:module";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HanaDatabaseClient} from "../tools/hana-client.mjs";
import {ddicTables, synonymSql, tableFrom259, viewSql} from "../tools/hana-shadow-schema.mjs";

// The shadow schema (tools/hana-shadow-schema.mjs, H3 B+C): the client lives
// in a schema of our own, over the tenant's tables, with SESSION_CONTEXT
// doing per-connection what the transpiler has no implicit MANDT for
// (ANOMALY-2026-09-11-no-implicit-mandt, docs/db-backends.md, "Shadow schema:
// the client lives in HANA"). Everything here runs against a fake hdb driver
// recording what reaches it; the schemas are ZOSD_H3_OWN (ours) and
// ZOSD_H3_TENANT (somebody else's), both invented for this fixture.
describe("the HANA shadow schema", () => {
  // DD02L says which of the generation's tables exist in the tenant and
  // which of them are client-dependent; the SYS catalog answers what our own
  // schema already holds. The shapes are the contract of the module.
  const DD02L_ROWS = [
    {TABNAME: "ZOSD_H3_CLI", CLIDEP: "X"},
    {TABNAME: "ZOSD_H3_FREE", CLIDEP: ""},
    {TABNAME: "ZOSD_H3_LAZY", CLIDEP: "X"},
    {TABNAME: "/ZOSD/H3_NS", CLIDEP: "X"},
    // SCARR stands in for the bed-measured view of fix round 3: HANA stored
    // the flight table's view with * expanded into the column list.
    {TABNAME: "SCARR", CLIDEP: "X"},
    // H5d: a DDIC view takes a synonym whatever its client dependence says
    {TABNAME: "ZOSD_H3_VIEWC", CLIDEP: "X", TABCLASS: "VIEW"},
    {TABNAME: "ZOSD_H3_VIEWF", CLIDEP: "", TABCLASS: "VIEW"},
    // the client column is the table's own (DD03L): a family on the bed
    // names it CLIENT, and some tables flagged client-dependent carry no
    // CLNT key field at all
    {TABNAME: "ZOSD_H3_CLIENT", CLIDEP: "X"},
    {TABNAME: "ZOSD_H3_NOCLNT", CLIDEP: "X"},
  ];
  // DD03L: the key fields of the client-dependent tables. MANDT for the
  // classic shape, CLIENT for the family the bed measured, and a table
  // whose first key field is not a client field and no key field is CLNT.
  // ZOSD_H3_CLIENT also carries an include marker before its client field
  // and a second CLNT key field after it, so neither "the first row" nor
  // "any CLNT" is what is read.
  const mandtKey = (TABNAME) => ({TABNAME, POSITION: "0001", FIELDNAME: "MANDT", KEYFLAG: "X", DATATYPE: "CLNT"});
  const DD03L_ROWS = [
    mandtKey("ZOSD_H3_CLI"), mandtKey("ZOSD_H3_LAZY"), mandtKey("/ZOSD/H3_NS"), mandtKey("SCARR"), mandtKey("ZOSD_H3_VIEWC"),
    {TABNAME: "ZOSD_H3_CLIENT", POSITION: "0003", FIELDNAME: "RCLNT", KEYFLAG: "X", DATATYPE: "CLNT"},
    {TABNAME: "ZOSD_H3_CLIENT", POSITION: "0002", FIELDNAME: "CLIENT", KEYFLAG: "X", DATATYPE: "CLNT"},
    {TABNAME: "ZOSD_H3_CLIENT", POSITION: "0001", FIELDNAME: ".INCLUDE", KEYFLAG: "X", DATATYPE: "CLNT"},
    {TABNAME: "ZOSD_H3_NOCLNT", POSITION: "0001", FIELDNAME: "ZOSD_H3_ID", KEYFLAG: "X", DATATYPE: "CHAR"},
  ];
  // the fake stands in through the CJS cache a real require uses; the
  // suites runner runs a shard's files in ONE process, so the stand-in is
  // given back after every test -- the next hdb consumer in the shard
  // otherwise gets a driver without prepare (FIX-4, the sqlscript suites).
  // the give-back is a DELETE, not a restore: at the first fakeHdb call the
  // real driver has never been required (hana-client loads hdb inside
  // connect()), so a saved original would be undefined and every restore
  // would return early -- the stand-in then survived the suite (the second
  // hold's GREEN 3: sqlscript-eager connected through it, prepare missing).
  // The next require after the delete loads the real driver fresh.
  afterEach(() => {
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve("hdb")];
  });

  const fakeHdb = ({views = [], synonyms = [], failName, failTimes = 0, failDd02lTimes = 0, notInCatalog = []} = {}) => {
    const sent = [];
    const options = [];
    let failed = 0;
    let failedDd02l = 0;
    const require = createRequire(import.meta.url);
    const path = require.resolve("hdb");
    require.cache[path] = {
      id: path, filename: path, loaded: true,
      exports: {createClient: (opts) => {
        options.push(opts);
        return {
          connect: (cb) => cb(undefined),
          setAutoCommit: () => undefined,
          exec: (sql, cb) => {
            sent.push(sql);
            if (/^\s*SELECT/i.test(sql) === false) return cb(undefined, 1); // SET SCHEMA and DDL
            if (failName !== undefined && failed < failTimes &&
                new RegExp(`FROM\\s+"?${failName}"?`, "i").test(sql) && !/DD02L/i.test(sql)) {
              failed += 1;
              // the 259 text the bed measured (fix round 1); the fakes sent
              // the plain `invalid table name: <name>` before it
              const error = new Error(`invalid table name:  Could not find table/view ${failName} in schema ZOSD_H3_TENANT: line 1 col 15 (at pos 14)`);
              error.code = 259;
              return cb(error);
            }
            if (failedDd02l < failDd02lTimes && /DD02L/i.test(sql)) {
              failedDd02l += 1;
              const error = new Error("invalid table name:  Could not find table/view DD02L in schema ZOSD_H3_TENANT: line 1 col 15 (at pos 14)");
              error.code = 259;
              return cb(error);
            }
            // the tenant's database catalog: every DD02L name has its object
            // unless the test says it is dictionary-only
            if (/FROM\s+SYS\.(TABLES|VIEWS)\b.*SCHEMA_NAME = 'ZOSD_H3_TENANT'/i.test(sql)) {
              const listed = [...(/_NAME IN \(([^)]*)\)/.exec(sql)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
              const isView = /SYS\.VIEWS/i.test(sql);
              return cb(undefined, DD02L_ROWS
                .filter((row) => listed.includes(row.TABNAME) && notInCatalog.includes(row.TABNAME) === false)
                .filter((row) => (row.TABCLASS === "VIEW") === isView)
                .map((row) => (isView ? {VIEW_NAME: row.TABNAME} : {TABLE_NAME: row.TABNAME})));
            }
            if (/FROM\s+SYS\.VIEWS/i.test(sql)) return cb(undefined, views);
            if (/FROM\s+SYS\.SYNONYMS/i.test(sql)) return cb(undefined, synonyms);
            if (/"DD03L"/i.test(sql)) {
              // the read is pinned to key fields: the fake answers only those
              expect(sql, "the DD03L read is the active version's key fields")
                .to.match(/AS4LOCAL = 'A' AND AS4VERS = '0000' AND KEYFLAG = 'X'/);
              const listed = [...(/TABNAME IN \(([^)]*)\)/.exec(sql)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
              return cb(undefined, DD03L_ROWS.filter((row) => listed.includes(row.TABNAME)));
            }
            if (/DD02L/i.test(sql)) {
              const pinned = /TABNAME\s*=\s*'([A-Z0-9_]+)'/.exec(sql)?.[1];
              return cb(undefined, DD02L_ROWS.filter((row) => pinned === undefined || row.TABNAME === pinned));
            }
            return cb(undefined, []);
          },
          commit: (cb) => cb(undefined),
          rollback: (cb) => cb(undefined),
          end: () => undefined,
        };
      }},
    };
    return {sent, options};
  };

  const connect = async (input = {}, fake = {}) => {
    const hdb = fakeHdb(fake);
    const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_H3_TENANT",
      ownSchema: "ZOSD_H3_OWN", client: "001", ...input});
    await db.connect();
    return {db, ...hdb};
  };

  it("a name the tenant's dictionary knows but its catalog does not gets no shadow (H5x-4 B4)", async () => {
    // the bed's first boot: DD02L knew a name our tree has as a table, the
    // database had no object for it, and CREATE SYNONYM was refused
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI", "ZOSD_H3_FREE"]}, {notInCatalog: ["ZOSD_H3_FREE"]});
    try {
      expect(sent.some((q) => /CREATE SYNONYM .*ZOSD_H3_FREE/.test(q)), "no synonym to nothing").to.equal(false);
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await db.disconnect();
    }
  });

  it("a view with the CLIENT predicate for a client-dependent table, a synonym otherwise", async () => {
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI", "ZOSD_H3_FREE"]});
    try {
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
      expect(sent).to.include(
        `CREATE SYNONYM "ZOSD_H3_OWN"."ZOSD_H3_FREE" FOR "ZOSD_H3_TENANT"."ZOSD_H3_FREE"`);
    } finally {
      await db.disconnect();
    }
  });

  it("a DDIC view is shadowed as a synonym, client-dependent or not (H5d)", async () => {
    // the tenant's view is itself a read-only database view: the shadow
    // names it, it does not wrap it -- no MANDT view over a view, no
    // definition of our own to police for drift.
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_VIEWC", "ZOSD_H3_VIEWF", "ZOSD_H3_CLI"]});
    try {
      expect(sent).to.include(`CREATE SYNONYM "ZOSD_H3_OWN"."ZOSD_H3_VIEWC" FOR "ZOSD_H3_TENANT"."ZOSD_H3_VIEWC"`);
      expect(sent).to.include(`CREATE SYNONYM "ZOSD_H3_OWN"."ZOSD_H3_VIEWF" FOR "ZOSD_H3_TENANT"."ZOSD_H3_VIEWF"`);
      // a client-dependent TABLE beside them still gets the MANDT view
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await db.disconnect();
    }
  });

  it("the lazy fallback shadows a view as a synonym and retries (H5d)", async () => {
    const {db, sent} = await connect({shadowTables: []}, {failName: "ZOSD_H3_VIEWC", failTimes: 1});
    try {
      const rows = await db.query(`SELECT * FROM zosd_h3_viewc`);
      expect(rows).to.deep.equal([]);
      expect(sent).to.include(`CREATE SYNONYM "ZOSD_H3_OWN"."ZOSD_H3_VIEWC" FOR "ZOSD_H3_TENANT"."ZOSD_H3_VIEWC"`);
      const attempts = sent.filter((s) => /FROM\s+zosd_h3_viewc/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "the failed statement and exactly one retry").to.equal(2);
    } finally {
      await db.disconnect();
    }
  });

  it("connect() points the session at our own schema, after the shadow DDL", async () => {
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI"]});
    try {
      expect(sent[sent.length - 1], "SET SCHEMA own is the last statement").to.equal(`SET SCHEMA "ZOSD_H3_OWN"`);
      expect(sent.indexOf(`SET SCHEMA "ZOSD_H3_OWN"`))
        .to.be.greaterThan(sent.indexOf(`CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI"`));
    } finally {
      await db.disconnect();
    }
  });

  it("existing objects are left alone: a second connect sends no DDL at all", async () => {
    // SYS.VIEWS.DEFINITION holds the view's query string -- the text after
    // AS (HANA's own documentation; the bed run confirms the column). The
    // fixture pins the documented shape: the view is current, the synonym
    // exists, and connect() sends nothing at all.
    const there = {
      views: [{VIEW_NAME: "ZOSD_H3_CLI",
        DEFINITION: `SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE MANDT = SESSION_CONTEXT('CLIENT')`}],
      synonyms: [{SYNONYM_NAME: "ZOSD_H3_FREE"}],
    };
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI", "ZOSD_H3_FREE"]}, there);
    try {
      expect(sent.filter((s) => /^\s*CREATE/i.test(s)), "nothing created twice").to.deep.equal([]);
    } finally {
      await db.disconnect();
    }
  });

  it("a full CREATE text in DEFINITION is current too: both shapes accepted", async () => {
    // the fakes before the bed pinned the full CREATE text; the comparison
    // takes that spelling as well, so whatever the column really holds, a
    // current view is never recreated -- and two hosts connecting at once
    // never race on CREATE OR REPLACE.
    const there = {
      views: [{VIEW_NAME: "ZOSD_H3_CLI", DEFINITION: viewSql("ZOSD_H3_CLI", "ZOSD_H3_OWN", "ZOSD_H3_TENANT", "MANDT")}],
      synonyms: [{SYNONYM_NAME: "ZOSD_H3_FREE"}],
    };
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI", "ZOSD_H3_FREE"]}, there);
    try {
      expect(sent.filter((s) => /^\s*CREATE/i.test(s)), "the full text is current too").to.deep.equal([]);
    } finally {
      await db.disconnect();
    }
  });

  it("the DEFINITION measured on the bed (columns expanded from *) is current", async () => {
    // FIX-3, bed 2026-11-12: HANA stores the view's query with * expanded
    // into the quoted column list, so round 2's textual compare of the query
    // part still called this view stale and recreated it on every connect
    // (and two hosts would race on CREATE OR REPLACE). The comparison reads
    // the FROM target and the predicate now; the projection is HANA's to
    // spell. The text below is the bed's, with this fixture's schema in the
    // tenant's place.
    const there = {
      views: [{VIEW_NAME: "SCARR",
        DEFINITION: `SELECT "MANDT" , "CARRID" , "CARRNAME" , "CURRCODE" , "URL" FROM "ZOSD_H3_TENANT"."SCARR" WHERE MANDT = SESSION_CONTEXT('CLIENT')`}],
      synonyms: [{SYNONYM_NAME: "ZOSD_H3_FREE"}],
    };
    const {db, sent} = await connect({shadowTables: ["SCARR", "ZOSD_H3_FREE"]}, there);
    try {
      expect(sent.filter((s) => /^\s*CREATE/i.test(s)), "the expanded text is current").to.deep.equal([]);
    } finally {
      await db.disconnect();
    }
  });

  it("a view whose definition drifted is recreated; a synonym is not touched", async () => {
    const drifted = {
      views: [{VIEW_NAME: "ZOSD_H3_CLI", DEFINITION: `CREATE VIEW "OLD"."SHAPE" AS SELECT 1 FROM DUMMY`}],
      synonyms: [{SYNONYM_NAME: "ZOSD_H3_FREE"}],
    };
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI", "ZOSD_H3_FREE"]}, drifted);
    try {
      expect(sent).to.include(
        `CREATE OR REPLACE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
      expect(sent.some((s) => /ZOSD_H3_FREE/.test(s) && /^\s*(CREATE|DROP)/i.test(s)), "the synonym stays").to.equal(false);
    } finally {
      await db.disconnect();
    }
  });

  it("a hard-coded client in the predicate is drift: the view is recreated", async () => {
    // FIX-3: the predicate is half of the contract. A view an older build
    // made with a literal client reads the wrong rows after a logon with
    // another client -- recreated with CREATE OR REPLACE.
    const stale = {
      views: [{VIEW_NAME: "ZOSD_H3_CLI",
        DEFINITION: `SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE MANDT = '001'`}],
      synonyms: [{SYNONYM_NAME: "ZOSD_H3_FREE"}],
    };
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI"]}, stale);
    try {
      expect(sent).to.include(
        `CREATE OR REPLACE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await db.disconnect();
    }
  });

  it("a view whose FROM names another schema or table is drift: recreated", async () => {
    // FIX-3: keep refusing what is not our view -- either half of the FROM
    // target not being ours is drift even when the predicate is right.
    for (const definition of [
      `SELECT * FROM "OTHER_SCHEMA"."ZOSD_H3_CLI" WHERE MANDT = SESSION_CONTEXT('CLIENT')`,
      `SELECT * FROM "ZOSD_H3_TENANT"."OTHER_TABLE" WHERE MANDT = SESSION_CONTEXT('CLIENT')`,
    ]) {
      const stale = {
        views: [{VIEW_NAME: "ZOSD_H3_CLI", DEFINITION: definition}],
        synonyms: [{SYNONYM_NAME: "ZOSD_H3_FREE"}],
      };
      const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLI"]}, stale);
      try {
        expect(sent).to.include(
          `CREATE OR REPLACE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
      } finally {
        await db.disconnect();
      }
    }
  });

  it("a 259 for a tenant table creates the shadow and retries once, and only once", async () => {
    const {db, sent} = await connect({shadowTables: []}, {failName: "ZOSD_H3_LAZY", failTimes: 1});
    try {
      const rows = await db.query(`SELECT * FROM zosd_h3_lazy`);
      expect(rows).to.deep.equal([]);
      const attempts = sent.filter((s) => /FROM\s+zosd_h3_lazy/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "the failed statement and exactly one retry").to.equal(2);
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_LAZY" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_LAZY" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await db.disconnect();
    }
  });

  it("the lazy fallback takes the measured expanded DEFINITION as current: retry only, no DDL", async () => {
    // the same drift decision runs in ensureShadowFor: the 259 for a table
    // whose shadow view already holds the bed's stored text (any quoted
    // column list, FROM and predicate ours) must be answered with the retry
    // alone -- a CREATE OR REPLACE here is the race two hosts lose (FIX-3).
    const {db, sent} = await connect({shadowTables: []}, {
      failName: "ZOSD_H3_LAZY", failTimes: 1,
      views: [{VIEW_NAME: "ZOSD_H3_LAZY",
        DEFINITION: `SELECT "MANDT" , "CARRNAME" , "URL" FROM "ZOSD_H3_TENANT"."ZOSD_H3_LAZY" WHERE MANDT = SESSION_CONTEXT('CLIENT')`}],
    });
    try {
      const rows = await db.query(`SELECT * FROM zosd_h3_lazy`);
      expect(rows).to.deep.equal([]);
      const attempts = sent.filter((s) => /FROM\s+zosd_h3_lazy/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "the failed statement and exactly one retry").to.equal(2);
      expect(sent.some((s) => /^\s*CREATE/i.test(s)), "the view is current: no DDL").to.equal(false);
    } finally {
      await db.disconnect();
    }
  });

  it("a 259 that keeps failing is retried once and then propagates", async () => {
    const {db, sent} = await connect({shadowTables: []}, {failName: "ZOSD_H3_LAZY", failTimes: 5});
    try {
      let error;
      try {
        await db.query(`SELECT * FROM zosd_h3_lazy`);
      } catch (e) { error = e; }
      expect(error?.code ?? Number(/invalid table name/.test(error?.message ?? ""))).to.not.equal(undefined);
      expect(error, "the 259 reaches the caller").to.not.equal(undefined);
      const attempts = sent.filter((s) => /FROM\s+zosd_h3_lazy/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "no third attempt").to.equal(2);
    } finally {
      await db.disconnect();
    }
  });

  it("a 259 for a name the tenant does not hold is not our table: no retry", async () => {
    const {db, sent} = await connect({shadowTables: []}, {failName: "ZOSD_H3_GHOST", failTimes: 1});
    try {
      let error;
      try {
        await db.query(`SELECT * FROM zosd_h3_ghost`);
      } catch (e) { error = e; }
      expect(error).to.not.equal(undefined);
      const attempts = sent.filter((s) => /FROM\s+zosd_h3_ghost/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "the statement was not retried").to.equal(1);
    } finally {
      await db.disconnect();
    }
  });

  it("a 259 on the fallback's own DD02L read does not re-enter the fallback", async () => {
    // critic MUST 1 at f0a248af1: ensureShadowFor's DD02L / SYS.VIEWS /
    // SYS.SYNONYMS reads go through the 259-retrying path, so a tenant
    // schema whose DD02L read itself failed with 259 re-entered the
    // fallback for the inner statement (probe: 199 DD02L reads). Now:
    // exactly one DD02L read, and the statement's own 259 is what reaches
    // the caller.
    const {db, sent} = await connect({shadowTables: []},
      {failName: "ZOSD_H3_LAZY", failTimes: 5, failDd02lTimes: 5});
    try {
      let error;
      try {
        await db.query(`SELECT * FROM zosd_h3_lazy`);
      } catch (e) { error = e; }
      expect(error, "the 259 reaches the caller").to.not.equal(undefined);
      expect(error?.code, "still HANA's invalid table name").to.equal(259);
      expect(String(error?.message), "the statement's own 259, not the fallback's")
        .to.include("ZOSD_H3_LAZY");
      const reads = sent.filter((s) => /^\s*SELECT/i.test(s) && /DD02L/i.test(s));
      expect(reads.length, "exactly one DD02L read").to.equal(1);
      const attempts = sent.filter((s) => /FROM\s+zosd_h3_lazy/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "the statement was not retried").to.equal(1);
    } finally {
      await db.disconnect();
    }
  });

  it("the 259 wire text measured on the bed names the table, not the first word", () => {
    // bed acceptance 2026-11-12 (REPORT open question 1, answered): the
    // runtime's `SELECT * FROM sflight` failed with this, and the first-word
    // read after "invalid table name:" took "Could" -- DD02L was asked for
    // COULD, found nothing, and the lazy fallback never fired.
    const error = new Error("invalid table name:  Could not find table/view SFLIGHT in schema OSD: line 1 col 15 (at pos 14)");
    error.code = 259;
    expect(tableFrom259(error), "the table, not the first word of the sentence").to.equal("SFLIGHT");
  });

  it("a /-namespaced 259 name keeps its namespace, quoted or not", () => {
    const bare = new Error("invalid table name:  Could not find table/view /DMO/TRAVEL in schema OSD: line 1 col 15 (at pos 14)");
    bare.code = 259;
    expect(tableFrom259(bare)).to.equal("/DMO/TRAVEL");
    const quoted = new Error(`invalid table name:  Could not find table/view "/DMO/TRAVEL" in schema OSD: line 1 col 15 (at pos 14)`);
    quoted.code = 259;
    expect(tableFrom259(quoted), "the quotes come off, the namespace stays").to.equal("/DMO/TRAVEL");
  });

  it("a /-namespaced table is shadowed in the eager set", async () => {
    // critic SHOULD 4 at f0a248af1: the 259 parser carried /DMO/TRAVEL
    // faithfully, and the eager filter refused it one call later. Quoted
    // identifiers carry the slashes; ZOSD_H3 names under a /ZOSD/ namespace
    // stand in for the real /DMO/ ones.
    const {db, sent} = await connect({shadowTables: ["/ZOSD/H3_NS"]});
    try {
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."/ZOSD/H3_NS" AS SELECT * FROM "ZOSD_H3_TENANT"."/ZOSD/H3_NS" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await db.disconnect();
    }
  });

  it("a /-namespaced 259 creates the shadow and retries", async () => {
    const {db, sent} = await connect({shadowTables: []}, {failName: "/ZOSD/H3_NS", failTimes: 1});
    try {
      const rows = await db.query(`SELECT * FROM "/ZOSD/H3_NS"`);
      expect(rows).to.deep.equal([]);
      const attempts = sent.filter((s) => /FROM\s+"\/ZOSD\/H3_NS"/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "the failed statement and exactly one retry").to.equal(2);
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."/ZOSD/H3_NS" AS SELECT * FROM "ZOSD_H3_TENANT"."/ZOSD/H3_NS" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await db.disconnect();
    }
  });

  it("the client is a node-hdb session variable, set at connect, not by SET", async () => {
    const {db, options} = await connect({shadowTables: []});
    try {
      expect(options[0]["SESSIONVARIABLE:CLIENT"], "the connect option, measured on the bed").to.equal("001");
      expect(options[0].host).to.be.a("string");
    } finally {
      await db.disconnect();
    }
  });

  it("the guard lets our shadow DDL through and still refuses DDL on the tenant schema", async () => {
    const {db, sent} = await connect({shadowTables: []});
    try {
      // ours: allowed, and it reaches the driver
      await db.execute(viewSql("ZOSD_H3_OK", "ZOSD_H3_OWN", "ZOSD_H3_TENANT", "MANDT"));
      expect(sent).to.include(viewSql("ZOSD_H3_OK", "ZOSD_H3_OWN", "ZOSD_H3_TENANT", "MANDT"));
      // the tenant's: refused before the driver, with the guard's own code
      let error;
      try {
        await db.execute(`CREATE VIEW "ZOSD_H3_TENANT"."X" AS SELECT 1 FROM DUMMY`);
      } catch (e) { error = e; }
      expect(error?.code).to.equal("HANA_READONLY");
      // even on our own schema, what is not shadow DDL stays refused
      try {
        await db.execute(`CREATE TABLE "ZOSD_H3_OWN"."X" (A INT)`);
        error = undefined;
      } catch (e) { error = e; }
      expect(error?.code).to.equal("HANA_READONLY");
    } finally {
      await db.disconnect();
    }
  });

  it("our own schema equal to the tenant's is refused before a socket opens", async () => {
    // critic MUST 2 at f0a248af1: nothing refused own == tenant, so the
    // shadow views went up over the tenant's own tables and the guard --
    // reading the owning schema off the statement -- admitted DDL on them.
    // Refused at connect, next to the STG_DB_FRESH refusal; the compare is
    // case-folded, and the lower-case spelling is the point here.
    const hdb = fakeHdb();
    const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_H3_TENANT",
      ownSchema: "zosd_h3_tenant", client: "001"});
    let error;
    try {
      await db.connect();
    } catch (e) { error = e; }
    expect(error, "refused").to.not.equal(undefined);
    expect(error?.message).to.include("HANA_OWN_SCHEMA");
    expect(hdb.options, "no socket opened").to.deep.equal([]);
    // and with the two names different, a CREATE on the tenant is still
    // refused by the guard
    const {db: second} = await connect({shadowTables: []});
    try {
      let refused;
      try {
        await second.execute(`CREATE VIEW "ZOSD_H3_TENANT"."X" AS SELECT 1 FROM DUMMY`);
      } catch (e) { refused = e; }
      expect(refused?.code, "the tenant stays read-only").to.equal("HANA_READONLY");
    } finally {
      await second.disconnect();
    }
  });

  it("lower-case schema names are normalised once: DDL, catalog literal and SET SCHEMA agree", async () => {
    // critic SHOULD 5 at f0a248af1: execute() folds quoted identifiers to
    // upper, but the catalog literals and SET SCHEMA went out with the env
    // spelling -- the view landed in one schema and the session sat in
    // another. One normalisation at construction.
    const {db, sent} = await connect({schema: "zosd_h3_tenant", ownSchema: "zosd_h3_own",
      shadowTables: ["ZOSD_H3_CLI"]});
    try {
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
      const views = sent.find((s) => /SYS\.VIEWS/.test(s) && /DEFINITION/.test(s));
      expect(sent.find((s) => /SYS\.TABLES/.test(s)), "the tenant catalog literal is upper too").to.include(`SCHEMA_NAME = 'ZOSD_H3_TENANT'`);
      expect(views, "the catalog literal is upper").to.include(`SCHEMA_NAME = 'ZOSD_H3_OWN'`);
      const dd02l = sent.find((s) => /DD02L/.test(s));
      expect(dd02l, "the DD02L read is upper").to.include(`FROM "ZOSD_H3_TENANT"."DD02L"`);
      expect(sent[sent.length - 1], "SET SCHEMA own is the last statement").to.equal(`SET SCHEMA "ZOSD_H3_OWN"`);
    } finally {
      await db.disconnect();
    }
  });

  it("existing-schema mode refuses to start without a client, naming OSD_CLIENT", async () => {
    delete process.env.OSD_CLIENT;
    const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_H3_TENANT"});
    let error;
    try {
      await db.connect();
    } catch (e) { error = e; }
    expect(error?.message).to.include("HANA_EXISTING_SCHEMA");
    expect(error?.message).to.include("OSD_CLIENT");
  });

  it("the session client is the sy-mandt the ABAP reads", async () => {
    let mandt;
    // the stub is GIVEN BACK, not deleted: a shard's process boots the
    // runtime at load (a suite importing start.mjs), and deleting the global
    // here threw the booted runtime away -- the next boot re-run then built
    // a hollow instance (setup fine, generated modules missing) and
    // job-periodic / osd-rfc / rap-r6 died on their first FunctionModules
    // call (the third hold's GREEN 7). With shard 4's file order the same
    // delete was the CI shards' '.context' failure.
    const priorAbap = globalThis.abap;
    globalThis.abap = {builtin: {sy: {get: () => ({
      dbsys: {set: () => undefined},
      mandt: {set: (value) => { mandt = value; }},
    })}}};
    try {
      fakeHdb(); // its own stand-in: no test may rely on a previous test's (the give-back deletes it, FIX-4)
      const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_H3_TENANT", client: "042"});
      await db.connect();
      expect(mandt, "sy-mandt is the logon client").to.equal("042");
      await db.disconnect();
    } finally {
      globalThis.abap = priorAbap;
    }
  });

  it("the client column is the table's own CLNT key field: CLIENT, not MANDT", async () => {
    // the bed: a whole family of client-dependent tables names the client
    // column CLIENT. MANDT hard-coded failed CREATE VIEW for every one of
    // them (an invalid column) and killed the connect.
    const {db, sent} = await connect({shadowTables: ["ZOSD_H3_CLIENT", "ZOSD_H3_CLI"]});
    try {
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLIENT" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLIENT" WHERE "CLIENT" = SESSION_CONTEXT('CLIENT')`);
      // the classic table beside it keeps MANDT
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLI" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLI" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
      expect(sent.some((s) => /ZOSD_H3_CLIENT/.test(s) && /MANDT|RCLNT|INCLUDE/.test(s) && /^\s*CREATE/i.test(s)),
        "neither the name MANDT, nor a marker row, nor a later CLNT key field").to.equal(false);
    } finally {
      await db.disconnect();
    }
  });

  it("the lazy fallback filters a CLIENT table on CLIENT too", async () => {
    const {db, sent} = await connect({shadowTables: []}, {failName: "ZOSD_H3_CLIENT", failTimes: 1});
    try {
      const rows = await db.query(`SELECT * FROM zosd_h3_client`);
      expect(rows).to.deep.equal([]);
      expect(sent).to.include(
        `CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLIENT" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLIENT" WHERE "CLIENT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await db.disconnect();
    }
  });

  it("the drift check takes the stored expanded definition of a CLIENT view as current", async () => {
    // the bed's stored shape (* expanded, the predicate as sent), for a
    // table whose client column is CLIENT: current, no DDL -- eager and lazy
    const stored = `SELECT "ZOSD_H3_ID" , "CLIENT" , "ZOSD_H3_TEXT" FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLIENT" WHERE "CLIENT" = SESSION_CONTEXT('CLIENT')`;
    const views = [{VIEW_NAME: "ZOSD_H3_CLIENT", DEFINITION: stored}];
    const eager = await connect({shadowTables: ["ZOSD_H3_CLIENT"]}, {views});
    try {
      expect(eager.sent.filter((s) => /^\s*CREATE/i.test(s)), "current: nothing created").to.deep.equal([]);
    } finally {
      await eager.db.disconnect();
    }
    const lazy = await connect({shadowTables: []}, {views, failName: "ZOSD_H3_CLIENT", failTimes: 1});
    try {
      await lazy.db.query(`SELECT * FROM zosd_h3_client`);
      expect(lazy.sent.filter((s) => /^\s*CREATE/i.test(s)), "current: retry only").to.deep.equal([]);
    } finally {
      await lazy.db.disconnect();
    }
    // and a view an older build made on MANDT over this table is drift
    const old = await connect({shadowTables: ["ZOSD_H3_CLIENT"]}, {views: [{VIEW_NAME: "ZOSD_H3_CLIENT",
      DEFINITION: `SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLIENT" WHERE MANDT = SESSION_CONTEXT('CLIENT')`}]});
    try {
      expect(old.sent).to.include(
        `CREATE OR REPLACE VIEW "ZOSD_H3_OWN"."ZOSD_H3_CLIENT" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_CLIENT" WHERE "CLIENT" = SESSION_CONTEXT('CLIENT')`);
    } finally {
      await old.db.disconnect();
    }
  });

  it("a client-dependent table without a CLNT key field is refused by name: no view, no synonym", async () => {
    // eager: nothing is made for it, the connect goes on and says so on
    // stderr; whatever an older build left for it is dropped
    const said = [];
    const priorError = console.error;
    console.error = (...args) => { said.push(args.join(" ")); };
    let eager;
    try {
      eager = await connect({shadowTables: ["ZOSD_H3_NOCLNT", "ZOSD_H3_CLI"]}, {
        views: [{VIEW_NAME: "ZOSD_H3_NOCLNT", DEFINITION: `SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_NOCLNT" WHERE MANDT = SESSION_CONTEXT('CLIENT')`}],
        synonyms: [{SYNONYM_NAME: "ZOSD_H3_NOCLNT"}],
      });
    } finally {
      console.error = priorError;
    }
    try {
      const made = eager.sent.filter((s) => /ZOSD_H3_NOCLNT/.test(s) && /^\s*CREATE/i.test(s));
      expect(made, "no view, no synonym").to.deep.equal([]);
      expect(eager.sent).to.include(`DROP VIEW "ZOSD_H3_OWN"."ZOSD_H3_NOCLNT"`);
      expect(eager.sent).to.include(`DROP SYNONYM "ZOSD_H3_OWN"."ZOSD_H3_NOCLNT"`);
      expect(said.join("\n"), "said, with the name").to.include("ZOSD_H3_NOCLNT");
      // the table beside it is shadowed as ever
      expect(eager.sent.some((s) => /^CREATE VIEW "ZOSD_H3_OWN"\."ZOSD_H3_CLI"/.test(s))).to.equal(true);
    } finally {
      await eager.db.disconnect();
    }
    // lazy: the statement that touches it gets the refusal, not a 259
    const {db, sent} = await connect({shadowTables: []}, {failName: "ZOSD_H3_NOCLNT", failTimes: 5});
    try {
      let error;
      try {
        await db.query(`SELECT * FROM zosd_h3_noclnt`);
      } catch (e) { error = e; }
      expect(error?.code, "refused, by its own code").to.equal("HANA_NO_CLIENT_COLUMN");
      expect(String(error?.message)).to.include("ZOSD_H3_NOCLNT");
      expect(sent.some((s) => /ZOSD_H3_NOCLNT/.test(s) && /^\s*CREATE/i.test(s)), "nothing made").to.equal(false);
      const attempts = sent.filter((s) => /FROM\s+zosd_h3_noclnt/i.test(s) && /^\s*SELECT/i.test(s));
      expect(attempts.length, "not retried").to.equal(1);
    } finally {
      await db.disconnect();
    }
  });

  it("the DDIC set the build knows is the layers' TABL names", () => {
    const root = mkdtempSync(join(tmpdir(), "hana-shadow-ddic-"));
    const write = (rel, body) => {
      mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), {recursive: true});
      writeFileSync(join(root, rel), body);
    };
    try {
      write("abap_transpile.json", JSON.stringify({input_folder: ["gen/hana-ddic", "src"]}));
      write("src/zosd_h3_a.tabl.xml", "<abapGit><TABNAME>ZOSD_H3_A</TABNAME></abapGit>");
      write("gen/hana-ddic/zosd_h3_b.tabl.xml", "<abapGit><TABNAME>ZOSD_H3_B</TABNAME></abapGit>");
      write("src/zcl_h3_c.clas.abap", "CLASS zcl_h3_c DEFINITION PUBLIC FINAL CREATE PUBLIC.\nENDCLASS.\nCLASS zcl_h3_c IMPLEMENTATION.\nENDCLASS.");
      expect(ddicTables(root)).to.deep.equal(["ZOSD_H3_A", "ZOSD_H3_B"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the DDL builders are the measured shapes", () => {
    expect(viewSql("ZOSD_H3_T", "ZOSD_H3_OWN", "ZOSD_H3_TENANT", "MANDT"))
      .to.equal(`CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_T" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_T" WHERE "MANDT" = SESSION_CONTEXT('CLIENT')`);
    expect(viewSql("ZOSD_H3_T", "ZOSD_H3_OWN", "ZOSD_H3_TENANT", "CLIENT"))
      .to.equal(`CREATE VIEW "ZOSD_H3_OWN"."ZOSD_H3_T" AS SELECT * FROM "ZOSD_H3_TENANT"."ZOSD_H3_T" WHERE "CLIENT" = SESSION_CONTEXT('CLIENT')`);
    // no column, no view: the builder never falls back to a name
    expect(() => viewSql("ZOSD_H3_T", "ZOSD_H3_OWN", "ZOSD_H3_TENANT")).to.throw(/client column/);
    expect(() => viewSql("ZOSD_H3_T", "ZOSD_H3_OWN", "ZOSD_H3_TENANT", `X" OR 1=1 --`)).to.throw(/client column/);
    expect(synonymSql("ZOSD_H3_T", "ZOSD_H3_OWN", "ZOSD_H3_TENANT"))
      .to.equal(`CREATE SYNONYM "ZOSD_H3_OWN"."ZOSD_H3_T" FOR "ZOSD_H3_TENANT"."ZOSD_H3_T"`);
  });
});
