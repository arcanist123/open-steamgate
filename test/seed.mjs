// Turns abapGit TABU captures (data/<table>.tabu.json, the format
// `abapGit serialize` writes for table contents) into INSERT statements for
// the transpiler's SQLite schema. CHAR/NUMC values are right-padded to their
// DDIC length because the runtime stores them padded (Character.set pads).
// No abapGit dependency: the JSON is a plain array of row objects.
import {readdirSync, readFileSync} from "node:fs";
import {dataDirsOf, ddicDirsOf, packsOf} from "../tools/osd-packs.mjs";
import {join} from "node:path";

// A field typed by a data element (ROLLNAME) carries no DATATYPE of its
// own in the table's XML: the element's, or its domain's, says what it is.
// Without this the flight pack's /dmo/ dates (ROLLNAME /DMO/FLIGHT_DATE ->
// domain /DMO/DATE, DATS) went in as ISO text cut to eight characters
// ('2027-06-'), so no date of the pack compared equal to anything (R7).
function elementType(rollname, ddicDirs) {
  const read = (name, kind) => {
    const file = `${name.toLowerCase().replace(/\//g, "#")}.${kind}.xml`;
    for (const dir of ddicDirs ?? []) {
      try { return readFileSync(join(dir, file), "utf8"); } catch { /* elsewhere */ }
    }
    return undefined;
  };
  const dtel = read(rollname, "dtel");
  if (dtel === undefined) return {};
  const own = {datatype: /<DATATYPE>([^<]+)</.exec(dtel)?.[1], leng: /<LENG>0*(\d+)</.exec(dtel)?.[1]};
  const domname = /<DOMNAME>([^<]+)</.exec(dtel)?.[1];
  if (own.datatype || domname === undefined) return own;
  const doma = read(domname, "doma");
  if (doma === undefined) return {};
  return {datatype: /<DATATYPE>([^<]+)</.exec(doma)?.[1], leng: /<LENG>0*(\d+)</.exec(doma)?.[1]};
}

function fieldLengths(tablXml, ddicDirs) {
  const lengths = new Map();
  const re = /<DD03P>([\s\S]*?)<\/DD03P>/g;
  let m;
  while ((m = re.exec(tablXml)) !== null) {
    const block = m[1];
    const name = /<FIELDNAME>([^<]+)</.exec(block)?.[1]?.toLowerCase();
    let datatype = /<DATATYPE>([^<]+)</.exec(block)?.[1];
    let leng = /<LENG>0*(\d+)</.exec(block)?.[1];
    const rollname = /<ROLLNAME>([^<]+)</.exec(block)?.[1];
    if (datatype === undefined && rollname !== undefined && rollname !== "MANDT") {
      ({datatype, leng} = elementType(rollname, ddicDirs));
    }
    if (name === undefined) {
      continue;
    }
    if (rollname === "MANDT") {
      lengths.set(name, {pad: 3});
    } else if ((datatype === "CHAR" || datatype === "NUMC") && leng !== undefined) {
      lengths.set(name, {pad: Number(leng)});
    } else if (datatype === "RAW" && leng !== undefined) {
      // a RAW(n) is its 2n hex digits in upper case, 00-padded, as a system
      // holds n bytes (ANOMALY-2026-09-24-raw-columns): abapGit's file may
      // carry fewer, and an equal comparison with a full value would miss
      lengths.set(name, {pad: 0, hex: 2 * Number(leng)});
    } else if (datatype === "DATS") {
      // **The file holds an ISO date and the runtime holds the internal one.**
      // These seed files are abapGit's own TABU JSON -- its data serialiser
      // names the folder, the file and the format -- and abapGit's ajson
      // insists on YYYY-MM-DD for a DATS field: `to_date` matches
      // `^(\d{4})-(\d{2})-(\d{2})(T|$)` and raises "Unexpected date format"
      // otherwise. We used to write 20260915, which is the internal form, so
      // the file looked like abapGit's and was not (A4H refused the import,
      // 2026-09-19). The conversion belongs on this side, in the reader.
      lengths.set(name, {pad: 0, date: true});
    } else {
      lengths.set(name, {pad: 0});
    }
  }
  return lengths;
}

function quote(value, pad, isDate = false, hex = 0) {
  if (typeof value === "number") {
    return String(value);
  }
  let s = String(value ?? "");
  // cut past 2n on purpose: a system holds n bytes and cuts a longer value
  if (hex > 0) s = s.toUpperCase().slice(0, hex).padEnd(hex, "0");
  if (isDate) {
    // ISO in the file, internal in the database; anything else is left as it
    // is, so a value that is already internal still works
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso !== null) s = iso[1] + iso[2] + iso[3];
  }
  if (pad > 0) {
    s = s.padEnd(pad, " ");
  }
  return "'" + s.replaceAll("'", "''") + "'";
}

/** abapGit's file name for a table and the name the database holds it under.
 *
 * A slash cannot be in a file name, so a namespaced table is `#dmo#travel`
 * in a seed file and `/dmo/travel` in the SQL: the runtime's
 * `buildDbTableName` lowercases and quotes the ABAP name, it does not rename
 * it. packs/rap-flight was the first pack with namespaced tables. */
export const dbTableName = (table) => (table.includes("#") ? table.replaceAll("#", "/") : table);

// A later layer owns the entire table, including when its capture is empty.
// Resolve owners once so fresh seeding and reseeding choose identical rows.
function ownedTables(root) {
  const owners = new Map();
  for (const dir of dataDirsOf(root)) {
    for (const file of readdirSync(dir).sort()) {
      if (file.endsWith(".tabu.json")) owners.set(file.slice(0, -".tabu.json".length).toLowerCase(), dir);
    }
  }
  return owners;
}

// Every table is inserted from its final owner only.
// Called with a folder it seeds only that one, which is what the tools do.
export function seedStatements(dataDir, ddicDir) {
  if (dataDir !== undefined) {
    return seedFrom(dataDir, [ddicDir ?? "src/ddic", "src/segw/ddic", "src/zosd_test/ddic"]);
  }
  const root = process.env.OSD_ROOT ?? process.cwd();
  const ddic = ddicDirsOf(root);
  const owners = ownedTables(root);
  return dataDirsOf(root).flatMap((dir) => seedFrom(dir, ddic, owners));
}

// A pack owns every table named by its TABU captures. On an existing DB,
// replace those tables' rows from the current captures at every start.
export async function reseedPackRows(db) {
  const root = process.env.OSD_ROOT ?? process.cwd();
  const owners = ownedTables(root);
  const packDirs = new Set(packsOf(root).map((pack) => pack.data).filter(Boolean));
  const ddic = ddicDirsOf(root);
  const tables = [...owners.keys()].filter((table) => packDirs.has(owners.get(table))).map(dbTableName);
  let missing = [];
  if (db.missingTables) {
    missing = await db.missingTables(tables);
  } else if (db.select) {
    const result = await db.select({select: "SELECT name FROM sqlite_master WHERE type = 'table'"});
    const present = new Set(result.rows.map((row) => String(row.name).toLowerCase()));
    missing = tables.filter((table) => !present.has(table));
  }
  const absent = new Set(missing.map((table) => String(table).toLowerCase()));
  for (const [table, dir] of owners) {
    const dbTable = dbTableName(table);
    if (!/^[a-z0-9_/]+$/i.test(dbTable)) throw new Error(`invalid seed table ${table}`);
    if (packDirs.has(dir) && !absent.has(dbTable)) await db.execute(`DELETE FROM "${dbTable}";`);
  }
  for (const dir of dataDirsOf(root)) {
    if (packDirs.has(dir)) await db.execute(seedFrom(dir, ddic, owners, absent));
  }
}

function seedFrom(dataDir, ddicDirs, owners, absent = new Set()) {
  const statements = [];
  for (const file of readdirSync(dataDir).sort()) {
    if (!file.endsWith(".tabu.json")) {
      continue;
    }
    const table = file.slice(0, -".tabu.json".length).toLowerCase();
    if (owners && owners.get(table) !== dataDir) continue;
    const dbTable = dbTableName(table);
    if (absent.has(dbTable)) continue;
    const rows = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
    let lengths = new Map();
    for (const dir of ddicDirs) {
      try {
        lengths = fieldLengths(readFileSync(join(dir, table + ".tabl.xml"), "utf8"), ddicDirs);
        break;
      } catch {
        // table defined elsewhere or in a lib: insert unpadded, the runtime pads on read
      }
    }
    // **One statement per batch of rows, not per row.**
    //
    // Measured by fable-osd's SQL trace over `npm run unit`: 4706 of 6793
    // statements and 553 ms of 1563 went into three tables seeded a row at a
    // time, and 2263 of the seeder's own 2521 statements were one table.
    // A multi-row `VALUES` is the same insert on all three engines, and the
    // cost of a statement here is its parse, not its rows.
    //
    // Batched by **the column list**, not by the table: two rows of one table
    // can carry different columns (a TABU JSON row omits what it has no value
    // for), and merging those would put a value under the wrong name. So a
    // batch ends when the shape changes, which also keeps the order the file
    // had -- rows of one table are inserted in the order they are written,
    // and a pack's rows still land after the ones they layer over.
    let batch = [];
    let shape;
    const flush = () => {
      if (batch.length === 0) return;
      statements.push(`INSERT INTO "${dbTable}" (${shape.map((c) => `"${c}"`).join(", ")}) VALUES ` +
        `${batch.map((v) => `(${v.join(", ")})`).join(", ")};`);
      batch = [];
    };
    for (const row of rows) {
      const cols = Object.keys(row);
      if (shape === undefined || cols.length !== shape.length || cols.some((c, i) => c !== shape[i])) {
        flush();
        shape = cols;
      }
      batch.push(cols.map((c) => quote(row[c], lengths.get(c)?.pad ?? 0, lengths.get(c)?.date === true, lengths.get(c)?.hex ?? 0)));
      // a bound on the statement rather than on the row count: engines differ
      // on how long a statement may be, and none of them differ on this being
      // far inside it
      if (batch.length >= 500) flush();
    }
    flush();
  }
  return statements;
}
