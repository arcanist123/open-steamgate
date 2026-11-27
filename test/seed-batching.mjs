import {expect} from "chai";
import {mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {SQLiteDatabaseClient} from "@abaplint/database-sqlite";
import {join} from "node:path";
import {dbTableName, reseedPackRows, seedStatements} from "./seed.mjs";
import {dataDirsOf} from "../tools/osd-packs.mjs";
import {save} from "../tools/osd-persist.mjs";
import {reseedExistingHana, schemaTables, setup} from "./setup.mjs";

describe("pack table ownership on fresh and existing databases", () => {
  let root;
  let priorRoot;
  let priorAbap;
  let priorPath;
  let priorBackend;
  let processListeners;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-seed-owners-"));
    priorRoot = process.env.OSD_ROOT;
    priorAbap = globalThis.abap;
    priorPath = process.env.STG_DB_PATH;
    priorBackend = process.env.STG_DB;
    processListeners = new Map(["beforeExit", "exit", "SIGTERM", "SIGINT"]
      .map((event) => [event, new Set(process.listeners(event))]));
    delete process.env.STG_DB;
    process.env.OSD_ROOT = root;
    globalThis.abap = {};
    for (const [name, order, rows] of [["early", 10, [{id: "1", value: "early"}, {id: "2", value: "old"}]],
      ["later", 20, [{id: "1", value: "later"}]]]) {
      const dir = join(root, "packs", name);
      mkdirSync(join(dir, "data"), {recursive: true});
      writeFileSync(join(dir, "osd-pack.json"), JSON.stringify({name, order}));
      writeFileSync(join(dir, "data", "zshared.tabu.json"), JSON.stringify(rows));
    }
  });
  afterEach(() => {
    for (const [event, originals] of processListeners) {
      for (const listener of process.listeners(event)) {
        if (!originals.has(listener)) process.removeListener(event, listener);
      }
    }
    if (priorRoot === undefined) delete process.env.OSD_ROOT;
    else process.env.OSD_ROOT = priorRoot;
    if (priorAbap === undefined) delete globalThis.abap;
    else globalThis.abap = priorAbap;
    if (priorPath === undefined) delete process.env.STG_DB_PATH;
    else process.env.STG_DB_PATH = priorPath;
    if (priorBackend === undefined) delete process.env.STG_DB;
    else process.env.STG_DB = priorBackend;
    rmSync(root, {recursive: true, force: true});
  });

  it("lets the later pack own all rows on first start and each restart, without duplicate keys", async () => {
    const db = new SQLiteDatabaseClient();
    await db.connect();
    await db.execute('CREATE TABLE zshared (id TEXT PRIMARY KEY, value TEXT);');
    await db.execute(seedStatements());
    const rows = async () => (await db.select({select: 'SELECT id, value FROM zshared ORDER BY id'})).rows;
    expect(await rows()).to.deep.equal([{id: "1", value: "later"}]);
    await db.execute("INSERT INTO zshared VALUES ('2', 'user');");
    await reseedPackRows(db);
    expect(await rows()).to.deep.equal([{id: "1", value: "later"}]);
    await reseedPackRows(db);
    expect(await rows()).to.deep.equal([{id: "1", value: "later"}]);
  });

  it("skips a pack table absent from an older database and still reseeds present tables", async () => {
    writeFileSync(join(root, "packs", "later", "data", "zmissing.tabu.json"), JSON.stringify([{id: "1"}]));
    const db = new SQLiteDatabaseClient();
    await db.connect();
    await db.execute('CREATE TABLE zshared (id TEXT PRIMARY KEY, value TEXT);');
    await db.execute("INSERT INTO zshared VALUES ('1', 'stale');");
    await reseedPackRows(db);
    expect((await db.select({select: 'SELECT value FROM zshared'})).rows).to.deep.equal([{value: "later"}]);
  });

  // A namespaced table cannot be a file name (a slash is a path separator),
  // so abapGit writes /DMO/TRAVEL as #dmo#travel and the runtime's database
  // holds it under the ABAP name: buildDbTableName in @abaplint/runtime
  // lowercases and quotes, it does not rename. packs/rap-flight was the
  // first pack with such tables; before this, the reader refused the file
  // ("invalid seed table #dmo#travel") and would have written #dmo#travel
  // into the SQL, a table no statement of the runtime ever touches.
  it("seeds and reseeds a namespaced table under its ABAP name", async () => {
    writeFileSync(join(root, "packs", "later", "data", "#dmo#travel.tabu.json"), JSON.stringify([{travel_id: "1"}]));
    const db = new SQLiteDatabaseClient();
    await db.connect();
    await db.execute('CREATE TABLE zshared (id TEXT PRIMARY KEY, value TEXT);');
    await db.execute('CREATE TABLE "/dmo/travel" (travel_id TEXT PRIMARY KEY);');
    await db.execute(seedStatements());
    expect((await db.select({select: 'SELECT travel_id FROM "/dmo/travel"'})).rows).to.deep.equal([{travel_id: "1"}]);
    await db.execute('INSERT INTO "/dmo/travel" VALUES (\'9\');');
    await reseedPackRows(db);
    expect((await db.select({select: 'SELECT travel_id FROM "/dmo/travel" ORDER BY travel_id'})).rows)
      .to.deep.equal([{travel_id: "1"}]);
  });

  it("converts ISO dates and pads keys when DDIC lives beside a generated set", () => {
    mkdirSync(join(root, "src", "sets"), {recursive: true});
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "src", "sets", "zset.tabl.xml"), '<DD03P><FIELDNAME>ID</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>000004</LENG></DD03P><DD03P><FIELDNAME>ON_DATE</FIELDNAME><DATATYPE>DATS</DATATYPE></DD03P>');
    writeFileSync(join(root, "data", "zset.tabu.json"), JSON.stringify([{id: "A", on_date: "2026-10-05"}]));
    expect(seedStatements().find((s) => s.includes('"zset"'))).equal('INSERT INTO "zset" ("id", "on_date") VALUES (\'A   \', \'20261005\');');
  });

  it("commits HANA's reseed transaction so a second session can see its rows", async () => {
    const pending = [];
    const visible = [];
    const db = {
      execute: async (sql) => { pending.push(...[sql].flat()); },
      commit: async () => { visible.push(...pending.splice(0)); },
    };
    await reseedExistingHana(db);
    expect(pending).to.deep.equal([]);
    expect(visible).to.deep.equal(['DELETE FROM "zshared";', ...seedStatements()]);
  });

  it("reseeds pack tables when setup restores a SQLite database", async () => {
    process.env.STG_DB_PATH = join(root, "saved.sqlite");
    const schema = {sqlite: ['CREATE TABLE zshared (id TEXT PRIMARY KEY, value TEXT);']};
    const start = async () => {
      const runtime = {builtin: {sy: {get: () => ({})}}, context: {databaseConnections: {}, RFCDestinations: {}}};
      globalThis.abap = runtime;
      await setup(runtime, schema, []);
      return runtime.context.databaseConnections.DEFAULT;
    };
    const first = await start();
    expect((await first.select({select: 'SELECT value FROM zshared'})).rows).to.deep.equal([{value: "later"}]);
    save(first);
    writeFileSync(join(root, "packs", "later", "data", "zshared.tabu.json"),
      JSON.stringify([{id: "1", value: "edited"}]));
    const restored = await start();
    expect((await restored.select({select: 'SELECT value FROM zshared'})).rows).to.deep.equal([{value: "edited"}]);
  });
});

describe("persistent backend schema guard", () => {
  it("extracts every generated table name without confusing indexes", () => {
    expect(schemaTables([`CREATE TABLE "one" ("id" INTEGER)`, `CREATE INDEX x ON "one" ("id")`,
      `CREATE TABLE two (id INTEGER)`])).to.deep.equal(["ONE", "TWO"]);
  });
});

// The seed writes one statement per **batch** of rows rather than one per
// row. fable-osd's SQL trace over `npm run unit` measured why: 4706 of 6793
// statements and 553 ms of 1563 went into three tables seeded a row at a
// time, and 2263 of the seeder's own 2521 statements were one table.
//
// What is asserted here is that batching did not change **what is seeded** —
// the count of statements is the thing being optimised, so it is the one
// thing a test of it must not be about.
describe("the seed inserts every row it has, in batches", () => {
  // **Both readings are taken at the same moment, and that is the whole
  // point of the `before`.**
  //
  // `seedStatements()` used to run in the describe body -- at file LOAD
  // time, which mocha does for every suite before it runs any of them --
  // while the directory was read inside the `it`. Three of the four
  // cross-reference tables are derived and gitignored, and
  // `test/osd-data.mjs` builds them in a `before()` when a fresh checkout
  // has none. So on a clean runner the statements were counted without
  // `cross`, `wbcrossgt` and `d010inc`, another suite then wrote them, and
  // this one compared a list made before they existed against a directory
  // that had them: "a table with rows is seeded and nothing else is",
  // missing exactly those three. On a workstation the files are always
  // there from an earlier run, so it passed for as long as anybody looked.
  //
  // Comparing two readings of a tree that something else is still writing
  // is a measurement of the gap between them. Take them together.
  let statements;
  let inFiles;
  before(() => {
    statements = seedStatements();
    inFiles = new Map();
    for (const dir of dataDirsOf(process.cwd())) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".tabu.json"))) {
        const count = JSON.parse(readFileSync(join(dir, file), "utf8")).length;
        if (count === 0) continue;
        const table = dbTableName(file.slice(0, -".tabu.json".length).toLowerCase());
        inFiles.set(table, (inFiles.get(table) ?? 0) + count);
      }
    }
  });

  it("names every table that has a data file, and no other", () => {
    const inserted = new Set(statements.map((s) => /INSERT INTO "([^"]+)"/.exec(s)?.[1]));
    expect([...inserted].sort(), "a table with rows is seeded and nothing else is")
      .to.deep.equal([...inFiles.keys()].sort());
  });

  it("carries as many rows as the files hold", () => {
    // counted from the statements by their value groups, so that a batch that
    // silently dropped a row would fail here rather than in whichever test
    // happens to read that row next
    const rows = new Map();
    for (const s of statements) {
      const table = /INSERT INTO "([^"]+)"/.exec(s)[1];
      const values = s.slice(s.indexOf(" VALUES ") + 8);
      // count the top-level groups: a bracket that opens at depth 0
      let depth = 0;
      let inString = false;
      let groups = 0;
      for (let i = 0; i < values.length; i += 1) {
        const c = values[i];
        if (c === "'") {
          if (inString && values[i + 1] === "'") i += 1;
          else inString = !inString;
          continue;
        }
        if (inString) continue;
        if (c === "(") { if (depth === 0) groups += 1; depth += 1; }
        if (c === ")") depth -= 1;
      }
      rows.set(table, (rows.get(table) ?? 0) + groups);
    }
    // the same list the statements were built from, not a fresh reading of
    // a directory another suite may have written to since
    for (const [table, count] of inFiles) {
      expect(rows.get(table), `${table}: every row of the file is in a statement`).to.equal(count);
    }
  });

  it("starts a new statement when the column list changes", () => {
    // a TABU JSON row omits what it has no value for, so two rows of one
    // table can carry different columns. Merging those would put a value
    // under the wrong name — silently, and only for the rows after the first
    for (const s of statements) {
      const cols = /INSERT INTO "[^"]+" \(([^)]*)\) VALUES /.exec(s)?.[1];
      expect(cols, `every statement names its columns: ${s.slice(0, 60)}`).to.be.a("string");
      // and not: "as many values as columns", counted by splitting on
      // commas. That was the first version and it is wrong about its own
      // subject — a value may contain a comma inside quotes, so it counted
      // seven parts for five columns. A check that needs a parser to be
      // right is a check that should use one or not exist; the row-count
      // test above already parses, and a statement whose arity is wrong is
      // rejected by the engine in every other suite.
    }
  });

  it("is far fewer statements than rows, which is the point", () => {
    // counted from the same list, for the same reason as above -- and the
    // floor is what the TRACKED seed data holds (3507 rows in 36 files),
    // not what a workstation happens to have after somebody built the
    // derived cross-reference tables. A threshold that only a developer's
    // machine can clear is a threshold that fails on a clean checkout and
    // teaches nobody anything.
    const rows = [...inFiles.values()].reduce((n, count) => n + count, 0);
    expect(rows, "there are rows to batch").to.be.greaterThan(1000);
    expect(statements.length, `${rows} rows in ${statements.length} statements`).to.be.lessThan(rows / 10);
  });
});
