// Run the integration suites listed in test/suites.d/*.json.
//
// Feature fragments keep independent suite additions out of the same file.
//
// It is a script rather than an inline `node -e` for a reason worth stating:
// the exit code has to be the runner's. A one-liner that spawns mocha and
// forgets to pass its status back reports success for a failing suite, which
// is the false green this project keeps paying for.
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";

/** Merge feature fragments, then sort suite paths alphabetically. The
 * root argument lets tools that inspect another checkout read its manifest. */
export function loadSuites(root = fileURLToPath(new URL("..", import.meta.url))) {
  const dir = join(root, "test", "suites.d");
  const fragments = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  if (fragments.length === 0) throw new Error(`${dir} has no suite fragments`);
  const files = [];
  const groups = {};
  const seen = new Set();
  for (const name of fragments) {
    const fragment = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (!Array.isArray(fragment.files) || (fragment.groups !== undefined && (fragment.groups === null || typeof fragment.groups !== "object" || Array.isArray(fragment.groups)))) {
      throw new Error(`${name} needs a files array and optional groups object`);
    }
    for (const [group, entries] of [[null, fragment.files], ...Object.entries(fragment.groups ?? {})]) {
      if (!Array.isArray(entries)) throw new Error(`${name}: ${group} must be an array`);
      const target = group === null ? files : (groups[group] ??= []);
      for (const file of entries) {
        if (typeof file !== "string" || !file.startsWith("test/") || !file.endsWith(".mjs")) throw new Error(`${name}: invalid suite ${file}`);
        if (seen.has(file)) throw new Error(`${name}: duplicate suite ${file}`);
        seen.add(file);
        target.push(file);
      }
    }
  }
  files.sort();
  for (const entries of Object.values(groups)) entries.sort();
  return {files, groups};
}

// Keep this routing table in step with test/suites.d/README.md. The longest
// matching prefix wins; equal-length matches use the fragment filename.
export const SUITE_FRAGMENTS = {
  "adt.json": ["adt-", "http-codelens"],
  "amdp-sqlscript.json": ["amdp-", "amdp.", "ir-", "sqlscript-", "hana-", "reserved-words"],
  "apc-daemons.json": ["apc-", "amc.", "dialog-step", "pages-push", "osd-apc", "osd-icf-apc"],
  "cds-sadl.json": ["cds-", "analytics", "ddic-"],
  "gateway-odata.json": ["batch-inserts", "conformance", "database-", "db-migrate", "demo-data", "gateway-", "http-case", "mocha.", "reference-", "replay-", "rfc-", "sapevent", "se16", "seed-", "sql-", "sqlite-", "store-", "transaction", "write-boundary"],
  "gogen-osgo.json": ["generation-", "osd-", "osgo-", "preview-", "stg-", "type-", "unit-run", "warm.", "xref-"],
  "infra-misc.json": ["osd-dataset", "osd-suites"],
  "jobs.json": ["batch-runs", "job-", "jobs-", "osd-job", "osd-queue", "telegram-"],
  "segw.json": ["bsp-", "editor.", "flp-", "generated-", "osd-bsp", "pages-index", "segw-", "segw.", "webgui"],
  "vscode.json": ["ci-vsix", "release-", "third-party-", "vsix-", "vscode-"],
};

export function suggestSuiteFragment(file, fragments = SUITE_FRAGMENTS) {
  const name = file.replace(/^.*\//, "");
  const matches = Object.entries(fragments).flatMap(([fragment, prefixes]) =>
    prefixes.filter((prefix) => name.startsWith(prefix)).map((prefix) => ({fragment, prefix})));
  matches.sort((a, b) => b.prefix.length - a.prefix.length || a.fragment.localeCompare(b.fragment));
  return matches[0]?.fragment ?? "infra-misc.json";
}

/** A suite on disk that the list does not name.
 *
 *  **A hand-kept list of suites is the same instrument as a hand-kept list of
 *  tasks**: it is read like a measurement and ages like an opinion, and this
 *  tree already grew a checker for the other one (`osd-queue-check.mjs`) for
 *  exactly that reason. Measured 2026-09-20: ten files under `test/` with
 *  `describe(` blocks in them were in no list and had run in nobody's suite
 *  for as long as anybody could tell. All ten passed when finally run, so
 *  nothing was hiding in them -- which is the point. A green `npm run
 *  integration` was a true answer to a narrower question than the one it was
 *  read as, and the drift was silent in the direction that reads as progress.
 *
 *  What counts as a suite is `describe(` at the start of a line. Deliberately
 *  crude: `test/setup.mjs`, `test/start.mjs`, `test/run.mjs` and `test/seed.mjs`
 *  are harness modules with no `describe` in them and drop out on their own,
 *  so the rule needs no list of exceptions to keep true -- and a list of
 *  exceptions is the thing that drifts. */
export const hasSuites = (text) => /^describe\(/m.test(text);

export function suitesOnDisk(dir, read = (p) => readFileSync(p, "utf8"), list = readdirSync) {
  return list(dir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `${dir}/${f}`)
    .filter((p) => hasSuites(read(p)));
}

/** Both directions, because a checker that complains in one is half a
 *  checker: a suite nobody runs, and a name in the list that is no longer a
 *  file. The second would fail the run on its own when mocha cannot find it;
 *  it is named here so the reason arrives before the stack trace does. */
export function listDrift(onDisk, listed) {
  const named = new Set(listed.map((f) => f.replace(/^\.\//, "")));
  return {
    unlisted: onDisk.filter((p) => named.has(p) === false),
    absent: [...named].filter((p) => onDisk.includes(p) === false && existsSync(p) === false),
  };
}

// **What a run could not look at is a third value, and it is not a pass.**
//
// Several suites are guarded on inputs that are not in this repository and
// never will be -- `.local/corpus` holds real customer projects,
// `.local/corpus-sap` SAP-delivered samples, `.local/lars` the library
// clones. Where they are absent those cases skip, and mocha reports them as
// "pending", which scrolls past and says neither which nor why.
//
// So a run says what it could not see, before and after. "1020 passing" on a
// workstation and "1020 passing" on a runner are then different claims that
// each say which they are, instead of one number standing in for two
// systems. The rule this stands on is the tree's own: a green that cannot go
// red measures nothing, and a green that never looked is the same thing
// wearing a better coat.
export const OPTIONAL = [
  [".local/corpus", "real SEGW/UI5 projects: the oracle for every byte-for-byte claim"],
  [".local/corpus-sap", "SAP-delivered sample projects: the oracle for the mapped kinds"],
  [".local/lars", "the library clones (open-abap-core, abapGit, open-abap-odata)"],
];

export function reportSkips(optional = OPTIONAL, say = console.log) {
  const absent = optional.filter(([path]) => existsSync(path) === false);
  if (absent.length === 0) {
    say("osd-suites: every optional input is present -- this run is the wide one\n");
    return absent;
  }
  say("osd-suites: NOT looked at, so whatever this run says it says about less:");
  for (const [path, why] of absent) {
    say(`  ${path.padEnd(20)} ${why}`);
  }
  say("");
  return absent;
}

export function assignShards(files, seconds, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error("shard count must be positive");
  const known = Object.values(seconds).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const median = known.length ? (known[Math.floor((known.length - 1) / 2)] + known[Math.floor(known.length / 2)]) / 2 : 1;
  const weight = (file) => Number.isFinite(seconds[file]) && seconds[file] > 0 ? seconds[file] : median;
  const shards = Array.from({length: count}, () => ({files: [], seconds: 0}));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const target = shards.reduce((best, shard) => shard.seconds < best.seconds ? shard : best);
    target.files.push(file);
    target.seconds += weight(file);
  }
  const position = new Map(files.map((file, index) => [file, index]));
  for (const shard of shards) shard.files.sort((a, b) => position.get(a) - position.get(b));
  return shards;
}

/** Executor returns a process status plus the reporter's completed failure list.
 * Unknown crashes, missing reports and more than three failing files stay red. */
export function runWithRetries(files, run, {group, stopEarly = false} = {}) {
  const first = run(files, "first");
  // Isolation failures prove contamination. A clean-process retry cannot
  // erase that evidence or turn the shared run green.
  if (first.failures?.some((failure) => failure.isolation)) return {status: 1, first, retries: [], lines: []};
  const complete = (report, selected) => !report.crashed && report.completed === true &&
    report.fileTests && Object.keys(report.fileTests).length === selected.length &&
    report.tests && Object.keys(report.tests).length === selected.length &&
    selected.every((file) => {
      const counts = report.fileTests[file];
      const tests = report.tests[file];
      return Array.isArray(tests) && counts && tests.length === counts.registered &&
        tests.every((test) => test && Array.isArray(test.titlePath) && test.titlePath.length > 0 &&
          test.titlePath.every((title) => typeof title === "string") && [null, "passed", "failed", "pending"].includes(test.outcome)) &&
        ["passed", "failed", "pending"].every((outcome) => tests.filter((test) => test.outcome === outcome).length === counts[outcome]) &&
        [counts.registered, counts.passed, counts.pending, counts.failed].every((n) => Number.isInteger(n) && n >= 0) &&
        counts.registered > 0 && counts.passed + counts.pending + counts.failed <= counts.registered;
    }) &&
    Array.isArray(report.failures) && Number.isInteger(report.totalFailures) &&
    Array.isArray(report.internalRetries) && report.internalRetries.length === 0 &&
    report.totalFailures >= 0 && report.totalFailures === report.failures.length;
  const passed = (report, selected) => report.status === 0 && complete(report, selected) && report.totalFailures === 0 &&
    selected.every((file) => {
      const counts = report.fileTests[file];
      return counts.failed === 0 && counts.passed + counts.pending === counts.registered;
    });
  const result = {status: passed(first, files) ? 0 : 1, first, retries: [], lines: []};
  if (first.status === 0 || group === "packaging" || stopEarly || first.bail === true) return result;
  const failures = first.failures ?? [];
  const failedFiles = [...new Set(failures.map((failure) => failure.file))];
  if (!complete(first, files) || !failures.length ||
      failedFiles.some((file) => !files.includes(file)) || failedFiles.length > 3) return result;
  const unaccounted = group ? [] : files.filter((file) => !failedFiles.includes(file) &&
    first.tests[file].some((test) => test.outcome === null));
  if (unaccounted.length) {
    for (const file of unaccounted) {
      for (const test of first.tests[file].filter((test) => test.outcome === null)) {
        const clean = (value) => String(value).replace(/[\r\n`|<>]/g, " ");
        result.lines.push(`- recovery refused: \`${clean(file)}\` — unexecuted test: ${clean(test.titlePath.join(" > "))}`);
      }
    }
    return result;
  }
  const retrySets = group ? [files] : failedFiles.map((file) => [file]);
  let recovered = 0;
  const clean = (value) => String(value).replace(/[\r\n`|<>]/g, " ");
  for (const retryFiles of retrySets) {
    const file = retryFiles[0];
    const retry = run(retryFiles, "retry");
    result.retries.push({...retry, file});
    const refused = [];
    if (complete(retry, retryFiles)) {
      for (const file of retryFiles) {
        // Compare paths as arrays: flattened titles can collide. Consume matches
        // so duplicate titles cannot conceal a lost registration either.
        const remaining = [...retry.tests[file]];
        for (const original of first.tests[file]) {
          const at = remaining.findIndex((test) => JSON.stringify(test.titlePath) === JSON.stringify(original.titlePath));
          if (at < 0) refused.push({file, title: original.titlePath.join(" > "), reason: "vanished test"});
          else {
            remaining.splice(at, 1);
            // Every matching instance must pass when duplicate paths make the
            // original failing instance ambiguous.
            const notPassed = original.outcome === "failed" && retry.tests[file].find((test) =>
              JSON.stringify(test.titlePath) === JSON.stringify(original.titlePath) && test.outcome !== "passed");
            if (notPassed && notPassed.outcome !== "failed") refused.push({file, title: original.titlePath.join(" > "),
              reason: `previously failing test became ${notPassed.outcome ?? "unexecuted"}`});
          }
        }
      }
    }
    for (const test of refused) result.lines.push(`- recovery refused: \`${clean(test.file)}\` — ${test.reason}: ${clean(test.title)}`);
    if (passed(retry, retryFiles) && refused.length === 0) {
      for (const file of group ? failedFiles : retryFiles) {
        const title = failures.find((failure) => failure.file === file).title;
        recovered++;
        result.lines.push(`- flaky / order-dependent: \`${clean(file)}\` — ${clean(title)} (passed once ${group ? "with the whole group" : "in isolation"})`);
      }
    }
  }
  if (recovered === failedFiles.length) result.status = 0;
  return result;
}

function parseShard(spec) {
  const match = /^(\d+)\/(\d+)$/.exec(spec ?? "");
  if (!match || +match[1] < 1 || +match[2] < 1 || +match[1] > +match[2]) {
    throw new Error(`invalid shard ${spec}; expected i/N with 1 <= i <= N`);
  }
  return {index: +match[1] - 1, count: +match[2]};
}

const invoked = process.argv[1] !== undefined && process.argv[1].endsWith("osd-suites.mjs");
if (invoked === false) {
  // imported for its reporter; the runner below is the command's job
} else {
const listed = loadSuites();
const files = listed.files ?? [];
const groups = listed.groups ?? {};
if (files.length === 0) {
  console.error("test/suites.d lists no suites -- that is not a pass, it is an empty run");
  process.exit(2);
}

// Asked before the run, not after: a list that does not cover the tree makes
// every number below it narrower than it reads, and finding that out at the
// end is finding it out after somebody has already believed the number.
// the same way the list itself is resolved: both sides of a comparison must
// be found by the same rule, or the checker answers about two trees
const TESTS = fileURLToPath(new URL("../test", import.meta.url));
const drift = listDrift(suitesOnDisk(TESTS).map((p) => `test/${p.slice(TESTS.length + 1)}`), [...files, ...Object.values(groups).flat()]);
if (drift.unlisted.length > 0 || drift.absent.length > 0) {
  for (const p of drift.unlisted) console.error(`osd-suites: ${p} has suites in it and test/suites.d does not name it; suggested fragment: test/suites.d/${suggestSuiteFragment(p)}`);
  for (const p of drift.absent) console.error(`osd-suites: test/suites.d names ${p}, which is not there`);
  console.error("Add it, or delete it. A list of suites nobody checks is a list that quietly shrinks the run.");
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes("--check")) {
  if (argv.length !== 1) {
    console.error("osd-suites: --check takes no other options");
    process.exit(2);
  }
  console.log(`osd-suites: ${files.length} ordinary suites and ${Object.values(groups).flat().length} grouped suites listed; no drift`);
  process.exit(0);
}
const report = argv.includes("--report-skips");
const takeOption = (name) => {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  argv.splice(at, 2);
  return value;
};
try {
  const shardSpec = takeOption("--shard");
  const listSpec = takeOption("--list-shard");
  const groupName = takeOption("--group");
  const timingsFile = takeOption("--timings");
  const reportFile = takeOption("--report");
  if (shardSpec && listSpec) throw new Error("choose --shard or --list-shard");
  if (groupName && (shardSpec || listSpec)) throw new Error("choose --group or --shard/--list-shard");
  if (groupName && !Object.hasOwn(groups, groupName)) throw new Error(`unknown suite group ${groupName}`);
  const shard = parseShard(shardSpec ?? listSpec ?? "1/1");
  const weights = JSON.parse(readFileSync(fileURLToPath(new URL("../test/suites-timings.json", import.meta.url)), "utf8"));
  const selected = groupName ? groups[groupName] : assignShards(files, weights, shard.count)[shard.index].files;
  if (listSpec) {
    for (const file of selected) console.log(file);
    process.exit(0);
  }
  if (selected.length === 0) throw new Error(`shard ${shard.index + 1}/${shard.count} has no suites`);
  const extra = argv.filter((a) => a !== "--report-skips");
  if (!groupName && Object.keys(groups).length > 0) console.log(`osd-suites: groups not run: ${Object.keys(groups).sort().join(", ")}`);
  const absent = report ? reportSkips() : [];
  // Always collect failures, including hook failures, even without --timings.
  const scratch = mkdtempSync(join(tmpdir(), "osd-suite-report-"));
  let result;
  try {
    let attempt = 0;
    result = runWithRetries(selected, (runFiles, phase) => {
      const path = join(scratch, `${attempt++}.json`);
      console.log(`osd-suites: ${phase}: ${runFiles.length} file(s)`);
      // Shared CI runners are slower than a desk: on 2026-11-08 four unrelated
      // cases hit mocha's default 2 s. A suite that sets its own timeout keeps it;
      // an explicit --timeout in the arguments wins over this default.
      const timeout = extra.some((arg) => arg === "-t" || /^--timeout(?:=|$)/.test(arg)) ? [] : ["--timeout", "10000"];
      const child = spawnSync("npx", ["mocha", ...runFiles, ...timeout,
        ...extra, "--require", fileURLToPath(new URL("./osd-test-isolation.cjs", import.meta.url)), "--require", fileURLToPath(new URL("./osd-suite-no-retries.cjs", import.meta.url)), "--retries", "0", "--reporter", fileURLToPath(new URL("./osd-suite-timing-reporter.cjs", import.meta.url))],
        {stdio: "inherit", env: {...process.env, OSD_SUITE_TIMINGS_FILE: path}});
      const metadata = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      return {...metadata, status: child.status ?? 1, crashed: Boolean(child.error || child.signal)};
    }, {group: groupName, stopEarly: extra.some((arg) => arg === "-b" || /^--bail(?:=|$)/.test(arg))});
    const save = (path, value) => {
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, value);
    };
    if (timingsFile) save(timingsFile, JSON.stringify(result.first, null, 2) + "\n");
    const summary = result.lines.length ? "### Suite retries\n\n" + result.lines.join("\n") + "\n" : "";
    if (reportFile) save(reportFile, summary);
    if (summary) {
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
  if (report && absent.length > 0) {
    console.log(`\nosd-suites: the above ran WITHOUT ${absent.map(([p]) => p).join(", ")}.`);
    console.log("            A pass here is narrower than a pass on a tree that has them.");
  }
  process.exit(result.status);
} catch (error) {
  console.error(`osd-suites: ${error.message}`);
  process.exit(2);
}
}
