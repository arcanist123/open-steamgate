// A base image for the in-memory SQLite database: the schema, the
// generation's mandatory rows and the seed rows, made once and then loaded
// as bytes. A start without STG_DB_PATH used to run all three every time --
// 0.4 s on main's CI runners, 1.1 s once packs/rap-flight brought 12 MB of
// seed rows (4.8 MB of INSERTs) -- and test hosts start a runtime about a
// hundred times per CI run. Loading the 20 MB image takes about 10 ms.
//
// STG_DB=file has had the same idea since B.13 (test/setup.mjs, BASE_DIR);
// this is the memory database's version of it.
//
// **The name is everything the stored rows are made from, read as content.**
// The DDL and the mandatory rows as handed over; every seed file and table
// definition the seeder reads (*.tabu.json in the data folders, *.tabl.xml
// in the DDIC folders); and the code between those inputs and the stored
// values (PIPELINE: the seeder with its padding and date conversion, the
// setup path that runs it, the literal normalisation every statement goes
// through, the SQLite client and its connection setup, and the versions of
// the SQLite engine packages). A change to any of them is another name, and
// a name that is not there is seeded the old way and written for the next
// start. Rows written after setup (demo data, the cross-reference) are not
// in the image and are made by the current code on every start.
//
// The code is read from the tree, so the image is only used where the tree
// is the code that runs: never inside a compiled binary, whose bundled
// seeder need not match the files beside it.
//
// **An image is trusted only after it proves itself.** The last thing
// written before the export is a stamp in the database header
// (PRAGMA user_version, which nothing else here uses); a load checks it and
// PRAGMA quick_check before answering yes, and takes the stamp out again so
// the database it hands over is the one a fresh seed makes. Anything else --
// an empty file, a truncated one, bytes that are not a database, a database
// made for another key -- is a miss: the file is removed, the half-opened
// connection closed, and the start seeds as before.
//
// OSD_SEED_IMAGE=0 turns it off; scaled data (STG_DATA_SCALE) never uses it.
// The folder keeps the newest KEEP images; temporary files a killed writer
// left behind are removed once they are an hour old.
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {dirname, isAbsolute, join} from "node:path";
import {dataDirsOf, ddicDirsOf} from "./osd-packs.mjs";
import {compiled, hosted} from "./osd-host.mjs";

const SEED_INPUT = /\.(tabu\.json|tabl\.xml)$/;
const KEEP = 8;
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

/** the code that decides what a seeded database holds, relative to the root */
export const PIPELINE = [
  "test/seed.mjs",
  "test/setup.mjs",
  "tools/osd-seed-image.mjs",
  "tools/osd-packs.mjs",
  "tools/sql-literals.mjs",
  "tools/sqlite-heap-client.mjs",
  "tools/sqlite-connection.mjs",
  "node_modules/@abaplint/database-sqlite/package.json",
  "node_modules/sql.js/package.json",
];

/** throws when a pipeline file is missing: then there is no key and no image */
export function seedImageKey(root, schema, insert) {
  const hash = createHash("sha256").update("osd-seed-image/2\0").update(String(schema)).update("\0");
  for (const statement of Array.isArray(insert) ? insert : [insert]) hash.update(String(statement)).update("\0");
  for (const file of PIPELINE) hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
  for (const dir of [...dataDirsOf(root), "--ddic--", ...ddicDirsOf(root)]) {
    hash.update(dir).update("\0");
    let files;
    try { files = readdirSync(dir).sort(); } catch { continue; }
    for (const file of files) {
      if (SEED_INPUT.test(file)) hash.update(file).update("\0").update(readFileSync(join(dir, file))).update("\0");
    }
  }
  return hash.digest("hex").slice(0, 24);
}

// the header stamp: 31 bits of the key, never 0 (a fresh database's value)
const stampOf = (key) => (parseInt(key.slice(0, 8), 16) & 0x7fffffff) || 1;

const pragma = (db, sql) => db.sqlite.exec(sql)[0]?.values?.[0]?.[0];

/** load(db) -> true when a sound image was loaded; save(db) after seeding */
export function seedImage(schema, insert, env = process.env) {
  if (env.OSD_SEED_IMAGE === "0" || Number(env.STG_DATA_SCALE ?? 0) > 0) return undefined;
  if (compiled || hosted()) return undefined;
  const root = env.OSD_ROOT ?? process.cwd();
  let key, file;
  try {
    key = seedImageKey(root, schema, insert);
    const base = env.STG_DB_BASE ?? join(".local", "db", "base");
    file = join(isAbsolute(base) ? base : join(root, base), `heap-${key}.sqlite`);
  } catch {
    return undefined;
  }
  const stamp = stampOf(key);
  return {
    file,
    async load(db) {
      if (existsSync(file) === false) return false;
      try {
        await db.connect(readFileSync(file));
        if (pragma(db, "PRAGMA user_version") !== stamp) throw new Error("not stamped for this key");
        if (pragma(db, "PRAGMA quick_check") !== "ok") throw new Error("quick_check failed");
        db.sqlite.exec("PRAGMA user_version = 0");
        return true;
      } catch (error) {
        try { db.sqlite?.close(); } catch { /* the half-opened connection is dropped either way */ }
        db.sqlite = undefined;
        rmSync(file, {force: true});
        console.error(`the seed image ${file} was not usable (${error?.message ?? error}); seeding instead`);
        return false;
      }
    },
    save(db) {
      // stamped last, written beside its final name and renamed: another
      // start reading the image never sees half of one
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(file), {recursive: true});
        db.sqlite.exec(`PRAGMA user_version = ${stamp}`);
        let bytes;
        try { bytes = db.export(); } finally { db.sqlite.exec("PRAGMA user_version = 0"); }
        writeFileSync(temporary, Buffer.from(bytes));
        renameSync(temporary, file);
        prune(dirname(file), file);
      } catch (error) {
        rmSync(temporary, {force: true});
        console.error(`the seed image could not be written: ${error?.message ?? error}`);
      }
    },
  };
}

/** keep the newest KEEP images (and the one just written); drop stale temporaries */
export function prune(dir, keep, now = Date.now()) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("heap-")) continue;
    const path = join(dir, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (name.endsWith(".tmp")) {
      if (now - stat.mtimeMs > STALE_TEMPORARY_MS) rmSync(path, {force: true});
    } else if (name.endsWith(".sqlite")) {
      entries.push({path, at: stat.mtimeMs});
    }
  }
  entries.sort((a, b) => b.at - a.at);
  for (const {path} of entries.slice(KEEP)) if (path !== keep) rmSync(path, {force: true});
}
