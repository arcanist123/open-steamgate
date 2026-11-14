// The accumulation step of the closure (H5c round 4), beside the loop --
// this file is its own package so the size budget stays honest, the way
// tools/hana-closure-stubs.mjs is. Three facts of the island build live
// here, none of them the loop's business:
//
// - the island is the UNION of the seed dump and every dump so far (bed run
//   5: a merge per dump REPLACED gen/hana-src, iteration 3 validated a tree
//   without the service, and the fixed point was false). Every dump is
//   converted once, into .local/hana-closure/layers-<NNN>/ (the converter is
//   OSD_HANA_CONVERTER, an external script, so it starts through
//   scriptCommandIn like every spawn of another tool), and hana-src-gen is
//   called with ALL the layers dirs -- the union, later wins per object.
//   gen/hana-ddic accumulates by hana-ddic-gen's own write mode (per-file
//   overlays, never clears).
// - the island's object count (classes+interfaces+tables) is the run's
//   control on the merges: after each merge it must not be below the
//   previous iteration's -- a shrink means objects were lost, and a fixed
//   point over a shrunken island is false.
// - a "fixed point" needs a build that succeeded (bed run 4's control:
//   osd-build FAILED on a generator step with zero transpiler findings, and
//   the loop read that as convergence): the build runs before the
//   declaration, and a non-zero exit with no findings aborts with its
//   FAILED line.
// - the merge step itself lives here since round 5: the dump's DDIC half
//   and the layers' hana-src-gen union. When the layers carry the DDIC XML
//   (the converter master writes .tabl/.dtel/.doma/.ttyp.xml from the DD*
//   rows), the converter is the dump path's writer of record:
//   hana-ddic-gen --from-dump is skipped -- one log line says so, and the
//   cross-check against the layers is a follow-up; without DDIC XML in the
//   layers (older converter output) the DDIC merge runs as before.
// - the writer of record is per NAME since round 7: a DDIC name the dumps
//   RESOLVED (manifest.closure.resolved per kind, accumulated in the loop's
//   state.json) without an island XML is written by hana-ddic-gen
//   --from-dump --names, exactly those names, into gen/hana-ddic -- where
//   the converter's file wins where it wrote one (gen/hana-src layers
//   later, and the later folder wins). TTYP and SHLP stay unwritten (no
//   DD40L writer exists in this tree); their hole stays visible on the
//   iteration line's resolved-vs-written counts.
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {basename, join} from "node:path";
import {scriptCommandIn, toolCommandIn} from "./osd-host.mjs";
import {parseFindings} from "./hana-closure.mjs";
import {islandTestCode} from "./hana-src-gen.mjs";

const TOOLS = fileURLToPath(new URL(".", import.meta.url));

/** the island's objects, counted: classes and interfaces off the
 *  gen/hana-src class files (one object each, though a converter layer
 *  carries .clas.abap, .clas.xml and the locals includes beside it), tables
 *  off gen/hana-ddic's *.tabl.xml AND off the layers' *.tabl.xml in
 *  gen/hana-src -- with the converter as the DDIC's writer of record
 *  gen/hana-ddic can be empty, and the shrink control must not go blind to
 *  tables (round 5). A stem both folders carry is one object. The shrink
 *  assert's unit and the count on every iteration line. Pure. */
export function islandObjectCount(root) {
  const names = {clas: new Set(), intf: new Set(), tabl: new Set()};
  const walk = (dir, onFile) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name), onFile);
      else onFile(entry.name);
    }
  };
  walk(join(root, "gen", "hana-src"), (name) => {
    if (islandTestCode(name) === true) return;
    const clas = /^([^/]+)\.clas\.abap$/.exec(name);
    if (clas !== null) return void names.clas.add(clas[1]);
    const intf = /^([^/]+)\.intf\.abap$/.exec(name);
    if (intf !== null) names.intf.add(intf[1]);
    const tabl = /^([^/]+)\.tabl\.xml$/.exec(name);
    if (tabl !== null) names.tabl.add(tabl[1]);
  });
  walk(join(root, "gen", "hana-ddic"), (name) => {
    const tabl = /^([^/]+)\.tabl\.xml$/.exec(name);
    if (tabl !== null) names.tabl.add(tabl[1]);
  });
  return {clas: names.clas.size, intf: names.intf.size, tabl: names.tabl.size,
    total: names.clas.size + names.intf.size + names.tabl.size};
}

/** the accumulation's control, per kind (round 5, critic r4 S-4): classes,
 *  interfaces and tables are each non-decreasing between iterations. A
 *  total that new tables hold up while the classes walk away is still a
 *  lost island -- the builder's own first shrink scenario passed on
 *  exactly that compensation. Throws with both totals and the kind that
 *  shrank. Pure. */
export function islandShrinkCheck(prev, now, iteration) {
  for (const kind of ["clas", "intf", "tabl"]) {
    if (now[kind] < prev[kind]) {
      throw new Error(`hana-closure: the island shrank: ${prev.total} -> ${now.total} object(s) (${kind} ${prev[kind]} -> ${now[kind]}, classes+interfaces+tables, iteration ${iteration})`);
    }
  }
}

/** how many DDIC XML files the layers carry (.tabl/.dtel/.doma/.ttyp.xml --
 *  the converter master writes them from the DD* rows, a4h-i7). Non-zero:
 *  the converter is the dump path's writer of record and the merge skips
 *  hana-ddic-gen --from-dump (the cross-check, --from-dump --against the
 *  layers, is a follow-up). Pure. */
export function layersDdicCount(layersDirs) {
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/\.(?:tabl|dtel|doma|ttyp)\.xml$/.test(entry.name) === true) count++;
    }
  };
  for (const dir of layersDirs ?? []) walk(dir);
  return count;
}

/** the DDIC objects the island carries, per TADIR kind: the stems of
 *  gen/hana-ddic's and gen/hana-src's *.tabl/.dtel/.doma/.ttyp.xml -- the
 *  converter's layer files included, which is where its writer-of-record
 *  output lives. The file stem back to the object name is abapGitFileName's
 *  one rule read backwards (the namespace escaped as #ns#). The per-name
 *  fill's who-is-missing and the iteration line's resolved-vs-written
 *  counts. Pure. */
export function ddicWritten(root) {
  const names = {TABL: new Set(), DTEL: new Set(), DOMA: new Set(), TTYP: new Set()};
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else {
        const ddic = /^([^.]+)\.(tabl|dtel|doma|ttyp)\.xml$/.exec(entry.name);
        if (ddic !== null) {
          names[ddic[2].toUpperCase()].add(ddic[1].replace(/^#([^#]+)#/, "/$1/").toUpperCase());
        }
      }
    }
  };
  walk(join(root, "gen", "hana-src"));
  walk(join(root, "gen", "hana-ddic"));
  return names;
}

/** one dump into its layers dir: the converter's --out must be empty (it
 *  refuses anything else), so a retry starts clean; the argv is the real
 *  converter's: <dump> --out <dir> --system <prefix>. Throws when
 *  OSD_HANA_CONVERTER is not configured or the converter fails. */
export function convertDump({root, env, dump, system, dir, say}) {
  const converter = env.OSD_HANA_CONVERTER;
  if (converter === undefined || converter === "") {
    throw new Error("hana-closure: OSD_HANA_CONVERTER must name the dump->layers converter (a path to dump-to-layers.mjs): every merge converts its dump into .local/hana-closure/layers-<NNN> first");
  }
  rmSync(dir, {recursive: true, force: true});
  mkdirSync(join(dir, ".."), {recursive: true});
  const [command, ...argv] = scriptCommandIn(env, converter, [dump, "--out", dir, "--system", system, "--allow-in-repo"]);
  say(`layers: ${basename(converter)} ${dump} -> ${dir}`);
  const child = spawnSync(command, argv, {cwd: root, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024});
  if (child.status !== 0) {
    const tail = [child.stdout, child.stderr].filter(Boolean).join("\n").slice(-2000);
    throw new Error(`hana-closure: the converter exited ${child.status ?? "on a signal"} for ${dump}${tail === "" ? "" : `:\n${tail}`}`);
  }
}

/** the layers dirs of this walk, oldest first, converting the current dump
 *  first when it has none yet -- the union hana-src-gen merges, in the
 *  order the dumps arrived, so the later dump's copy of an object wins.
 *  state.layers (an array of {dump, dir}) remembers them across runs; a
 *  dir whose plan.json is gone is converted again in place. Mutates
 *  state; the caller saves it. */
export function ensureLayers({root, state, dump, system, env, say}) {
  state.layers ??= [];
  const known = state.layers.find((l) => l.dump === dump);
  const dir = known?.dir ?? join(root, ".local", "hana-closure", `layers-${String(state.layers.length + 1).padStart(3, "0")}`);
  if (known === undefined || existsSync(join(dir, "plan.json")) === false) {
    convertDump({root, env, dump, system, dir, say});
    if (known === undefined) state.layers.push({dump, dir});
  }
  return state.layers.map((l) => l.dir);
}

/** the positive control's verdict: the build's exit and log to a decision.
 *  Exit 0 stands; non-zero with findings in the log is "exit 1 with
 *  findings only", the walk's ordinary material; non-zero with NO findings
 *  is the abort -- bed run 4's generator crash, which the loop used to
 *  read as convergence. Throws with the build's FAILED line. Pure. */
export function buildVerdict(status, output) {
  if (status === 0) return {status, findings: 0};
  const findings = parseFindings(output);
  if (findings.length > 0) return {status, findings: findings.length};
  const text = String(output ?? "");
  const failed = text.split("\n").find((line) => /FAILED/.test(line)) ??
    text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? `exit ${status}`;
  throw new Error(`hana-closure: the build failed with no findings -- not a fixed point: ${failed}`);
}

/** the positive control itself: the tree's own build
 *  (tools/osd-build.mjs) before the loop declares a fixed point, through
 *  toolCommandIn like every tool of this tree. Returns the verdict (with
 *  the finding count for the report line); throws through buildVerdict. */
export function buildCheck({root, env, say}) {
  const [command, ...argv] = toolCommandIn(env, join(TOOLS, "osd-build.mjs"), []);
  say("build: osd-build.mjs (the fixed point's positive control)");
  const child = spawnSync(command, argv, {cwd: root, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024});
  return buildVerdict(child.status === null ? -1 : child.status, [child.stdout, child.stderr].filter(Boolean).join("\n"));
}

/** whether the generation the positive control just built LOADS (B6): a
 *  build can be green and its init.mjs still not import -- a class
 *  constructor that raises, an import cycle -- and the island was reported
 *  "builds" twice while it could not start. Runs
 *  tools/osd-generation-check.mjs --json over output/ through toolCommandIn.
 *  Returns {loads, error}. */
export function loadCheckOf({root, env, say}) {
  const [command, ...argv] = toolCommandIn(env, join(TOOLS, "osd-generation-check.mjs"), ["output", "--json"]);
  say("load: osd-generation-check.mjs (does the built generation import)");
  const child = spawnSync(command, argv, {cwd: root, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024});
  const line = String(child.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).at(-1);
  if (line === undefined) {
    const tail = String(child.stderr ?? "").trim().split("\n").at(-1) ?? "";
    return {loads: false, error: `the load check gave no verdict (exit ${child.status}): ${tail}`};
  }
  const verdict = JSON.parse(line);
  return verdict.loads === true ? {loads: true} : {loads: false, error: verdict.load_error ?? `exit ${child.status}`,
    ...(verdict.load_constructor !== undefined ? {constructor: verdict.load_constructor} : {})};
}

// ------------------------------------------------------------ the merge --

// a generator's refusal of one object, H5a's TABCLASS guard speaking
// through hana-ddic-map (`hana-ddic-gen` exits 2 on it): the dictionary HAS
// the object, the generator here cannot write it. The loop must not die on
// the refusal -- the object is recorded as a gap and the merge continues
// without it.
const REFUSAL = /hana-ddic-map: (.+?): TABCLASS ([A-Za-z]+) is not written here/g;

// a copy of the dump without the refused rows, for the retry: every file
// verbatim but tables/DD02L.jsonl, which loses every row whose TABNAME a
// refusal named (that is the table the TABCLASS refusal names). The merge
// tools write per-file overlays, so re-running a step against the copy is
// safe, and the loop's own dump stays the original -- the next delta dump
// answers whether the object recurs.
function filteredDump(root, dump, without) {
  const skip = new Set(without.map((n) => n.toUpperCase()));
  const dir = join(root, ".local", "hana-closure", "dump-filtered");
  rmSync(dir, {recursive: true, force: true});
  const copy = (from, to) => {
    mkdirSync(to, {recursive: true});
    for (const entry of readdirSync(from, {withFileTypes: true})) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) copy(source, target);
      else copyFileSync(source, target);
    }
  };
  copy(dump, dir);
  const dd02l = join(dir, "tables", "DD02L.jsonl");
  if (existsSync(dd02l) === true) {
    const kept = readFileSync(dd02l, "utf8").split("\n").filter((line) => {
      if (line.trim() === "") return false;
      try {
        return skip.has(String(JSON.parse(line).TABNAME ?? "").trim().toUpperCase()) === false;
      } catch {
        return true; // not this file's judge: the merge tool refuses bad lines by number
      }
    });
    writeFileSync(dd02l, kept.length === 0 ? "" : kept.join("\n") + "\n");
  }
  return dir;
}

/** the current dump into the build's inputs: gen/hana-ddic and gen/hana-src,
 *  the two folders abap_transpile.json already lists before src/. When the
 *  layers carry the DDIC XML (round 5: the converter master writes
 *  .tabl/.dtel/.doma/.ttyp.xml from the DD* rows), the converter IS the
 *  dump path's writer of record: the DDIC step is skipped -- one log line
 *  says so, and the cross-check (`hana-ddic-gen --from-dump --against
 *  <layers>`) is a follow-up. Without DDIC XML in the layers (older
 *  converter output) the DDIC merge runs as before. Both steps are tools of
 *  this tree, so they start through toolCommandIn -- in a compiled binary
 *  that is `osd gen <name>`, not a path off import.meta.url -- and their
 *  exits are this loop's failures -- except a refusal of one object: that
 *  is parsed, the object joins the gaps, and the step retries against a
 *  filtered copy of the dump (the refusal leaves when a dump the merge
 *  handled carries the name again -- the generator wrote it at last). A
 *  tool that does not know --from-dump (PR #926, merged) is refused by its
 *  own "unknown option", and the message says what it needs. fill (round 7)
 *  carries the resolved DDIC names and the dumps newest-first for the
 *  per-name fill that runs after the steps. */
export function mergeInputs(root, dump, layersDirs, env, say, fill = undefined) {
  const layersDdic = layersDdicCount(layersDirs);
  const steps = [
    ...(layersDdic > 0 ? [] : [["hana-ddic-gen.mjs", ["--from-dump", dump, "--out", join(root, "gen", "hana-ddic")]]]),
    // the union of every dump so far: ALL the layers dirs, later wins per object
    ["hana-src-gen.mjs", [...layersDirs.flatMap((d) => ["--layers", d]), "--out", join(root, "gen", "hana-src")]],
  ];
  if (layersDdic > 0) {
    say(`merge: the layers carry the DDIC XML (${layersDdic} file(s)) -- hana-ddic-gen --from-dump is skipped, the converter is the writer of record`);
  }
  const refused = new Map();
  for (const [script, argv] of steps) {
    const [command, ...args] = toolCommandIn(env, join(TOOLS, script), argv);
    let stepDump = dump;
    for (;;) {
      // the retry always makes progress: a refusal names an object, the
      // object joins `refused`, and the next pass reads a dump copy without
      // its row -- so no refusal can come back, and the walk ends when an
      // exit names nothing new (S-7.4: the dead `attempt >= 64` guard is
      // gone; the loop's own refusals bound it)
      say(`merge: ${script} ${script === "hana-src-gen.mjs" ? `--layers ${layersDirs.length} layer dir(s) (the union so far)` : `--from-dump ${stepDump}`}`);
      const child = spawnSync(command, args.map((a) => (a === dump ? stepDump : a)), {cwd: root, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024});
      if (child.status === 0) break;
      const tail = [child.stdout, child.stderr].filter(Boolean).join("\n").slice(-2000);
      // the refusals this exit named that no earlier exit named
      const fresh = [...tail.matchAll(REFUSAL)]
        .map((m) => ({name: m[1].trim().toUpperCase(), tabclass: m[2].trim().toUpperCase(), line: m[0]}))
        .filter((r) => refused.has(r.name) === false);
      if (fresh.length === 0) {
        const hint = /unknown option/.test(tail)
          ? `\nhana-closure: ${script} refused --from-dump: this hana-ddic-gen predates --from-dump (PR #926, merged) -- the tree needs updating`
          : "";
        throw new Error(`hana-closure: ${script} exited ${child.status ?? "on a signal"} merging ${stepDump}${tail === "" ? "" : `:\n${tail}`}${hint}`);
      }
      for (const r of fresh) {
        refused.set(r.name, {name: r.name, kind: "TABL", reason: `unsupported TABCLASS ${r.tabclass}`, first_finding: r.line});
        say(`merge: ${script} refuses ${r.name} (unsupported TABCLASS ${r.tabclass}) -- recorded as a gap, the merge continues without it`);
      }
      stepDump = filteredDump(root, dump, [...refused.keys()]);
    }
  }
  // the per-name fill (round 7): after the steps, so a step the layers let
  // run has written what it has and the fill writes only the rest
  const fillRefused = fill === undefined ? [] : ddicFill({root, env, say, resolved: fill.resolved, dumps: fill.dumps});
  return {refused: [...refused.values(), ...fillRefused]};
}

// the per-name fill (H5c round 7): the dumps RESOLVED a DDIC name -- the
// dictionary HAS it -- but the converter's TADIR package selection did not
// write it, and with the converter as the writer of record the loop skips
// the dump's own DDIC merge. The writer of record is per NAME, not per run:
// a resolved .tabl/.dtel/.doma name without an island XML is written by
// hana-ddic-gen --from-dump --names for exactly those names, into
// gen/hana-ddic (the converter's file wins where it wrote one: gen/hana-src
// layers later, and the later folder wins). dumps is newest-first; a name a
// dump's DD* rows do not carry stays for the older ones; a TABCLASS refusal
// drops the name (it is the merge-refusal gap it already is) and the fill
// goes on. Returns the refusals it met.
function ddicFill({root, env, say, resolved, dumps}) {
  const have = ddicWritten(root);
  const left = new Map(); // name -> the kind it resolved under
  const perKind = [];
  for (const kind of ["TABL", "DTEL", "DOMA"]) {
    const missing = (resolved[kind] ?? []).filter((n) => have[kind].has(n) === false);
    if (missing.length > 0) perKind.push(`${kind} ${missing.length}`);
    for (const name of missing) left.set(name, kind);
  }
  if (left.size === 0) return [];
  say(`ddic fill: ${left.size} resolved DDIC name(s) without an island XML (${perKind.join(", ")}) -- hana-ddic-gen --from-dump --names writes exactly these; where the converter wrote one, its file wins`);
  const refused = new Map();
  for (const dump of dumps) {
    if (left.size === 0) break;
    for (let attempt = 0; attempt < 64 && left.size > 0; attempt++) {
      const names = [...left.keys()].sort().join(",");
      const [command, ...args] = toolCommandIn(env, join(TOOLS, "hana-ddic-gen.mjs"),
        ["--from-dump", dump, "--names", names, "--out", join(root, "gen", "hana-ddic")]);
      say(`ddic fill: hana-ddic-gen --from-dump ${dump} --names ${names}`);
      const child = spawnSync(command, args, {cwd: root, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024});
      if (child.status === 0) {
        const now = ddicWritten(root);
        for (const [name, kind] of [...left]) {
          if (now[kind].has(name) === true) left.delete(name);
        }
        break;
      }
      const tail = [child.stdout, child.stderr].filter(Boolean).join("\n").slice(-2000);
      const fresh = [...tail.matchAll(REFUSAL)]
        .map((m) => ({name: m[1].trim().toUpperCase(), tabclass: m[2].trim().toUpperCase(), line: m[0]}))
        .filter((r) => refused.has(r.name) === false);
      if (fresh.length === 0) {
        // the for condition bounds this loop (attempt < 64), so the body's
        // own attempt guard was dead (S-7.4): a fresh refusal is the only
        // way past it, and each one drops a name from `left`
        const hint = /unknown option/.test(tail)
          ? `\nhana-closure: hana-ddic-gen refused --names: this hana-ddic-gen predates the per-name fill -- the tree needs updating`
          : "";
        throw new Error(`hana-closure: the DDIC fill exited ${child.status ?? "on a signal"} for ${dump}${tail === "" ? "" : `:\n${tail}`}${hint}`);
      }
      for (const r of fresh) {
        refused.set(r.name, {name: r.name, kind: "TABL", reason: `unsupported TABCLASS ${r.tabclass}`, first_finding: r.line});
        say(`ddic fill: hana-ddic-gen refuses ${r.name} (unsupported TABCLASS ${r.tabclass}) -- recorded as a gap, the fill continues without it`);
        left.delete(r.name);
      }
    }
  }
  if (left.size > 0) {
    say(`ddic fill: ${left.size} name(s) still without an XML: no dump's DD* rows carry them (TTYP and SHLP are not written by --from-dump at all)`);
  }
  return [...refused.values()];
}

// ------------------------------------------------------------ the island --

/** the file basenames of the island -- gen/hana-src/** and gen/hana-ddic/*.
 *  The closure is scoped to it: a finding whose file is one of these
 *  basenames is the service's and is classified; src/, packs/ and other
 *  gen/ findings are the tree's own business, counted once, never asked. The
 *  validation's file names are bare basenames (the transpiler reports the
 *  name only), so "under gen/hana-src/*" is decided by membership in this
 *  set, not by a path prefix on the finding -- and a basename both an island
 *  layer and src/ carry is the island's, the later layer wins the build
 *  anyway. Reads the tree's folders, nothing else. Lives here beside the
 *  module's other island facts (islandObjectCount, ddicWritten) since FIX-1;
 *  tools/hana-closure.mjs re-exports it. */
export function islandBasenames(root) {
  const names = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else names.add(entry.name);
    }
  };
  walk(join(root, "gen", "hana-src"));
  walk(join(root, "gen", "hana-ddic"));
  return names;
}

/** the identity of the inputs the findings came from, for the request's
 *  `generation`: the sha256 the dump->layers converter recorded of the
 *  dump's manifest.json, copied into gen/hana-src/manifest.json by THIS
 *  module's merge; empty when no merge has written one yet. (The loop's
 *  build is validationMessage over the tree -- it writes no manifest of its
 *  own; the dump's is the manifest on the path.) Lives here since FIX-1:
 *  it reads the merge's own output. */
export function generationOf(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "gen", "hana-src", "manifest.json"), "utf8"));
    return String(manifest.dump?.manifest_sha256 ?? "");
  } catch {
    return "";
  }
}
