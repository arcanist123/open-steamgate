#!/usr/bin/env node
// The dependency closure, by iteration (H5c). CLAUDE.md's Sprint-0
// prediction, made into a loop: a real service's classes transpile against
// this tree's libraries and its own sources -- everything else they name is
// the service's closure (its facades, their interfaces and exceptions, the
// DDIC their variables and SELECTs are typed by, the function groups their
// mapped operations live in) -- and the closure is the long pole. This tool
// walks it: validate, read the transpiler's own words, ask the dumper for
// what is missing, merge the answer into the build's inputs, repeat until a
// fixed point.
//
//   node tools/hana-closure.mjs --dump <dir> --system <prefix>
//        [--out <dir>] [--max-iterations <n>] [--dry-run]
//        [--stub-unresolved] [--max-stub-rounds <n>] [--defer-ddic]
//        [--require-unstubbed <glob>]...
//
//   --dump <dir>          the current dump directory (iteration 1's input;
//                         what `vsp hana dump` wrote for the service, the
//                         same directory hana-ddic-gen --from-dump reads).
//                         After a dumper round the loop's own dump is the
//                         one it just wrote, and the state remembers it. A
//                         --dump also answers a pending round by hand.
//   --system <prefix>     required: the dump->layers converter names its
//                         layers <system>-<package>, and hana-src-gen
//                         --from-dump needs the prefix.
//   --out <dir>           where the loop keeps its files; default
//                         gen/hana-closure -- state.json,
//                         closure-request.json and closure-gaps.json, all
//                         carrying a real tenant's object names, which is
//                         why gen/hana-closure is on the private gen/ list
//                         (tools/osd-tmp.mjs). The dumps are NOT here: they
//                         go to .local/hana-closure/dump-<NNN>/ (gitignored,
//                         private), one directory per dumper round.
//   --max-iterations <n>  at most n dumper rounds in this run (default 10).
//                         The cap stops the loop AFTER writing the pending
//                         request, so the next run picks up where this one
//                         stopped; the budget is per run, not per closure.
//   --dry-run             merge, validate, classify, write and print the
//                         request -- and stop, even when the dumper is
//                         configured.
//   --stub-unresolved     lazy activation (round 3; H5x-1 as fix round 1
//                         corrects it -- docs/db-backends.md). A class
//                         compiles as a whole or not at all, so the island
//                         must close every name a class MENTIONS. With the
//                         flag the body of every method whose findings do
//                         not resolve is replaced by the stub raise of
//                         zcx_osd_not_activated (`missing = '<names>'`, or
//                         the first finding's text when the findings name
//                         nothing, so a GET never reads "needs ''"). A
//                         method keeps its body only while a DDIC name of
//                         that method is still pending in THIS iteration's
//                         request: not asked yet, its object neither in the
//                         island nor excluded this run, the answer neither
//                         missing nor a merge refusal; nameless, present-
//                         only, resolved-but-still-failing and dead names
//                         all stub. Blocks are cut at abaplint's parsed
//                         positions, the stubbed source written back into
//                         gen/hana-src, every stub recorded in
//                         closure-stubs.json (--max-stub-rounds, default
//                         5). A DDIC-kind name a would-be-stubbed method
//                         names is asked from the dumper in the SAME
//                         iteration; only code kinds stay `deferred`
//                         (--defer-ddic keeps round 3). The nameless
//                         stubs' findings are the framework work list:
//                         framework-gaps.json beside the stubs, "framework
//                         gaps: N" on the line. Before anything is
//                         requested the island is checked by file name
//                         (abapGit naming; the XML present for the DDIC
//                         kinds; a code kind as .clas.abap OR .intf.abap):
//                         a name whose object the island holds is never
//                         requested, never a gap -- its finding is a
//                         cascade of that object's own, "cascade (present)"
//                         on the line. When no stub applies any more, the
//                         EXCLUSION decision runs over the whole island as
//                         a GRAPH analysis (tools/hana-closure-graph.mjs
//                         graphDecide, over references() edges; #933's
//                         text machinery is deleted): decided only when no
//                         definition-level name is pending, re-decided
//                         every iteration (the record carries the LAST
//                         decision); roots -- objects whose definition
//                         references a name answered missing, or whose
//                         definition findings name nothing -- are excluded
//                         together with the dependents that cannot compile
//                         without them ({level: "cascade", of: [roots]};
//                         definition-level references only: a dependent
//                         that references a root only in a body is
//                         stubbed, not excluded); cycles of present
//                         objects that name only each other are kept
//                         ({level: "cycle", members}); a FRIENDS clause
//                         naming an excluded object is stripped, never
//                         excluding; and NEVER a registered service's own
//                         class -- the MPC/DPC/_EXT pairs a registration
//                         names, or by suffix without one: the run fails
//                         instead. Since H5x-3 (fix round 1) the island's
//                         TEST CODE -- a class whose OWN definition is the
//                         ABAP unit-test framework's (FOR TESTING, or
//                         inheriting from or implementing the framework's
//                         classes/interfaces; never a class that merely
//                         references one) -- leaves the build before any of
//                         this is needed: recorded {testCode: true} in the
//                         record's roots, never stubbed, never asked, never
//                         a framework gap; a dependent of a test-code root
//                         falls as a CASCADE of it through the graph
//                         decision's seeds, and a FRIENDS clause naming one
//                         strips. Since
//                         H5x-2 the names come from the
//                         structural pass (references(), one SyntaxLogic
//                         pass per object): a signature-level miss (a
//                         parameter typed by a missing name) stays whole
//                         while its DDIC name is pending and is otherwise
//                         cut from the METHODS statement with the body
//                         stubbed, and a GLOBAL FRIENDS clause naming a
//                         gone object (excluded, or answered missing/
//                         refused) is stripped -- a friend that leaves
//                         costs the clause, never the class.
//   --defer-ddic          keeps round 3's behaviour: every name of a
//                         stubbed method is lazy, even the dictionary's.
//   --max-stub-rounds <n> the cap of the stub rounds above (default 5, and
//                         only read with --stub-unresolved).
//   --require-unstubbed <glob>
//                         repeatable: the fixed point FAILS when a seed
//                         class's method matching the glob (`*_GET_ENTITYSET`;
//                         `CLASS=>METHOD` with `=>`) is stubbed. Every fixed
//                         point writes closure-summary.json beside the record
//                         (tools/hana-closure-report.mjs) and fails as well
//                         when a seed class -- the registered service's
//                         MPC/DPC/_EXT -- is not an island object or is
//                         excluded: a green build without the service is the
//                         false green this guards against (H5x-4 B1).
//
// The layers accumulate (round 4): every dump is converted first, into
// .local/hana-closure/layers-<NNN>/ (OSD_HANA_CONVERTER through
// scriptCommandIn, one run per dump, remembered in state.json), and
// hana-src-gen is called with ALL of them -- the island is the UNION of
// the seed dump and every dump so far, later wins per object; the DDIC
// accumulates by hana-ddic-gen's own write mode (per-file overlays). The
// island's object count (classes+interfaces+tables) rides the iteration
// line and never shrinks, per kind (classes, interfaces, tables) -- a
// shrink aborts with both counts (bed run 5; per kind since round 5).
// No fixed point without a positive control (bed run 4): the build runs
// first -- exit 0 or non-zero-with-findings stands, non-zero with NO
// findings aborts with the build's FAILED line.
//
// The writer of record is per NAME (round 7): every DDIC name the dumps
// RESOLVED (manifest.closure.resolved per kind, accumulated in state.json)
// must have an XML in the island; the names without one -- the converter's
// TADIR package selection skipped them -- are written by hana-ddic-gen
// --from-dump --names for exactly those names, into gen/hana-ddic, where
// the converter's file wins where it wrote one (the later layer folder
// wins). The iteration line carries the per-kind gap counts and the
// resolved-vs-written DDIC counts, so a writer-of-record hole is visible.
//
// One iteration: merge the current dump into the inputs (hana-src-gen
// --layers writes gen/hana-src from ALL the layers dirs; gen/hana-ddic is
// written by hana-ddic-gen --from-dump ONLY when the layers carry no DDIC
// XML -- with the converter as the DDIC's writer of record the step is
// skipped, one log line says so -- spawned through tools/osd-host.mjs's
// toolCommandIn and scriptCommandIn, the way every tool a tool starts is;
// the DDIC tool's --from-dump is PR #926 (merged), and a tool that does
// not know the flag is refused with a message saying so),
// then run the
// build's own validation over the tree -- the same channel hana-ddic-gen
// --from-build reads, the validationMessage exported from there, reused and
// not duplicated -- and classify the findings OF THE ISLAND: the service
// lives in gen/hana-src/* and gen/hana-ddic/*, and the validation reports
// bare file names, so the island is a basename set collected from those
// folders. A finding outside it -- src/, packs/, another gen/ folder -- is
// the tree's own business: counted once per iteration line, never asked.
// A merge tool's refusal of one object (the H5a TABCLASS guard:
// `hana-ddic-map: <name>: TABCLASS APPEND is not written here`, the tool
// exits 2) does not stop the loop either: the refusal is parsed, the object
// is recorded as a gap (kind TABL, reason "unsupported TABCLASS APPEND" --
// the dictionary HAS it, the generator here cannot write it, asking cannot
// source it), and the step retries against a filtered copy of the dump in
// .local/hana-closure/ (DD02L.jsonl minus the refused rows). Every other
// finding the transpiler emits, of the island, is classified:
//
//   DDIC            `Database table or view "x" not found` (TABL);
//                   `contains unknown: X not found` (data element or the
//                   DDIC kind the dumper resolves, DTEL when the fix says
//                   lookupDataElement); `Contains unknown, X not found`
//                   (the error's first line); `contains unknown: X,
//                   lookupDomain` (DOMA); `field not part of structure
//                   x-comp` (a TABL structure)
//   program object  `Class x not found`, `Unknown class x` (CLAS, INTF for
//                   an if_* name), `CATCH, unknown class CX_*` (CLAS),
//                   `Super class "X" not found or contains errors` (CLAS,
//                   round 7), `Target type unknown, X` (round 7: the
//                   kind-less dictionary triple),
//                   `could not resolve top X` / `unable to resolve x`
//                   (INTF for an IF_* name), and a `parser_error` naming
//                   "FUNCTION" in a `*.fugr.*` file (the function group
//                   itself, its name read off the file)
//   cascade         `Method (or attribute) "m" not found`, `Component "c"
//                   not found in structure`, `Not an object reference`,
//                   `not a table type mt_*`, `... not found in class or
//                   interface`, `"param" not found` with fix findTop/Target
//                   -- the search-help exits' TABLES signatures, whose
//                   types arrive with the function group -- and since round
//                   7 (bed run 10): `Definition for "X" not found in
//                   scope(AttributeName)`, `Method parameter type not
//                   compatible`, `N cannot be instantiated, class is
//                   defined as protected`. Skipped: the name is not the
//                   thing that is missing.
//
// Names are upper-cased, de-duplicated, and split into fresh (never asked)
// and gaps (asked in an earlier round, still unresolved -- not in the
// tenant, or a kind this route cannot source yet). The gaps file carries
// each gap's TADIR kind, the first finding that named it and the number of
// validation passes that have named it; a dump manifest's `closure.missing`
// joins them with the kind they are missing under, read on every
// continuation -- the answer is per kind, and a name that resolved under
// one of the kinds it was asked under is one the dictionary HAS: the other
// kinds' `missing` is not "does not exist" and never makes it a gap. No
// fresh names is the fixed point. Otherwise the request goes to
// closure-request.json -- schema 1, the file the dumper's reader reads:
// requested/seen under the nine upper-case TADIR kinds, seen = every name
// an earlier iteration asked (so the dumper skips it), gaps = the current
// gaps, generation = the hash the merge's manifest carries of the dump's
// own manifest -- and the dumper runs:
//
//   $OSD_HANA_DUMPER hana dump --host <HANA_HOST> --port <HANA_PORT> \
//       --user <HANA_USER> --schema <HANA_SCHEMA> \
//       --provenance "hana-closure iteration <n>: the closure request's names" \
//       --ddic-closure <out>/closure-request.json \
//       --out <root>/.local/hana-closure/dump-<NNN> \
//       --skip-test-includes --allow-in-repo
//
// The loop's own log line for that command is redacted -- `--host <env>`
// and the like, never the values: a loop log is exactly what gets pasted
// into a report, and the values travel only in the by-hand command printed
// when no dumper is configured (and in the child's environment).
// --skip-test-includes is the dumper's own flag (round 7, off by default
// there) and rides on every call: the closure must never carry CCAU test
// includes (bed run 12 pulled SAP's unit-test assertion class through a
// facade's test include and stubbed six of its methods). The island rule
// for the files a dump carries anyway is hana-src-gen's (round 7).
//
// A name the transpiler names without a dictionary kind (the `ddic` bucket:
// the message says only that the type is unknown) is requested under TABL,
// DTEL and TTYP -- SHLP too when the finding itself says search help; the
// dumper answers what exists and reports the rest in `closure.missing`.
//
// OSD_HANA_DUMPER names the binary and OSD_HANA_DUMP_ENV an env file with
// the connection (KEY=VALUE lines, `#` comments, `export ` allowed):
// HANA_HOST/HANA_PORT/HANA_USER/HANA_SCHEMA become the argv flags the real
// dumper marks required, and HANA_PASSWORD becomes VSP_HANA_PASSWORD in the
// child's environment -- the one thing the dumper reads from the
// environment, and the one secret: nothing from the env file but the
// connection flags is on the argv. The dump lands under .local/
// (gitignored, inside the working tree, which the dumper refuses -- hence
// --allow-in-repo). The dumper is a foreign binary -- another project's,
// with credentials of its own -- so it is spawned by the path the
// environment names, never through toolCommand/scriptCommandIn (which would
// dispatch it through `osd gen` or put a node interpreter in front of it)
// and never process.execPath.
//
// The request is written BEFORE any dumper round, and writing it marks its
// names asked (state.json) and the round pending: with the dumper
// configured the next run executes the pending round first; a hand-run dump
// is continued with --dump <dir>, and names still unresolved there surface
// as gaps. --dry-run writes and prints the request and stops;
// --max-iterations bounds the rounds of a run and stops with the pending
// request on disk.
//
// **No HANA from here**: everything above the dumper is tested against a
// scratch tree and a fake dumper that mimics the real CLI contract (the
// required flags, the schema-1 request, the git-tree refusal unless
// --allow-in-repo, the password from VSP_HANA_PASSWORD only) --
// test/hana-closure.mjs, fixtures ZOSD_H5C_*; the real iteration is dell's,
// on the bed.
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {runsAs} from "./osd-main.mjs";
import {validationMessage} from "./hana-ddic-gen.mjs";
import {islandClassPaths, planStubPass, registeredServiceClasses, seedClasses, serviceGuardBySuffixOnly, dropPresentNames, frameworkGapList, objectFilePresent} from "./hana-closure-stubs.mjs";
import {buildCheck, ddicWritten, ensureLayers, generationOf, islandBasenames, islandObjectCount, islandShrinkCheck, mergeInputs} from "./hana-closure-merge.mjs";
import {dumperConfigured, dumpRound, printedCommand, provenanceFor} from "./hana-closure-dumper.mjs";
import {cascadeOf, classifyFindings, exclusionCandidates, nameFromAbapFile, parseFindings} from "./hana-closure-exclude.mjs";
import {analyseIsland, graphDecide, mergeNames, requestKindOf, structuralRegistry, testCodeObjects, waitsOf, writeClosureRecord} from "./hana-closure-graph.mjs";
import {closureSummary, has, liftedStubs, loadState, loadStubRecord, recordStub, saveState, stubList, take, takeAll, trackLifted, writeClosureSummary} from "./hana-closure-report.mjs";

// ------------------------------------------------------------ findings ----

// the classifier and the island-wide exclusion decision live in
// tools/hana-closure-exclude.mjs since fix round 2 (their own package, the
// size budget stays honest); re-exported here so every reader -- the tests,
// tools/hana-closure-merge.mjs, the probes -- keeps one import path.
export {parseFindings, classifyFindings, nameFromAbapFile} from "./hana-closure-exclude.mjs";
// the island's basename set lives with the merge module's other island
// facts (islandObjectCount, ddicWritten) since FIX-1; re-exported here so
// every reader -- the tests, the probes -- keeps one import path
export {islandBasenames} from "./hana-closure-merge.mjs";

// ------------------------------------------------------------- request ----

// the nine TADIR kinds, in the order the request file lists them
const TADIR = ["TABL", "DTEL", "DOMA", "TTYP", "SHLP", "CLAS", "INTF", "FUGR", "PROG"];

/** the TADIR kinds a classified name is requested under. A `ddic` name has
 *  no kind of its own -- the transpiler's wording says only that the type
 *  is unknown -- so it is asked under every dictionary kind the dumper
 *  resolves by name: TABL, DTEL and TTYP, plus SHLP when the finding's
 *  message says search help -- the message only, never the raw line (the
 *  raw ends in the file name, and a file called *searchhelpexits* must not
 *  classify). The dumper resolves what exists and reports
 *  the rest in its manifest's `closure.missing`, which the loop reads into
 *  the gaps. Pure. */
export function tadirKinds(kind, finding) {
  if (kind === "ddic") {
    // H5x-2: the structural ask carries no DOMA precision (the UnknownType's
    // error text says `lookup` for every kind-less miss), so the kind-less
    // triple grew DOMA -- the dumper answers what exists, per kind
    const kinds = ["TABL", "DTEL", "TTYP", "DOMA"];
    if (/search[ -]?help/i.test(String(finding ?? ""))) kinds.push("SHLP");
    return kinds;
  }
  const of = {tabl: "TABL", dtel: "DTEL", doma: "DOMA", clas: "CLAS", intf: "INTF", fugr: "FUGR"};
  return [of[kind] ?? "PROG"];
}

/** the request file's content, schema 1 -- exactly the keys the dumper's
 *  reader reads (`schema`, `iteration`, `requested`, `seen`; the rest is
 *  provenance for the walk): the fresh names per kind, every name an
 *  earlier iteration asked under the kinds it was requested under (so the
 *  dumper skips it), and the current gaps. `deferred` -- the stubbed
 *  methods' code names, only with --stub-unresolved -- and `excluded` --
 *  the definition-level exclusions' objects, never under deferred -- are
 *  OPTIONAL keys: the dumper's reader takes requested/seen and ignores
 *  unknown keys, so the file stays schema 1 with them beside. Pure. */
export function requestFor({iteration, generation, fresh, asked, gaps, deferred, excluded}) {
  const perKind = () => {
    const kinds = {};
    for (const kind of TADIR) kinds[kind] = [];
    return kinds;
  };
  const requested = perKind();
  for (const n of fresh ?? []) {
    for (const kind of tadirKinds(n.kind, n.message ?? n.finding)) {
      if (requested[kind].includes(n.name) === false) requested[kind].push(n.name);
    }
  }
  const seen = perKind();
  for (const [name, a] of Object.entries(asked ?? {})) {
    const kinds = a.kinds ?? [String(a.kind ?? "").toUpperCase()].filter((k) => k !== "");
    for (const kind of kinds) {
      if (seen[kind] !== undefined && seen[kind].includes(name) === false) seen[kind].push(name);
    }
  }
  const result = {
    schema: 1,
    iteration,
    generation: generation ?? "",
    source: "transpile validate() findings",
    requested,
    seen,
    gaps: (gaps ?? []).map((g) => ({name: g.name, kind: g.kind, first_finding: g.first_finding, iterations_requested: g.iterations_requested})),
  };
  if (deferred !== undefined) {
    const list = perKind();
    for (const n of deferred) {
      for (const kind of tadirKinds(n.kind, n.message ?? n.finding)) {
        if (list[kind].includes(n.name) === false) list[kind].push(n.name);
      }
    }
    result.deferred = list;
  }
  if (excluded !== undefined && excluded.length > 0) {
    const list = perKind();
    for (const n of excluded) {
      for (const kind of tadirKinds(n.kind, n.message ?? n.finding)) {
        if (list[kind].includes(n.name) === false) list[kind].push(n.name);
      }
    }
    result.excluded = list;
  }
  return result;
}

// ---------------------------------------------------------------- loop ----

// the state file and the argv helpers live in tools/hana-closure-report.mjs
// since H5x-4 B1, with the stub record and the run summary

// the request's `generation` (the merge manifest's sha) and the dumper
// round's provenance live with their modules since FIX-1: generationOf in
// tools/hana-closure-merge.mjs (it reads the merge's own manifest),
// provenanceFor in tools/hana-closure-dumper.mjs (the dumper's contract)

// the dumper round and the by-hand command live in
// tools/hana-closure-dumper.mjs since H5x-1: their own package, the size
// budget stays honest

/** one iteration to the fixed point, or one stop on the way to it. The
 *  result says which: "fixed-point" (everything the closure names is in the
 *  build or in the gaps file), "dry-run", "no-dumper" (with the command to
 *  run by hand), or "cap" (with the pending request on disk). */
export async function run(args = process.argv.slice(2), options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const env = options.env ?? process.env;
  const say = options.say ?? ((m) => console.log(`hana-closure: ${m}`));
  const out = resolve(root, take(args, "--out") ?? join("gen", "hana-closure"));
  const dumpArg = take(args, "--dump");
  const system = take(args, "--system");
  const maxIterations = Number(take(args, "--max-iterations") ?? "10");
  const maxStubRounds = Number(take(args, "--max-stub-rounds") ?? "5");
  const stubUnresolved = has(args, "--stub-unresolved");
  const deferDdic = has(args, "--defer-ddic");
  const requireUnstubbed = takeAll(args, "--require-unstubbed");
  const dryRun = has(args, "--dry-run");
  if (args.length > 0) throw new Error(`hana-closure: unknown option ${args.find((a) => a.startsWith("--")) ?? args[0]}`);
  if (Number.isInteger(maxIterations) === false || maxIterations < 0) {
    throw new Error("hana-closure: --max-iterations needs a number >= 0");
  }
  if (Number.isInteger(maxStubRounds) === false || maxStubRounds < 0) {
    throw new Error("hana-closure: --max-stub-rounds needs a number >= 0");
  }
  if (system === undefined) {
    throw new Error("hana-closure: --system <prefix> is required (the dump->layers converter names its layers <system>-<package>)");
  }
  mkdirSync(out, {recursive: true});
  // the seam readers follow OSD_HANA_CLOSURE_OUT when --out is not the default
  env.OSD_HANA_CLOSURE_OUT = out;
  const loaded = loadState(out);
  const state = loaded ?? {iteration: 1, asked: {}};
  state.missing ??= {};
  state.refused ??= {};
  if (dumpArg === undefined && state.dump === undefined) {
    throw new Error(`hana-closure: no dump known: pass --dump <dir> (the dump the build's inputs are made of)`);
  }
  if (dumpArg !== undefined) {
    state.dump = resolve(root, dumpArg);
    // a hand-run dump supersedes a pending round (critic r2's S-e; fourth
    // round asked): left behind, the next configured run re-executes the
    // answered round into an --out the dumper refuses as non-empty
    delete state.pending;
  }
  let dump = resolve(root, state.dump);
  saveState(out, state);
  const requestPath = join(out, "closure-request.json");

  // a pending round: a request was written and its names are asked, but no
  // dump has answered it yet. With the dumper configured this run executes
  // the pending round first (the promise the dry-run and the cap make: the
  // next run picks up where the last one stopped); --dump on the command
  // line is a hand-run answer and supersedes it; without the dumper the
  // pending command is printed again, and nothing is merged -- the pending
  // dump does not exist.
  if (state.pending !== undefined && dumpArg === undefined) {
    if (existsSync(requestPath) === false) {
      throw new Error(`hana-closure: the state's pending round (iteration ${state.pending.iteration}) has no request on disk: ${requestPath} is gone; remove state.json's pending or start over`);
    }
    if (dumperConfigured(env) === false) {
      const dumpDir = state.pending.dumpDir;
      const command = printedCommand(env, requestPath, dumpDir, provenanceFor(state.pending.iteration));
      say(`no dumper here: OSD_HANA_DUMPER (the binary) and OSD_HANA_DUMP_ENV (an env file with the connection) are not both set. The pending request is ${requestPath}; run the dumper by hand and continue with --dump ${dumpDir}:`);
      say(`  ${command}`);
      return {stopped: "no-dumper", iteration: state.pending.iteration, command};
    }
    dumpRound({root, env, say, requestPath, dumpDir: state.pending.dumpDir, provenance: provenanceFor(state.pending.iteration)});
    state.dump = state.pending.dumpDir;
    state.iteration = state.pending.iteration;
    delete state.pending;
    saveState(out, state);
    dump = resolve(root, state.dump);
  }

  // every merge converts its dump first: no converter configured, no walk
  // (a pending round without the dumper returned above -- printing the
  // by-hand command needs no converter)
  if (env.OSD_HANA_CONVERTER === undefined || env.OSD_HANA_CONVERTER === "") {
    throw new Error("hana-closure: OSD_HANA_CONVERTER must name the dump->layers converter (a path to dump-to-layers.mjs): every merge converts its dump into .local/hana-closure/layers-<NNN> first");
  }

  // the dumper budget of this run; a resumed run has its own
  let rounds = 0;
  // the stubs, once per (class, method) (H5x-4 B1), of the CURRENT
  // iteration (M3 B5.1, the lift rule in tools/hana-closure-report.mjs);
  // a resumed run's iteration before is the record on disk
  let stubMap = stubUnresolved === true && loaded !== undefined ? loadStubRecord(out) : new Map();
  let previousStubs = new Map();
  const liftedMap = new Map();
  let liftedNow = 0;
  const stubRecords = () => stubList(stubMap);
  for (;;) {
    // what the dump's own manifest says the dictionary answered, read on
    // every continuation: every name in closure.missing (the requested
    // names the dictionary does not have) joins the gaps with the kind it
    // is missing under; a name a later round reports resolved leaves them.
    // The answer is PER KIND -- a kind-less name is asked under TABL, DTEL
    // and TTYP, and a name that resolved under one of them is one the
    // dictionary HAS: `missing` under the other two is not "does not
    // exist", so it must not re-enter the gaps over a resolution. A
    // hand-written dump without a manifest answers nothing here.
    try {
      const manifest = JSON.parse(readFileSync(join(dump, "manifest.json"), "utf8"));
      const resolved = new Set();
      // and they accumulate per kind (round 7): the per-name DDIC fill and
      // the resolved-vs-written counts of the iteration line read them
      // across all the dumps of the walk
      state.resolved ??= {};
      for (const [kind, list] of Object.entries(manifest.closure?.resolved ?? {})) {
        state.resolved[kind] = [...new Set([...(state.resolved[kind] ?? []),
          ...list.map((n) => String(n).trim().toUpperCase())])];
        for (const name of state.resolved[kind]) resolved.add(name);
      }
      for (const name of resolved) delete state.missing[name];
      for (const [kind, list] of Object.entries(manifest.closure?.missing ?? {})) {
        for (const name of list) {
          const upper = String(name).trim().toUpperCase();
          if (state.asked[upper] !== undefined && resolved.has(upper) === false) {
            state.missing[upper] = {kind, iteration: state.asked[upper].iteration};
          }
        }
      }
      // and the kinds the dumper's closure does not follow (FIX-1's dumper
      // update): the name was asked, the dictionary existence is UNANSWERED
      // -- a gap with the reason, unless a kind's missing already said
      // does-not-exist (that is the stronger word) or a round resolved it
      for (const [kind, list] of Object.entries(manifest.closure?.unhandled ?? {})) {
        for (const name of list) {
          const upper = String(name).trim().toUpperCase();
          if (state.asked[upper] !== undefined && resolved.has(upper) === false && state.missing[upper] === undefined) {
            state.missing[upper] = {kind, iteration: state.asked[upper].iteration, reason: "unhandled by the dumper's closure"};
          }
        }
      }
      saveState(out, state);
    } catch {
      // no manifest, no closure: the findings are the only word
    }

    // the layers dirs of the walk so far, this iteration's dump converted
    // first when new (round 4's accumulation; the loop saves state.layers)
    const layersDirs = ensureLayers({root, state, dump, system, env, say});
    saveState(out, state);
    // the per-name DDIC fill (round 7): the names the dumps RESOLVED minus
    // the DDIC XMLs the island already carries, written by
    // hana-ddic-gen --from-dump --names, newest dump first
    const fill = Object.keys(state.resolved ?? {}).length > 0
      ? {resolved: state.resolved, dumps: [...state.layers].reverse().map((l) => l.dump)}
      : undefined;
    const {refused} = mergeInputs(root, dump, layersDirs, env, say, fill);
    // the merge refusals join the state's (the gap stands while the object
    // is in no build) and leave when a dump the merge handled carries the
    // name again without a refusal -- the generator wrote it at last; a
    // delta dump that lost the name is not a resolution
    for (const r of refused) state.refused[r.name] = {kind: r.kind, reason: r.reason, first_finding: r.first_finding};
    if (refused.length > 0) {
      saveState(out, state);
    } else {
      const handled = (() => {
        try {
          return readFileSync(join(dump, "tables", "DD02L.jsonl"), "utf8").split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => String(JSON.parse(l).TABNAME ?? "").trim().toUpperCase());
        } catch {
          return [];
        }
      })();
      for (const name of handled) delete state.refused[name];
      saveState(out, state);
    }

    // the accumulation's control (round 4): the island's object count never
    // shrinks between iterations -- a shrink is a merge that lost objects,
    // and a fixed point over it is false (bed run 5's)
    const objects = islandObjectCount(root);
    if (state.islandObjects !== undefined) islandShrinkCheck(state.islandObjects, objects, state.iteration);
    state.islandObjects = objects;
    saveState(out, state);

    // only the island's findings are the service's: the validation reports
    // bare file names, so the scope is the island's basename set, and a
    // finding outside gen/hana-src or gen/hana-ddic is the tree's own
    // business, counted once, never asked
    const island = islandBasenames(root);
    // this ITERATION's exclusions: cleared and re-decided whenever the
    // island grows; the wipe makes the first validation read no stale
    // record, the graph rounds write the last decision.
    const excludedRecords = [];
    const excludedObjects = new Set();
    // the stub record restarts with the re-laid island (M3 B5.1)
    previousStubs = stubMap;
    stubMap = new Map();
    if (stubUnresolved === true) writeClosureRecord(out, {stubRecords: stubRecords(), excludedRecords, waits: []});
    // the structural pass (H5x-2): one SyntaxLogic pass per island object
    // over the build's own file set -- the names' primary source and the
    // graph decision's input, in both modes
    const analysis = analyseIsland({reg: await structuralRegistry(root, say),
      root, classPaths: islandClassPaths(root)});
    let all = parseFindings(await validationMessage(root, join(out, "closure-stubs.json")));
    let findings = all.filter((f) => island.has(f.file));
    // FIX-1: this iteration's analysis errors, keyed by file ("red, unknown
    // cause" -- kept, never excluded); without --stub-unresolved this is the
    // record's only write, the audit trail of what the walk could not analyse
    const errorRecords = new Map((analysis.errors ?? []).map((e) => [e.file, e]));
    if (stubUnresolved === false && errorRecords.size > 0) writeClosureRecord(out,
      {stubRecords: stubRecords(), excludedRecords, waits: [], errors: [...errorRecords.values()]});
    // lazy activation (--stub-unresolved) as fix round 1 corrects it: a
    // method keeps its body only while a DDIC name of its is still pending
    // in THIS iteration's request; nameless, present-only, resolved-but-
    // still-failing and dead names all stub, the raise carrying the
    // finding's text when no name exists; the nameless stubs' findings are
    // the framework work list; a class whose definition findings name
    // nothing still pending is EXCLUDED in a quiescent round (registered
    // service's own classes fail the run instead)
    const deferredPairs = new Map();
    const eagerNames = new Map();
    // the objects whose planning threw this iteration (FIX-1): out of the
    // decision's material entirely -- kept in the build, never excluded
    const planErrored = new Set();
    let stubRounds = 0;
    let frameworkGaps = 0;
    let cycles = 0;
    let guardBySuffix = false;
    let testExcluded = new Set();
    if (stubUnresolved === true) {
      const classPaths = islandClassPaths(root);
      const islandFiles = island;
      const guard = registeredServiceClasses(root);
      guardBySuffix = serviceGuardBySuffixOnly(root);
      const objectOf = (basename) => nameFromAbapFile(basename.replace(/\..*$/, ""));
      // fix round 2, item 1: the EXCLUSION's own predicate, stricter than
      // the stub's -- a name is pending until a dump ANSWERED it: unasked,
      // or asked with no missing/refused/resolved answer recorded. A merge
      // refusal is answered (the filtered-dump retry settled it this
      // iteration; a later dump carrying the name lifts it, and the
      // per-iteration re-decision un-excludes whatever it excluded).
      const resolvedSet = new Set(Object.values(state.resolved ?? {}).flat());
      const pendingAtFixedPoint = (name, kind) =>
        objectFilePresent(name, kind, islandFiles) === false &&
        state.missing[name] === undefined && state.refused[name] === undefined &&
        excludedObjects.has(name) === false &&
        (state.asked[name] === undefined || resolvedSet.has(name) === false);
      // a name gone from the build -- excluded, or answered
      // missing/refused: the FRIENDS strip's predicate
      const goneOf = (name) => excludedObjects.has(name) === true ||
        state.missing[name] !== undefined || state.refused[name] !== undefined;
      // this run's framework gaps: one entry per distinct nameless finding text
      const gapFindings = new Map();
      const analysisObjects = analysis.objects;
      const byObject = new Map(analysisObjects.map((o) => [o.object, o]));
      const defNamesOf = (o) => (o.unknowns ?? []).filter((u) => u.level === "definition")
        .map((u) => ({name: u.name, kind: requestKindOf(u.name, u), via: u.via}));
      const upsertRecord = (rec) => {
        const at = excludedRecords.findIndex((r) => r.object === rec.object);
        if (at >= 0) excludedRecords[at] = rec;
        else excludedRecords.push(rec);
      };
      const writeRecord = () =>
        writeClosureRecord(out, {stubRecords: stubRecords(), excludedRecords,
          waits: waitsOf(analysisObjects.filter((o) => testExcluded.has(o.object) === false), pendingAtFixedPoint),
          errors: [...errorRecords.values()]});
      // H5x-3, fix round 1: the island's test code is a class whose OWN
      // definition is test code (FOR TESTING, or inheriting from or
      // implementing the ABAP unit-test framework's classes/interfaces --
      // testCodeObjects). Nothing else: the first round closed this
      // transitively and the bed's registered service's own DPC was dragged
      // in by the test helpers it merely names (two AUNIT-mentioning EPM
      // test classes pulled the whole EPM layer, and the DPC's source names
      // its own _EXT), so the seed guard killed the run. The roots leave
      // the build here (records; never stubbed, never asked, never a
      // framework gap); their DEPENDENTS fall as cascades of them through
      // the graph decision (#934), which the quiescent round makes with
      // these roots as seeds -- never as test code -- and a FRIENDS clause
      // naming a root strips, as for any excluded object. A registered
      // service's own class still fails the run.
      const testCode = testCodeObjects(analysisObjects, (o) => {
        try {
          return readFileSync(join(root, o.file), "utf8");
        } catch {
          return undefined;
        }
      });
      testExcluded = testCode.all;
      for (const name of [...testExcluded].sort()) {
        if (guard.has(name) === true) {
          const how = guardBySuffix === true
            ? "recognised by suffix (no registration in gen/hana-segw or the island's *.iwsv.xml / *.iwmo.xml)"
            : "gen/hana-segw or the island's *.iwsv.xml / *.iwmo.xml";
          throw new Error(`hana-closure: ${name} is a registered service's own class (${how}): the unit-test-framework rule would exclude it -- the service itself cannot be excluded from the build, the run fails`);
        }
        const o = byObject.get(name);
        if (o === undefined) continue;
        excludedRecords.push({level: "definition", object: name, file: o.file, kind: o.kind,
          missing: [], findings: [], testCode: true});
        excludedObjects.add(name);
      }
      if (testExcluded.size > 0) {
        say(`test code: ${testExcluded.size} island object(s) out of the build (a class whose own definition is the ABAP unit-test framework's, H5x-3)`);
        writeRecord();
      }
      for (;;) {
        const byFile = new Map();
        for (const f of findings) {
          if (/\.(?:clas\.abap|clas\.locals_imp\.abap|intf\.abap)$/.test(f.file) === false) continue;
          const list = byFile.get(f.file) ?? [];
          list.push(f);
          byFile.set(f.file, list);
        }
        if (byFile.size === 0) {
          say(`stub: no stubbable finding remains after ${stubRounds} round(s)`);
          break;
        }
        if (stubRounds >= maxStubRounds) {
          say(`stub cap: --max-stub-rounds ${maxStubRounds} reached with ${byFile.size} class file(s) still naming findings; their names stay in the request`);
          break;
        }
        const planned = [];
        for (const [basename, list] of byFile) {
          for (const path of (classPaths.get(basename) ?? []).sort()) {
            let source;
            try {
              source = readFileSync(path, "utf8");
            } catch {
              say(`stub: ${basename} could not be read; its findings stay in the request`);
              continue;
            }
            const object = objectOf(basename);
            if (planErrored.has(object) === true) continue;
            if (testExcluded.has(object) === true) continue;
            const refs = byObject.get(object)?.unknowns ?? [];
            let plan;
            try {
              plan = planStubPass({source, findings: list, basename, refs,
                missingOf: (name) => state.missing[name] !== undefined,
                asked: (name) => state.asked[name] !== undefined,
                refusedOf: (name) => state.refused[name] !== undefined,
                islandFiles, excludedObjects, deferDdic, goneOf});
            } catch (error) {
              // FIX-1: one file's planning must not stop the walk -- recorded,
              // the object leaves the decision material (kept, never excluded)
              const message = String(error?.message ?? error);
              const file = path.slice(root.length + 1);
              say(`stub: ${basename} could not be planned (${message}); its findings stay in the request, the object stays in the build`);
              errorRecords.set(file, {file, error: message});
              planErrored.add(object);
              continue;
            }
            for (const n of plan.nameless) {
              const entry = gapFindings.get(n.finding) ??
                {finding: n.finding, ...(n.member !== undefined ? {member: n.member} : {}), used_by: []};
              entry.used_by.push({file: basename, line: n.line, method: n.method});
              gapFindings.set(n.finding, entry);
            }
            if (plan.unparseable === true) {
              say(`stub: ${basename} does not parse; its findings stay in the request`);
            }
            planned.push({basename, object, file: path.slice(root.length + 1), path, source,
              plan, unmatched: plan.unparseable === true ? list : plan.unmatched});
          }
        }
        // the decision's material: every island object's definition-level
        // references (the graph), beside this round's findings outside
        // every method body -- signature-line findings are the stub pass's
        const planByFile = new Map(planned.map((p) => [p.basename, p]));
        const objects = analysisObjects.filter((o) => planErrored.has(o.object) === false && testExcluded.has(o.object) === false).map((o) => {
          const sigLines = new Set(o.signatureLines ?? []);
          const entry = {object: o.object, defNames: defNamesOf(o),
            edges: (o.edges ?? []).filter((e) => e.level === "definition").map((e) => e.to),
            friends: o.friends ?? [], nameless: [], findings: []};
          for (const base of o.files ?? []) {
            const p = planByFile.get(base);
            for (const f of (p !== undefined ? p.plan.unmatched : [])) {
              if (sigLines.has(f.line) === true) continue;
              entry.findings.push(f.raw);
              // a super or friend wording names nothing the classifier
              // could ask (both names travel structurally): never a
              // nameless root -- the strip and the graph handle them
              const tag = cascadeOf(f.message);
              if (tag !== "friend" && tag !== "super" && classifyFindings([f]).names.length === 0) {
                entry.nameless.push(f.raw);
              }
            }
          }
          return entry;
        });
        // a file whose definition material is settled holds its stubs back
        // for the decision (the hold) -- but a blocked decision decides
        // nothing and a decided file that STAYS needs its stubs: they
        // apply then (S-2.2)
        const candidateFiles = [];
        for (const p of planned) {
          const existing = candidateFiles.find((c) => c.object === p.object);
          if (existing === undefined) {
            candidateFiles.push({object: p.object, defNames: defNamesOf(byObject.get(p.object) ?? {}), unmatched: [...p.unmatched]});
          } else {
            existing.unmatched.push(...p.unmatched);
          }
        }
        const held = exclusionCandidates({files: candidateFiles, pendingOf: pendingAtFixedPoint});
        const applied = [];
        let friendStrips = 0;
        const applyPlans = (entries) => {
          for (const entry of entries) {
            if (entry.plan.unparseable === true) continue;
            if (entry.plan.source !== entry.source) writeFileSync(entry.path, entry.plan.source);
            friendStrips += entry.plan.friendsStripped?.length ?? 0;
            for (const stub of entry.plan.stubs) {
              applied.push(entry.object);
              recordStub(stubMap, {object: entry.object, file: entry.file, class: stub.className,
                method: stub.method, missing: stub.missing, finding: stub.finding,
                ...(stub.signature === true ? {signature: true} : {})}, previousStubs);
            }
            for (const nk of entry.plan.deferred) deferredPairs.set(nk.name, {name: nk.name, kind: nk.kind, finding: nk.finding});
            for (const e of entry.plan.eager) eagerNames.set(e.name, e);
          }
        };
        applyPlans(planned.filter((p) => held.has(p.object) === false));
        let excludedNow = 0;
        if (applied.length === 0 && planned.length > 0) {
          // quiescent: no stub applied this round -- the whole island is
          // decided at once, dependents falling with their roots in the
          // same decision (the graph needs no transpiler roundtrip)
          const decision = graphDecide({objects,
            pendingOf: pendingAtFixedPoint,
            statusOf: (name, kind) => excludedObjects.has(name) === true ? "excluded"
              : objectFilePresent(name, kind, islandFiles) === true ? "present" : "absent",
            guard,
            guardMode: guardBySuffix === true ? "suffix" : "registration",
            // the island's test-code roots: already excluded above; here
            // they are graph nodes, so their dependents fall as cascades
            // of them (H5x-3 fix round 1: the dependents are #934's
            // cascades, never test code themselves)
            seeds: testExcluded});
          if (decision.blocked === true) {
            // S-2.2: nothing is decided this round -- the hold limbo would
            // leave a capped run red forever; the held files' stubs and
            // strips apply after all (the decision re-reads the island
            // next round from whatever the sources then are)
            applyPlans(planned.filter((p) => held.has(p.object) === true));
          } else {
            for (const r of decision.roots) {
              const o = byObject.get(r.object);
              upsertRecord({level: "definition", object: r.object, file: o.file, kind: o.kind,
                missing: r.missing, findings: objects.find((x) => x.object === r.object)?.findings ?? []});
              excludedObjects.add(r.object);
              excludedNow += 1;
              say(`excluded: ${r.object} (${o.file}): its definition references ${r.missing.join(", ") || "nothing it can reach (nameless findings)"} -- the file stays in its layer on disk, the build is kept from it`);
            }
            for (const c of decision.cascades) {
              const o = byObject.get(c.object);
              upsertRecord({level: "cascade", object: c.object, file: o.file, kind: o.kind, of: c.of,
                findings: objects.find((x) => x.object === c.object)?.findings ?? [], excluded: true});
              excludedObjects.add(c.object);
              excludedNow += 1;
              say(`excluded: ${c.object} (${o.file}): cascade of ${c.of.join(", ")} -- the file leaves the build with them`);
            }
            for (const cy of decision.cycles) {
              cycles = Math.max(cycles, cy.members.length);
              const findingsMap = {};
              for (const m of cy.members) findingsMap[m] = objects.find((x) => x.object === m)?.findings ?? [];
              upsertRecord({level: "cycle", members: cy.members, kept: true, findings: findingsMap});
              say(`cycle: ${cy.members.join(", ")} -- kept in the build (a residual cycle is a checker limit, not a reason to exclude)`);
            }
            for (const s of decision.strips) {
              const o = byObject.get(s.object);
              upsertRecord({level: "cascade", object: s.object, file: o.file, kind: o.kind, of: s.of,
                edge: "friends", action: "strip-friends",
                findings: objects.find((x) => x.object === s.object)?.findings ?? [], excluded: false});
              say(`friends: ${s.object} strips GLOBAL FRIENDS ${s.of.join(", ")} (a friend that leaves costs the clause, not the class)`);
            }
            // the held files that STAY in the build get their plans after
            // all -- only an excluded file's plans are moot
            applyPlans(planned.filter((p) => held.has(p.object) === true && excludedObjects.has(p.object) === false));
          }
        }
        if (applied.length === 0 && excludedNow === 0 && friendStrips === 0) {
          say(`stub: ${byFile.size} class file(s) name findings, but none could be stubbed (definition-level, or awaiting the dumper's DDIC answer); the names stay in the request`);
          break;
        }
        stubRounds += 1;
        const perClass = new Map();
        for (const cls of applied) perClass.set(cls, (perClass.get(cls) ?? 0) + 1);
        for (const [cls, count] of perClass) {
          say(`stub round ${stubRounds}: ${cls}: ${count} method(s) stubbed (generation ${generationOf(root) || "none"})`);
        }
        if (excludedNow > 0 || gapFindings.size > 0 || excludedRecords.length > 0 || friendStrips > 0) {
          // the seam reads closure-stubs.json: written before the
          // revalidation, so the findings leave at once
          writeRecord();
          writeFileSync(join(out, "framework-gaps.json"), JSON.stringify(frameworkGapList(gapFindings), null, 2) + "\n");
        }
        all = parseFindings(await validationMessage(root, join(out, "closure-stubs.json")));
        findings = all.filter((f) => island.has(f.file));
      }
      writeRecord();
      writeFileSync(join(out, "framework-gaps.json"),
        JSON.stringify(frameworkGapList(gapFindings, (file) => guard.has(objectOf(file))), null, 2) + "\n");
      frameworkGaps = gapFindings.size;
      const lifted = liftedStubs(previousStubs, stubMap, excludedObjects);
      liftedNow = lifted.length;
      trackLifted(liftedMap, previousStubs, stubMap, excludedObjects);
      for (const s of lifted) say(`lifted: ${s.class}=>${s.method} (${s.object}) -- its reason no longer holds, the body is back`);
    }
    const unscoped = all.length - findings.length;
    // the names: the references first, then the text fallback for the
    // findings no reference carries (H5x-2)
    const analysisForNames = testExcluded.size > 0
      ? {...analysis, objects: analysis.objects.filter((o) => testExcluded.has(o.object) === false)}
      : analysis;
    const {names: structuralNames, structuralCount, rest} = mergeNames(
      {analysis: analysisForNames, findings, classPaths: islandClassPaths(root)});
    const classified = classifyFindings(rest);
    // H5x-1: a name whose object is in the island -- by file name for
    // CLAS/INTF, by the XML present for the DDIC kinds -- is never
    // requested and never a gap, whatever asked for it before: the finding
    // is a CASCADE of that object's own findings, counted below as
    // "cascade (present)". An object excluded this run is out of the
    // build; its name rides the request's excluded key instead.
    const {names, present} = dropPresentNames([...structuralNames, ...classified.names], island, excludedObjects);
    const cascades = classified.cascades;
    const unclassified = classified.unclassified;
    // and the stubs' eager DDIC names (H5x-1): asked like any classified name
    for (const e of eagerNames.values()) {
      if (names.some((n) => n.name === e.name) === false) names.push(e);
    }

    // the names the stubs wait for are not gaps, they are "not needed yet":
    // they leave requested and the gaps file and travel in the request's
    // `deferred` -- unless a finding that was not stubbed still names them
    // (a definition-level use), which is the request's business as today
    const deferredOnly = [];
    for (const [name, entry] of deferredPairs) {
      if (names.some((n) => n.name === name) === false) deferredOnly.push(entry);
    }
    const deferredOnlyNames = new Set(deferredOnly.map((d) => d.name));
    const fresh = names.filter((n) => state.asked[n.name] === undefined);
    // asked and still unresolved; the dumper's missing answer names the kind
    // when it has one. iterations_requested counts the validation passes
    // that have named the gap, the first one included.
    const gapNames = new Set();
    const gaps = [];
    const gapOf = (name, kind, a) => {
      gapNames.add(name);
      const reason = state.missing[name]?.reason;
      return {
        name,
        kind,
        first_finding: a.finding,
        iterations_requested: state.iteration - a.iteration + 2,
        ...(reason !== undefined ? {reason} : {}),
      };
    };
    for (const n of names) {
      const a = state.asked[n.name];
      if (a === undefined) continue;
      gaps.push(gapOf(n.name, state.missing[n.name]?.kind ?? a.kinds[0], a));
    }
    for (const name of Object.keys(state.missing).sort()) {
      const a = state.asked[name];
      if (a === undefined || gapNames.has(name)) continue;
      if (stubUnresolved === true && deferredOnlyNames.has(name) === true) continue;
      gaps.push(gapOf(name, state.missing[name].kind, a));
    }
    // and the merge refusals: objects the dictionary HAS but the generator
    // here cannot write -- recorded with the refusal as their first finding
    // and a reason, never iterations_requested (they were never asked; the
    // request cannot source them, so they do not go into it either)
    const refusedGaps = Object.keys(state.refused).sort()
      .filter((name) => gapNames.has(name) === false)
      .map((name) => ({name, kind: state.refused[name].kind, first_finding: state.refused[name].first_finding, reason: state.refused[name].reason}));
    // recomputed every pass: a gap that a later round resolves leaves the
    // file on its own
    writeFileSync(join(out, "closure-gaps.json"), JSON.stringify({gaps: [...gaps, ...refusedGaps]}, null, 2) + "\n");
    // per-kind gap counts and resolved-vs-written DDIC counts on the line
    // (round 7): a writer-of-record hole is written < resolved, visible
    // before anything asks
    const gapKinds = [...new Set(gaps.map((g) => g.kind))].sort()
      .map((k) => `${k} ${gaps.filter((g) => g.kind === k).length}`).join(", ");
    const writtenDdic = ddicWritten(root);
    const ddicCounts = TADIR.filter((k) => (state.resolved?.[k] ?? []).length > 0)
      .map((k) => `${k} ${state.resolved[k].length}/${writtenDdic[k]?.size ?? 0}`).join(", ");
    say(`iteration ${state.iteration}: ${fresh.length} new name(s), ${gaps.length} gap(s), ${unscoped} outside the island (not asked), ${refusedGaps.length} merge-refusal gap(s), ${cascades} cascade finding(s) skipped, ${structuralCount} structural, ${unclassified.length} unclassified${stubUnresolved === true ? `, ${deferredOnly.length} deferred by stubs, ${stubMap.size} stubbed method(s), ${liftedNow} lifted, framework gaps: ${frameworkGaps}${cycles > 0 ? `, ${cycles} cycle member(s) kept` : ""}` : ""}, ${objects.total} island object(s)${gapKinds !== "" ? `, gaps by kind: ${gapKinds}` : ""}${ddicCounts !== "" ? `, DDIC resolved/written: ${ddicCounts}` : ""}, ${present} cascade (present)${excludedRecords.length > 0 ? `, ${excludedRecords.filter((r) => r.level !== "cycle").length} excluded` : ""}${stubUnresolved === true && guardBySuffix === true ? ", service guard: by suffix, no registration" : ""}`);
    for (const line of unclassified) say(`unclassified: ${line}`);

    if (fresh.length === 0) {
      // the positive control (round 4): a validation with no findings and a
      // broken build was bed run 4's false fixed point -- the build's own
      // exit must agree before the declaration
      const build = buildCheck({root, env, say});
      if (build.findings > 0) say(`build: exited ${build.status} with ${build.findings} finding(s) -- exit 1 with findings only, the fixed point stands`);
      say(`fixed point: every unresolved name has been asked and nothing new is named; ${gaps.length + refusedGaps.length} gap(s) -> ${join(out, "closure-gaps.json")}`);
      const seeds = seedClasses(root);
      writeClosureSummary(out, closureSummary({iterations: state.iteration, islandObjects: objects.total, seeds: seeds.all, named: seeds.named,
        present: (name) => objectFilePresent(name, "clas", island), excluded: excludedObjects, stubs: stubRecords(), lifted: [...liftedMap.values()], gaps: [...gaps, ...refusedGaps], requireUnstubbed}));
      return {stopped: "fixed-point", iteration: state.iteration, gaps: [...gaps, ...refusedGaps], cascades, unclassified, unscoped,
        ...(stubUnresolved === true ? {stubs: stubRecords(), stubRounds} : {})};
    }

    const iteration = state.iteration + 1;
    const dumpDir = join(root, ".local", "hana-closure", `dump-${String(iteration).padStart(3, "0")}`);
    const freshCount = fresh.length;
    const request = requestFor({iteration, generation: generationOf(root), fresh, asked: state.asked, gaps,
      ...(stubUnresolved === true ? {deferred: deferredOnly} : {}),
      // the request's excluded key carries the LAST decision's excluded
      // objects -- the roots and the cascades that fall with them (their
      // names are out of the build either way); cycles are no exclusion at
      // all, and a FRIENDS strip is a record, not an exclusion
      ...(excludedRecords.some((r) => r.level === "definition" || r.level === "cascade") === true
        ? {excluded: excludedRecords
          .filter((r) => r.level === "definition" || (r.level === "cascade" && r.excluded === true))
          .map((r) => ({name: r.object, kind: r.kind === "INTF" ? "intf" : "clas"}))}
        : {})});
    writeFileSync(requestPath, JSON.stringify(request, null, 2) + "\n");
    say(`request ${iteration}: ${freshCount} new name(s) -> ${requestPath}`);

    // the request is written: its names are ASKED from this moment, so a
    // hand-run dump + --dump continuation sees them as asked and gaps the
    // ones still unresolved; the round is pending until a dump answers it
    for (const n of fresh) {
      state.asked[n.name] = {kinds: tadirKinds(n.kind, n.message ?? n.finding), iteration, finding: n.finding};
    }
    state.iteration = iteration;
    state.pending = {iteration, dumpDir};
    saveState(out, state);

    if (dryRun === true) {
      say(`dry run: stopping before the dumper; run it by hand and continue with --dump ${dumpDir}`);
      return {stopped: "dry-run", iteration, request, fresh, gaps, cascades, unclassified};
    }
    if (rounds >= maxIterations) {
      say(`cap: --max-iterations ${maxIterations} reached after ${rounds} dumper round(s); the pending request is ${requestPath}`);
      return {stopped: "cap", iteration, request, fresh, gaps, cascades, unclassified};
    }
    if (dumperConfigured(env) === false) {
      const command = printedCommand(env, requestPath, dumpDir, provenanceFor(iteration));
      say(`no dumper here: OSD_HANA_DUMPER (the binary) and OSD_HANA_DUMP_ENV (an env file with the connection) are not both set. The request is ${requestPath}; run the dumper by hand and continue with --dump ${dumpDir}:`);
      say(`  ${command}`);
      return {stopped: "no-dumper", iteration, request, command, fresh, gaps, cascades, unclassified};
    }
    dumpRound({root, env, say, requestPath, dumpDir, provenance: provenanceFor(iteration)});
    state.dump = dumpDir;
    delete state.pending;
    saveState(out, state);
    rounds++;
    dump = dumpDir;
  }
}

if (runsAs("hana-closure.mjs")) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`hana-closure: ${error?.message ?? error}`);
    process.exit(2);
  });
}
