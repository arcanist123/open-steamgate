import {expect} from "chai";
import {createRequire} from "node:module";
import {giveBackHdb} from "./hdb-stub.mjs";
import {HanaDatabaseClient} from "../tools/hana-client.mjs";

// HANA_EXISTING_SCHEMA=1: the mode that runs OSG-JS over a HANA which
// already holds an SAP system's schema (docs/db-backends.md, "Existing
// schema, read-only").
//
// The mode only skips: no DROP SCHEMA, no CREATE SCHEMA, no CREATE TABLE, no
// seed inserts -- and STG_DB_FRESH=1 together with it is refused outright,
// because "start from nothing" is exactly what the mode must never mean
// against a schema somebody else owns. Keep one code path; the flag turns
// nothing new on, it only leaves steps out. The fake hdb module below stands
// in for the driver, so connect() can be driven without a HANA.
describe("HANA_EXISTING_SCHEMA mode", () => {
  // the stand-in is given back after every test, so the next hdb consumer in
  // the shard's process meets the real driver (test/hdb-stub.mjs)
  afterEach(giveBackHdb);

  // connect() reaches the driver through createRequire("hdb"); the same CJS
  // cache a real require would use is pointed at a stand-in first.
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

  const fakeHdb = () => {
    const sent = [];
    const require = createRequire(import.meta.url);
    const path = require.resolve("hdb");
    require.cache[path] = {
      id: path,
      filename: path,
      loaded: true,
      exports: {createClient: () => ({
        connect: (cb) => cb(undefined),
        setAutoCommit: () => undefined,
        exec: (sql, cb) => { sent.push(sql); cb(undefined, 1); },
        commit: (cb) => cb(undefined),
        rollback: (cb) => cb(undefined),
        end: () => undefined,
      })},
    };
    return sent;
  };

  it("refuses STG_DB_FRESH=1, naming both flags, before anything is sent", async () => {
    const sent = fakeHdb();
    const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_H1_FRESH", client: "001"});
    process.env.STG_DB_FRESH = "1";
    let error;
    try {
      await db.connect();
    } catch (e) { error = e; } finally {
      delete process.env.STG_DB_FRESH;
    }
    expect(error, "the combination is refused").to.not.equal(undefined);
    expect(error.message).to.include("HANA_EXISTING_SCHEMA");
    expect(error.message).to.include("STG_DB_FRESH");
    expect(sent, "nothing reached the driver").to.deep.equal([]);
  });

  it("sends no DDL: connect() issues only SET SCHEMA", async () => {
    const sent = fakeHdb();
    const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_H1_EXISTING", client: "001"});
    await db.connect();
    expect(sent).to.deep.equal([`SET SCHEMA "ZOSD_H1_EXISTING"`]);
    await db.disconnect();
  });

  it("the seed and DDL the setup would run are skipped with the mode", async () => {
    // the setup's HANA branch returns straight after connect() in the mode,
    // so the schema statements and the seed INSERTs never reach a client.
    // This holds the client to its half: after a connect in the mode, the
    // session carries no schema of ours and nothing is prepared for seeding.
    const sent = fakeHdb();
    const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_H1_NOSEED", client: "001"});
    await db.connect();
    const ddl = sent.filter((s) => !s.startsWith("SET SCHEMA"));
    expect(ddl, "no DROP, no CREATE, no INSERT").to.deep.equal([]);
  });

  it("without the mode the same connect still builds, as it always did", async () => {
    // the mode only skips; prove the shared path is untouched: CREATE SCHEMA
    // (its error ignored, as before) and SET SCHEMA, in that order.
    const sent = fakeHdb();
    const db = new HanaDatabaseClient({schema: "ZOSD_H1_BUILD"});
    await db.connect();
    expect(sent).to.deep.equal([`CREATE SCHEMA "ZOSD_H1_BUILD"`, `SET SCHEMA "ZOSD_H1_BUILD"`]);
  });

  it("STG_DB_FRESH=1 alone still drops the schema, as it always did", async () => {
    const sent = fakeHdb();
    const db = new HanaDatabaseClient({schema: "ZOSD_H1_FRESH2"});
    process.env.STG_DB_FRESH = "1";
    try {
      await db.connect();
    } finally {
      delete process.env.STG_DB_FRESH;
    }
    expect(sent.some((s) => s.startsWith(`DROP SCHEMA "ZOSD_H1_FRESH2"`))).to.equal(true);
  });
});
