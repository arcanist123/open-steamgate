import assert from "node:assert/strict";
import {test} from "node:test";
import {spawnSync} from "node:child_process";
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const manifest = "sha256:" + "a".repeat(64);
const config = "sha256:" + "c".repeat(64);
const other = "sha256:" + "f".repeat(64);
const revision = "0123456789abcdef0123456789abcdef01234567";

// A stand-in for the two docker commands the script calls. FAKE_ID is what
// `docker image inspect` answers: the config digest on the classic store, the
// manifest digest on the containerd store (Docker 29).
const fakeDocker = `#!/usr/bin/env bash
if [[ "$1 $2" == "image inspect" ]]; then echo "$FAKE_ID"; exit 0; fi
if [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
  if [[ "$5" == "--raw" ]]; then printf '{"config":{"digest":"%s"}}\\n' "$FAKE_CONFIG"; exit 0; fi
  printf '{"os":"linux","architecture":"%s","config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}\\n' "$FAKE_ARCH" "$FAKE_REVISION"
  exit 0
fi
echo "unexpected docker $*" >&2; exit 3
`;

function run({id, arch = "amd64", label = revision, digest = manifest}) {
  const bin = mkdtempSync(join(tmpdir(), "verify-pushed-"));
  try {
    writeFileSync(join(bin, "docker"), fakeDocker);
    chmodSync(join(bin, "docker"), 0o755);
    return spawnSync("bash", ["docker/image/verify-pushed.sh", "ghcr.io/example/osd", digest, "osd:ci", "linux/amd64", revision], {
      encoding: "utf8",
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ID: id, FAKE_CONFIG: config, FAKE_ARCH: arch, FAKE_REVISION: label}});
  } finally { rmSync(bin, {recursive: true, force: true}); }
}

test("classic image store: the image ID is the pushed config digest", () => {
  const r = run({id: config});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /classic image store/);
});

test("containerd image store: the image ID is the pushed manifest digest", () => {
  const r = run({id: manifest});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /containerd image store/);
});

test("a different image is refused and named", () => {
  const r = run({id: other});
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`has ID ${other}`));
});

test("a wrong platform is refused", () => {
  const r = run({id: config, arch: "arm64"});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pushed platform linux\/arm64, expected linux\/amd64/);
});

test("a wrong revision label is refused", () => {
  const r = run({id: manifest, label: "e045eab1"});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pushed revision label 'e045eab1'/);
});

test("a malformed digest is refused before any lookup", () => {
  const r = run({id: config, digest: "sha256:xyz"});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a manifest digest/);
});
