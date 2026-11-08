// One whole-corpus run: freeze the osgo inputs, run Node gogen and the
// gogen that abapiti compiled to Go on them, compare, report.
//
//   node tools/selfhost/corpus-run.mjs --abapiti <abapiti checkout> --bin <abapiti binary> \
//     --abaplint <abaplint checkout> --transpiler <transpiler checkout> --out <empty dir> \
//     [--stale-gen] [--objects A,B] [--no-traps | --traps-only]
//
// The comparison itself is abapiti's tools/selfhost-step4.py (--inputs): the
// Node reference with V8 coverage, the translated closure, emit-go with the
// reachability of that very run, go build, the Go run, cmp. This module
// installs the corpus driver for it, runs the trap listing and the full run,
// records wall time and peak RSS per phase, and leaves the verdict to
// corpus-report.mjs. Run from the OSG checkout root; heavy (see README).
import {spawnSync} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const need = (name) => { const v = opt(name); if (!v) { console.error(`corpus-run: ${name} is required`); process.exit(2); } return resolve(v); };
const abapiti = need("--abapiti"), bin = need("--bin"), lint = need("--abaplint"), transpiler = need("--transpiler"), out = need("--out");
const root = process.cwd();
if (existsSync(out) && readdirSync(out).length) { console.error(`corpus-run: ${out} must be empty`); process.exit(2); }
mkdirSync(out, {recursive: true});

// peak RSS of the largest process a phase waited for (getrusage of the children)
const MEASURE = "import resource,subprocess,sys,time,json\nt=time.time()\nr=subprocess.call(sys.argv[2:])\n"
  + "open(sys.argv[1],'w').write(json.dumps({'exit':r,'seconds':round(time.time()-t,1),'maxRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}))\nsys.exit(r)";
const timings = {};
function phase(name, command, extra = {}) {
  const stat = join(out, `${name}.time.json`);
  const r = spawnSync("python3", ["-c", MEASURE, stat, ...command], {cwd: root, stdio: ["ignore", "inherit", "inherit"], env: {...process.env, ...extra}});
  timings[name] = existsSync(stat) ? JSON.parse(readFileSync(stat, "utf8")) : {exit: r.status};
  rmSync(stat, {force: true});
  writeFileSync(join(out, "timings.json"), JSON.stringify(timings, null, 1) + "\n");
  return timings[name].exit;
}

const inputArgs = ["--out", join(out, "inputs"), ...(args.includes("--stale-gen") ? ["--stale-gen"] : []), ...(opt("--objects") ? ["--objects", opt("--objects")] : [])];
if (phase("inputs", [process.execPath, join(root, "tools/selfhost/corpus-inputs.mjs"), ...inputArgs]) !== 0) process.exit(1);

// the step-4 harness reads .local/step4/step4-driver.mjs; the corpus driver
// takes its place for this run and the previous file comes back afterwards
const driver = join(root, ".local/step4/step4-driver.mjs");
const saved = existsSync(driver) ? readFileSync(driver) : null;
mkdirSync(join(root, ".local/step4"), {recursive: true});
copyFileSync(join(root, "tools/selfhost/corpus-driver.mjs"), driver);
const harness = ["python3", join(abapiti, "tools/selfhost-step4.py"), "--inputs", join(out, "inputs", "inputs.json")];
const tail = [bin, root, lint, transpiler];
try {
  if (!args.includes("--no-traps")) phase("traps", [...harness, "--list-traps", ...tail, join(out, "traps")]);
  if (!args.includes("--traps-only")) phase("full", [...harness, ...tail, join(out, "full")]);
} finally {
  if (saved) writeFileSync(driver, saved); else rmSync(driver, {force: true});
}
const r = spawnSync(process.execPath, [join(root, "tools/selfhost/corpus-report.mjs"), out], {stdio: "inherit"});
process.exit(r.status ?? 1);
