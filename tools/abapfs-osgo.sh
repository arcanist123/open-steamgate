#!/bin/sh
# Shared osgo conformance setup; CI uses --setup-only before its two runners.
# Run the complete ABAP-FS recipe through tools/osd-heavy.sh locally.
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
  --setup-only) setup_only=1 ;;
  '') setup_only=0; : "${STG_PORT:?Run through tools/osd-heavy.sh to assign STG_PORT}" ;;
  *) echo "usage: sh tools/abapfs-osgo.sh [--setup-only]" >&2; exit 2 ;;
esac

# Stage before transpiling, and again in the new live generation. Both the
# inactive fixture and its retained active copy must enter zz_store.json.
stage_fixture() {
  node --input-type=module <<'JS'
import {mkdirSync, writeFileSync, readFileSync, existsSync} from "node:fs";
import {join} from "node:path";
import {files} from "./test/adt-conformance/fixtures/source.mjs";
// The write cases' disposable package (run.mjs --write-package '$STG_ADT_WRITES').
const packageXml = `<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DEVC><DEVCLASS>$STG_ADT_WRITES</DEVCLASS><CTEXT>Disposable write cases</CTEXT></DEVC></asx:values></asx:abap></abapGit>`;
const live = existsSync("build/live/manifest.json");
for (const root of ["src/adt-writes", ...(live ? ["build/live/source/adt-writes/src"] : [])]) {
  mkdirSync(root, {recursive: true});
  writeFileSync(join(root, "package.devc.xml"), packageXml);
}
for (const [name, source] of Object.entries(files)) {
  for (const root of ["src/conformance-fixture", ...(live ? ["build/live/source/conformance-fixture/src"] : [])]) {
    mkdirSync(root, {recursive: true});
    const path = join(root, name);
    writeFileSync(path, source);
    if (readFileSync(path, "utf8") !== source) throw new Error(`fixture differs: ${path}`);
  }
}
JS
}
stage_fixture
npm run transpile
stage_fixture
mkdir -p tools/gogen/.out
printf '%s\n' '#!/bin/sh' "exec \"$(command -v node)\" \"$PWD/bin/osd.mjs\" \"\$@\"" > tools/gogen/.out/osd
chmod +x tools/gogen/.out/osd
test -x tools/gogen/.out/osd
node tools/gogen/osgo.mjs
[ "$setup_only" = 0 ] || exit 0
node tools/osd-adt-gogen-gate.mjs tools/gogen/.out/osgo-compile-report.json tools/osd-adt-gogen-allowlist.json

log="${TMPDIR:-/tmp}/osgo-adt.log"
tools/gogen/.out/osgo -adt -port "$STG_PORT" -root "$PWD" >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$STG_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$STG_PORT/health" >/dev/null 2>&1 || {
  tail -20 "$log"
  exit 2
}
# The osgo expected file includes write: save/restore was verified before enabling it.
node tools/abapfs-conformance.mjs --url "http://127.0.0.1:$STG_PORT" \
  --expected test/fixtures/abapfs-conformance/expected-osgo.json \
  --out .local/conformance/abapfs-osgo
