#!/usr/bin/env node
// The seed capture of packs/rap-flight: run the scenario's own data generator
// once in the transpiled runtime and write what it made into the pack's
// data/ folder as abapGit TABU JSON, the format every pack's seed rows have
// (test/seed.mjs reads them at start).
//
//   npm run transpile                      # the generator and its tables
//   node tools/rap-flight/seed-capture.mjs [--out packs/rap-flight/data]
//
// The rows are generator output and so are NOT tracked (the licence decision
// of 2026-11-09: derived SAP content stays out of the repository). A build
// makes them whenever the inputs the generator reads changed: it asks
// seedsDue() in its own process and, when the answer is yes, starts this
// script as a child with --ensure and the output of the generation it just
// made (tools/osd-build.mjs makePackSeeds); the hand run above is for
// refreshing them on purpose. The generator is random where the scenario is: the master data
// (agencies, airports, connections, the status pairs) comes out the same
// every run, and the transactional counts do not -- a capture's counts are
// one run's, which is how docs/rap-flight-pack.md labels them.
//
// Boots the runtime of a generation the caller names -- output/ of the live
// one for a hand run, the one the build just made when the build calls this
// (its --output, which under --no-switch is not the live one) -- on a
// database of its own (throwawayDatabase below), and runs
// ZCL_OSD_RAPFLIGHT_SEED=>RUN inside one dialog step -- committed when it
// returns, rolled back if it dumps (tools/osd-dialog-step.mjs) -- and then
// selects every table the generator fills. Dates come out as the internal
// YYYYMMDD and go into the file as YYYY-MM-DD, which is what abapGit's own
// serialiser writes and what test/seed.mjs converts back.
import {createHash} from "node:crypto";
import {mkdirSync, writeFileSync, readFileSync, existsSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {dialogStep} from "../osd-dialog-step.mjs";
import {runsAs} from "../osd-main.mjs";
import {markerOf, SEEDS_MARKER} from "../osd-packs.mjs";

// the tables the generator writes, in the order a reader expects them
export const TABLES = [
  "/dmo/airport", "/dmo/carrier", "/dmo/connection", "/dmo/flight",
  "/dmo/agency", "/dmo/customer",
  "/dmo/supplcat", "/dmo/supplcat_t", "/dmo/supplement", "/dmo/suppl_text",
  "/dmo/travel", "/dmo/booking", "/dmo/book_suppl",
  "/dmo/trvl_stat", "/dmo/trvl_stat_t", "/dmo/oall_stat", "/dmo/oall_stat_t",
  "/dmo/book_stat", "/dmo/book_stat_t",
  "/dmo/travel_m", "/dmo/booking_m", "/dmo/booksuppl_m",
  // the overlay's stand-ins for I_Currency (R7) and I_Country (R10),
  // filled by the seed class
  "i_currency", "i_country",
];

/** abapGit's file name for a namespaced table: /dmo/travel -> #dmo#travel.tabu.json */
export const fileOf = (table) => table.toLowerCase().replace(/\//g, "#") + ".tabu.json";

/** the DATS columns of a table, read off its abapGit XML, so the file can carry ISO dates */
export function dateColumns(tablXml) {
  const out = new Set();
  for (const m of tablXml.matchAll(/<DD03P>([\s\S]*?)<\/DD03P>/g)) {
    const name = /<FIELDNAME>([^<]+)</.exec(m[1])?.[1]?.toLowerCase();
    const datatype = /<DATATYPE>([^<]+)</.exec(m[1])?.[1];
    const rollname = /<ROLLNAME>([^<]+)</.exec(m[1])?.[1]?.toUpperCase();
    if (name && (datatype === "DATS" || /_DATE$|^BEGIN_DATE$|^END_DATE$|^FLIGHT_DATE$|^BOOKING_DATE$/.test(rollname ?? ""))) out.add(name);
  }
  return out;
}

/** one row as the file holds it: trimmed strings, ISO dates, numbers as numbers */
export function fileRow(row, dates) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.toLowerCase();
    if (typeof v === "string") {
      const t = v.replace(/\s+$/, "");
      out[key] = dates.has(key) && /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t;
    } else {
      out[key] = v;
    }
  }
  return out;
}

export async function capture({root = process.cwd(), out = join("packs", "rap-flight", "data"), output = join(root, "output"), log = console.log} = {}) {
  const from = (file) => import(pathToFileURL(resolve(root, output, file)).href);
  const {initializeABAP} = await from("init.mjs");
  await initializeABAP();
  const {zcl_osd_rapflight_seed} = await from("zcl_osd_rapflight_seed.clas.mjs");
  const started = performance.now();
  const lines = await dialogStep(() => zcl_osd_rapflight_seed.run(), "rap-flight seed");
  for (const line of lines.array()) log(`  ${line.get()}`);
  const counts = await zcl_osd_rapflight_seed.counts();
  log(`seed-capture: ${counts.get()} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  const client = globalThis.abap.context.databaseConnections.DEFAULT;
  mkdirSync(resolve(root, out), {recursive: true});
  const written = [];
  for (const table of TABLES) {
    const xml = tablXmlOf(root, table);
    const dates = xml ? dateColumns(xml) : new Set();
    const rows = ((await client.select({select: `SELECT * FROM "${table}"`})).rows ?? []).map((r) => fileRow(r, dates));
    const file = join(out, fileOf(table));
    writeFileSync(resolve(root, file), "[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n");
    written.push({table, rows: rows.length, file});
    log(`seed-capture: ${table}: ${rows.length} rows -> ${file}`);
  }
  return {counts: counts.get(), written};
}

function tablXmlOf(root, table) {
  const name = table.toLowerCase().replace(/\//g, "#") + ".tabl.xml";
  for (const dir of ["packs/rap-flight/upstream/legacy", "packs/rap-flight/upstream/managed", "packs/rap-flight/upstream/reuse",
    "packs/rap-flight/upstream/reuse/agency", "packs/rap-flight/upstream/reuse/supplement", "packs/rap-flight/upstream/reuse/carrier"]) {
    const p = resolve(root, dir, name);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return undefined;
}

// The overlay files the generator reads (its own two classes and the seed
// class that drives it), the upstream commit and this script: what a capture
// is a function of. The marker beside the rows names the digest of these, so
// a checkout that fetched a new commit or edited the overlay rebuilds its
// seed without being asked and a reviewer can tell rows from their source.
const SEED_INPUTS = [
  "src/#dmo#cl_flight_data_generator.clas.abap",
  "src/#dmo#cl_flight_data_generator.clas.locals_imp.abap",
  "src/#dmo#cl_data_generator_managed.clas.abap",
  "src/zcl_osd_rapflight_seed.clas.abap",
  "src/zcl_osd_rapflight_seed.clas.locals_imp.abap",
];

export function seedInputsDigest(root) {
  const pack = join(root, "packs", "rap-flight");
  const manifest = JSON.parse(readFileSync(join(pack, "osd-pack.json"), "utf8"));
  const hash = createHash("sha256");
  // the commit the fetch actually holds, not the ref the manifest names: a
  // ref that is a branch can bring a new commit under the same name
  hash.update(markerOf(pack).upstream?.commit ?? manifest.sources?.[0]?.ref ?? "");
  hash.update(readFileSync(new URL(import.meta.url), "utf8"));
  for (const file of SEED_INPUTS) {
    const path = join(pack, file);
    if (!existsSync(path)) {
      throw new Error(`packs/rap-flight: the overlay no longer carries ${file}, so the seed cannot be made from it`);
    }
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

/** A capture is due when the pack is here and fetched, but its rows are
 *  missing or were made from other inputs. The build asks this in its own
 *  process (importing this module costs no runtime boot) and starts the
 *  capture child only when the answer is yes. */
export function seedsDue(root = process.cwd()) {
  const pack = join(root, "packs", "rap-flight");
  if (existsSync(join(pack, "osd-pack.json")) === false || existsSync(join(pack, "upstream")) === false) {
    return false; // no pack here, or not fetched: the build itself says so
  }
  const digest = seedInputsDigest(root);
  try {
    const marker = JSON.parse(readFileSync(join(pack, "data", SEEDS_MARKER), "utf8"));
    if (marker.digest === digest && TABLES.every((t) => existsSync(join(pack, "data", fileOf(t))))) {
      return false;
    }
  } catch { /* no marker yet, or rows missing: a capture is due */ }
  return true;
}

/** The build's path (`--ensure`): make the pack's seed rows when they are
 *  due, in the pack's own data/ folder (not tracked), from the output of the
 *  generation it names. Returns whether it captured. */
export async function ensurePackSeeds(root = process.cwd(), log = console.log, {output} = {}) {
  if (seedsDue(root) === false) {
    return false;
  }
  const pack = join(root, "packs", "rap-flight");
  log("rap-flight seed: the generator's rows are made at build (not tracked), running it");
  const {counts} = await capture({root, log, output});
  mkdirSync(join(pack, "data"), {recursive: true});
  writeFileSync(join(pack, "data", SEEDS_MARKER),
    JSON.stringify({digest: seedInputsDigest(root), counts, at: new Date().toISOString()}, null, 2) + "\n");
  return true;
}

// The runtime the capture boots is written into and thrown away: what it
// keeps is the JSON files, nothing in that database outlives the child. So
// the child never runs on the database configuration it inherited, whatever
// started it -- the process that asked for a build may itself be serving a
// persistent DuckDB file, which DuckDB locks for its lifetime and refuses
// every other process, and an inherited STG_DB_PATH alone would have the
// capture read somebody's live rows and write them back on its way out
// (tools/osd-persist.mjs saves on exit). With both gone the runtime's own
// default is an in-memory SQLite, which is the scratch pad this wants.
// Cleared here, in the child, and not at the spawn site: three roads lead
// into this file (the build's child, a compiled binary's `gen`, a hand run)
// and this is the one place they share -- and the build imports the module
// in its own process to ask seedsDue(), a process that must not have its
// environment edited from under it.
function throwawayDatabase() {
  delete process.env.STG_DB;
  delete process.env.STG_DB_PATH;
}

if (runsAs("seed-capture.mjs")) {
  throwawayDatabase();
  const value = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const output = value("--output") === undefined ? undefined : resolve(value("--output"));
  const work = value("--ensure") === undefined
    ? capture({out: value("--out"), output}) // the hand run: refresh on purpose
    : ensurePackSeeds(process.cwd(), console.log, {output}); // the build's child
  work.then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
