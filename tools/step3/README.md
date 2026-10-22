# Step 3: persistent lint engine

`abap/src/lint/` contains `ZCL_OSD_LINT_ENGINE` and its refusal exception;
`abap/zosd_lint_probe.prog.abap` is the standalone OSGo report. This tools
directory is outside `abap_transpile.json`'s `src/test/gen` inputs and
`abaplint.jsonc`'s global files, and has no discoverable pack manifest. Normal
`npm test`, transpilation and default packs therefore do not load the external
`zcl_lnt_*` references. Slice 1 links it into the HTTP host only on request.

`prime(files,deps,config)` replaces one static registry, parsing once through
`ZCL_LNT_REGISTRY_RUN`. A failed prime clears the previous registry. `check`
resolves the file's owning object and returns its ordered issues, including
issues in other includes of that object. Missing prime/file/object raises
`ZCX_OSD_LINT_ENGINE`, never a successful empty result. Callers must serialize
access and own the relevant ABAP statics; the slice 1 host policy is below.
`update` explicitly raises: generated `update_file` exists,
but dependent invalidation and overlay restoration belong to the next slice.

## Pins and generated member names

Use the full native zlnt build for abaplint commit
`577f875ebec44cfaf64841cfe71c8ab8dc32622e`, core **2.120.56**. The names below
were resolved from that build's `names.json` and `native/lib` declarations:

| Type | Members used (ABAP importing parameters) |
| --- | --- |
| `zcl_lnt_registry_run` | constructor; `add_file(i_filename,i_raw)`; `add_dependency(i_filename,i_raw)`; `parse(i_config)` → ref to `zcl_lnt_registry` |
| `zcl_lnt_registry` | `get_file_by_name(i_filename)` → ref to `zif_lnt_file`; `find_object_for_file(i_file)` → ref to `zif_lnt_object`; `find_issues_object(i_iobj)` → ref to `zlnt_runtime_arra_c22708faf2e3` |
| `zlnt_runtime_arra_c22708faf2e3` | `dense()`; `items` is a standard table of refs to object, downcast to `zcl_lnt_issue` |
| `zcl_lnt_issue` | `get_key`, `get_severity`, `get_filename`, `get_message` → string; `get_start`, `get_end` → ref to `zcl_lnt_position` |
| `zcl_lnt_position` | `get_row()` → `f`; `get_col()` → ref to `zlnt_runtime_opti_8df4f98f9a3a` (checked `has`, `number_special`, then `value`) |
| `zlnt_runtime_tele_970d5104e5f4` | `now()` → elapsed milliseconds as `f`, using the build's wrapping runtime clock |

Also verified but deliberately unused: Registry `update_file(i_file)` and
`remove_file(i_file)` return ref to `zif_lnt_registry`; RegistryRun
`report_0493(i_reg_f149)` runs a whole-registry report. `find_issues_object`
performs dirty-aware parsing internally. No parse/report call is made by the
facade between the two unchanged checks.

## Build the pinned Node oracle without touching the shared checkout

`lint-oracle.mjs` defaults to `$HOME/dev/abaplint/packages/core` (override with
`--core` or `ABAPLINT_CORE`). It refuses unless both package and compiled
Registry versions are 2.120.56. The shared checkout inspected for this slice
was at `08f9193bb55b6584586b95e7226bd2e78f0ed067`, version 2.120.52; it was
left untouched. These exact offline commands build the pinned Git snapshot
using its already-installed dependencies, writing only a new temporary tree:

```sh
CORE_BUILD=$(mktemp -d /tmp/osd-step3-core.XXXXXX)
git -C "$HOME/dev/abaplint" archive \
  577f875ebec44cfaf64841cfe71c8ab8dc32622e packages/core |
  tar -x -C "$CORE_BUILD"
ln -s "$HOME/dev/abaplint/packages/core/node_modules" \
  "$CORE_BUILD/packages/core/node_modules"
npm run compile --prefix "$CORE_BUILD/packages/core"
export ABAPLINT_CORE="$CORE_BUILD/packages/core"
```

The compile script invokes `tsc` and stamps the runtime version. If the shared
dependency tree is unavailable, install into the temporary snapshot instead:
`npm install --ignore-scripts --no-audit --no-fund --prefix "$CORE_BUILD/packages/core"`,
then run the same compile command. Do not check out, install into, or build in
the shared repository. The oracle uses `Registry`, `MemoryFile`, `addFile`,
`addDependency`, `parse`, and `findIssuesObject`; it checks the same object twice
and refuses if ordered results change.

## Prepare corpora and export the effective ADT configuration

From this repository root, with its normal locked dependencies installed:

```sh
OSG=$PWD
KIT=$(realpath ../selfhost-m1/osg-check-kit)
mkdir -p "$OSG/.local/step3"
node tools/step3/lint-oracle.mjs --export-adt-config --root "$OSG" \
  > "$OSG/.local/step3/adt-config.json"
node tools/step3/prepare-corpus.mjs --kit "$KIT" \
  --out "$OSG/.local/step3/m1"
node tools/step3/prepare-corpus.mjs --kit "$KIT" \
  --config "$OSG/.local/step3/adt-config.json" \
  --out "$OSG/.local/step3/adt"
```

Export mode calls the real `configuredRegistry` in `tools/osd-store-registry.mjs`
and prints its effective config, including transpiler validation rules,
`check_syntax`, identifier restrictions, syntax settings and object allow-list.
It uses OSG's installed dependencies (currently core 2.120.73), independently
of the .56 oracle. It does not substitute the repository's lint rules.

The helper copies the M1 kit's frozen **OSG `3ee404ca`** corpus, retaining `src`,
`gen`, pack and `libs` paths, list order, bytes and dependency classification.
It writes separate `clean` and `broken` directories, each with `files.txt`,
`deps.txt`, `abaplint.json` and `target.txt`, plus a parent `corpus.json` with
counts and source/config hashes. Output must not already exist. This is a
frozen engine fixture, not an export of today's active OSG store/layers.

M1 has 2,785 files, with libraries as checkable inputs and **zero dependencies**;
the helper preserves that intentionally. It does not reclassify those libraries
as dependencies. Only the broken target's bytes change: insert
`step3_undefined = 1.` immediately before the `valid_id` assignment in
`src/adt/zcl_osd_adt_logoff.clas.abap`, preserving its object identity. Separate
directories avoid loading two versions of the same object into one registry.
The supplied kit's `check.sh` uses the older whole-registry CLI; use the commands
below for this object-scoped probe.

## Build on dell (about 12 GB; not run in this slice)

Run from the repository root. `ZLNT` is the unpacked build directory containing
`native/lib` and `names.json`; the existing local build is a sibling `zlnt/out`.
Keep the osabap build outputs isolated from other sessions:

```sh
OSG=$PWD
ZLNT=$(realpath ../zlnt/out)
export OSABAP_BUILD_ROOT="$OSG/.local/step3/native-build"
OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh node tools/gogen/osabap.mjs \
  tools/step3/abap/zosd_lint_probe.prog.abap \
  --lib "$ZLNT/native/lib" --lib tools/step3/abap/src/lint
PROBE="$OSABAP_BUILD_ROOT/.out/osabap"
```

The usual osabap prerequisites (Go, pinned libraries/converter, Node dependencies)
must already be bootstrapped. This command supplies the full emitted zlnt
library and explicitly opts into the facade's `src/lint` directory; it does
not change the regular transpile configuration.

## Run and diff

With `OSG`, `ABAPLINT_CORE` and `PROBE` set as above:

```sh
for corpus in m1 adt; do
  for variant in clean broken; do
    (
      cd "$OSG/.local/step3/$corpus/$variant"
      TARGET=$(cat target.txt)
      node "$OSG/tools/step3/lint-oracle.mjs" \
        --files files.txt --deps deps.txt --config abaplint.json \
        --target "$TARGET" > node.txt
      "$PROBE" --files files.txt --deps deps.txt --config abaplint.json \
        --target "$TARGET" -allow-read . > abap.txt
      sed '/^# ms /d' node.txt > node.stable.txt
      sed '/^# ms /d' abap.txt > abap.stable.txt
      diff -u node.stable.txt abap.stable.txt
    ) || exit 1
  done
done
```

List entries and target names are relative to the process working directory;
they retain their full logical paths. Both runners preserve dependency paths
too, unlike the old native batch report which reduced dependencies to basenames.
Lists accept LF/CRLF and empty lines. Sources are read as UTF-8 through binary
datasets in ABAP, following `native/zabaplint.prog.abap`. No fixture source
normalization is done by these runners.

Each runner prints `# check1 issues=N`, ordered pipe-delimited issue lines,
`# check2 issues=N`, the second set of lines, and `# ms prime=... check1=...
check2=...`. File IO is excluded from prime timing. The probe clock has integer
millisecond resolution. Only timing lines are removed for comparison; order,
duplicates, positions, severity, filenames, messages and issue counts stay.
This diagnostic format has no escaping and the ABAP report line size is 1,023;
use it for this controlled fixture, not as an HTTP transport.

Local .56 oracle output on the M1-rule fixture (the same issue on both checks):

```text
# check1 issues=0
# check2 issues=0
# ms prime=9306.150 check1=38.752 check2=8.382
```

```text
# check1 issues=1
check_syntax|Error|src/adt/zcl_osd_adt_logoff.clas.abap|12:5|12:20|"step3_undefined" not found, Target
# check2 issues=1
check_syntax|Error|src/adt/zcl_osd_adt_logoff.clas.abap|12:5|12:20|"step3_undefined" not found, Target
# ms prime=9387.969 check1=44.372 check2=11.589
```

These are Node observations, not ABAP latency or parity results. The whole M1
corpus still has its historical issues; the selected clean object has none.
Even equality using the exported ADT config would prove only the .56 engine
boundary: OSG's .73 core, DDLS diagnostics, AMDP warnings, ADT severity/URI
mapping, overlays and dependent-closure warm mode remain outside this slice.

## Focused source checks

```sh
for version in open-abap v750; do
  OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh node tools/step3/lint-source.mjs \
    --zlnt "$ZLNT/native/lib" --core-lib "$KIT/libs/open-abap-core" \
    --version "$version"
done
node --check tools/step3/lint-oracle.mjs
node --check tools/step3/prepare-corpus.mjs
node --check tools/step3/lint-source.mjs
git diff --check
```

`lint-source.mjs` runs the repository's unchanged rules against the new ABAP,
with real generated public declarations as dependencies. It replaces dependency
implementations with empty class blocks to keep this inexpensive; it checks
the adapter's signatures/types and syntax, not generated implementation bodies
or native execution. It also checks the probe and abapGit metadata. No normal
build settings or library checkout are edited by these checks.

## Slice 1: opt-in saved CHECKRUN in the serving OSGo process

Build from a normally prepared checkout (packs/libs fetched and `gen/` current).
The external full zlnt folder stays outside Git. From this repository root:

```sh
ZLNT=$(realpath ../zlnt/out)
OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh node tools/gogen/osgo.mjs \
  --lint-lib "$ZLNT/native/lib"
```

This extends `compileOsg`'s usual layer/library folders with the external zlnt
folder and `tools/step3/abap/src/lint`, and emits `zz_lint.go` next to the
compiled classes. Without `--lint-lib`, neither folder is loaded and that file
contains no linkage. The binary remains `tools/gogen/.out/osgo`. Normal builds
and ordinary CHECK/OUTLINE still use their existing providers.

`-lint-engine=abap` (or `OSD_LINT_ENGINE=abap`) selects `storelint.Compiler` for
CHECKRUN. An explicit flag overrides the environment; the default is `node`.
There is no fallback to Node for an opted-in source CHECKRUN. Selecting ABAP
on a binary built without `--lint-lib` keeps the server running, with source
CHECKRUN returning `notProcessed` and a rebuild instruction in `statusText`.

The build embeds the effective config returned by the real `configuredRegistry`
(the same JSON object that `lint-oracle.mjs --export-adt-config` prints), plus
the Node store's ordered file membership and hidden-layer decisions. At startup,
Go reads bytes from the configured object-store roots and library file lists;
ABAP, XML and ASDDLS files retain the leading `/` used by Node's registry.
Libraries are checkable inputs, as in `buildRegistry`, rather than dependencies.
The Go list must match the build's Node list exactly before priming. The
zlnt implementation itself is compiled code, not an additional registry input.

Prime runs once, synchronously before HTTP readiness. The generated bridge owns
one private `abap.Session` and `abap.Statics`, retained by closures for the
server's lifetime. `storelint.Compiler` serializes prime/check with its mutex.
The caller is already inside the HTTP work process; the bridge makes direct
typed ABAP calls without starting a dialog step, reacquiring `WorkProcess`,
re-entering HTTP, or borrowing the request's Session. The store still releases
its mutex around the compiler and performs its normal stale-result checks.
The existing 30-second CHECKRUN context is checked before/after ABAP execution;
it cannot preempt generated ABAP mid-call.

Every check verifies the entire ordered corpus identity before and after the
ABAP call, including metadata, libraries and hidden files. Source edits, new or
removed files, a different root, or an active-generation change require restart
and re-prime. Config guards cover `abaplint.jsonc`, `abap_transpile.json`,
`libs.lock.json` and the selected packs' manifests; changed config or file
membership/order requires a rebuild. Adding/removing packs or changing layer
selection likewise requires rebuilding the store facts; this slice does not
rediscover roots in a running server. Guard/IO failures, missing prime or target,
and ABAP panics produce `notProcessed` with a reason, never a clean report.
A failed ABAP call poisons that engine until restart.

`check` selects the saved logical filename for the requested class include (or
INTF/PROG/INCL main source), then calls `ZCL_OSD_LINT_ENGINE=>CHECK`. Ordered
issues, including duplicates and issues in sibling includes, map to severity
`E`, unchanged start row/column and message. URI mapping mirrors `diagnosticUri`
and `frameUri`, including class namespace escaping, include resources, INCL's
own URI and fallback to the triggering source. The existing Go inline SOURCE
refusal and dictionary-presence behavior remain in `storecheck`. DDLS/SRVD
source checks explicitly refuse here; DDLS generator diagnostics and AMDP
portability warnings are not supplied by the translated core. AMDP report
parity remains a separate acceptance gap, alongside the pin and warm-mode gaps.

### HTTP differential gate and proof of execution origin

Use an otherwise idle ABAP server and a **fresh, truncated log for each start**.
The log records one successful `lint-engine=abap prime=1 files=...`, then an
entry and completion line for each direct facade check, with a monotonic check
counter, issue count and elapsed time. A failure has no completion line.
The diff script requires that log and checks one completed invocation per POST.

For the stronger no-sidecar gate, run a copy of the binary in a directory with
no `osd` sidecar beside it. A nonexistent `OSGO_SIDECAR` alone is insufficient:
discovery also searches beside the executable.

```sh
mkdir -p .local/step3/abap-only
cp tools/gogen/.out/osgo .local/step3/abap-only/osgo
OSGO_SIDECAR="$PWD/.local/step3/no-sidecar" OSD_HEAVY_RANGE=80-89 \
  tools/osd-heavy.sh .local/step3/abap-only/osgo \
  -adt -lint-engine=abap -root "$PWD" \
  2> .local/step3/osgo-abap.log
```

Start the normal Node ADT host over the **same saved corpus, libraries, layers
and config**. Set `ABAP_URL` and `NODE_URL` to the respective loopback origins
using the actual ports reported by their launchers. The script uses the
conformance HTTP Session for CSRF/cookies and its namespace-aware response XML
reader; it does not compare a standalone CLI dump.

```sh
node tools/step3/checkrun-diff.mjs \
  --abap "$ABAP_URL" --node "$NODE_URL" \
  --abap-log .local/step3/osgo-abap.log \
  --variant clean --out .local/step3/http-clean
```

It always includes `ZCL_OSD_ADT_LOGOFF`, requires zero issues for `clean`, and
checks each object twice by default. `--objects objects.json` accepts additional
absolute ADT URIs or records such as
`{"uri":"/sap/bc/adt/oo/classes/zcl_osd_adt_uri","issues":0}`; `minIssues` is
also supported. `--repeat N` controls repetitions. Reports must be `processed`;
the exact ordered `(severity,line,column,message,uri)` tuples must match. No
message, coordinate, URI, ordering or duplicate normalization is performed.
`--out` retains both XML responses and parsed JSON. Mismatches exit nonzero.

Repeat with a disposable complete saved-store copy containing the broken logoff
mutation from `prepare-corpus.mjs` (`step3_undefined = 1.` immediately before
the `valid_id` assignment). Start **both servers on that broken corpus before
priming**, use a new ABAP log, and run:

```sh
node tools/step3/checkrun-diff.mjs \
  --abap "$ABAP_URL" --node "$NODE_URL" \
  --abap-log .local/step3/osgo-abap.log \
  --variant broken --out .local/step3/http-broken
```

`broken` requires a diagnostic naming `step3_undefined` on both engines, so two
empty reports cannot pass. Both variants use the same ADT class URI; they are
separate server lifecycles, not an overlay update. The earlier frozen M1 kit
alone is not a runnable ADT store: retain the full root/config/library layout
for this HTTP gate. Preserve any mismatch against OSG's actual .73 Node host;
a .56 engine-oracle match does not establish .73 product parity.

### Cheap local checks and remaining work

```sh
(cd tools/gogen/go && GOPROXY=off go test -race ./storelint ./objstore ./storecheck ./storecompiler)
(cd tools/gogen/go && GOPROXY=off go vet ./storelint ./objstore ./storecheck ./storecompiler)
(cd tools/gogen/go && GOPROXY=off go build ./storelint ./objstore ./storecheck ./storecompiler)
node --test tools/gogen/lint-engine.test.mjs tools/step3/checkrun-diff.test.mjs
```

The first Node test compiles a small ABAP implementation with the actual public
facade declaration and verifies the typed bridge and private persistent statics
without zlnt. The second uses synthetic HTTP servers to test report equality,
the nonzero broken gate, and execution-origin refusal. Go tests cover mapping,
refusals, corpus/config changes, serialization and delegation. These checks do
not substitute for dell's full zlnt build and clean/broken real HTTP gate.

The local echo host also builds and its Go tests pass with existing sibling
library sources read-only (`OSG_HOME` points to that prepared tree). This clone
does not have its own pinned `.local/lars` sources. `go vet ./cmd/osgo` reports
nine unreachable-code findings in generated echo-library methods; no required
check is suppressed or modified. The neutral touched packages pass vet.

Slice 2 must implement saved edits and overlay/inline SOURCE, including empty
and new-object buffers, dependent invalidation and restoration after failures;
match Node warm-mode closure behavior; and migrate/verify the .73 pin. It must
also close the DDLS/AMDP report gaps and measure end-to-end warm latency and
retained memory including the identity guards added here.
