// The database statements of the osgo fast path (osg-build.mjs
// osgiDatabase), per object, so a fast build splices in the re-lowered
// objects' rows: part of the per-object front-end cache, README
// tools/gogen/osgo-incr.md. Carved out of osgo-incr.mjs (the size rule).
import {createRequire} from "node:module";
import {readFileSync, renameSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {core} from "./frontend-inventory.mjs";
import {sealCache} from "./osgo-incr-meta.mjs";

const upper = (text) => String(text).toUpperCase();
const keyOf = (type, name) => `${type} ${name}`;

const require2 = createRequire(import.meta.url);
/** the per-object statement lists DatabaseSetup produces, attributed so a
 *  fast build can splice in the re-lowered objects' rows. The write side
 *  checks the reconstruction against the real run before caching.
 *  `only` builds the contributions of those object keys alone. */
export function dbContributions(reg, only) {
  const {SQLiteDatabaseSchema} = require2("@abaplint/transpiler/build/src/db/schema_generation/sqlite_database_schema.js");
  const {PopulateTables} = require2("@abaplint/transpiler/build/src/db/populate_tables.js");
  const {CDSDatabaseView} = require2("@abaplint/transpiler/build/src/db/cds_database_view.js");
  const schema = new SQLiteDatabaseSchema(reg), populate = new PopulateTables(reg), cds = new CDSDatabaseView(reg);
  const order = [], tabl = new Map(), view = new Map(), cdsViews = new Map(), inserts = new Map();
  for (const obj of reg.getObjects()) {
    const key = keyOf(obj.getType(), upper(obj.getName()));
    if (only !== undefined && !only.has(key)) continue;
    if (!order.includes(key)) order.push(key);
    if (!inserts.has(key)) inserts.set(key, []);
    const add = (statement) => { if (statement.length > 0) inserts.get(key).push(statement); };
    try {
      if (obj instanceof core.Objects.Table && obj.getTableCategory() === core.Objects.TableCategory.Transparent) tabl.set(key, schema.buildTABL(obj).trim());
      else if (obj instanceof core.Objects.View) view.set(key, schema.buildVIEW(obj).trim());
      else if (obj instanceof core.Objects.DataDefinition) {
        const built = cds.build(obj);
        if (built !== undefined) cdsViews.set(key, built);
      }
    } catch { /* the real run fails the same way; the write-time check catches a difference */ }
    try {
      add(populate.insertTADIR(obj));
      if (obj instanceof core.Objects.MessageClass) for (const s of populate.insertT100(obj)) add(s);
      else if (obj instanceof core.Objects.WebMIME) for (const s of populate.insertWWWPARAMS(obj)) add(s);
      else if (obj instanceof core.Objects.Class || obj instanceof core.Objects.Interface || obj instanceof core.Objects.Program) {
        add(populate.insertREPOSRC(obj));
        if (obj instanceof core.Objects.Class || obj instanceof core.Objects.Interface) {
          for (const s of populate.insertSEOSUBCO(obj)) add(s);
          for (const s of populate.insertSEOSUBCODF(obj)) add(s);
          for (const s of populate.insertSEOSUBCOTX(obj)) add(s);
        }
      }
    } catch { /* as above */ }
  }
  let tail = "";
  try { tail = populate.insertT000(); } catch { /* none */ }
  return {order, tabl, view, cdsViews, inserts, tail};
}

const at = (store, key) => store instanceof Map ? store.get(key) : store?.[key];

/** the flat statement lists of `run()`, in its order, out of the per-object
 *  contributions, with `fresh` (the contributions of the fresh registry,
 *  which cover the re-lowered objects) substituted per object key */
export function dbFlat(cached, fresh) {
  const of = (kind, key) => {
    const mine = fresh && at(fresh[kind], key);
    if (mine !== undefined) return mine;
    return at(cached[kind], key);
  };
  const schemas = [];
  for (const key of cached.order) { const s = of("tabl", key); if (s !== undefined) schemas.push(s); }
  for (const key of cached.order) { const s = of("view", key); if (s !== undefined) schemas.push(s); }
  for (const key of cached.order) { const s = of("cdsViews", key); if (s !== undefined) schemas.push(s); }
  const insert = [];
  for (const key of cached.order) {
    const mine = fresh && at(fresh.inserts, key);
    insert.push(...(mine ?? at(cached.inserts, key) ?? []).filter((s) => s.length > 0));
  }
  if (cached.tail && cached.tail.length > 0) insert.push(cached.tail);
  return {schemas, insert};
}

/** the database record of a generation's cache: `db.json` beside index.json,
 *  and then the stamp that makes the generation usable (osgo-incr-meta.mjs) */
export function dbCacheWrite(dir, contributions) {
  const file = join(dir, "db.json"), temp = `${file}.${process.pid}.pending`;
  writeFileSync(temp, JSON.stringify({order: contributions.order,
    tabl: Object.fromEntries(contributions.tabl), view: Object.fromEntries(contributions.view),
    cdsViews: Object.fromEntries(contributions.cdsViews),
    inserts: Object.fromEntries([...contributions.inserts].map(([k, v]) => [k, v])), tail: contributions.tail}));
  renameSync(temp, file);
  sealCache(dir);
}

/** @returns {object | undefined} the recorded contributions, or undefined */
export function dbCacheRead(dir) {
  try { return JSON.parse(readFileSync(join(dir, "db.json"), "utf8")); } catch { return undefined; }
}
