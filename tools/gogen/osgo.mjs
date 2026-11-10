import {writeGo} from "./symbols.ts";
import {emitGo, goIdent} from "./emit-go.mjs";
import {planLayers, writeLayers} from "./go-layers.mjs";
import {editedObjects, osgoTiers} from "./osgo-layers.mjs";
import {gofmtCached} from "./gofmt-cache.mjs";
// OSGo: build the Go host of open-steamgate (go/cmd/osgo) out of OSG's own
// ABAP, compiled as gateway.mjs compiles it (osg-build.mjs), with the ICF
// shim in front: a browser can use it.
//
//   node tools/gogen/osgo.mjs            -> .out/osgo  (all of OSG; heavy, run it under the shared lock;
//                                           refused when gen/ is not the tree's generation, --stale-gen overrides)
//   node tools/gogen/osgo.mjs --echo     -> .out/osgo-echo  (the shim, open-abap-core and a test handler at /echo)
//   .out/osgo [-port 3095] [-db file.sqlite] [-root <checkout>]
//   --unit-owners A,B|none (or OSGO_UNIT_OWNERS): the classes whose ABAP Unit
//   tests the ADT test runner can run (osgo-adt-unit.mjs; default the fixture)
//   --unlayered (or OSGO_LAYERS=0): all generated Go in package main, as
//   before the layered build (below)
//   --fast (or OSGO_FAST=1): no Node build when only class/interface bodies
//   changed since the live generation (osgo-fast.mjs), else run it first
//
// The generated classes go into three Go packages (go-layers.mjs,
// osgo-layers.mjs): generated/osgo/core (the libraries), generated/osgo/app
// (the tree) and package main (the objects being edited, beside main.go), so
// a save of a class recompiles package main and links, while Go's build cache
// keeps core and app (docs/osgo-fast-rebuild.md). The phases of the run are
// printed at the end and written to .out/osgo-phases.json.
//
// The generated half of the program is written beside go/cmd/osgo/main.go:
// zz_generated.go (the classes), zz_db.json (tables and seed rows) and
// zz_boot.go (what boots, which SICF nodes are mounted, the launchpad tiles
// and the pack folders, as read from the checkout now).
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {columnRegistry, compileProgram} from "./frontend.mjs";
import {home} from "./home.mjs";
import {adtSourceHash} from "../osd-adt-gogen-gate.mjs";
import {lintFolders, lintBuildSpec, lintEngineGo, lintBuildOptions, goLintEngineGo, withGoLintModule} from "./lint-engine.mjs";
import {unitOwners, unitClasses, unitGo} from "./osgo-adt-unit.mjs";

const here = import.meta.dirname;
const echo = process.argv.includes("--echo");
const layered = !echo && !process.argv.includes("--unlayered") && process.env.OSGO_LAYERS !== "0";
const layersDir = join(here, "go", "generated", "osgo");
const fast = !echo && (process.argv.includes("--fast") || process.env.OSGO_FAST === "1");
// what the fast path decided (osgo-fast.mjs), for .out/osgo-phases.json
let fastInfo;
// the full Node build, run by --fast when it cannot skip it; its failure is
// this build's, with its exit code (osd-build.mjs has said why)
function nodeBuild() {
  try {
    execFileSync(process.execPath, [join(home, "tools", "osd-build.mjs")], {cwd: home, stdio: ["ignore", "inherit", "inherit"]});
  } catch (e) { console.error(`osgo: the Node build failed (exit ${e.status})`); process.exit(e.status || 1); }
  phase("transpile");
}
// the phases of this run, in ms (printed at the end, .out/osgo-phases.json)
const phases = {};
let phaseMark = performance.now();
const phase = (name) => { const now = performance.now(); phases[name] = (phases[name] ?? 0) + Math.round(now - phaseMark); phaseMark = now; };
const {engine: lintEngine, lib: lintLib} = lintBuildOptions(process.argv.slice(2));
const extraFolders = lintEngine === "abap" ? lintFolders(home, lintLib) : [];
const dir = join(here, "go", "cmd", "osgo");
const out = join(here, ".out", echo ? "osgo-echo" : "osgo");
const reportPath = `${out}-compile-report.json`;
// A failed build must not leave a previous successful report for the gate.
rmSync(reportPath, {force: true});
const sourceHash = adtSourceHash();
const sourceEpoch = process.env.SOURCE_DATE_EPOCH ?? execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {cwd: home, encoding: "utf8"}).trim();
if (!/^\d+$/.test(sourceEpoch)) throw new Error(`invalid SOURCE_DATE_EPOCH: ${sourceEpoch}`);
const builtAt = new Date(Number(sourceEpoch) * 1000).toISOString().slice(0, 16).replace("T", " ");

let program;
let unit = {classes: [], missing: []};
const owners = echo ? [] : unitOwners();
let statements = [];
let services = [];
const notServed = [];
let tiles = {tiles: []};
// the object store's facts (tools/gogen/store.mjs): none for --echo
let store = "";
let webapps = [];
// the push channels (*.sapc.xml) whose handler class this program has, and
// the ones left out; served by go/apc around the compiled ZCL_APC_HOST
// (ultra/packs, 2026-09-24)
const channels = [];
const channelsLeftOut = [];
if (echo) {
  program = compileProgram({folders: [`${home}/.local/lars/open-abap-core/src`, `${home}/.local/lars/express-icf-shim/src`, join(dir, "testdata")],
    objects: ["cl_express_icf_shim", "cl_http_entity", "cl_http_utility", "zcl_osgo_echo"]});
  console.log(`front end: ${program.classes.length} classes, ${program.partial.length} statement stubs`);
  services = [{path: "/echo", handler: "ZCL_OSGO_ECHO", active: true}];
} else {
  // --fast (or OSGO_FAST=1): skip the Node build when only class or
  // interface bodies changed since the live generation (osgo-fast.mjs proves
  // it), else run it here first; docs/osgo-fast-rebuild.md "The fast path"
  if (fast) {
    const {fastProof} = await import("./osgo-fast.mjs");
    const proof = await fastProof(home);
    fastInfo = proof;
    phase("fast proof");
    if (proof.ok) {
      console.log(`osgo fast: generation ${proof.hash} is live ${proof.base} with ${proof.changed.length} edited source file(s) (${proof.changed.join(", ")}); no Node build`);
    } else {
      console.log(`osgo fast: full build (${proof.reason})`);
      nodeBuild();
    }
  }
  const {compileOsg, osgDatabase, staleGen} = await import("./osg-build.mjs");
  // a stale gen/ is refused (--stale-gen builds it anyway, with the warning)
  const staleCheck = async () => {
    const stale = await staleGen();
    if (stale && !process.argv.includes("--stale-gen")) {
      console.error(`osgo: refused: ${stale} (or pass --stale-gen)`);
      process.exit(2);
    }
    if (stale) console.warn(`osgo: WARNING ${stale}`);
  };
  if (!fastInfo?.ok) await staleCheck();
  phase("stale check");
  let built = compileOsg({extraFolders, includeTests: new Set(owners)});
  phase("front end");
  // the fast path skipped the Node build's syntax check: an edited object
  // the front end found errors in is not built here. The full path runs
  // instead, so the refusal is osd-build.mjs's own (message, exit code), and
  // a tree it accepts is built as the full path builds it
  if (fastInfo?.ok) {
    const {fastSyntaxRefusal} = await import("./osgo-fast.mjs");
    const refusal = fastSyntaxRefusal(fastInfo.changed, built.program.diagnostics ?? []);
    phase("fast syntax check");
    if (refusal !== undefined) {
      console.log(`osgo fast: full build (${refusal})`);
      fastInfo = {ok: false, hash: fastInfo.hash, base: fastInfo.base, reason: refusal};
      nodeBuild();
      await staleCheck();
      built = compileOsg({extraFolders, includeTests: new Set(owners)});
      phase("front end");
    }
  }
  program = built.program;
  console.log(built.summary);
  unit = unitClasses(program, owners);
  console.log(`ABAP Unit: ${unit.classes.length} test classes of ${owners.length} owners (${owners.join(", ") || "none"})${unit.missing.length ? `; left out: ${unit.missing.join("; ")}` : ""}`);
  // the fast path: the live generation's cross-reference with the edited
  // objects' rows derived again, instead of a parse of the tree
  let xref;
  if (fastInfo?.ok) {
    const {fastXrefRows} = await import("./osgo-fast.mjs");
    xref = await fastXrefRows(home, fastInfo);
    console.log(`osgo fast: cross-reference ${xref ? "from the live generation's rows" : "parsed (no live rows to start from)"}`);
  }
  const db = await osgDatabase(program, {xref});
  statements = db.statements;
  console.log(db.summary);
  // SMW0: the W3MI objects of the layers (the BSP apps' pages among them)
  // beside the binary in media/, their WWWPARAMS rows with the real sizes
  const {layers} = await import("./osg-build.mjs");
  const {collectMedia, writeMedia, replaceWwwparams} = await import("./media.mjs");
  const media = collectMedia(layers.filter(existsSync));
  statements = replaceWwwparams(statements, media);
  writeMedia(media, join(here, ".out", "media"));
  // the ICF registry as the Node hosts apply it at start (test/start.mjs
  // applyAtStartup): the same decision over the same *.sicf.xml, recorded
  // against an empty registry at build time and written as seed rows, so the
  // ICF services app and the status tables do not start empty
  const {applyAtStartup} = await import(`${home}/tools/osd-icf-apply.mjs`);
  const icfSql = [];
  const recorder = {select: async () => ({rows: []}), execute: async (sql) => { icfSql.push(sql); }};
  const icfActions = await applyAtStartup(recorder, {root: home, say: () => {}, now: new Date(Number(sourceEpoch) * 1000).toISOString()});
  if (icfActions === undefined) throw new Error("ICF registry could not be applied at build time");
  statements = [...statements, ...icfSql];
  console.log(`ICF registry: ${icfActions.length} nodes, ${icfSql.length} statements into the seed`);
  console.log(`media: ${media.length} W3MI objects, ${Math.round(media.reduce((n, o) => n + o.size, 0) / 1024)} KB -> .out/media`);
  // the SICF nodes of the tree, as the Node hosts mount them, minus the
  // paths src/icf/nodes.json gives to another front, minus a handler class
  // this program does not have (it would answer CX_SY_CREATE_OBJECT_ERROR)
  const {services: sicf} = await import(`${home}/tools/osd-icf.mjs`);
  const {nodes} = await import(`${home}/tools/osd-nodes.mjs`);
  const claimed = nodes(home, {proxies: false}).filter((n) => n.source.endsWith("nodes.json")).map((n) => n.path);
  const compiled = new Set(program.classes.map((c) => c.name));
  for (const s of sicf(home)) {
    if (s.handler === undefined && s.active !== false) continue;
    if (claimed.some((p) => s.path === p || s.path.startsWith(`${p}/`))) continue;
    // mounted as a refusal (main.go), so a request below it is not taken by
    // a parent node whose class is compiled, or by the 404 of no node
    if (s.type !== "ABAP") notServed.push({path: s.path, handler: String(s.handler ?? ""), why: `handler type ${s.icftyp} is not served by OSGo`});
    else if (!compiled.has(String(s.handler).toUpperCase())) notServed.push({path: s.path, handler: String(s.handler).toUpperCase(), why: `${String(s.handler).toUpperCase()} is not in this program`});
    else services.push({path: s.path, handler: String(s.handler).toUpperCase(), active: s.active !== false});
  }
  const {channels: sapc} = await import(`${home}/tools/osd-icf.mjs`);
  for (const c of sapc(home)) {
    if (!compiled.has("ZCL_APC_HOST")) channelsLeftOut.push({path: c.path, handler: c.handler, why: "ZCL_APC_HOST is not in this program"});
    else if (!compiled.has(String(c.handler).toUpperCase())) channelsLeftOut.push({path: c.path, handler: String(c.handler).toUpperCase(), why: `${String(c.handler).toUpperCase()} is not in this program`});
    else channels.push({path: c.path, name: c.name, handler: String(c.handler).toUpperCase()});
  }
  // DESTINATION 'STORE' over the files of the tree (go/objstore)
  const {storeConfig} = await import("./store.mjs");
  // the fast path: the edited files are active as they are now (osgo-fast.mjs);
  // copies neither this build nor the last one (the binary that may still be
  // serving, its zz_store.json) names are removed
  const edited = fastInfo?.ok ? (await import("./osgo-fast.mjs")).fastStoreEdits(home, fastInfo.changed, join(here, ".out", "osgo-active"), {previous: join(dir, "zz_store.json")}) : undefined;
  const cfg = await storeConfig(home, {edited});
  store = JSON.stringify(cfg);
  console.log(`store: ${cfg.roots.length} roots, ${cfg.libs.length} libraries (${cfg.libs.reduce((n, l) => n + l.files.length, 0)} files), ${Object.keys(cfg.built).length} files of this generation`);
  const {tilesOf, webappsOf} = await import(`${home}/tools/osd-packs.mjs`);
  tiles = {tiles: tilesOf(home)};
  webapps = webappsOf(home).map((p) => ({path: `/app/${p.name}`, dir: p.dir}));
}
phase("database, media, ICF, store");

// The generated classes, in one package or in three. The text `go` is what
// the checks below and the generation read: the unlayered emission in both
// cases, so the generation names the program, not how it was packaged.
let go, layerInfo;
rmSync(join(dir, "zz_generated.go"), {force: true});
if (layered) {
  const {layers, libs, hidden} = await import("./osg-build.mjs");
  const hot = editedObjects(home, layers);
  const plan = planLayers(program, osgoTiers({layers, libs: [...libs, ...extraFolders], hidden, hot}));
  layerInfo = {...plan.info, edited: [...hot].sort()};
  phase("layer plan");
  writeLayers(program, plan, {mainDir: dir, pkgDir: (i) => join(layersDir, plan.names[i]),
    importPath: (i) => `osg/gogen/generated/osgo/${plan.names[i]}`, unitBuild: false});
  phase("emit");
  go = emitGo(program);
  phase("generation hash emit");
  console.log(`layers: ${Object.entries(plan.info.classes).map(([n, c]) => `${n} ${c}`).join(", ")} classes; edited: ${layerInfo.edited.join(", ") || "none"}${plan.info.promoted.length ? `; promoted: ${plan.info.promoted.length}` : ""}`);
} else {
  rmSync(layersDir, {recursive: true, force: true});
  go = writeGo(join(dir, "zz_generated.go"), program);
  phase("emit");
}
// The other generated files of package main reach the classes the way
// zz_generated.go does in a layered build: a dot import of each package
// below, and a use of its marker type, so an import is never unused.
const writeMainGo = (name, src) => writeFileSync(join(dir, name), !layered ? src
  : src.replace(/^package main\n/, `package main\n\nimport (\n\t. "osg/gogen/generated/osgo/core"\n\t. "osg/gogen/generated/osgo/app"\n)\n`) + "\nvar _ = GogenCoreLayer{}\nvar _ = GogenAppLayer{}\n");
// a field of a generated structure, as the emitter spells it in this build
// (exported when the classes are layered, emit-go.mjs ident)
const field = (name) => goIdent(name, layered);
writeFileSync(join(dir, "zz_db.json"), JSON.stringify(statements));
writeFileSync(join(dir, "zz_store.json"), store);
writeMainGo("zz_unit.go", unitGo(unit.classes));
// the table registry as JSON, the column registry a dynamic WHERE parser reads
writeFileSync(join(dir, "zz_tables.json"), JSON.stringify(columnRegistry(program), null, 1));
const has = (fn) => go.includes(`\nfunc ${fn}(`);
if (lintEngine === "abap" && lintLib && (!has("ZCL_OSD_LINT_ENGINE_PRIME") || !has("ZCL_OSD_LINT_ENGINE_CHECK"))) {
  throw new Error("ABAP lint facade methods were not compiled");
}
const lintSpec = lintLib ? await lintBuildSpec(home) : undefined;
writeMainGo("zz_lint.go", lintEngine === "go" ? goLintEngineGo(lintSpec) : lintEngineGo(lintSpec, field));
// the system status of the binary (ultra/json, status.mjs / go/cmd/osgo/status.go):
// what it serves, and the generation it is
{
  const {statusFacts, statusGo} = await import("./status.mjs");
  const generated = go + JSON.stringify(statements);
  const facts = echo ? {services: [], packs: [], generation: `go:${(await import("node:crypto")).createHash("sha256").update(generated).digest("hex").slice(0, 16)}`}
    : await statusFacts({program, services: services.filter((x) => x.active), webapps, generated});
  writeMainGo("zz_status.go", statusGo(facts, has("ZCL_OSD_STATUS_REFRESH")));
  console.log(`status: ${facts.services.length} services and ${facts.packs.length} packs of this binary, generation ${facts.generation}`);
}
// Keep generated ADT references out of handwritten cmd/osgo and echo tests.
const adtSessionAdapter = has("New_ZCL_OSD_ADT_SESSION") && has("ZCL_OSD_ADT_HANDLER_USE_SESSION") ? `
type adtSystemSession struct {
 *ZCL_OSD_ADT_SESSION
 step *abap.Session
 resolved ZIF_OSD_ADT_SESSION__TY_SESSION
}
func (a *adtSystemSession) ZIF_OSD_ADT_SESSION__RESOLVE(s *abap.Session, cookies, headers *[]*IHTTPNVP) ZIF_OSD_ADT_SESSION__TY_SESSION {
 // the session class's own rows (ZOSD_ADT_SESS and its handles) run on the
 // state session, outside the step's LUW (workprocesses.go withADTState):
 // a system's session context is kernel state, it survives a dumped
 // request, and an ADT read that touches it stays a read step. The class
 // is the same one either way; only the session it runs on moves.
 withADTState(a.step, func(state *abap.Session) {
  a.resolved = a.ZCL_OSD_ADT_SESSION.ZIF_OSD_ADT_SESSION__RESOLVE(state, cookies, headers)
 })
 return a.resolved
}
// END, ENQ_CONTEXT_ENDED and RELEASE_OBJECT delete the same rows (a plain
// GET that opened a session and asks nothing of it ends it in the same
// step): on the state session too, or a read step's query_only connection
// refuses them (every ADT source read of the slice-5 bench answered 500)
func (a *adtSystemSession) ZIF_OSD_ADT_SESSION__END(s *abap.Session, id string) {
 withADTState(a.step, func(state *abap.Session) { a.ZCL_OSD_ADT_SESSION.ZIF_OSD_ADT_SESSION__END(state, id) })
 adtSessionEnded(id) // the logical internal session ends with it (workprocesses.go)
}
func (a *adtSystemSession) ZIF_OSD_ADT_SESSION__ENQ_CONTEXT_ENDED(s *abap.Session, id string) {
 withADTState(a.step, func(state *abap.Session) { a.ZCL_OSD_ADT_SESSION.ZIF_OSD_ADT_SESSION__ENQ_CONTEXT_ENDED(state, id) })
}
func (a *adtSystemSession) ZIF_OSD_ADT_SESSION__RELEASE_OBJECT(s *abap.Session, id, typ, name string) {
 withADTState(a.step, func(state *abap.Session) { a.ZCL_OSD_ADT_SESSION.ZIF_OSD_ADT_SESSION__RELEASE_OBJECT(state, id, typ, name) })
}
func (a *adtSystemSession) View() (string, bool) { return a.resolved.${field("id")}, a.resolved.${field("stateful")} == "X" }
func (a *adtSystemSession) Alive(id string) bool {
 alive := false
 withADTState(a.step, func(state *abap.Session) { alive = a.ZIF_OSD_ADT_SESSION__ALIVE(state, id) == "X" })
 return alive
}
func (a *adtSystemSession) Adopt(id, typ, name string) string {
 handle := ""
 withADTState(a.step, func(state *abap.Session) { handle = a.ZIF_OSD_ADT_SESSION__ADOPT_HANDLE(state, id, typ, name) })
 return handle
}
func (a *adtSystemSession) Forget(id, handle string) (typ, name string) {
 withADTState(a.step, func(state *abap.Session) { a.ZIF_OSD_ADT_SESSION__RELEASE_HANDLE(state, id, handle, &typ, &name) })
 return
}
func (a *adtSystemSession) Holds(handle, typ, name string) bool {
 id := a.resolved.${field("id")}
 if id == "" || handle == "" || !a.Alive(id) {
  return false
 }
 held := false
 withADTState(a.step, func(state *abap.Session) { held = a.ZIF_OSD_ADT_SESSION__HOLDS(state, id, handle, typ, name) == "X" })
 if !held {
  return false
 }
 holder, found := (adtsystem.ENQHolders{Server: adtLocks, Kernel: adtKernel, Client: abap.Mandt}).Holder(typ, name)
 return found && holder == adtKernel.Owner().Key(id)
}
func (a *adtSystemSession) Release(handle, typ, name string) {
 a.Forget(a.resolved.${field("id")}, handle)
 if sid, ok := adtKernel.Handle(a.resolved.${field("id")}); ok {
 adtLocks.Dequeue(sid, enq.Request{Client: abap.Mandt, Table: "ZOSD_ADT_LOCK", Fields: []enq.Field{{Value: typ, Length: 4}, {Value: name, Length: 40}}, Mode: "E", Scope: 3})
 }
}
func init() {
 hasADTSession = true
 bindADTSession = func(s *abap.Session) func() {
  session := &adtSystemSession{ZCL_OSD_ADT_SESSION: New_ZCL_OSD_ADT_SESSION(s, 1800, "0"), step: s}
  clear := adtSystems.Bind(s, adtsystem.Provider{Sessions: session, Holders: adtsystem.ENQHolders{Server: adtLocks, Kernel: adtKernel, Client: abap.Mandt}, Identity: adtIdentity(abap.SysID, os.LookupEnv)})
  ZCL_OSD_ADT_HANDLER_USE_SESSION(s, session)
  adtWriteSessions.Store(s, session)
  return func() { adtWriteSessions.Delete(s); clear(); ZCL_OSD_ADT_HANDLER_USE_SESSION(s, nil) }
 }
}
` : "// ADT session classes are absent; use the handwritten no-op binding.\n";
writeMainGo("zz_adt_session.go", `package main
import ("osg/gogen/abap"; "osg/gogen/adtsystem"; "osg/gogen/enq"; "os")
var _ *abap.Session
var _ adtsystem.Provider
var _ enq.Request
var _ = os.LookupEnv
${adtSessionAdapter}`);
const boots = ["ZCL_STG_SEGW_REGISTRY_REGISTER", "ZCL_STG_SHLP_REGISTRY_REGISTER"].filter(has);
// the synthetic demo rows: ZCL_OSD_DEMO_DATA=>BOOT with the knob the Node
// hosts pass (tools/osd-demo-data.mjs, OSD_DEMO_ROWS); main.go runs it in a
// dialog step of its own, after boot, and starts without them if it dumps
const demoData = has("ZCL_OSD_DEMO_DATA_BOOT")
  ? "const hasDemoData = true\n\nfunc demoData(s *abap.Session, config string) string { return ZCL_OSD_DEMO_DATA_BOOT(s, config) }"
  : "// ZCL_OSD_DEMO_DATA is not in this program\nconst hasDemoData = false\n\nfunc demoData(s *abap.Session, config string) string { return \"\" }";
// ZCL_APC_HOST as go/apc's Host, when this program compiled it (cmd/o4dserve's
// adapter): the query of the upgrade request as the handler's form fields
const apcAdapter = has("New_ZCL_APC_HOST") ? `
type apcHost struct{ h *ZCL_APC_HOST }

func (a apcHost) Open(s *abap.Session) bool         { return a.h.OPEN(s) == "X" }
func (a apcHost) Message(s *abap.Session, t string) { a.h.MESSAGE(s, t) }
func (a apcHost) Close(s *abap.Session, reason string, code int32) { a.h.CLOSE(s, reason, code) }
func (a apcHost) Drain(s *abap.Session) []string { return a.h.DRAIN(s) }

func newAPCHost(s *abap.Session, handler string, r *http.Request) apc.Host {
\t// in the order the URL has them, decoded as URLSearchParams decodes them
\t// for the Node host (apc.FormFields; url.ParseQuery would drop a pair with
\t// a bad escape or a ';')
\tfields := []*IHTTPNVP{}
\tfor _, f := range apc.FormFields(r.URL.RawQuery) {
\t\tfields = append(fields, &IHTTPNVP{${field("name")}: f[0], ${field("value")}: f[1]})
\t}
\treturn apcHost{New_ZCL_APC_HOST(s, handler, &fields)}
}
` : `
// ZCL_APC_HOST is not in this program: no channel is served
func newAPCHost(s *abap.Session, handler string, r *http.Request) apc.Host { return nil }
`;
writeMainGo("zz_boot.go", `package main

import (
\t"net/http"
\t"net/url"
\t"strings"

\t"osg/gogen/abap"
\t"osg/gogen/apc"
)

var _, _ = url.ParseQuery, strings.Split
${apcAdapter}
// the push channels (*.sapc.xml) whose handler this program has
var apcChannels = []apcChannel{
${channels.map((c) => `\t{Path: ${JSON.stringify(c.path)}, Name: ${JSON.stringify(c.name)}, Handler: ${JSON.stringify(c.handler)}},`).join("\n")}
}

// the push channels left out, and why
var apcLeftOut = []icfRefused{
${channelsLeftOut.map((s) => `\t{Path: ${JSON.stringify(s.path)}, Handler: ${JSON.stringify(s.handler)}, Why: ${JSON.stringify(s.why)}},`).join("\n")}
}

// generated by tools/gogen/osgo.mjs${echo ? " --echo" : ""}

// the checkout whose webapp/ is served unless -root says another
const osgRoot = "."

// what the Node hosts do at start: the SEGW registry and the search helps as providers
func boot(s *abap.Session) {
${boots.map((b) => `\t${b}(s)`).join("\n")}
}

${demoData}

// the shim's REQ and RES are the exchange (go/abap/icf.go)
func runShim(s *abap.Session, x *abap.ICFExchange, base string) {
\tCL_EXPRESS_ICF_SHIM_RUN(s, abap.Data{P: x}, abap.Data{P: x}, base)
}

var icfServices = []icfService{
${services.map((s) => `\t{Path: ${JSON.stringify(s.path)}, Handler: ${JSON.stringify(s.handler)}, Active: ${s.active}},`).join("\n")}
}

// the SICF nodes left out, each answered with a refusal at its own path
var notServed = []icfRefused{
${notServed.map((s) => `\t{Path: ${JSON.stringify(s.path)}, Handler: ${JSON.stringify(s.handler)}, Why: ${JSON.stringify(s.why)}},`).join("\n")}
}

const packTiles = ${JSON.stringify(JSON.stringify(tiles))}

// what the build was, for ZCL_OSD_SYSINFO's environment tab
const buildFacts = ${JSON.stringify(`build\t${program.classes.length} classes compiled, ${program.partial.length} statement stubs, ${program.skipped.length} methods not compiled; built ${builtAt} UTC`)}

var packWebapps = map[string]string{
${webapps.map((w) => `\t${JSON.stringify(w.path)}: ${JSON.stringify(relative(home, w.dir))},`).join("\n")}
}
`);
mkdirSync(join(here, ".out"), {recursive: true});
phase("emit");
// a generated package whose emission is unchanged gets its formatted copy
// back from .out/gofmt (gofmt-cache.mjs)
try {
  gofmtCached({dir, cacheDir: join(here, ".out", "gofmt"),
    files: layered ? ["core", "app"].map((p) => ({key: p, file: join(layersDir, p, "zz_generated.go")})) : []});
} catch (e) { console.log(`gofmt: ${String(e.stderr).split("\n").slice(0, 10).join("\n")}`); process.exit(1); }
phase("gofmt");
const t1 = performance.now();
// OSGO_GO_TRACE=<file>: go build's own trace of its actions (Chrome trace
// JSON), which tools/gogen/osgo-cycle.mjs reads for compile and link times
const goTrace = process.env.OSGO_GO_TRACE ? [`-debug-trace=${process.env.OSGO_GO_TRACE}`] : [];
try {
  withGoLintModule(join(here, "go"), lintEngine === "go" ? lintLib : undefined, modArgs =>
    execFileSync("go", ["build", ...modArgs, ...goTrace, "-o", out, "./cmd/osgo"], {cwd: join(here, "go"), stdio: ["ignore", "pipe", "pipe"], env: {...process.env, GOWORK: "off", GOPROXY: "off"}}));
} catch (e) {
  const lines = String(e.stderr).split("\n").filter((l) => /\.(go|abap):\d/.test(l) || /^#/.test(l));
  console.log(`go build failed; first:\n${lines.slice(0, 25).join("\n")}`);
  process.exit(1);
}
console.log(`go build ${Math.round(performance.now() - t1)} ms -> ${out}${existsSync(out) ? "" : " (missing!)"}`);
phase("go build");
if (!existsSync(out)) throw new Error("osgo build produced no binary");
if (sourceHash !== adtSourceHash()) throw new Error("ADT sources changed during osgo build; rebuild before gating");
writeFileSync(reportPath, JSON.stringify({classes: program.classes.map(c => c.name), adtSourceHash: sourceHash,
  statementStubs: program.partial, methodsNotCompiled: program.skipped}, null, 2) + "\n");
console.log(`${services.length} SICF nodes mounted, ${notServed.length} not served, ${webapps.length} pack folders, ${tiles.tiles.length} tiles, ${channels.length} push channels${channelsLeftOut.length ? ` (left out: ${channelsLeftOut.map((c) => `${c.path} ${c.why}`).join("; ")})` : ""}`);
phase("report");
writeFileSync(join(here, ".out", `${echo ? "osgo-echo" : "osgo"}-phases.json`), JSON.stringify({phases, layered, layers: layerInfo, fast: fastInfo}, null, 1) + "\n");
console.log(`phases (ms): ${Object.entries(phases).map(([k, v]) => `${k} ${v}`).join(", ")}`);
