import {append} from "./append.ts";
import {funcName, writeGo, refreshSymbolBuild} from "./symbols.ts";
// ABAP Unit on gogen. Test includes are compiled only for selected owners.
// Results are JSON rows: {class, testclass, method, status, message}.
import {spawnSync} from "node:child_process";
import {appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {availableParallelism} from "node:os";
import {dirname, join, resolve} from "node:path";
import {performance} from "node:perf_hooks";
import {fileURLToPath} from "node:url";
import {runnerCacheOptions} from "./runner-cache.mjs";
import {prepareRunnerCache, finishRunnerCache} from "./runner-cache-recording.mjs";
import {compileProgram} from "./frontend.mjs";
import {referencedClasses} from "./emit-go.mjs";
import {callsIn, planLayers, writeLayers} from "./go-layers.mjs";
import {reconcile, killedGoTool, markBuildFailure} from "./unit-results.mjs";
import {home} from "./home.mjs";
import {cacheLocation, frontendInputs, readFrontendCache, writeFrontendCache} from "./frontend-cache.mjs";
import {unitInputs} from "./unit-inputs.mjs";
import {processTimeout, runUnit} from "./unit-process.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const commandStarted = performance.now();
const args = process.argv.slice(2);
const values = (flag) => args.flatMap((x, i) => x === flag ? [args[i + 1]] : []);
const jobsText = values("--jobs")[0];
const jobs = jobsText === undefined ? Math.min(availableParallelism(), 16) : Number(jobsText);
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 256) throw new Error("--jobs must be an integer from 1 to 256");
const selected = new Set(values("--class").map((x) => x.toUpperCase()));
const out = resolve(values("--out")[0] ?? join(here, ".out", "unit"));
const fixture = values("--fixture")[0];
const extraInputs = values("--input").map((folder) => {
  if (!folder || folder.startsWith("--")) throw new Error("--input needs a directory");
  return resolve(folder);
});
const config = JSON.parse(readFileSync(join(home, "abap_transpile.json"), "utf8"));
const skipped = new Set((config.options?.skip ?? config.skip ?? []).map((s) =>
  `${s.object}/${s.class}/${s.method}`.toUpperCase()));
const walk = (dir) => !existsSync(dir) ? [] : readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const {sources, folders, libDirs, skip, overrides} = unitInputs({home, config, fixture, extraInputs, extraPacks: !args.includes("--no-extra-packs")});
for (const o of overrides) console.error(`Override ${o.object}: ${o.input} hides ${o.hidden}`);
const owners = [...new Set(sources.map((f) => f.split("/").at(-1).replace(/\.clas\.testclasses\.abap$/, "").replaceAll("#", "/").toUpperCase()))]
  .filter((o) => selected.size === 0 || selected.has(o));
if (selected.size && owners.length !== selected.size) throw new Error(`unknown test owner: ${[...selected].filter((x) => !owners.includes(x)).join(", ")}`);
// One bad generated method must not hide every other owner's verdict. Keep
// this sequential: cmd/unit is the compiler's scratch package, and the Go
// runtime has process-global class constructors.
if (args.includes("--per-owner") && !selected.size && !fixture) {
  const rows = [];
  const cacheCounts = {hit: 0, miss: 0, bypass: 0};
  const timingMs = {frontendClosureRounds: [], emit: 0, goBuild: 0, run: 0};
  // the child's test processes plus a minute for its frontend and Go build
  const perOwnerTimeout = processTimeout() + 60000;
  for (const owner of owners) {
    const child = spawnSync("node", [join(here, "unit.mjs"), "--class", owner, "--unlayered", ...(args.includes("--no-extra-packs") ? ["--no-extra-packs"] : []), ...(args.includes("--no-cache") ? ["--no-cache"] : []), "--jobs", String(jobs), "--out", join(out, owner.toLowerCase()), ...extraInputs.flatMap((folder) => ["--input", folder])], {
      cwd: home, encoding: "utf8", timeout: perOwnerTimeout, maxBuffer: 20e6, env: process.env,
    });
    if (!child.stdout) {
      rows.push({class: owner, source: "harness", status: "NOT_COMPILED", message: child.stderr || child.error?.message || `exit ${child.status}`});
      continue;
    }
    try {
      const result = JSON.parse(child.stdout);
      append(rows, result.rows);
      if (result.cache?.status in cacheCounts) cacheCounts[result.cache.status]++;
      append(timingMs.frontendClosureRounds, result.timingMs?.frontendClosureRounds ?? []);
      for (const phase of ["emit", "goBuild", "run"]) timingMs[phase] += result.timingMs?.[phase] ?? 0;
    }
    catch { rows.push({class: owner, source: "harness", status: "NOT_COMPILED", message: child.stderr || "invalid child result"}); }
  }
  const compiled = owners.filter((owner) => {
    const own = rows.filter((r) => r.class === owner);
    return own.some((r) => r.status === "SUCCESS" || r.status === "FAILED")
      && own.every((r) => r.status !== "NOT_COMPILED");
  });
  console.log(JSON.stringify({classes: owners.length, compiled: compiled.length, rows, timingMs, overrides,
    cache: {status: cacheCounts.miss ? "miss" : cacheCounts.hit ? "hit" : "bypass", reason: "per-owner snapshots", counts: cacheCounts}}));
  process.exit(rows.some((r) => r.status === "FAILED") ? 1 : rows.some((r) => r.status === "NOT_COMPILED" || r.status === "NEEDS_DB") ? 2 : 0);
}
mkdirSync(out, {recursive: true});
const runDir = mkdtempSync(join(out, "run-"));
const goDir = join(runDir, "go");
const timingMs = {frontendClosureRounds: [], emit: 0, goBuild: 0, run: 0};
const cacheRoot = cacheLocation(home);
const cacheEnabled = !args.includes("--no-cache");
const cacheInputs = cacheEnabled ? frontendInputs({home, folders, owners, fixture, unlayered: args.includes("--unlayered")}) : null;
// not the osgo build's generated packages (osgo-layers.mjs): large, and no
// unit build imports them
cpSync(join(here, "go"), goDir, {recursive: true, filter: (src) => src !== join(here, "go", "generated", "osgo")});
const cacheMeta = cacheEnabled ? readFrontendCache(cacheRoot, cacheInputs.key, goDir) : null;
const cache = {status: !cacheEnabled ? "bypass" : cacheMeta ? "hit" : "miss",
  reason: !cacheEnabled ? "--no-cache" : cacheMeta ? "inputs unchanged" : existsSync(cacheRoot) ? "inputs changed or no matching snapshot" : "cache empty",
  key: cacheInputs?.key};
let program, rows, ready, groups, layerInfo, writeGeneratedGo;
if (cacheMeta) {
  refreshSymbolBuild(goDir);
  rows = cacheMeta.rows;
  layerInfo = cacheMeta.layers;
  ready = rows.filter((x) => x.status === "READY");
  groups = [...Map.groupBy(ready, (r) => `${r.class}:${r.testclass}`)].map(([key, methods]) => ({key, methods}));
  timingMs.discovery = Math.round(performance.now() - commandStarted);
} else {
const available = new Set(folders.flatMap(walk).filter((f) => !skip(f) && /\.(clas|intf)\.abap$/.test(f))
  .map((f) => f.split("/").at(-1).split(".")[0].replaceAll("#", "/").toUpperCase()));
const sourceByName = new Map(folders.flatMap(walk).filter((f) => !skip(f) && /\.clas\.abap$/.test(f))
  .map((f) => [f.split("/").at(-1).split(".")[0].replaceAll("#", "/").toUpperCase(), f]));
const objectByName = new Map(folders.flatMap(walk).filter((f) => !skip(f) && /\.(clas|intf)\.abap$/.test(f))
  .map((f) => [f.split("/").at(-1).split(".")[0].replaceAll("#", "/").toUpperCase(), f]));
const typeFileByName = new Map(folders.flatMap(walk).filter((f) => !skip(f) && /\.(tabl|ttyp|dtel|doma)\.xml$/.test(f))
  .map((f) => [f.split("/").at(-1).split(".")[0].replaceAll("#", "/").toUpperCase(), f]));

// Grow from actual compiled references, not every object in a library. The
// registry sees the entire library, so an omitted class remains typeable.
let wanted = new Set([...owners, "CL_ABAP_UNIT_ASSERT", "KERNEL_CX_ASSERT"]);
const sourceQueue = [...wanted];
while (sourceQueue.length) {
  const name = sourceQueue.shift();
  const file = sourceByName.get(name);
  if (!file) continue;
  const testFile = owners.includes(name) ? sources.find((f) => f.split("/").at(-1).startsWith(name.toLowerCase().replaceAll("/", "#") + ".")) : undefined;
  const contents = readFileSync(file, "utf8") + (testFile ? "\n" + readFileSync(testFile, "utf8") : "");
  for (const ref of contents.matchAll(/(?<![A-Z0-9_/])(?:\/[A-Z0-9_]+\/)?(?:ZCL|ZCX|CL|CX)_[A-Z0-9_]+\b/gi)) {
    const target = ref[0].toUpperCase();
    if (available.has(target) && !wanted.has(target)) { wanted.add(target); sourceQueue.push(target); }
  }
}
let registry;
const session = {};
const calledBy = new WeakMap();
const runnerCache = prepareRunnerCache(folders, runnerCacheOptions(home));
const objectCacheOptions = runnerCache.options;
timingMs.frontendClosureCounts = [];
for (let round = 0; round < 12; round++) {
  const started = performance.now();
  program = compileProgram({...objectCacheOptions, folders, objects: [...wanted], tolerant: true, includeTests: new Set(owners), skip, registry, session});
  registry = program.reg;
  const refs = new Set([...referencedClasses(program), ...program.missing]);
  for (const name of wanted) {
    const sup = program.reg.getObject("CLAS", name)?.getDefinition()?.getSuperClass();
    if (sup) refs.add(sup.toUpperCase());
  }
  for (const c of program.classes) {
    // a class the session reused is the same IR object as last round
    let found = calledBy.get(c);
    if (!found) {
      found = new Set(c.super ? [c.super] : []);
      for (const m of c.methods) callsIn(m.body, found);
      calledBy.set(c, found);
    }
    for (const x of found) refs.add(x);
  }
  const more = [...refs].filter((x) => available.has(x) && !wanted.has(x) && !x.includes(":"));
  timingMs.frontendClosureRounds.push(Math.round(performance.now() - started));
  timingMs.frontendClosureCounts.push({...program.frontendCounts, added: more.length, selected: wanted.size});
  if (!more.length) break;
  for (const x of more) wanted.add(x);
  if (round === 11) throw new Error(`dependency closure did not settle: ${more.join(", ")}`);
}
finishRunnerCache(runnerCache.certificate);

function testsOf(program) {
  const classes = new Map(program.classes.map((c) => [c.name, c]));
  const rows = [];
  for (const owner of owners) {
    const obj = program.reg.getObject("CLAS", owner);
    if (!obj) { rows.push({class: owner, status: "NOT_COMPILED", message: "class absent from the registry"}); continue; }
    for (const f of obj.getABAPFiles().filter((x) => x.getFilename().endsWith(".testclasses.abap"))) {
      for (const def of f.getInfo().listClassDefinitions()) {
        if (!def.isForTesting || def.isGlobal || def.isAbstract) continue;
        const testclass = def.name.toUpperCase();
        const cls = classes.get(`${owner}:${testclass}`);
        for (const m of def.methods.filter((x) => x.isForTesting)) {
          const method = m.name.toUpperCase();
          const compiled = cls?.methods.some((x) => x.name === method);
          const why = cls?.stubs.find((x) => x.name === method)?.reason
            ?? program.skipped.find((x) => x.startsWith(`${owner}:${testclass}=>${method}:`))
            ?? (compiled ? "" : program.diagnostics.filter((d) => d.object === owner).map((d) => d.message).join("\n")
              || "test method missing from generated class");
          const skip = skipped.has(`${owner}/${testclass}/${method}`);
          rows.push({class: owner, testclass, method, status: skip ? "SKIPPED" : compiled ? "READY" : "NOT_COMPILED",
            message: skip ? "skipped due to configuration" : why});
        }
      }
    }
  }
  return rows;
}

rows = testsOf(program);
const classes = new Map(program.classes.map((c) => [c.name, c]));
function alertsOf(key, seen = new Set()) {
  if (seen.has(key)) return [];
  seen.add(key);
  const [name, method] = key.split("=>");
  const cls = classes.get(name);
  const m = cls?.methods.find((x) => x.name === method);
  if (!m) return cls?.stubs.find((x) => x.name === method)?.reason ? [cls.stubs.find((x) => x.name === method).reason] : [];
  const alerts = [];
  const visit = (n) => {
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    if (!n || typeof n !== "object") return;
    if (n.s === "stub") alerts.push(n.reason);
    if (n.e === "call") {
      const target = n.owner ?? (n.receiver?.type?.k === "ref" ? n.receiver.type.name : name);
      if (target) append(alerts, alertsOf(`${target}=>${n.method}`, seen));
    }
    for (const [k, v] of Object.entries(n)) if (k !== "type") visit(v);
  };
  visit(m.body);
  return alerts;
}
for (const row of rows) if (row.status === "READY") {
  const name = `${row.class}:${row.testclass}`;
  row.alerts = [...new Set([row.method, "SETUP", "TEARDOWN", "CLASS_SETUP", "CLASS_TEARDOWN"]
    .flatMap((method) => alertsOf(`${name}=>${method}`)).filter(Boolean))];
}
// A test whose method or hooks reach SQL gets a fresh in-memory database for
// its class. Schema and generated object rows come from the same transpiler
// DatabaseSetup the Node init uses; TABU rows use test/seed.mjs.
const sql = /^(select_|sql_|db_|insert_db|update_db|delete_db|modify_db|commit_work|rollback_work)/i;
function needsDb(key, seen = new Set()) {
  if (seen.has(key)) return false;
  seen.add(key);
  const [name, method] = key.split("=>");
  const m = classes.get(name)?.methods.find((x) => x.name === method);
  if (!m) return false;
  const visit = (n) => {
    if (Array.isArray(n)) return n.some(visit);
    if (!n || typeof n !== "object") return false;
    if (n.s && sql.test(n.s)) return true;
    if (n.e === "call") {
      const target = n.owner ?? (n.receiver?.type?.k === "ref" ? n.receiver.type.name : name);
      if (target && needsDb(`${target}=>${n.method}`, seen)) return true;
    }
    return Object.entries(n).some(([k, v]) => k !== "type" && visit(v));
  };
  return visit(m.body);
}
for (const row of rows) if (row.status === "READY") {
  const key = `${row.class}:${row.testclass}`;
  if ([row.method, "SETUP", "TEARDOWN", "CLASS_SETUP", "CLASS_TEARDOWN"].some((m) => needsDb(`${key}=>${m}`))) {
    row.db = true;
  }
}

const layerOfFile = (file) => file && libDirs.some((dir) => file.startsWith(dir + "/")) ? 0 : 1;
// Test include classes live in unit, ordinary repository classes in app, and
// the imported libraries in core (go-layers.mjs promotes what points upward).
const plan = planLayers(program, {names: ["core", "app", "unit"],
  classTier: (name) => {
    const owner = name.split(":")[0];
    return name.includes(":") && owners.includes(owner) ? 2 : layerOfFile(sourceByName.get(owner));
  },
  interfaceTier: (name) => layerOfFile(objectByName.get(name)),
  ddicTier: (name) => typeFileByName.has(name) ? layerOfFile(typeFileByName.get(name)) : undefined});
layerInfo = plan.info;
writeGeneratedGo = function (dir) {
  if (args.includes("--unlayered") || fixture) {
    writeGo(join(dir, "zz_generated.go"), program, "main", null, true);
    return;
  }
  writeLayers(program, plan, {mainDir: dir, pkgDir: (i) => join(goDir, "generated", plan.names[i]),
    importPath: (i) => `osg/gogen/generated/${plan.names[i]}`});
}

timingMs.discovery = Math.round(performance.now() - commandStarted - timingMs.frontendClosureRounds.reduce((a, b) => a + b, 0));
const emitStarted = performance.now();
const goName = (x) => x.toUpperCase().replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
ready = rows.filter((x) => x.status === "READY");
groups = [...Map.groupBy(ready, (r) => `${r.class}:${r.testclass}`)].map(([key, methods]) => ({key, methods}));
// A4H: an assertion in TEARDOWN stops this local test class unless the
// assertion that actually failed was called with QUIT = NO.
const generated = ["package main", "", "import (_ \"embed\"; \"encoding/json\"; \"flag\"; \"os\"; \"path/filepath\"; \"regexp\"; \"runtime/debug\"; \"strconv\"; \"strings\"; \"time\"; \"osg/gogen/abap\"; \"osg/gogen/castdiag\"; \"osg/gogen/abapsite\"; \"osg/gogen/session\")", "",
  "//go:embed zz_db.json", "var dbScript []byte", "",
  "type result struct { Class string `json:\"class\"`; Testclass string `json:\"testclass\"`; Method string `json:\"method\"`; Status string `json:\"status\"`; Message string `json:\"message\"`; Where string `json:\"where,omitempty\"` }",
  "var assertSite = regexp.MustCompile(`(?m)([A-Za-z0-9_]+\\.clas\\.testclasses\\.abap):([0-9]+)`)\n// lastSite: where the last caught error began in ABAP source (abapiti 10-09), not for assertions\nvar lastSite string\nfunc failureMessage(x any) string { msg := castdiag.DumpText(x); lastSite = \"\"; if r, ok := abap.AsRaised(x); !ok || r.Class != \"KERNEL_CX_ASSERT\" { st := string(debug.Stack()); if w, ok := x.(*abap.Rethrown); ok { st = w.Stack }; lastSite = abapsite.Site(st) }; if msg != \"Expected abap_true\" && msg != \"Expected abap_false\" { return msg }; sites := assertSite.FindAllStringSubmatch(string(debug.Stack()), -1); if len(sites) == 0 { return msg }; site := sites[len(sites)-1]; return msg + \" at \" + site[1] + \":\" + site[2] }",
  "func caught(f func()) (msg string) { defer func() { if x := recover(); x != nil { msg = failureMessage(x) } }(); f(); return }",
  "func caughtTeardown(f func()) (msg string, assertion, quitNo bool) { defer func() { if x := recover(); x != nil { msg = failureMessage(x); if r, ok := abap.AsRaised(x); ok && r.Class == \"KERNEL_CX_ASSERT\" { assertion, quitNo = true, r.AssertionQuitNo } } }(); f(); return }",
  "func isNotCompiled(msg string) bool { return strings.Contains(msg, \"NOT_COMPILED in \") }",
  `func main() { mediaDir := os.Getenv("GOGEN_UNIT_MEDIA_DIR"); if mediaDir == "" { exe, err := os.Executable(); if err != nil { panic(err) }; mediaDir = filepath.Join(filepath.Dir(exe), "media") }; if err := abap.SetMediaDir(mediaDir); err != nil { panic(err) }; results := []result{}`,
  "classesFile := flag.String(\"classes-file\", \"\", \"JSON list of test classes to run\")",
  "imageFile := flag.String(\"seed-image\", \"\", \"seeded SQLite image\")",
  "imageOut := flag.String(\"seed-image-out\", \"\", \"write seeded SQLite image and exit\")",
  "timingsOut := flag.String(\"timings-out\", \"\", \"write per-class durations\")",
  "phasesOut := flag.String(\"phases-out\", \"\", \"write startup and seed durations\")",
  "resultsOut := flag.String(\"results-out\", \"\", \"checkpoint of completed test classes\")",
  "flag.Parse()",
  "if text := os.Getenv(\"GOGEN_UNIT_MAX_STACK\"); text != \"\" { limit, err := strconv.Atoi(text); if err != nil || limit < 1024 { panic(\"invalid GOGEN_UNIT_MAX_STACK\") }; debug.SetMaxStack(limit) }",
  "selected := map[string]bool{}; if *classesFile != \"\" { data, err := os.ReadFile(*classesFile); if err != nil { panic(err) }; var names []string; if err := json.Unmarshal(data, &names); err != nil { panic(err) }; for _, name := range names { selected[name] = true } }",
  "durations := map[string]float64{}; startupStarted := time.Now()",
  "s := &abap.Session{}"];
if (groups.some(({methods}) => methods.some((m) => m.db))) generated.push(
  "var dbImage []byte; if *imageFile != \"\" { var err error; dbImage, err = os.ReadFile(*imageFile); if err != nil { panic(err) } } else { seed, err := abap.OpenDB(dbScript); if err != nil { panic(err) }; dbImage, err = seed.Image(); if err != nil { panic(err) }; seed.Close() }; if *imageOut != \"\" { if err := os.WriteFile(*imageOut, dbImage, 0600); err != nil { panic(err) }; return }");
else generated.push("_ = imageFile; if *imageOut != \"\" { if err := os.WriteFile(*imageOut, nil, 0600); err != nil { panic(err) }; return }");
generated.push("if *phasesOut != \"\" { data, _ := json.Marshal(map[string]float64{\"startupSeedMs\": float64(time.Since(startupStarted).Microseconds()) / 1000}); if err := os.WriteFile(*phasesOut, data, 0600); err != nil { panic(err) } }");
generated.push("checkpoint := func(active string) { if *resultsOut != \"\" { data, err := json.Marshal(struct { Active string `json:\"active,omitempty\"`; Rows []result `json:\"rows\"`; Durations map[string]float64 `json:\"durations\"` }{active, results, durations}); if err != nil { panic(err) }; temp := *resultsOut + \".tmp\"; if err := os.WriteFile(temp, data, 0600); err != nil { panic(err) }; if err := os.Rename(temp, *resultsOut); err != nil { panic(err) } } }");
// any group with SQL hands every class's session the seed image (below)
const hasDB = groups.some(({methods}) => methods.some((m) => m.db));
for (const {key, methods} of groups) {
  const [owner, local] = key.split(":");
  const c = classes.get(key);
  const T = goName(key);
  const special = (name, receiver) => c.methods.some((m) => m.name === name)
    ? `${receiver}.${goName(name)}(s)` : "";
  // A test class runs in a Session of its own: private statics, and its
  // own copy of the seed image as the database (abap.Session owns both).
  // The image is handed to every class's session, because a class whose
  // SQL the static detection missed opens its copy on its first statement.
  generated.push(`if *classesFile == "" || selected[${JSON.stringify(key)}] {`, `checkpoint(${JSON.stringify(key)})`, "classStarted := time.Now()", "session.BeginTestClass()", "s = &abap.Session{}", ...(hasDB ? ["s.UseUnitImage(dbImage)"] : []), ...(c.methods.some((m) => m.name === "CLASS_TEARDOWN") ? ["groupStart := len(results)"] : []), "classError := \"\"; classSite := \"\"", "stopClass := false");
  // one LUW chain as the Node unit run has (abap.BeginUnitLUW): COMMIT and
  // ROLLBACK WORK end it, nothing between the methods does
  if (methods.some((m) => m.db)) generated.push("classError = caught(func(){ if err := s.OpenUnitDB(dbImage); err != nil { panic(err) } }); classSite = lastSite");
  if (c.methods.some((m) => m.name === "CLASS_SETUP")) generated.push(`if classError == "" { classError = caught(func(){ ${funcName(key, "CLASS_SETUP")}(s) }); classSite = lastSite }`);
  for (const row of methods) {
    generated.push(`{ r := result{Class:${JSON.stringify(owner)}, Testclass:${JSON.stringify(local)}, Method:${JSON.stringify(row.method)}, Status:"SUCCESS"}`,
      "if stopClass { r.Status = \"SKIPPED\"; r.Message = \"stopped after teardown failure\" } else if classError != \"\" { r.Status = \"FAILED\"; if isNotCompiled(classError) { r.Status = \"NOT_COMPILED\" }; r.Message = \"class_setup: \" + classError; r.Where = classSite } else {",
      `test := New_${T}(s)`,
      `err := caught(func(){ ${special("SETUP", "test")} })`,
      "if err == \"\" { err = caught(func(){ test." + goName(row.method) + "(s) }) }",
      "site := lastSite",
      `tear, assertion, quitNo := caughtTeardown(func(){ ${special("TEARDOWN", "test")} })`,
      "if assertion && !quitNo { stopClass = true }",
      "if err == \"\" && tear != \"\" { err = \"teardown: \" + tear; site = lastSite }",
      "if err != \"\" { r.Status = \"FAILED\"; if isNotCompiled(err) { r.Status = \"NOT_COMPILED\" }; r.Message = err; r.Where = site }", "}", "results = append(results, r)", "}");
  }
  if (c.methods.some((m) => m.name === "CLASS_TEARDOWN")) generated.push(
    `if err := caught(func(){ ${funcName(key, "CLASS_TEARDOWN")}(s) }); err != "" { for i := groupStart; i < len(results); i++ { results[i].Status = "FAILED"; if isNotCompiled(err) { results[i].Status = "NOT_COMPILED" }; results[i].Message += " class_teardown: " + err; if lastSite != "" { if results[i].Where == "" { results[i].Where = lastSite } else { results[i].Where += " class_teardown: " + lastSite } } } }`);
  generated.push("abap.EndTestClass(s)", `durations[${JSON.stringify(key)}] = float64(time.Since(classStarted).Microseconds()) / 1000`,
    'checkpoint("")', "}");
}
generated.push("if *timingsOut != \"\" { data, err := json.Marshal(durations); if err != nil { panic(err) }; if err := os.WriteFile(*timingsOut, data, 0600); err != nil { panic(err) } }", "enc := json.NewEncoder(os.Stdout); if err := enc.Encode(results); err != nil { panic(err) }", "}");
// Go resolves imports inside its module tree. Copy the small module into this
// invocation's tree so another unit run cannot replace generated packages
// between emission and compilation.
const {collectMedia, replaceWwwparams} = await import("./media.mjs");
const media = collectMedia(folders.filter(existsSync));
const dir = join(goDir, "cmd", "unit");
mkdirSync(dir, {recursive: true});
writeGeneratedGo(dir);
writeFileSync(join(dir, "zz_main.go"), generated.join("\n") + "\n");
if (ready.some((r) => r.db)) {
  const {DatabaseSetup} = await import(`${home}/node_modules/@abaplint/transpiler/build/src/db/index.js`);
  const {seedStatements} = await import(`${home}/test/seed.mjs`);
  process.env.OSD_ROOT ??= home;
  const db = new DatabaseSetup(program.reg).run();
  writeFileSync(join(dir, "zz_db.json"), JSON.stringify(replaceWwwparams([...db.schemas.sqlite, ...db.insert, ...seedStatements(fixture)], media)));
} else writeFileSync(join(dir, "zz_db.json"), "[]");
timingMs.emit = Math.round(performance.now() - emitStarted);
}
const {collectMedia, writeMedia} = await import("./media.mjs");
const media = collectMedia(folders.filter(existsSync));
writeMedia(media, join(runDir, "media"));
const summary = {classes: owners.length, compiled: new Set(ready.map((r) => r.class)).size, rows, timingMs, overrides, layers: layerInfo, cache, buildDir: goDir};
const updateCompiledCount = () => {
  summary.compiled = owners.filter((owner) => {
    const own = rows.filter((r) => r.class === owner);
    return own.some((r) => r.status === "SUCCESS" || r.status === "FAILED")
      && own.every((r) => r.status !== "NOT_COMPILED" && r.status !== "NEEDS_DB");
  }).length;
};
writeFileSync(join(runDir, "plan.json"), JSON.stringify(summary, null, 2));
if (!ready.length || args.includes("--build-only")) { console.log(JSON.stringify(summary)); process.exit(ready.length ? 0 : 2); }
const bin = join(runDir, "unit");
if (process.env.GOGEN_GO_BUILD_X) writeFileSync(join(runDir, "go-build-x.log"), "");
// The Go compiler can reject a method that the IR frontend accepted. Find
// its ABAP source position, retain its typed signature, and emit a method
// that raises NOT_COMPILED when reached. The next build reports any further
// errors, so unrelated owners can still share this one binary.
function stubGoErrors(diagnostics) {
  const pending = new Map();
  for (const line of diagnostics.split("\n")) {
    const match = /^([^:\n]+\.abap):(\d+):\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, file, rowText, reason] = match;
    const row = Number(rowText);
    const candidates = program.classes.flatMap((cls) =>
      [...cls.methods, ...(cls.constructor ? [cls.constructor] : [])]
        .filter((m) => m.pos?.file === file && m.pos.row <= row)
        .map((m) => ({cls, method: m})));
    candidates.sort((a, b) => b.method.pos.row - a.method.pos.row);
    const target = candidates[0];
    if (!target) continue;
    const {cls, method} = target;
    if (method.name === "CONSTRUCTOR") continue;
    if (!pending.has(method)) pending.set(method, {cls, method, reason});
  }
  // Resolve all diagnostics before removing methods: a second error in one
  // method must not be attributed to the preceding, still-valid method.
  for (const {cls, method, reason} of pending.values()) {
    cls.methods.splice(cls.methods.indexOf(method), 1);
    cls.stubs.push({...method, reason: `Go compiler: ${reason}`});
  }
  return pending.size;
}
// GOCACHE is the caller's, else Go's own per-user cache. A cache inside the
// checkout started cold in every fresh one (osgjs-unit stages a checkout per
// run) and wrote ~10 GB a run (2026-10-09).
let build;
for (let attempt = 0; attempt < 100; attempt++) {
  const buildStarted = performance.now();
  build = spawnSync("go", ["build", ...(process.env.GOGEN_GO_BUILD_X ? ["-x"] : []), "-trimpath", "-o", bin, "./cmd/unit"], {
    cwd: goDir, encoding: "utf8", env: process.env, maxBuffer: 5e6,
  });
  if (process.env.GOGEN_GO_BUILD_X) appendFileSync(join(runDir, "go-build-x.log"), build.stderr ?? "");
  timingMs.goBuild += Math.round(performance.now() - buildStarted);
  if (build.status === 0) break;
  if (build.signal || build.error || killedGoTool(build.stderr) || !program || !stubGoErrors(build.stderr ?? "")) break;
  const emitRetryStarted = performance.now();
  writeGeneratedGo(join(goDir, "cmd", "unit"));
  timingMs.emit += Math.round(performance.now() - emitRetryStarted);
}
if (build.status !== 0) {
  markBuildFailure(ready, build);
  updateCompiledCount();
  console.log(JSON.stringify({...summary, rows}));
  process.exit(2);
}
if (cacheEnabled && !cacheMeta) {
  try { writeFrontendCache(cacheRoot, cacheInputs.key, goDir, {rows, layers: layerInfo}); }
  catch (error) { console.error(`warning: frontend cache was not saved: ${error.message}`); }
}
const runStarted = performance.now();
const {actual, runDetail} = await runUnit({bin, groups, ready, jobs, out, runDir});
timingMs.run = Math.round(performance.now() - runStarted);
timingMs.runDetail = runDetail;
timingMs.total = Math.round(performance.now() - commandStarted);
const reconciled = reconcile(ready, actual);
for (let i = 0; i < ready.length; i++) { ready[i].status = reconciled[i].status; ready[i].message = reconciled[i].message; if (reconciled[i].where) ready[i].where = reconciled[i].where; if (reconciled[i].source) ready[i].source = reconciled[i].source; }
updateCompiledCount();
console.log(JSON.stringify({...summary, rows}));
if (ready.some((x) => x.status === "FAILED")) process.exit(1);
if (ready.some((x) => x.status === "NOT_COMPILED")) process.exit(2);
