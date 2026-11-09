// The edit cycle of osgo, measured (docs/osgo-fast-rebuild.md): edit one
// string literal in a class body, rebuild the way a user does (the
// transpile, then tools/gogen/osgo.mjs), stop the running binary, start the
// new one, wait until /osd/serving answers with the new generation. Prints a
// phase table per run and the median per phase.
//
//   node tools/gogen/osgo-cycle.mjs [--runs 3] [--unlayered] [--fast] [--gocache warm|cold]
//        [--file src/demo/zcl_zstg_demo_dpc_ext.clas.abap] [--port 8091] [--json out.json]
//
// --fast rebuilds with `osgo.mjs --fast` alone (osgo-fast.mjs): the Node
// build runs inside it only when the edit is not a class body edit; the prime
// is always a full build, so the edits start from a live generation.
//
// Heavy: run it under the shared lock. Before the first edit it builds once
// unedited (the prime, not counted), so a warm run starts from a build of the
// clean tree as a developer's does. In the layered build the first edit of a
// class moves it from package app to package main (osgo-layers.mjs), which
// recompiles app once; it is reported apart ("first edit") from the edits
// after it. --gocache cold gives every build an empty GOCACHE (the module
// cache stays). The edited file is restored however the run ends.
import {execFileSync, spawn} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {home} from "./home.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
const runs = Number(value("--runs", "3"));
const unlayered = args.includes("--unlayered");
const fast = args.includes("--fast");
const gocache = value("--gocache", "warm");
const file = resolve(home, value("--file", "src/demo/zcl_zstg_demo_dpc_ext.clas.abap"));
const port = Number(value("--port", "8091"));
const jsonOut = value("--json");
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
if (!["warm", "cold"].includes(gocache)) throw new Error("--gocache must be warm or cold");
const LITERAL = /'Key TravelId missing[^']*'/;
const original = readFileSync(file, "utf8");
if (!LITERAL.test(original)) throw new Error(`${file}: the literal this cycle edits ('Key TravelId missing') is not there; pass a --file that has it`);

const ms = (t0) => Math.round(performance.now() - t0);
const scratch = mkdtempSync(join(tmpdir(), "osgo-cycle-"));
let server;

function run(cmd, argv, env = {}) {
  const t0 = performance.now();
  try {
    execFileSync(cmd, argv, {cwd: home, stdio: ["ignore", "pipe", "pipe"], env: {...process.env, ...env}, maxBuffer: 1 << 28});
  } catch (e) {
    throw new Error(`${cmd} ${argv.join(" ")} failed:\n${String(e.stdout ?? "").split("\n").slice(-15).join("\n")}\n${String(e.stderr ?? "").split("\n").slice(-15).join("\n")}`);
  }
  return ms(t0);
}

/** compile and link times of a go build out of its -debug-trace */
function goTrace(path) {
  const out = {compileMs: {}, linkMs: 0, packagesCompiled: 0};
  if (!existsSync(path)) return out;
  // a Chrome trace array, which go may leave unterminated
  const text = readFileSync(path, "utf8").trim().replace(/^\[/, "").replace(/\]$/, "").replace(/,\s*$/, "");
  let events;
  try { events = JSON.parse(`[${text}]`); } catch (e) { console.error(`osgo-cycle: ${path} unreadable (${e.message}); no compile/link split`); return out; }
  const open = new Map();
  for (const e of events) {
    const name = String(e.name ?? "");
    const m = /^Executing action \((build|link) (.+)\)$/.exec(name);
    if (!m) continue;
    let dur;
    if (e.ph === "X") dur = e.dur / 1000;
    else if (e.ph === "B") { open.set(`${e.tid}:${name}`, e.ts); continue; }
    else if (e.ph === "E") { const ts = open.get(`${e.tid}:${name}`); if (ts === undefined) continue; dur = (e.ts - ts) / 1000; }
    else continue;
    if (m[1] === "link") out.linkMs += Math.round(dur);
    else {
      out.packagesCompiled++;
      const pkg = m[2].startsWith("osg/gogen/generated/osgo/") ? m[2].slice("osg/gogen/generated/osgo/".length)
        : m[2] === "osg/gogen/cmd/osgo" || m[2] === "main" ? "main" : "other";
      out.compileMs[pkg] = (out.compileMs[pkg] ?? 0) + Math.round(dur);
    }
  }
  return out;
}

async function waitServing(generation, t0) {
  for (;;) {
    if (server.exitCode !== null) throw new Error(`osgo exited ${server.exitCode} before it served; see ${join(scratch, "osgo.log")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/osd/serving`);
      if (r.ok) {
        const body = await r.json();
        if (body.ready && body.generation === generation) return ms(t0);
        if (body.ready) throw new Error(`/osd/serving names ${body.generation}, the build wrote ${generation}`);
      }
    } catch (e) { if (/names/.test(e.message)) throw e; }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function stop() {
  if (!server || server.exitCode !== null) return 0;
  const t0 = performance.now();
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
  return ms(t0);
}

async function start(generation) {
  const t0 = performance.now();
  const homeDir = mkdtempSync(join(scratch, "home-"));
  const log = join(scratch, "osgo.log");
  server = spawn(join(home, "tools/gogen/.out/osgo"), ["-adt", "-port", String(port), "-root", home, "-home", homeDir],
    {cwd: home, stdio: ["ignore", "ignore", "ignore"], env: {...process.env, OSD_BIND: "127.0.0.1"}});
  writeFileSync(log, `pid ${server.pid}\n`);
  return waitServing(generation, t0);
}

async function build(label) {
  const env = gocache === "cold" ? {GOCACHE: mkdtempSync(join(scratch, "gocache-"))} : {};
  const trace = join(scratch, `trace-${label}.json`);
  const row = {run: label};
  const viaFast = fast && label !== "prime";
  if (!viaFast) row.transpile = run("node", ["tools/osd-build.mjs"]);
  const t0 = performance.now();
  run("node", ["tools/gogen/osgo.mjs", ...(unlayered ? ["--unlayered"] : []), ...(viaFast ? ["--fast"] : [])], {...env, OSGO_GO_TRACE: trace});
  row["osgo.mjs"] = ms(t0);
  const facts = JSON.parse(readFileSync(join(home, "tools/gogen/.out/osgo-phases.json"), "utf8"));
  Object.assign(row, facts.phases);
  const t = goTrace(trace);
  for (const [pkg, v] of Object.entries(t.compileMs)) row[`compile ${pkg}`] = v;
  row.link = t.linkMs;
  row["go build actions"] = t.packagesCompiled;
  if (env.GOCACHE) rmSync(env.GOCACHE, {recursive: true, force: true});
  const status = readFileSync(join(home, "tools/gogen/go/cmd/osgo/zz_status.go"), "utf8");
  row.generation = /const buildGeneration = "([^"]+)"/.exec(status)?.[1];
  row.layers = facts.layers?.classes;
  if (viaFast) row.fast = facts.fast?.ok === true ? "fast" : `full: ${facts.fast?.reason}`;
  return row;
}

const rows = [];
try {
  console.error(`osgo-cycle: ${unlayered ? "unlayered" : "layered"}${fast ? ", fast path" : ""}, GOCACHE ${gocache}, ${runs} edit runs of ${file}`);
  const prime = await build("prime");
  prime.restart = await start(prime.generation);
  console.error(`prime: ${JSON.stringify(prime)}`);
  // the layered build pays the move of the edited class into package main
  // once; that first edit is run and reported apart from the rest
  const total = unlayered ? runs : runs + 1;
  for (let i = 1; i <= total; i++) {
    writeFileSync(file, original.replace(LITERAL, `'Key TravelId missing (osgo-cycle ${process.pid}-${i})'`));
    const t0 = performance.now();
    const row = await build(!unlayered && i === 1 ? "first edit" : `edit ${unlayered ? i : i - 1}`);
    // a run that fell back to the full build would count as a fast one and
    // inflate the median without a word: the measurement is refused
    if (fast && row.fast !== "fast") throw new Error(`osgo-cycle: ${row.run} did not take the fast path (${row.fast}); the measurement is refused`);
    row.stop = await stop();
    row.restart = await start(row.generation);
    row["edit to serving"] = ms(t0);
    rows.push(row);
    console.error(JSON.stringify(row));
  }
} finally {
  writeFileSync(file, original);
  await stop();
  rmSync(scratch, {recursive: true, force: true});
}

const counted = rows.filter((r) => r.run.startsWith("edit"));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2); };
const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => rows.some((r) => typeof r[k] === "number"));
const table = [`| phase (ms) | ${rows.map((r) => r.run).join(" | ")} | median of edits |`, `| --- | ${rows.map(() => "---:").join(" | ")} | ---: |`];
for (const k of keys) table.push(`| ${k} | ${rows.map((r) => r[k] ?? "").join(" | ")} | ${median(counted.map((r) => r[k] ?? 0))} |`);
console.log(`osgo-cycle: ${unlayered ? "unlayered" : "layered"} build${fast ? ", fast path" : ""}, GOCACHE ${gocache}, ${new Date().toISOString()}`);
console.log(table.join("\n"));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({unlayered, fast, gocache, rows}, null, 1) + "\n");
