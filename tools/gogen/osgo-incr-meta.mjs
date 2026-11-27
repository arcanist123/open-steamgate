// The completeness of one generation of the osgo per-object front-end cache:
// the stamp written last, and the whole-metadata check a fast build makes
// before it reuses anything. Part of tools/gogen/osgo-incr.mjs (README
// tools/gogen/osgo-incr.md), carved out of it (the size rule).
//
// A generation is written in three steps by two callers: the recorder's
// finish (the entries, index.json), then osgDatabase (db.json, once it has
// proved the per-object statements equal the real run). A build interrupted
// between them, or one whose statements did not attribute, leaves an index
// without a database record; a later fast build that took the index then
// died in osgDatabase with no full-build retry. So the stamp `complete.json`
// is written last, over the digests of both files, and removed first when a
// generation is written again; a fast build accepts the cache only with the
// stamp, both digests matching, and both files of the shape it walks.
import {createHash} from "node:crypto";
import {readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const STAMP = "complete.json";

/** remove the stamp: what is written now is not complete yet */
export function unsealCache(dir) {
  rmSync(join(dir, STAMP), {force: true});
}

/** write the stamp over the index and the database record as they are now */
export function sealCache(dir) {
  const file = join(dir, STAMP), temp = `${file}.${process.pid}.pending`;
  writeFileSync(temp, JSON.stringify({index: sha(readFileSync(join(dir, "index.json"))), db: sha(readFileSync(join(dir, "db.json")))}));
  renameSync(temp, file);
}

const str = (v) => typeof v === "string";
const num = (v) => typeof v === "number" && Number.isFinite(v);
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v, item = () => true) => Array.isArray(v) && v.every(item);
const strs = (v) => arr(v, str);
const values = (v, item) => obj(v) && Object.values(v).every(item);
const strOrNull = (v) => v === null || str(v);

/** the shape of one entry of index.entries, as the reader walks it */
const validEntry = (e) => obj(e) && strs(e.deps) && strs(e.reads) && strs(e.pushed) && strs(e.anonRefs)
  && typeof e.broken === "boolean" && typeof e.portable === "boolean" && obj(e.files)
  && (e.digest === undefined || str(e.digest)) && (e.regFiles === undefined || values(e.regFiles, str))
  && (e.super === undefined || strOrNull(e.super)) && (e.depsKnown === undefined || typeof e.depsKnown === "boolean");

/** why index.json is not of the shape the reader walks, or undefined */
export function indexProblem(x) {
  if (!obj(x)) return "it is not an object";
  const checks = {
    schema: str(x.schema), tool: str(x.tool), folders: strs(x.folders), objects: strs(x.objects), order: strs(x.order),
    segments: arr(x.segments, (s) => Array.isArray(s) && s.length === 3 && str(s[0]) && Number.isInteger(s[1]) && s[1] >= 0 && (s[2] === 0 || s[2] === 1)),
    strayLayoutOk: typeof x.strayLayoutOk === "boolean", ctorDefaults: strs(x.ctorDefaults),
    anonNamed: values(x.anonNamed, strOrNull), anonReach: values(x.anonReach, (by) => values(by, num)),
    straySlots: values(x.straySlots, strs), classes: arr(x.classes, (c) => Array.isArray(c) && c.length === 2 && strOrNull(c[0]) && str(c[1])),
    entries: values(x.entries, validEntry), broken: strs(x.broken), supers: values(x.supers, strOrNull), wanted: strs(x.wanted),
    cdsViews: obj(x.cdsViews), diagnostics: strs(x.diagnostics),
    rtti: obj(x.rtti) && arr(x.rtti.structs) && arr(x.rtti.known) && arr(x.rtti.classSupers),
    ownership: arr(x.ownership, (o) => Array.isArray(o) && str(o[0]) && obj(o[1]) && arr(o[1].names)),
    aliased: strs(x.aliased), registryOrder: strs(x.registryOrder), includeTests: strs(x.includeTests), allPortable: typeof x.allPortable === "boolean",
  };
  const bad = Object.entries(checks).find(([, ok]) => !ok);
  if (bad) return `its ${bad[0]} is not of the recorded shape`;
  // every object of the sequences has an entry the reader can load
  const missing = [...x.order, ...x.segments.map((s) => s[0])].find((k) => !Object.hasOwn(x.entries, k));
  if (missing !== undefined) return `${missing} is in its sequence but has no entry`;
  return undefined;
}

/** why db.json is not of the shape dbFlat walks, or undefined */
export function dbProblem(x) {
  if (!obj(x)) return "it is not an object";
  if (!strs(x.order) || !values(x.tabl, str) || !values(x.view, str) || !values(x.cdsViews, str)
      || !values(x.inserts, strs) || !str(x.tail)) return "it is not of the recorded shape";
  return undefined;
}

/**
 * The metadata of one generation, accepted as a whole or not at all.
 * @returns {{ok: true, index: any, db: any} | {ok: false, reason: string}}
 */
export function readSealedCache(dir, gen) {
  let indexBytes;
  try { indexBytes = readFileSync(join(dir, "index.json")); } catch { return {ok: false, reason: `no per-object cache of the live generation ${gen}`}; }
  const incomplete = (why) => ({ok: false, reason: `the per-object cache of generation ${gen} is incomplete or damaged (${why})`});
  let stamp, dbBytes;
  try { stamp = JSON.parse(readFileSync(join(dir, STAMP), "utf8")); } catch { return incomplete("no completion stamp: the build that wrote it did not finish its database record"); }
  try { dbBytes = readFileSync(join(dir, "db.json")); } catch { return incomplete("no database record"); }
  if (!obj(stamp) || stamp.index !== sha(indexBytes) || stamp.db !== sha(dbBytes)) return incomplete("the stamp does not match its files");
  let index, db;
  try { index = JSON.parse(indexBytes.toString("utf8")); } catch { return incomplete("index.json does not parse"); }
  try { db = JSON.parse(dbBytes.toString("utf8")); } catch { return incomplete("db.json does not parse"); }
  const why = indexProblem(index);
  if (why !== undefined) return incomplete(`index.json: ${why}`);
  const dbWhy = dbProblem(db);
  if (dbWhy !== undefined) return incomplete(`db.json: ${dbWhy}`);
  return {ok: true, index, db};
}
