// Release smoke for `osd hana` in the compiled binary (linux): the rescue path
// off a HANA database must work from the executable alone, in a folder that is
// not a checkout. Against the FAKE sidecar (test/osd-hana/fake-sidecar.mjs) and
// synthetic fixtures -- no network, no database.
//
//   node scripts/smoke-binary-hana.mjs <osd binary>
//
// Checks, each by exit code and output:
//   osd hana --help, osd hana doctor --help        usage, exit 0
//   osd hana extract --dry-run                     the plan, exit 0, nothing written
//     with the fake sidecar placed BESIDE a copy of the binary and no
//     OSD_HANA_DUMP: the binary's own caller path (osd-hana-dump in the
//     directory of the executable), verified against a test pin
//     (--sidecar-pin, so it runs as unpinned and says so).
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {buildExtractFixtures} from "../test/osd-hana/extract-fixtures.mjs";

const binary = process.argv[2];
if (binary === undefined || !existsSync(binary)) {
  console.error("usage: node scripts/smoke-binary-hana.mjs <osd binary>");
  process.exit(2);
}
const fakeSource = fileURLToPath(new URL("../test/osd-hana/fake-sidecar.mjs", import.meta.url));
const contractDir = fileURLToPath(new URL("../test/osd-hana/contract/", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "osd-hana-smoke-"));
let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    failed = true;
    if (detail !== undefined) console.log(detail);
  }
};
try {
  const bin = join(root, "bin");
  const work = join(root, "work");
  for (const dir of [bin, work]) mkdirSync(dir, {recursive: true});
  const osd = join(bin, "osd");
  copyFileSync(resolve(binary), osd);
  chmodSync(osd, 0o755);

  // the fake, its recorded contracts baked in (as test/osd-hana/harness.mjs
  // does), and a wrapper named like the real sidecar that hands it the list
  // and dump fixtures -- the child environment is an allowlist, so the
  // fixtures cannot travel any other way
  const fixtures = buildExtractFixtures(join(root, "fixtures"));
  const fake = join(root, "fake-sidecar");
  writeFileSync(fake, readFileSync(fakeSource, "utf8").replace("__CONTRACT_DIR__", contractDir.replaceAll("\\", "\\\\")));
  chmodSync(fake, 0o755);
  const sidecar = join(bin, "osd-hana-dump");
  writeFileSync(sidecar, `#!/bin/sh\nFAKE_SIDECAR_LIST='${fixtures.list}' FAKE_SIDECAR_DUMP='${fixtures.dump}' exec '${fake}' "$@"\n`);
  chmodSync(sidecar, 0o755);
  const pin = join(root, "test-pin.json");
  writeFileSync(pin, JSON.stringify({
    name: "osd-hana-dump", version: "v9.9.9-test", commit: "a".repeat(40), schema: 1, read_only: true,
    targets: {"linux-x64": createHash("sha256").update(readFileSync(sidecar)).digest("hex")},
  }));

  const env = {...process.env, OSD_HANA_PASSWORD: "smoke-only"};
  delete env.OSD_HANA_DUMP;
  const run = (args) => spawnSync(osd, args, {cwd: work, env, encoding: "utf8", input: "", timeout: 120_000});

  for (const args of [["hana", "--help"], ["hana", "doctor", "--help"]]) {
    const r = run(args);
    const usage = args.length === 2 ? "Usage: osd hana <verb>" : "Usage: osd hana doctor";
    check(`osd ${args.join(" ")}: exit 0, usage`, r.status === 0 && r.stdout.includes(usage), `${r.status}\n${r.stdout}\n${r.stderr}`);
  }

  const out = join(work, "out");
  const r = run(["hana", "extract", "--host", "127.0.0.1", "--port", "1", "--user", "SMOKE",
    "--sidecar-pin", pin, "--allow-unpinned-sidecar", "--out", out, "--dry-run"]);
  check("osd hana extract --dry-run: exit 0", r.status === 0, `${r.status}\n${r.stdout}\n${r.stderr}`);
  check("osd hana extract --dry-run: the plan is printed", /plan: \d+ objects in scope/.test(r.stdout), r.stdout);
  check("osd hana extract --dry-run: the sidecar beside the binary was the one run", r.stderr.includes(sidecar), r.stderr);
  check("osd hana extract --dry-run: nothing written", !existsSync(join(out, "src")), out);
} finally {
  rmSync(root, {recursive: true, force: true});
}
process.exit(failed ? 1 : 0);
