// The cross-reference tables, filled on every host, by one module.
//
// **Decided 2026-09-24 (Alice, AGENDA.md):** sources stay files in abapGit
// shape plus git; database tables hold only DERIVED indices such as the
// cross-reference, rebuilt from the files per generation and never edited.
// So nothing here reads the tables back to merge with them: a seed replaces
// every row of CROSS, WBCROSSGT, WBCROSSGTX and D010INC with what the files
// say, and a second seed of the same files is the same four tables.
//
// Why a module and not a line in each host: the end-of-dialog-step rule was
// written once, correctly, next to its one caller, and the two hosts written
// after it did not copy it (CLAUDE.md, "A rule written once..."). Until this
// file the cross-reference had the same shape one step worse: it was written
// by nobody but a person running `osd-xref.mjs --write`, into git-ignored
// seed files, so every host started with four empty tables and vsp's
// where-used and graph tools, which read them over freestyle SQL, saw nothing.
//
// The callers, all through the functions below:
//
//   test/start.mjs (inline)   seedAtStartup(client, {root})
//   tools/osd-serve.mjs       seedAtStartup(client, {root}) -- also the
//                             binary's `osd serve`, which the workbench and
//                             `osd up` start
//   tools/osd-data.mjs        seedAtStartup, when it boots a runtime of its own
//   scripts/build-preview.mjs rows(root) at build time, into the bundle
//   web/preview-backend.mjs   applyRows(client, rows) -- a service worker has
//                             no files to parse
//   OSGo (tools/gogen/osgo.mjs on spike/go-backend) rows(root) and
//                             insertStatements(rows) at build time
//
// The API:
//
//   await rows(root, {cache})   -> {CROSS: [...], WBCROSSGT, WBCROSSGTX, D010INC}
//                                  rows with upper-case field names, unpadded.
//                                  The parse costs ~3 s on the full tree, so
//                                  the answer is kept per generation in
//                                  build/xref/<key>.json (cache: false skips
//                                  it; cacheKey(root) says which generation)
//   insertStatements(rows)      -> SQL strings: one DELETE per table, then
//                                  multi-row INSERTs, CHAR padded to its DDIC
//                                  length the way the seed pads it; a row
//                                  with a value longer than its column is
//                                  left out (overlong(rows) names them)
//   await applyRows(client, rows)  runs them on a DatabaseClient in one
//                                  transaction; returns the counts + refused.
//                                  Refuses a connection with a transaction
//                                  already open: a seed is not part of an LUW
//   await seedAtStartup(client, {root, say})  rows + applyRows, reported;
//                                  never throws, returns the counts or undefined
//
// The four tables are client-independent (no MANDT in src/osd/ddic/*.tabl.xml,
// as on a system), so no row carries a client.
//
// This file is bundled into the preview's service worker, so it imports
// nothing at the top: the parse (abaplint, node:fs) is loaded inside rows()
// only, and webpack is told to leave that import alone.

/** the four tables, in the order they are written, as the database names them */
export const TABLES = ["CROSS", "WBCROSSGT", "WBCROSSGTX", "D010INC"];

/** the CHAR/NUMC widths of src/osd/ddic/<table>.tabl.xml; test/xref-seed.mjs
 *  holds this against the XML so the two cannot drift apart */
export const WIDTHS = {
  CROSS: {TYPE: 1, NAME: 30, INCLUDE: 40},
  WBCROSSGT: {OTYPE: 2, NAME: 120, INCLUDE: 40},
  WBCROSSGTX: {OTYPE: 2, NAME: 120, INCLUDE: 40},
  D010INC: {MASTER: 40, INCLUDE: 40, OBSOLETE_IN_VERSION: 4},
};

// what the cache key carries besides the generation: bump it when what
// tools/osd-xref.mjs derives changes and the tree does not
const DERIVATION = "xref-1";
// how many generations' rows build/xref keeps, this one included
const KEEP = 8;

/** The rows the files say. */
export async function rows(root = process.cwd(), options = {}) {
  const fs = await import(/* webpackIgnore: true */ "node:fs");
  const path = await import(/* webpackIgnore: true */ "node:path");
  const key = options.cache === false || options.only !== undefined ? undefined : await cacheKey(root);
  const dir = path.join(root, "build", "xref");
  const file = key === undefined ? undefined : path.join(dir, `${key}.json`);
  if (file !== undefined && fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8"));
      // a torn, foreign or empty file is a miss, not an answer: `{}` read as
      // rows would empty all four tables and call that a seed
      if (wellFormed(cached)) return cached;
    } catch {
      // unreadable: a miss
    }
  }
  const {CrossReference} = await import(/* webpackIgnore: true */ "./osd-xref.mjs");
  const {ObjectStore} = await import(/* webpackIgnore: true */ "./osd-store.mjs");
  const store = new ObjectStore({root});
  const tables = new CrossReference(store).build(options.only).tables();
  const out = {
    CROSS: tables.cross,
    WBCROSSGT: tables.wbcrossgt,
    WBCROSSGTX: tables.wbcrossgtx,
    D010INC: tables.d010inc,
  };
  if (file !== undefined) {
    try {
      fs.mkdirSync(dir, {recursive: true});
      // written aside and renamed, so a second process starting at the same
      // moment reads a whole file or none
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, file);
      // the last few generations' answers, not only the newest: a tree goes
      // back to a generation it was on -- a test creates an object and
      // deletes it, a branch is checked out and back -- and each return
      // used to parse the whole tree again (~5 s alone, 21.6 s on vsp-i7
      // under load, inside every recycle's boot). A `.tmp` is somebody's
      // write in flight unless it is old enough to be the leftover of a
      // writer that died.
      // Pruned after the write, so writers missing at once cannot leave more.
      const kept = [];
      for (const old of fs.readdirSync(dir)) {
        const full = path.join(dir, old);
        try {
          if (old.endsWith(".json")) kept.push({full, at: fs.statSync(full).mtimeMs});
          else if (old.endsWith(".tmp") && Date.now() - fs.statSync(full).mtimeMs > 10 * 60 * 1000) fs.rmSync(full, {force: true});
        } catch {
          // gone meanwhile: another process's prune
        }
      }
      kept.sort((a, b) => b.at - a.at || (a.full < b.full ? -1 : 1));
      for (const {full} of kept.slice(KEEP)) fs.rmSync(full, {force: true});
    } catch {
      // a tree that cannot be written to still gets its rows
    }
  }
  return out;
}

/** four arrays of rows carrying the columns of their table, as strings */
export function wellFormed(tables) {
  if (tables === null || typeof tables !== "object") return false;
  return TABLES.every((t) => Array.isArray(tables[t]) && tables[t].every((row) =>
    row !== null && typeof row === "object" && Object.keys(WIDTHS[t]).every((c) => typeof row[c] === "string")));
}

/** Which generation the rows belong to. Everything the parse reads, and the
 *  code that parses:
 *
 *  - the build's hash of its inputs (tools/osd-build.mjs hashOf: the
 *    folders, the libraries, the config, the transpiler, the generators);
 *  - **`gen/` by content** (genHash). hashOf leaves `gen/` out on purpose --
 *    for the build it is an output -- but the object store parses it, so a
 *    key without it filed the rows of a tree before `transpile` under the
 *    same name as the tree after it, and served them (found by review);
 *  - the derivation: tools/osd-xref.mjs and what it imports, by content.
 *    In the binary those files are not on disk and the binary's own
 *    identity, already inside hashOf, stands for them.
 *
 *  Undefined where there is no tree to hash, which only costs the cache. */
// options.hash names another generation of this tree than its own hash (the
// osgo fast path asks for the live generation's rows, tools/gogen/osgo-fast.mjs)
export async function cacheKey(root, options = {}) {
  try {
    const {hashOf, genHash, generatorClosure} = await import(/* webpackIgnore: true */ "./osd-build.mjs");
    const {hosted} = await import(/* webpackIgnore: true */ "./osd-host.mjs");
    const {createHash} = await import(/* webpackIgnore: true */ "node:crypto");
    const {readFileSync} = await import(/* webpackIgnore: true */ "node:fs");
    const {fileURLToPath} = await import(/* webpackIgnore: true */ "node:url");
    const h = createHash("sha256");
    h.update(DERIVATION).update("\0").update(options.hash ?? hashOf(root)).update("\0").update(genHash(root)).update("\0");
    if (!hosted()) {
      // `tools` is for the test that proves a change to the derivation
      // moves the key, over a copy of this folder
      const tools = options.tools ?? fileURLToPath(new URL(".", import.meta.url));
      for (const f of generatorClosure(tools, [["osd-xref.mjs"], ["osd-xref-seed.mjs"]])) {
        h.update(f.slice(tools.length)).update("\0").update(readFileSync(f)).update("\0");
      }
    }
    return h.digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

const quote = (value, width = 0) => `'${String(value ?? "").padEnd(width, " ").replaceAll("'", "''")}'`;

/** A row with a value longer than its column. Refused, not cut: a name cut
 *  to the width is another name, and a where-used that answers for the
 *  wrong object is worse than one that says it left a row out. */
export function overlong(tables) {
  const out = [];
  for (const table of TABLES) {
    for (const row of tables[table] ?? []) {
      const column = Object.entries(WIDTHS[table]).find(([c, w]) => String(row[c] ?? "").length > w);
      if (column !== undefined) out.push({table, column: column[0], row});
    }
  }
  return out;
}

/** The rows as SQL: every table emptied, then filled. Emptying first is what
 *  makes a restart, a second host on the same database file, or a stored
 *  browser database restored under a new build all end in the same rows.
 *  Rows `overlong` names are left out. */
export function insertStatements(tables, options = {}) {
  const batch = options.batch ?? 500;
  const refused = new Set(overlong(tables).map((o) => o.row));
  const out = [];
  for (const table of TABLES) {
    const widths = WIDTHS[table];
    const columns = Object.keys(widths);
    const owners = options.only?.map(o => quote(o.name.toUpperCase(), 40));
    const ownerColumn = table === "D010INC" ? "master" : "include";
    out.push(`DELETE FROM "${table.toLowerCase()}"${owners === undefined ? "" : ` WHERE "${ownerColumn}" IN (${owners.join(", ")})`};`);
    const list = (tables[table] ?? []).filter((row) => !refused.has(row));
    for (let i = 0; i < list.length; i += batch) {
      const values = list.slice(i, i + batch)
        .map((row) => `(${columns.map((c) => quote(row[c], widths[c])).join(", ")})`);
      out.push(`INSERT INTO "${table.toLowerCase()}" (${columns.map((c) => `"${c.toLowerCase()}"`).join(", ")}) VALUES ${values.join(", ")};`);
    }
  }
  return out;
}

/** Run them on the eleven-method DatabaseClient every host already holds,
 *  as one transaction: the DELETEs and the INSERTs land together or not at
 *  all, so a failed INSERT leaves the previous rows rather than half of the
 *  new ones under a log line saying nothing was seeded. Every client of
 *  test/setup.mjs has beginTransaction / commit / rollback (the interface
 *  requires them). */
export async function applyRows(client, tables, options = {}) {
  if (options.only?.length === 0) return {...counts(tables), refused: []};
  // **Outside an LUW, or not at all.** beginTransaction() on every client
  // is a no-op when a transaction is already open, so inside somebody's LUW
  // the COMMIT below would commit their work with ours and a ROLLBACK would
  // take theirs back. A seed runs at start, before any dialog step; one
  // that finds a transaction open is a caller in the wrong place.
  if (inTransaction(client)) {
    throw new Error("the cross-reference is seeded outside an LUW, and this connection has one open");
  }
  // optional, so a client that only records statements (OSGo's build does)
  // can take them too
  await client.beginTransaction?.();
  try {
    for (const sql of insertStatements(tables, options)) {
      await client.execute(sql);
    }
    await client.commit?.();
  } catch (e) {
    await client.rollback?.();
    throw e;
  }
  const refused = overlong(tables);
  const n = counts(tables);
  for (const {table} of refused) n[table] -= 1;
  return {...n, refused};
}

/** Whether a DatabaseClient has a transaction open. The SQLite, DuckDB,
 *  DuckDB-wasm and HANA clients keep `inTransaction`; the PostgreSQL client
 *  holds a checked-out `client` for exactly as long as one is open. */
export function inTransaction(client) {
  return client.inTransaction === true || (client.pool !== undefined && client.client !== undefined);
}

export const counts = (tables) => Object.fromEntries(TABLES.map((t) => [t, (tables[t] ?? []).length]));

/** What a host with a tree does at start. Loud and not fatal: the tables
 *  are an index for tools, and a system that cannot build its index still
 *  serves -- but it says so, because four empty tables read as "nobody uses
 *  this" to every tool that asks them. */
export async function seedAtStartup(client, options = {}) {
  const say = options.say ?? ((line) => console.log(line));
  try {
    const started = Date.now();
    const tables = await rows(options.root ?? process.cwd(), options);
    const n = await applyRows(client, tables);
    if (options.quiet !== true) {
      say(`cross-reference: ${TABLES.map((t) => `${t} ${n[t]}`).join(", ")} (${Date.now() - started} ms)`);
    }
    // said even when quiet: a row left out is a where-used that is short
    for (const {table, column, row} of n.refused) {
      say(`cross-reference: ${table} row left out, ${column} longer than its column: ${JSON.stringify(row)}`);
    }
    return n;
  } catch (e) {
    say(`cross-reference not seeded: ${e?.message ?? e}. Where-used and the graph tools will see empty tables.`);
    return undefined;
  }
}

/** Derive selected rows from the exact registry the warm transpiler used.
 * No disk reads, registry invalidation or whole-tree parse. */
export async function rowsFromRegistry(registry, only) {
  const {CrossReference} = await import(/* webpackIgnore: true */ "./osd-xref.mjs");
  const tables = new CrossReference(undefined, registry).build(only).tables();
  return {CROSS: tables.cross, WBCROSSGT: tables.wbcrossgt,
    WBCROSSGTX: tables.wbcrossgtx, D010INC: tables.d010inc};
}

/** Replace selected rows supplied by the compiler, under the swap lock. */
export async function refreshAfterSwap(client, tables, only) {
  if (!Array.isArray(only) || !wellFormed(tables)) {
    throw new Error("the warm swap requires cross-reference rows from its compiler build view");
  }
  return applyRows(client, tables, {only});
}
