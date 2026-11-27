// Native cold insertion order, without reparsing the kept objects.
const key = o => `${o.getType()} ${o.getName()}`;

// The bases a DDIC view XML names, as the file states them: DD25V's VIEWNAME
// for the view's own name, every DD26V TABNAME for what it reads (repeated
// per field in DD27P, which says the same names). A UI5 view of the same file
// suffix states no VIEWNAME and names nothing.
function viewBases(files) {
  const bases = new Map();
  for (const f of files) {
    if (typeof f?.filename !== "string" || !f.filename.toLowerCase().endsWith(".view.xml")) continue;
    const name = /<VIEWNAME>([^<]+)<\/VIEWNAME>/.exec(f.contents ?? "")?.[1];
    if (name === undefined) continue;
    const tabs = new Set();
    for (const m of (f.contents ?? "").matchAll(/<TABNAME>([^<]+)<\/TABNAME>/g)) {
      tabs.add(m[1].toUpperCase());
    }
    bases.set(name.toUpperCase(), tabs);
  }
  return bases;
}

// The DDL the transpiler writes for a view over a view reaches the database
// in registry order (its own db/index.js: "todo: what if the view is based on
// another view?"), and the first namespaced consumption view of a pack sorts
// before the interface view it reads (/dmo/c_connection_r before
// /dmo/i_connection_r). SQLite checks a view's bases at first read and lets
// that pass; DuckDB checks at CREATE and refuses ("Catalog Error: Table with
// name ... does not exist"), which is every DuckDB start dead, node and
// Wasm. The registry is ours to feed, so the order is ours to fix: a view
// waits until every base of its own that is a view has been named. A base
// that is a table never makes a view wait -- the DDL creates every table
// before the first view -- and nothing that is not a view moves at all.
// A cycle cannot be ordered; the waiting views then keep their rank order.
// Measured with the pinned toolchain, the failure that follows is not a
// database's: the type resolver overflows its stack first (RangeError in
// View.parseType / DDIC.lookupView) before any DDL is emitted, so no error
// names the cycle's views. ANORMALIES, 2026-11-09; upstream needs an issue.
function viewsAfterWhatTheyRead(objects, bases) {
  if (bases.size === 0) return objects;
  const isView = o => o.getType() === "VIEW";
  const viewNames = new Set(objects.filter(isView).map(o => o.getName().toUpperCase()));
  const reads = new Map();
  for (const o of objects) {
    if (!isView(o)) continue;
    const name = o.getName().toUpperCase();
    const viewsRead = [...(bases.get(name) ?? [])].filter(b => viewNames.has(b) && b !== name);
    if (viewsRead.length > 0) reads.set(name, new Set(viewsRead));
  }
  if (reads.size === 0) return objects;
  const out = [];
  const named = new Set();
  let waiting = [];
  for (const o of objects) {
    if (!isView(o)) { out.push(o); continue; }
    const name = o.getName().toUpperCase();
    const wants = reads.get(name);
    if (wants === undefined || [...wants].every(b => named.has(b))) {
      out.push(o);
      named.add(name);
    } else {
      waiting.push(o);
    }
  }
  while (waiting.length > 0) {
    const rest = [];
    for (const o of waiting) {
      const wants = reads.get(o.getName().toUpperCase());
      if ([...wants].every(b => named.has(b))) {
        out.push(o);
        named.add(o.getName().toUpperCase());
      } else {
        rest.push(o);
      }
    }
    if (rest.length === waiting.length) { out.push(...rest); break; }
    waiting = rest;
  }
  return out;
}

// A help view (DD25V VIEWCLASS H) has no database object on a system: its
// search helps read it as a join (tools/segw-shlp.mjs). Given to the
// transpiler it became a CREATE VIEW over its DD28J rows -- a help view
// has none, its joins are foreign keys -- whose columns name tables its
// FROM lacks: SQLite takes it and fails on a read, an engine that checks
// at CREATE fails the schema (ANORMALIES 2026-11-14-help-view-schema). So
// it leaves the registry before the run, on every path that runs one: the
// cold transpile, the warm compiler's kept registry and the warm verifier
// all order their registry here (a cold/warm difference failed the warm
// premise, PR #952 critic MUST-1). The names go back.
export function dropHelpViews(reg, core) {
  const dropped = [];
  // the registry's own objects, not an earlier ordering's snapshot
  delete reg.getObjects;
  for (const obj of [...reg.getObjects()]) {
    if (!(obj instanceof core.Objects.View)) continue;
    obj.parseXML?.();
    if (obj.parsedData?.header?.VIEWCLASS !== "H") continue;
    for (const file of obj.getFiles()) reg.removeFile(file);
    dropped.push(obj.getName());
  }
  return dropped.sort();
}

/** orders the registry as the cold transpiler would, after dropping its
 *  help views; returns the names dropped */
export function orderRegistry(reg, core, files, libs = []) {
  const dropped = dropHelpViews(reg, core);
  // Let the same Registry used by the cold transpiler admit and group files.
  // In particular, tadir.json creates no object and must not move the library's
  // TADIR table ahead of T000/T100. Filename-derived ranks missed that rule.
  const sources = [...files];
  const library = [...libs];
  const cold = new core.Registry();
  for (const f of sources) cold.addFile(new core.MemoryFile(f.filename, f.contents));
  for (const f of library) cold.addDependency(new core.MemoryFile(f.filename, f.contents));
  const rank = new Map([...cold.getObjects()].map((o, i) => [key(o), i]));
  // Discard an earlier iterator's snapshot after membership has changed.
  delete reg.getObjects;
  const ordered = [...reg.getObjects()].sort((a, b) =>
    (rank.get(key(a)) ?? Infinity) - (rank.get(key(b)) ?? Infinity));
  const bases = viewBases([...sources, ...library]);
  reg.getObjects = function* () { yield* viewsAfterWhatTheyRead(ordered, bases); };
  return dropped;
}
