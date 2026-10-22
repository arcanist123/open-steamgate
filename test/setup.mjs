import {phase} from "../tools/osgjs-trace.mjs";
import {installXStringBuffer} from "../tools/osd-xstring-buffer.mjs";
import {SQLiteDatabaseClient} from "../tools/sqlite-heap-client.mjs";
import {randomBytes} from "node:crypto";
import {bootIdentity} from "../tools/osd-identity.mjs";
import {installTrim} from "../tools/sql-literals.mjs";
import {installSqlTrace, fileSink} from "../tools/osd-sql-trace.mjs";
import {batchInserts} from "../tools/osd-batch-inserts.mjs";
import {TraceRing, TraceDestination} from "../tools/osd-sql-trace-buffer.mjs";
import {StoreDestination} from "../tools/osd-store-destination.mjs";
import {beforeAdtHandleDDL, adtHandleMigration} from "../tools/osd-adt-handle-migrate.mjs";
export {beforeAdtHandleDDL} from "../tools/osd-adt-handle-migrate.mjs";

/** The trace a running system holds, for the ST05-shaped screen to read
 *  (backlog G.10). It is off until the screen turns it on, and the wrapper
 *  costs nothing while it is. */
export const traceRing = new TraceRing();

export function schemaTables(ddl) {
  return [ddl].flat().flatMap((statement) =>
    [...String(statement).matchAll(/\bCREATE\s+TABLE\s+"?([A-Za-z_][A-Za-z_0-9]*)"?/gi)].map((match) => match[1].toUpperCase()));
}

// Standalone migrations take the write lock; startup holds it across the
// whole chain and the drift decision. Savepoints keep each migration's
// rollback local without releasing the startup transaction.
function withSchemaMigrationLock(native, migrate) {
  const nested = native.isTransaction;
  native.exec(nested ? "SAVEPOINT osd_schema_migration" : "BEGIN IMMEDIATE");
  try {
    const result = migrate();
    native.exec(nested ? "RELEASE osd_schema_migration" : "COMMIT");
    return result;
  } catch (error) {
    if (nested) {
      native.exec("ROLLBACK TO osd_schema_migration");
      native.exec("RELEASE osd_schema_migration");
    } else {
      native.exec("ROLLBACK");
    }
    throw error;
  }
}

export function migrateAdtHandleFile(native, found, wanted, ddl, fingerprintOf) {
  const table = adtHandleMigration(found, wanted, ddl, fingerprintOf);
  if (!table) return false;
  return withSchemaMigrationLock(native, () => {
    const current = native.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint;
    if (current === wanted) return true;
    if (current !== found) return false;
    // These rows are transient session handles, so discarding them on an
    // upgrade is acceptable. No business table or session row is dropped.
    native.exec("DROP TABLE zosd_adt_shdl");
    native.exec(table);
    native.prepare("UPDATE osd_schema SET fingerprint = ?, at = ?")
      .run(wanted, new Date().toISOString());
    return true;
  });
}

// Add the permanent job key to the previous business schema without moving
// useful rows aside. Backfill unacknowledged intents before a new OPEN can
// allocate their count. The operations ledger covers already acknowledged
// pre-upgrade intents at candidate selection time.
export function migrateJobIdentityFile(native, found, wanted, ddl, fingerprintOf) {
  const identity = ddl.find((statement) => /^CREATE TABLE ['"]zosd_job_identity['"] /i.test(statement));
  const step = ddl.find((statement) => /^CREATE TABLE ['"]zosd_job_step['"] /i.test(statement));
  const parent = ddl.find((statement) => /^CREATE TABLE ['"]zosd_job_outbox['"] /i.test(statement));
  if (!identity || !step || !parent || fingerprintOf(ddl) !== wanted) return false;
  const oldParent = parent.replace(/,\s*['"]step_count['"]\s+NCHAR\(2\)/i, "");
  const previous = ddl.filter((statement) => statement !== identity);
  const oneStep = previous.filter((statement) => statement !== step)
    .map((statement) => statement === parent ? oldParent : statement);
  const prior = fingerprintOf(previous) === found ? "multistep" :
    fingerprintOf(oneStep) === found && oldParent !== parent ? "one-step" : undefined;
  if (!prior) return false;
  return withSchemaMigrationLock(native, () => {
    const current = native.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint;
    if (current === wanted) return true;
    if (current !== found) return false;
    if (native.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zosd_job_identity'").get()) {
      return false;
    }
    if (prior === "one-step") {
      native.exec("ALTER TABLE zosd_job_outbox ADD COLUMN step_count NCHAR(2)");
      native.exec(step);
    }
    native.exec(identity);
    const insertIdentity = native.prepare(`INSERT INTO zosd_job_identity
      (mandt, jobname, jobcount, owner, intent_id) VALUES (?, ?, ?, ?, ?)`);
    for (const row of native.prepare(`SELECT mandt, jobname, jobcount, owner, intent_id
      FROM zosd_job_outbox`).all()) {
      insertIdentity.run(row.mandt, String(row.jobname ?? "").trim().toUpperCase(),
        row.jobcount, row.owner, row.intent_id);
    }
    native.prepare("UPDATE osd_schema SET fingerprint = ?, at = ?")
      .run(wanted, new Date().toISOString());
    return true;
  });
}

// The predecessor columns are additive. Existing committed outbox rows have
// no dependency and keep their original import digest.
export function beforeJobPredecessorDDL(ddl) {
  const parent = ddl.find((statement) => /^CREATE TABLE ['"]zosd_job_outbox['"] /i.test(statement));
  if (!parent) return ddl;
  const previousParent = parent
    .replace(/,\s*['"]pred_jobname['"]\s+NCHAR\(32\)\s+COLLATE RTRIM/i, "")
    .replace(/,\s*['"]pred_jobcount['"]\s+NCHAR\(8\)\s+COLLATE RTRIM/i, "")
    .replace(/,\s*['"]pred_intent_id['"]\s+NCHAR\(32\)\s+COLLATE RTRIM/i, "");
  return ddl.map((statement) => statement === parent ? previousParent : statement);
}

export function migrateJobPredecessorFile(native, found, wanted, ddl, fingerprintOf) {
  if (fingerprintOf(ddl) !== wanted) return false;
  const previous = beforeJobPredecessorDDL(ddl);
  if (fingerprintOf(previous) === wanted) return false;
  if (fingerprintOf(previous) !== found) return false;
  return withSchemaMigrationLock(native, () => {
    const current = native.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint;
    if (current === wanted) return true;
    if (current !== found) return false;
    native.exec(`ALTER TABLE zosd_job_outbox ADD COLUMN pred_jobname NCHAR(32) COLLATE RTRIM`);
    native.exec(`ALTER TABLE zosd_job_outbox ADD COLUMN pred_jobcount NCHAR(8) COLLATE RTRIM`);
    native.exec(`ALTER TABLE zosd_job_outbox ADD COLUMN pred_intent_id NCHAR(32) COLLATE RTRIM`);
    native.exec("UPDATE zosd_job_outbox SET pred_jobname = '', pred_jobcount = '', pred_intent_id = ''");
    native.prepare("UPDATE osd_schema SET fingerprint = ?, at = ?")
      .run(wanted, new Date().toISOString());
    return true;
  });
}

export function beforeJobEventDDL(ddl) {
  const parent = ddl.find((statement) => /^CREATE TABLE ['"]zosd_job_outbox['"] /i.test(statement));
  if (!parent) return ddl;
  const previousParent = parent
    .replace(/,\s*['"]source_instance['"]\s+NCHAR\(32\)\s+COLLATE RTRIM/i, "")
    .replace(/,\s*['"]wait_seq['"]\s+NCHAR\(16\)/i, "")
    .replace(/,\s*['"]event_id['"]\s+NCHAR\(32\)\s+COLLATE RTRIM/i, "")
    .replace(/,\s*['"]event_param['"]\s+NCHAR\(64\)\s+COLLATE RTRIM/i, "");
  return ddl.map((statement) => statement === parent ? previousParent : statement);
}

export function migrateJobEventFile(native, found, wanted, ddl, fingerprintOf) {
  if (fingerprintOf(ddl) !== wanted) return false;
  const previous = beforeJobEventDDL(ddl);
  if (fingerprintOf(previous) === wanted || fingerprintOf(previous) !== found) return false;
  return withSchemaMigrationLock(native, () => {
    const current = native.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint;
    if (current === wanted) return true;
    if (current !== found) return false;
    native.exec("ALTER TABLE zosd_job_outbox ADD COLUMN source_instance NCHAR(32) COLLATE RTRIM");
    native.exec("ALTER TABLE zosd_job_outbox ADD COLUMN wait_seq NCHAR(16)");
    native.exec("ALTER TABLE zosd_job_outbox ADD COLUMN event_id NCHAR(32) COLLATE RTRIM");
    native.exec("ALTER TABLE zosd_job_outbox ADD COLUMN event_param NCHAR(64) COLLATE RTRIM");
    native.exec("UPDATE zosd_job_outbox SET source_instance = '', wait_seq = '', event_id = '', event_param = ''");
    native.prepare("UPDATE osd_schema SET fingerprint = ?, at = ?")
      .run(wanted, new Date().toISOString());
    return true;
  });
}

export function beforeJobStepInputDDL(ddl) {
  return ddl.map((statement) => /^CREATE TABLE ['"]zosd_job_step['"] /i.test(statement) ?
    statement.replace(/,\s*['"]input_json['"]\s+TEXT(?:\s+COLLATE\s+RTRIM)?/i, "") : statement);
}

export function migrateJobStepInputFile(native, found, wanted, ddl, fingerprintOf) {
  if (fingerprintOf(ddl) !== wanted) return false;
  const previous = beforeJobStepInputDDL(ddl);
  if (fingerprintOf(previous) === wanted || fingerprintOf(previous) !== found) return false;
  return withSchemaMigrationLock(native, () => {
    const current = native.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint;
    if (current === wanted) return true;
    if (current !== found) return false;
    native.exec("ALTER TABLE zosd_job_step ADD COLUMN input_json TEXT COLLATE RTRIM");
    native.exec("UPDATE zosd_job_step SET input_json = '[]'");
    native.prepare("UPDATE osd_schema SET fingerprint = ?, at = ?")
      .run(wanted, new Date().toISOString());
    return true;
  });
}

// Start by date and time and periodic starts (2026-10-01): eight additive
// outbox columns. A committed intent written before has none of them and
// keeps its import digest: an empty column is a job that is not timed.
const JOB_SCHEDULE_COLUMNS = [["sdlstrtdt", 8], ["sdlstrttm", 6], ["laststrtdt", 8], ["laststrttm", 6],
  ["prdmins", 2], ["prdhours", 2], ["prddays", 3], ["prdweeks", 2]];

export function beforeJobScheduleDDL(ddl) {
  const parent = ddl.find((statement) => /^CREATE TABLE ['"]zosd_job_outbox['"] /i.test(statement));
  if (!parent) return ddl;
  let previousParent = parent;
  for (const [column, width] of JOB_SCHEDULE_COLUMNS) {
    previousParent = previousParent.replace(new RegExp(`,\\s*['"]${column}['"]\\s+NCHAR\\(${width}\\)\\s+COLLATE RTRIM`, "i"), "");
  }
  return ddl.map((statement) => statement === parent ? previousParent : statement);
}

export function migrateJobScheduleFile(native, found, wanted, ddl, fingerprintOf) {
  if (fingerprintOf(ddl) !== wanted) return false;
  const previous = beforeJobScheduleDDL(ddl);
  if (fingerprintOf(previous) === wanted || fingerprintOf(previous) !== found) return false;
  return withSchemaMigrationLock(native, () => {
    const current = native.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint;
    if (current === wanted) return true;
    if (current !== found) return false;
    for (const [column, width] of JOB_SCHEDULE_COLUMNS) {
      native.exec(`ALTER TABLE zosd_job_outbox ADD COLUMN ${column} NCHAR(${width}) COLLATE RTRIM`);
    }
    native.exec(`UPDATE zosd_job_outbox SET ${JOB_SCHEDULE_COLUMNS.map(([column]) => `${column} = ''`).join(", ")}`);
    native.prepare("UPDATE osd_schema SET fingerprint = ?, at = ?")
      .run(wanted, new Date().toISOString());
    return true;
  });
}

// The release order of the outbox (DSL L3 slice 5d, 2026-10-02): RELEASE_SEQ,
// which JOB_CLOSE writes and the drain sorts by, and in the same change the
// gate table's RUN_BIND, the binding a DSL L3 run started with. Both are
// additive; a pending intent written before has an empty RELEASE_SEQ and
// drains first, in the order it drained before.
export function beforeJobReleaseDDL(ddl) {
  return ddl.map((statement) => /^CREATE TABLE ['"]zosd_job_outbox['"] /i.test(statement)
    ? statement.replace(/,\s*['"]release_seq['"]\s+NCHAR\(16\)/i, "")
    : /^CREATE TABLE ['"]zosd_l3_stage['"] /i.test(statement)
      ? statement.replace(/,\s*['"]run_bind['"]\s+NCHAR\(255\)\s+COLLATE RTRIM/i, "") : statement);
}

export function migrateJobReleaseFile(native, found, wanted, ddl, fingerprintOf) {
  if (fingerprintOf(ddl) !== wanted) return false;
  const previous = beforeJobReleaseDDL(ddl);
  if (fingerprintOf(previous) === wanted || fingerprintOf(previous) !== found) return false;
  return withSchemaMigrationLock(native, () => {
    const current = native.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint;
    if (current === wanted) return true;
    if (current !== found) return false;
    native.exec("ALTER TABLE zosd_job_outbox ADD COLUMN release_seq NCHAR(16)");
    native.exec("UPDATE zosd_job_outbox SET release_seq = ''");
    if (native.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zosd_l3_stage'").get()) {
      native.exec("ALTER TABLE zosd_l3_stage ADD COLUMN run_bind NCHAR(255) COLLATE RTRIM");
      native.exec("UPDATE zosd_l3_stage SET run_bind = ''");
    }
    native.prepare("UPDATE osd_schema SET fingerprint = ?, at = ?")
      .run(wanted, new Date().toISOString());
    return true;
  });
}

export function ensureJobEventMetadata(native) {
  native.exec("BEGIN IMMEDIATE");
  try {
    native.exec(`CREATE TABLE IF NOT EXISTS zosd_job_source_instance (id TEXT PRIMARY KEY)`);
    if (!native.prepare("SELECT id FROM zosd_job_source_instance LIMIT 1").get()) {
      native.prepare("INSERT INTO zosd_job_source_instance (id) VALUES (?)")
        .run(randomBytes(16).toString("hex"));
    }
    native.exec("COMMIT");
  } catch (error) { native.exec("ROLLBACK"); throw error; }
}

// HANA's execute opens a transaction even for the DELETE in a reseed.
export async function reseedExistingHana(db) {
  const {reseedPackRows} = await import("./seed.mjs");
  await reseedPackRows(db);
  await db.commit();
}

async function requireCurrentSchema(db, ddl, backend, recovery) {
  const missing = await db.missingTables(schemaTables(ddl));
  if (missing.length === 0) return;
  throw new Error(`Existing ${backend} database is missing generated tables: ${missing.join(", ")}. ${recovery}; automatic migration is not implemented.`);
}

/** `STG_SQL_TRACE=<file.ndjson>` records every statement the chosen client is
 *  asked for -- the second sieve of backlog W.1, and the cheap half of O.1.
 *
 *  Here rather than in a client, because all six paths below choose a
 *  different client and every one of them has to be traceable: a tracer
 *  written into one client is a tracer the other five do not have. This file
 *  is the transpiler's `options.setup`, so it is the one place the server,
 *  the unit run and the browser preview all pass through. */
function traced(db) {
  const file = globalThis.process?.env?.STG_SQL_TRACE;
  const toFile = file === undefined || file === "" ? undefined : fileSink(file);
  // Installed whether or not anything is listening, because the screen turns
  // it on at runtime; `enabled` keeps that free until something does.
  return installSqlTrace(db, (entry) => {
    toFile?.(entry);
    traceRing.record(entry);
  }, {enabled: () => toFile !== undefined || traceRing.on === true});
}

/** the destination the ST05 screen calls, the same shape as AMDP's */
export function installTraceDestination(abap) {
  abap.context.RFCDestinations ??= {};
  abap.context.RFCDestinations["SQLTRACE"] = new TraceDestination(traceRing);
}

/**
 * The destination the editor screen calls (backlog G.8), and the third user
 * of this seam rather than a third seam.
 *
 * The store is opened on the first call, not here: it indexes the tree and
 * parses it with abaplint, which is seconds, and most processes that install
 * it never get a request for it. Where there is no tree at all -- the browser
 * preview, a compiled binary beside no checkout -- opening it fails and the
 * failure becomes the sentence the screen shows, which is the honest answer
 * and not an empty object list.
 */
export function installStoreDestination(abap, options = {}) {
  abap.context.RFCDestinations ??= {};
  // A serving child receives the destination from its host before boot.
  // Never open a second source store, even from a class constructor.
  const supplied = options.destination ?? globalThis.__osdStoreDestination;
  if (supplied !== undefined) {
    abap.context.RFCDestinations.STORE = supplied;
    return;
  }
  abap.context.RFCDestinations["STORE"] = new StoreDestination({
    // imported inside the opener, never at the top of this file: the store
    // pulls in abaplint and node:fs, and this module is bundled into the
    // service worker of the browser preview. A static import would put the
    // whole parser in a page that can never use it.
    store: options.store ?? (async () => {
      if (globalThis.__stgPreview !== undefined) {
        throw new Error("the browser preview serves a built system: there is no source tree in a page");
      }
      const root = globalThis.process?.cwd?.();
      const {existsSync} = await import("node:fs");
      const {join} = await import("node:path");
      if (root === undefined || existsSync(join(root, "abap_transpile.json")) === false) {
        throw new Error(`no tree at ${root ?? "this process"}: abap_transpile.json is not there`);
      }
      const {ObjectStore} = await import("../tools/osd-store.mjs");
      return new ObjectStore({root});
    }),
    ...options,
  });
}

// Called by the transpiled runtime before anything runs (abap_transpile.json
// options.setup). Same shape as every open-abap repo: one in-memory DB,
// schema from the DDIC in src/ + libs, seed rows from data/*.tabu.json.
// STG_DB=duckdb swaps SQLite for DuckDB (tools/duckdb-client.mjs).
export async function setup(abap, schemas, insert) {
  installXStringBuffer(abap);
  await phase("database-setup", () => setupDatabase(abap, schemas, insert));
  // opt-in, Node only (the preview never installs it): a table of the allow
  // list that has no rows here is filled from this destination on its first
  // read (docs/rfc-proxy.md, "P2: tables"). After the database, whichever
  // branch of setupDatabase built it, because it wraps that connection.
  if (globalThis.__stgPreview === undefined && globalThis.process?.env?.STG_TABLE_PROXY) {
    const {installTableProxy} = await import("../tools/rfc-table-proxy.mjs");
    await installTableProxy(abap, {
      destination: process.env.STG_TABLE_PROXY,
      allow: process.env.STG_TABLE_PROXY_ALLOW ?? "",
      mode: process.env.STG_TABLE_PROXY_MODE ?? process.env.STG_RFC_PROXY_MODE,
      folder: process.env.STG_RFC_CAPTURE,
      maxRows: process.env.STG_TABLE_PROXY_MAX_ROWS,
      noLive: process.env.STG_RFC_NO_LIVE === "1" || process.env.CI === "true",
      trace: process.env.STG_RFC_TRACE === "1",
    });
  }
}

async function withTmpPackages(insert) {
  if (globalThis.__stgPreview !== undefined || !Array.isArray(insert)) return insert;
  const root = globalThis.process?.env?.OSD_ROOT ?? globalThis.process?.cwd?.();
  if (root === undefined) return insert;
  const {tadirWithTmp} = await import("../tools/osd-tmp.mjs");
  const {localObjectKeys} = await import("../tools/osd-deploy-manifest.mjs");
  return tadirWithTmp(insert, localObjectKeys(root));
}

async function setupDatabase(abap, schemas, insert) {
  let db;
  // The transpiler hands over the object directory and the sources one row
  // per statement -- 1542 INSERTs into TADIR and 907 into REPOSRC, measured
  // on a real unit run after the seed itself was batched (e088c4d). A
  // statement costs its parse, so consecutive rows of one shape are merged
  // into one. Here rather than in each branch below: all six of them execute
  // this same array.
  // TADIR says $TMP only for an object of $TMP (tools/osd-tmp.mjs): the
  // transpiler files everything there, and ABAP that refuses to export a
  // local object (zcl_stg_segw_repo) reads it
  insert = await withTmpPackages(insert);
  const given = insert;
  insert = batchInserts(insert);
  // the browser preview (web/preview-backend.mjs): seed rows come from the
  // bundle, the database from cache storage when there is one
  const preview = globalThis.__stgPreview;
  // Who this system is, before a line of ABAP runs: sy-sysid, sy-mandt and
  // sy-uname come from tools/osd-identity.mjs, which the status snapshot and
  // the ADT façade read too, so the three cannot drift apart (backlog G.1b).
  // In the browser there is no environment; the build wrote the id into the
  // bundle and the backend hands it over here.
  bootIdentity(abap, preview?.env ?? globalThis.process?.env ?? {});
  // OPEN DATASET (X0, docs/dataset.md): the disk behind OSD_DATASET_READ /
  // OSD_DATASET_WRITE, refusing everything when neither is set; in the
  // browser preview a file system in memory, gone with the page
  {
    const {installDataset, memoryDatasetHost} = await import("../tools/osd-dataset.mjs");
    if (preview !== undefined || globalThis.process?.versions?.node === undefined) {
      abap.context.dataset = memoryDatasetHost();
      abap.context.datasets ??= {};
    } else {
      await installDataset(abap);
    }
  }
  if (globalThis.process?.versions?.node && abap.Classes?.CL_AMC_CHANNEL_MANAGER) {
    const {installAmc} = await import("../tools/osd-amc.mjs");
    installAmc(abap);
    const {installDaemons} = await import("../tools/osd-daemon-host.mjs");
    installDaemons(abap);
  }
  // the lock server (tools/osd-enq-host.mjs): ENQUEUE_<obj> / DEQUEUE_<obj>,
  // DEQUEUE_ALL, ENQUEUE_READ, COMMIT/ROLLBACK WORK and the end of a step;
  // the update-task modules (UPDATE_TASK in a *.fugr.xml) on Node, where the
  // tree is on disk -- in the browser none, so a COMMIT there hands no lock
  // to an update
  {
    const {installEnq} = await import("../tools/osd-enq-host.mjs");
    let updateModules = [];
    if (preview === undefined && globalThis.process?.versions?.node !== undefined) {
      try {
        const {functionModules} = await import(/* webpackIgnore: true */ "../tools/osd-fm-registry.mjs");
        const {generatorFoldersOf} = await import(/* webpackIgnore: true */ "../tools/osd-packs.mjs");
        const root = process.cwd();
        updateModules = functionModules(generatorFoldersOf(root).map((f) => `${root}/${f}`))
          .filter((fm) => fm.updateTask).map((fm) => fm.name);
      } catch (e) {
        console.warn(`osd-enq-host: the update-task modules were not read (${e?.message ?? e}); COMMIT WORK hands no lock to an update`);
        updateModules = [];
      }
    }
    installEnq(abap, {updateModules});
  }
  if (preview !== undefined) {
    preview.schemas = schemas;
    // **The rows as they were given, not as they were batched.** The
    // preview's "reset" calls this again with what it kept here, and
    // batching an already-batched array merged it once more: REPOSRC became
    // one INSERT of 5.6 MB, and sql.js died on it with "memory access out of
    // bounds" (node) or "is not a function" (the service worker). Reset had
    // been failing with a 500 for as long as it batched; found while
    // testing that reset re-seeds the cross-reference.
    preview.insert = given;
    if (preview.database === "duckdb") {
      const {DuckDBWasmClient, duckdbSchema, duckdbInserts} = await import("../tools/duckdb-wasm-client.mjs");
      db = installTrim(new DuckDBWasmClient({wasmURL: preview.wasmURL}));
      abap.context.databaseConnections["DEFAULT"] = traced(db);
      await db.connect();
      await db.execute(duckdbSchema(schemas));
      await db.execute(duckdbInserts(insert));
      await db.execute(preview.seed);
    } else {
      db = installTrim(new SQLiteDatabaseClient());
      abap.context.databaseConnections["DEFAULT"] = traced(db);
      await db.connect(preview.stored);
      if (preview.stored === undefined) {
        await db.execute(schemas.sqlite);
        await db.execute(insert);
        await db.execute(preview.seed);
      }
    }
    preview.db = db;
    // The AMDP destination belongs here too. Three lines below the early
    // return, the non-preview path says "it is installed whatever the
    // database is, because the failure a developer needs is 'no HANA to run
    // this in', not 'unknown destination'" -- and the preview returned before
    // reaching it, so in the browser there was no destination at all. A
    // stated intention that the code does not honour is worse than no
    // intention: the AMDP tile asked an honest question and got a crash page
    // (E.5, 2026-09-19).
    const {AmdpDestination: PreviewAmdp} = await import("../tools/amdp-destination.mjs");
    abap.context.RFCDestinations ??= {};
    const procedures = preview.database === "duckdb"
      ? new Map((await import("../web/generated/amdp.mjs")).procedures.map((one) => [one.module.toUpperCase(), one]))
      : undefined;
    abap.context.RFCDestinations["AMDP"] = new PreviewAmdp({procedures});
    installTraceDestination(abap);
    installStoreDestination(abap);
    return;
  }
  const {seedStatements, reseedPackRows} = await import("./seed.mjs");
  // CALL FUNCTION ... DESTINATION: .local/rfc-destinations.json says which
  // name is local, replay, live or record (tools/rfc-replay.mjs); without
  // it 'NONE' and '' run here and any other name replays STG_RFC_CAPTURE
  const {installRfcDestinations} = await import("../tools/rfc-replay.mjs");
  await installRfcDestinations(abap, {trace: process.env.STG_RFC_TRACE === "1"});
  if (process.env.STG_RFC_PROXY) {
    // opt-in: a CALL FUNCTION without DESTINATION whose module is not
    // transpiled goes to this destination when STG_RFC_PROXY_ALLOW names it
    // (docs/rfc-proxy.md). STG_RFC_PROXY_MODE: live | record | replay.
    const {installFunctionProxy} = await import("../tools/rfc-proxy.mjs");
    await installFunctionProxy(abap, {
      destination: process.env.STG_RFC_PROXY,
      allow: process.env.STG_RFC_PROXY_ALLOW ?? "",
      mode: process.env.STG_RFC_PROXY_MODE,
      folder: process.env.STG_RFC_CAPTURE,
      noLive: process.env.STG_RFC_NO_LIVE === "1" || process.env.CI === "true",
      trace: process.env.STG_RFC_TRACE === "1",
    });
  }
  // This branch is Node-only; keep node:sqlite out of the preview bundle.
  const {JobDestination} = await import(/* webpackIgnore: true */ "../tools/osd-job-port.mjs");
  const jobs = new JobDestination(process.cwd(), process.env);
  abap.context.RFCDestinations["JOBS"] = jobs;
  const {installCapacity} = await import(/* webpackIgnore: true */ "../tools/osd-capacity-host.mjs");
  installCapacity(abap, jobs);
  abap.context.osdGeneration = jobs.generation;
  // AMDP: a method whose body is SQLScript has been rewritten by
  // tools/amdp-gen.mjs into CALL FUNCTION ... DESTINATION 'AMDP', and this is
  // where that destination is answered (docs/amdp-in-hana.md). It is
  // installed whatever the database is, because the failure a developer needs
  // is "no HANA to run this in", not "unknown destination".
  const {AmdpDestination} = await import("../tools/amdp-destination.mjs");
  abap.context.RFCDestinations["AMDP"] = new AmdpDestination({trace: process.env.STG_AMDP_TRACE === "1"});
  installTraceDestination(abap);
  installStoreDestination(abap);
  if (process.env.STG_DB === "postgres") {
    // The preview returns above and has no PostgreSQL socket. Keep this
    // server-only driver out of its service-worker bundle (as rfc-live does).
    const {OsdPostgresClient, postgresInserts} = await import(/* webpackIgnore: true */ "../tools/postgres-client.mjs");
    db = new OsdPostgresClient({trace: process.env.STG_DB_TRACE === "1"});
    // The upstream client creates a pool before it opens a socket. Verify a
    // real query before publishing the backend's identity to ABAP and status.
    await db.connect();
    abap.context.databaseConnections["DEFAULT"] = traced(db);
    abap.builtin.sy.get().dbsys?.set(db.name);
    if (await db.hasSchema(schemas.pg)) {
      await reseedPackRows(db);
      return;
    }
    await db.beginTransaction();
    try {
      await db.execute(schemas.pg);
      await db.execute(postgresInserts(insert));
      await db.execute(seedStatements());
      await loadScaledData(db, "postgres");
      await db.stamp(schemas.pg);
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
    return;
  }
  // STG_DB=hana: a real HANA, which is the mode the AMDP work runs in -- the
  // procedure and the tables are then in one database and nothing has to be
  // mirrored (docs/amdp-in-hana.md, backlog B.19). Never a default: the cost
  // is per statement and it is 52x on a single-row SELECT, measured in
  // docs/db-backends.md. HANA_SCHEMA picks the schema, default OSD, and it is
  // kept between runs unless STG_DB_FRESH=1.
  if (process.env.STG_DB === "hana") {
    const {HanaDatabaseClient, hanaSchema, hanaInserts} = await import("../tools/hana-client.mjs");
    // Which columns are byte strings is a generation artefact
    // (tools/osd-ddic-binary.mjs writes it into gen/), so it is read from
    // the generation this run belongs to, and only here, the one branch that
    // uses it. A static import made every bundle of this module -- the Bun
    // binary, the preview -- need gen/ at bundle time and froze whatever it
    // held then; the specifier is a variable so no bundler resolves it.
    const ddicBinaryModule = "../gen/osd-ddic-binary.mjs";
    const {ddicBinary} = await import(/* webpackIgnore: true */ ddicBinaryModule);
    db = new HanaDatabaseClient({trace: process.env.STG_DB_TRACE === "1", ddicBinary});
    abap.context.databaseConnections["DEFAULT"] = traced(db);
    await db.connect();
    // Seed once per run, not once per connection. A run opens more than one
    // (the database client, and the AMDP destination holds its own), and both
    // used to build the whole schema. The connection that made the schema
    // fresh is the one that seeds it; every other finds it there.
    if (await db.hasSchema() && db.droppedSchema !== true) {
      await requireCurrentSchema(db, hanaSchema(schemas, ddicBinary), "HANA",
        "Use a fresh HANA_SCHEMA, or explicitly recreate it with STG_DB_FRESH=1");
      // not migrated: a column renamed since is named, not met at a SELECT.
      // `{query: (sql) => db.query(sql)}`, not `db` itself: refuseUnmigratedHana
      // destructures `query` off its first argument and calls it unbound, so
      // passing `db` straight through lost its `this` and died one query in
      // with "Cannot read properties of undefined (reading 'trace')" --
      // found live against a real HANA (a schema this build had already
      // built, hit on the very next connection that did not itself drop it).
      // The DuckDB branch above already gets this right.
      const {refuseUnmigratedHana} = await import("../tools/osd-db-migrate.mjs");
      await refuseUnmigratedHana({query: (sql) => db.query(sql)}, db.schema);
      await reseedExistingHana(db);
      return;
    }
    await db.execute(hanaSchema(schemas, ddicBinary));
    await db.execute(hanaInserts(insert));
    await db.execute(seedStatements());
    await loadScaledData(db, "hana");
    await db.commit();
    return;
  }
  if (process.env.STG_DB === "duckdb") {
    const {DuckDBDatabaseClient, duckdbSchema, duckdbInserts} = await import("../tools/duckdb-client.mjs");
    // Import-time initialization and the host both call setup. Release the
    // predecessor before replacing DEFAULT instead of leaving it to GC.
    await abap.context.databaseConnections["DEFAULT"]?.disconnect();
    // STG_DB_PATH=some.duckdb keeps the data between runs
    db = new DuckDBDatabaseClient({trace: process.env.STG_DB_TRACE === "1", path: process.env.STG_DB_PATH ?? ":memory:"});
    abap.context.databaseConnections["DEFAULT"] = traced(db);
    await db.connect();
    if (process.env.STG_DB_PATH && await db.hasSchema()) {
      await requireCurrentSchema(db, duckdbSchema(schemas), "DuckDB",
        "Use a new STG_DB_PATH after preserving the old file");
      // a file made by an earlier build: the column renames since then are
      // applied before anything reads it, and its views are the running
      // generation's, in one transaction (tools/osd-db-migrate.mjs)
      const {migrateDuckdbFile} = await import("../tools/osd-db-migrate.mjs");
      const migrated = await migrateDuckdbFile({query: (sql) => db.query(sql), execute: (sql) => db.execute(sql)}, duckdbSchema(schemas));
      for (const done of migrated.renamed) {
        console.log(`${process.env.STG_DB_PATH}: renamed ${done}`);
      }
      if (migrated.foreign.length > 0) {
        console.log(`${process.env.STG_DB_PATH}: views this build does not have, left as they are: ${migrated.foreign.join(", ")}`);
      }
      // A persistent database keeps its business rows, but the generated
      // repository catalog must follow the running generation. Otherwise a
      // new BSP page is in the registry while its WWWPARAMS object is absent.
      await upsertGeneratedMetadata(db, insert);
      await reseedPackRows(db);
      return;
    }
    await db.execute(duckdbSchema(schemas));
    await db.execute(duckdbInserts(insert));
    await db.execute(seedStatements());
    await loadScaledData(db, "duckdb");
    await db.commit();
    return;
  }
  // STG_DB=file: a real SQLite file, written while the process runs, WAL
  // (tools/sqlite-file-client.mjs). The rows survive a crash and a recycle,
  // and a second connection can read them. The default path keeps them
  // beside the tree, out of git.
  if (process.env.STG_DB === "file") {
    const {FileSqliteClient, DEFAULT_DATABASE, BASE_DIR, setAsideDatabase} = await import("../tools/sqlite-file-client.mjs");
    const {fingerprintOf, SchemaDrift} = await import("../tools/osd-persist.mjs");
    const {existsSync, renameSync, copyFileSync, mkdirSync} = await import("node:fs");
    const {join, dirname} = await import("node:path");
    const path = process.env.STG_DB_PATH ?? DEFAULT_DATABASE;
    const wanted = fingerprintOf(schemas.sqlite);
    // A base image: this DDIC's schema and mandatory rows, seeded once and
    // kept under .local/db/base/<hash>.sqlite. A database that does not exist
    // yet is a copy of it — milliseconds, and the same bytes every time —
    // and the first instance of a new DDIC seeds and leaves the image behind
    // for the next. This is what makes twenty runtimes over twenty files
    // cheap: each is a copy, and nobody seeds twice.
    //
    // The image is named by the schema *and* the rows that went into it: the
    // generation's mandatory rows (the wwwparams of every SMW0 object) and
    // the seed. Named by the schema alone, an image made before a pack
    // brought a new media object was copied for every later database, and
    // the object was in the generation and not in the table (B.13,
    // 2026-09-17). The stamp inside the file stays the schema's, which is
    // what drift means.
    const seeded = seedStatements();
    const imageOf = fingerprintOf([schemas.sqlite, ...insert, ...seeded]);
    const base = join(BASE_DIR, `${imageOf}.sqlite`);
    if (!existsSync(path) && existsSync(base)) {
      mkdirSync(dirname(path), {recursive: true});
      copyFileSync(base, path);
    }
    db = new FileSqliteClient({trace: process.env.STG_DB_TRACE === "1", path});
    abap.context.databaseConnections["DEFAULT"] = traced(db);
    await db.connect();
    let found = await db.stampedSchema();
    const drift = withSchemaMigrationLock(db.db, () => {
      found = db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'osd_schema'").get()
        ? db.db.prepare("SELECT fingerprint FROM osd_schema LIMIT 1").get()?.fingerprint : undefined;
      if (found === wanted) return false;
      const beforeHandle = beforeAdtHandleDDL(schemas.sqlite);
      const handlePriorWanted = fingerprintOf(beforeHandle);
      const beforeRelease = beforeJobReleaseDDL(beforeHandle);
      const releasePriorWanted = fingerprintOf(beforeRelease);
      const beforeSchedule = beforeJobScheduleDDL(beforeRelease);
      const schedulePriorWanted = fingerprintOf(beforeSchedule);
      const beforeInput = beforeJobStepInputDDL(beforeSchedule);
      const inputPriorWanted = fingerprintOf(beforeInput);
      const beforeEvent = beforeJobEventDDL(beforeInput);
      const eventPriorWanted = fingerprintOf(beforeEvent);
      const beforePredecessor = beforeJobPredecessorDDL(beforeEvent);
      const priorWanted = fingerprintOf(beforePredecessor);
      if (migrateJobIdentityFile(db.db, found, priorWanted, beforePredecessor, fingerprintOf)) found = priorWanted;
      if (migrateJobPredecessorFile(db.db, found, eventPriorWanted, beforeEvent, fingerprintOf)) found = eventPriorWanted;
      if (migrateJobEventFile(db.db, found, inputPriorWanted, beforeInput, fingerprintOf)) found = inputPriorWanted;
      if (migrateJobStepInputFile(db.db, found, schedulePriorWanted, beforeSchedule, fingerprintOf)) found = schedulePriorWanted;
      if (migrateJobScheduleFile(db.db, found, releasePriorWanted, beforeRelease, fingerprintOf)) found = releasePriorWanted;
      if (migrateJobReleaseFile(db.db, found, handlePriorWanted, beforeHandle, fingerprintOf)) found = handlePriorWanted;
      if (migrateAdtHandleFile(db.db, found, wanted, schemas.sqlite, fingerprintOf)) found = wanted;
      // Decide while holding the same lock as the migrations, even when an
      // unstamped database has tables. A pre-lock stamp is only a snapshot.
      return found !== wanted && (found !== undefined ||
        db.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n > 0);
    });
    if (found === wanted) {
      // the rows are already there, made for this DDIC. The tables the
      // generation writes at start (wwwparams: which SMW0 objects exist and
      // what they are called) are the generation's, not the user's, so they
      // follow it: an object a pack added since this file was made is put
      // in, one the pack dropped is taken out.
      await refreshGenerated(db, insert);
      await reseedPackRows(db);
      ensureJobEventMetadata(db.db);
      return;
    }
    if (drift) {
      // a file made for another DDIC, or one nobody stamped: not this
      // instance's data. Moved aside with the schema it was made for in
      // its name, never dropped — the rows may be somebody's
      const said = `${path} was made for schema ${found ?? "nobody recorded which"} and this runtime generates ${wanted}`;
      if (process.env.STG_DB_STRICT === "1") {
        throw new SchemaDrift(`${said}: refusing to touch it (STG_DB_STRICT=1)`);
      }
      await db.disconnect();
      const aside = `${path}.${found ?? "unstamped"}.drift`;
      // the -wal and the -shm go with it: a shared-memory index left behind
      // under the old name is what a later runtime maps and dies on
      setAsideDatabase(path, aside);
      console.log(`${said}: moved to ${aside}, starting with an empty database`);
      db = new FileSqliteClient({trace: process.env.STG_DB_TRACE === "1", path});
      abap.context.databaseConnections["DEFAULT"] = traced(db);
      await db.connect();
    }
    await db.execute(schemas.sqlite);
    await db.execute(insert);
    await db.execute(seeded);
    await loadScaledData(db, "sqlite");
    await db.stamp(schemas.sqlite);
    await db.commit();
    // the image for the next instance, unless scaled data made this one a
    // special case rather than the mandatory rows
    if (!existsSync(base) && !(Number(process.env.STG_DATA_SCALE ?? 0) > 0)) {
      try {
        db.fork(base);
      } catch (error) {
        console.error(`the base image could not be written: ${error?.message ?? error}`);
      }
    }
    ensureJobEventMetadata(db.db);
    return;
  }
  db = installTrim(new SQLiteDatabaseClient());
  abap.context.databaseConnections["DEFAULT"] = traced(db);
  // STG_DB_PATH keeps the rows between runs for SQLite too, which is what
  // a runtime that gets recycled needs: it is read here and written when
  // this process is asked to go away (tools/osd-persist.mjs). Without it
  // the database is in memory and the seed runs every time, as before.
  const {loadInto, saveWhenAsked, stamp} = await import("../tools/osd-persist.mjs");
  // a file made for a different DDIC is not this instance's data, so it is
  // said out loud and built again rather than served as if it fitted
  const restored = await loadInto(db, schemas.sqlite);
  saveWhenAsked(db);
  if (restored === true) {
    await reseedPackRows(db);
    return;
  }
  await db.execute(schemas.sqlite);
  await db.execute(insert);
  await db.execute(seedStatements());
  await loadScaledData(db, "sqlite");
  await stamp(db, schemas.sqlite);
}

// STG_DATA_SCALE=<rows> adds that many synthetic flight facts (tools/gen-data.mjs)
// for the analytical cube; the seeds stay as they are
async function loadScaledData(db, kind) {
  const scale = Number(process.env.STG_DATA_SCALE ?? 0);
  if (scale > 0) {
    const {loadFlightFacts} = await import("../tools/gen-data.mjs");
    await loadFlightFacts(db, scale, kind);
  }
}

// The tables the generation's own INSERTs fill are rewritten from the
// generation on every boot over an existing file: delete what is there for
// each of those tables, insert what the generation says. Nothing else in the
// file is touched.
async function refreshGenerated(db, insert) {
  const statements = Array.isArray(insert) ? insert : String(insert ?? "").split("\n").filter((s) => s.trim() !== "");
  const tables = new Set();
  for (const s of statements) {
    const m = /^INSERT INTO "([^"]+)"/i.exec(s.trim());
    if (m) {
      tables.add(m[1]);
    }
  }
  if (tables.size === 0) {
    return;
  }
  for (const table of tables) {
    await db.execute(`DELETE FROM "${table}";`);
  }
  await db.execute(statements.filter((s) => /^INSERT INTO "/i.test(s.trim())));
  await db.commit();
}

/** Refresh generation-owned repository rows without clearing user tables.
 * DuckDB's persistent mode previously skipped the generated INSERTs entirely
 * after the first boot. Only the object catalog is upserted: trip facts and
 * other application data remain untouched. */
export async function upsertGeneratedMetadata(db, insert) {
  const statements = Array.isArray(insert) ? insert : String(insert ?? "").split("\n").filter((s) => s.trim() !== "");
  const owned = statements
    .filter((s) => /^INSERT INTO "(?:tadir|wwwparams)"/i.test(s.trim()))
    .map((s) => s.replace(/^INSERT INTO/i, "INSERT OR REPLACE INTO"));
  if (owned.length === 0) return;
  await db.execute(owned);
  await db.commit();
}
