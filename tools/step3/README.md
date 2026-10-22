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

Slice 1's restart/source refusals above are historical. Slice 2 below replaces
them. Warm checks, the .73 pin, DDLS/AMDP and measurements remain separate gates.

## Slice 2: edits and inline SOURCE without restarting

The ABAP provider keeps the saved snapshot bytes and the same private
Session/Statics and mutex. Before each CHECKRUN it captures the current saved
corpus, removes deleted files in the old order, then updates/adds changed files
in the current order through `ZCL_OSD_LINT_ENGINE=>UPDATE`. A content change or
ordinary file addition/removal does not re-prime. A generation switch between
requests is accepted; the store still rejects a switch, write or source/config
change during a request with a retry reason. The default Go/Node snapshot path
and ordinary CHECK/OUTLINE retain their existing behavior.

The facade uses zlnt `update_file`, `add_file` and `remove_file`.
Its retained lexical reader index follows Node's `OBJECT_NAME_PATTERN`, including
mentions in comments, strings and metadata. It replaces the changed object's
edges and dirties the same transitive reader closure as Node. Both sides of an
overlay use this exact update path. `find_issues_object` parses lazily at CHECK;
restoration leaves the saved objects dirty until the next check, or coalesces
with a subsequent installation. Unchanged bytes do not invalidate or parse.
This implements saved-registry invalidation; it does not select the separate Node
warm-check mode.

A SOURCE request resolves the saved main/include filename, or the first
writable root's `osd/<name>.<type>.abap` filename for a new object, matching Node.
An empty buffer is an update, distinct from removal. Under the checker mutex,
Go installs the overlay, calls ABAP CHECK, and restores the exact original bytes
(or removes a temporary new file) in a defer before checking input identity and
logging completion. Saved snapshots never adopt the overlay. A thrown check
returns `notProcessed`; after successful restoration the next request can run.
A failed update, restore or re-prime poisons the registry and requires restart,
since its state cannot be proven. No file is written for SOURCE.

Config guards, pack discovery and potential layer-winner changes select a full
re-prime fallback. `tools/step3/lint-inputs.mjs` reuses the real Node store/layer
resolver and `configuredRegistry`, exporting facts without checking source.
The ABAP engine is then fully re-primed with those facts; the processed report's
`statusText` says `ABAP lint: full re-prime after structural layer/config change`.
This structural fallback requires Node and the checkout's dependencies; if
unavailable, `notProcessed` explicitly says full re-prime needs structural input
resolution. Ordinary saved edits, file additions/removals without shadowing, and
overlays do not invoke Node or the compiler sidecar. Newly resolved checker roots
do not republish the runtime or replace the Go object's store build/active-version
facts; installing/routing new pack objects still belongs to host publication.

A full re-prime that exceeds the existing 30-second CHECKRUN context reports
the structural fallback and timeout; retry uses the completed primed registry.
Snapshot capture still reads/hashes the whole saved corpus before and after a
check. The Go baseline retains one saved byte copy in addition to the ABAP
registry and its reader index. End-to-end latency and retained memory must be
measured on the full native build; this slice makes no warm-latency claim.

### Overlay work counters

The former flat reader table scanned every edge when dropping one object's
entries and again for every name in the transitive closure. Prime repeated
the drop scan even for newly indexed objects. OSGo also implements SORTED
unique insertion and HASHED key reads as scans. The index now appends regex
words, sorts once per object and skips adjacent duplicates, storing edges in
1,024 fixed buckets. Integer INDEX access selects a bucket; exact word and
object comparisons resolve collisions. Removal reads the old files before
mutation, so include removal and replacement object identities leave no edges.
The lexical candidate set is unchanged; no signature heuristic narrows it.
The no-op guard accepts the bridge's blank false flag as well as an empty one.
An offline lexical audit of the available frozen M1 corpus (2,785 files,
2,210 objects, 233,383 edges, not gate 4's 3,028-file corpus) reaches 48 objects
from LOGOFF. That implies at least 11,435,767 flat-reader visits per changed
update before, on both install and restore. Those 48 objects remain candidates.

`STATS` exposes cumulative counters reset by prime. The Go bridge logs deltas
and separate durations for `phase=install`, `phase=check`, `phase=restore`:
`updates`, `noops`, `indexed`, `reader-visits`, `dirtied`, `parse-runs`,
`parse-objects`. `dirtied` counts distinct objects per update, including the
target once. `parse-objects` counts dirty candidates immediately before calling
`find_issues_object`; it is not a count of rule executions or completed parses
after an exception. Only the target object runs rules. Restore logs zero parse
work; a subsequent saved check includes any pending restore parse work.
The existing final `check=N issues=N elapsed=...` gate marker is unchanged.

The Node test command below compiles and executes the **actual facade** with
a small registry double and rejects statement/method stubs. Its 301-object,
30,301-edge fixture performs two changed install/check/restore overlays:
236 reader visits versus at least 242,408 flat-index visits before; four
objects dirtied (one per update, same set as before), two dirty parse candidates
versus four eagerly parsed before. If a saved check follows every restoration,
the restore parse is deferred to that check rather than eliminated. An exact
unchanged overlay dirties zero objects. A separate real Node test compares
ordered diagnostic tuples with eager versus lazy parsing across signature/body
changes, restore/no-op, empty buffers, new objects and batched removal/addition.
These checks isolate invalidation/index work; dell/i10 must measure the linked
engine, verify diagnostic parity and audit its compile report. The unchanged Go
snapshot capture and registry-wide global-name pass can still cost time.

### Slice 2 HTTP gates

Build with `--lint-lib` and start an otherwise idle ABAP host and the normal
Node host as in Slice 1, over the same clean saved corpus/config and a fresh
ABAP log. The hosts may share a disposable source root or use identical copies.
Do not restart either host between phases. Keep the Node runtime pinned to its
already compiled clean output when preparing a disposable tree, as in the
Slice-1 gate; checking an intentionally broken saved draft must not trigger a
runtime rebuild.

```sh
node tools/step3/checkrun-diff.mjs \
  --abap "$ABAP_URL" --node "$NODE_URL" \
  --abap-log .local/step3/osgo-abap.log \
  --mode overlay --out .local/step3/http-overlay

node tools/step3/checkrun-diff.mjs \
  --abap "$ABAP_URL" --node "$NODE_URL" \
  --abap-log .local/step3/osgo-abap.log \
  --mode saved-edit --out .local/step3/http-saved-edit
```

Overlay mode GETs and compares the hosts' saved logoff source, then POSTs inline
base64 clean -> broken (`step3_undefined`) -> clean text. After **each** overlay,
a saved CHECKRUN must be clean, proving broken diagnostics do not survive
restoration. It also checks a brand-new `ZCL_STEP3_OVERLAY_NEW` class, requiring
GET 404 before and after, and verifies the saved logoff bytes remain identical.
Each round has seven exact comparisons; the default two rounds yield 14.
The temporary class URI must be absent before starting.

Saved-edit mode supports writes: it uses the conformance kit's stateful Session,
LOCK/accessMode=MODIFY, PUT source/main with lockHandle, and UNLOCK. It writes
clean -> broken -> clean on both hosts and checks after each phase (six exact
comparisons with default repetitions). Finally it attempts restoration and
unlock on **both** hosts even if a check or one host's cleanup fails. Use a
disposable clean tree; original text is restored, while draft/history metadata
can record the test writes. Neither mode activates or republishes a generation.

Both modes require processed reports, exact ordered diagnostic tuples and
status text, a nonempty broken diagnostic naming `step3_undefined`, one startup
prime and exactly one completed direct ABAP check per comparison. They retain
XML/JSON with `--out`; failures exit nonzero. Default `--mode saved` preserves
the original clean/broken saved-corpus gate. `--repeat N` controls repetitions.

### Local evidence and remaining acceptance work

Cheap checks for Slice 2:

```sh
(cd tools/gogen/go && GOPROXY=off go test -race \
  ./storelint ./objstore ./storecheck ./storecompiler ./cmd/osgo)
(cd tools/gogen/go && GOPROXY=off go vet \
  ./storelint ./objstore ./storecheck ./storecompiler)
node --test tools/gogen/lint-engine.test.mjs tools/step3/checkrun-diff.test.mjs
# Reuse the focused source-check commands above for open-abap and v750.
git diff --check
```

Go tests cover remove/update/add order, overlay/check/restore order for existing
and new objects, empty text, thrown checks and retries, restore failure poisoning,
config re-prime status, pack/shadow discovery, generation changes, serialization,
and unchanged Node refusals. Node tests exercise the typed update/remove bridge,
the real Node registry's transitive invalidation and finally restoration, actual
structural fact export, and synthetic HTTP overlay/write gates including cleanup
after mismatches and HTTP failures. The facade passes focused open-abap/v750
source checks against the supplied zlnt declarations; ABAP stays ASCII and within
255 columns.

The gogen workflow runs the bridge/gate Node tests and the neutral checker
packages under vet and race tests.

These are local unit/source checks, not native execution parity evidence. Dell/i10
must build the full zlnt-linked executable and run both Slice-2 HTTP modes against
the actual .73 Node host, preserving mismatches and timing/memory evidence.
Slice 1's 24/24 gate at `5055acad` does not establish edit/overlay parity.
Remaining work: Node warm-check mode/closure acceptance and warm measurements;
engine .56 -> .73 migration/parity beyond these fixtures; DDLS generator
diagnostics; AMDP portability warnings and their ADT report mapping.

## TS-HG Go engine (opt-in)

Companion abapiti patch: `5b56ecf` on `feat/tshg-library`, based on
`selfhost` at `bae64e1`, in the separate `abapiti-tshg` clone.

`-lint-engine=go` (or `OSD_LINT_ENGINE=go`) selects abapiti's direct
TypeScript → HIR → Go translation of the pinned abaplint core. Node remains the
default. This is a separate build input from the TS-HA `native/lib` directory:

```sh
# From OSG, using the separate abapiti review branch feat/tshg-library.
OSG=$PWD
ABAPITI=$(realpath ../abapiti-tshg)
mkdir -p "$OSG/.local/step3"
(cd "$ABAPITI" && GOPROXY=off go build -o "$OSG/.local/step3/abapiti-tshg" ./cmd/abapiti)

# Heavy generation/build: dell runs these on i10. Use a fresh output directory.
OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh \
  "$OSG/.local/step3/abapiti-tshg" abaplint --target go \
  --go-package abaplint -o "$OSG/.local/step3/tshg"
LINT_LIB="$OSG/.local/step3/tshg/go"
OSD_HEAVY_RANGE=80-89 tools/osd-heavy.sh node tools/gogen/osgo.mjs \
  --lint-engine go --lint-lib "$LINT_LIB"
```

The abapiti patch adds `--go-package`: `main` retains the existing CLI and site
profiling outputs; another package name emits a library via `EmitPackage` and a
generated `library.go` wrapper. Library generation does not invoke `go build`.
Its module path is `zabaplint`; the exported API is `Checker.Prime(files, deps,
config)`, `Check(filename) []Issue`, `Update(filename, *raw)` and `Stats()`.
`nil` removes a file; a pointer to an empty string installs empty source. Paths
and bytes are preserved. The wrapper returns structured Issue getter values,
preserving order, duplicates and both start/end coordinates. It never parses
the batch CLI's text report. Use a fresh output directory to avoid mixing CLI
and library artifacts. No hand edits to generated code are needed.

OSG imports the library only in its optional generated `zz_lint.go` bridge and
uses a temporary modfile with a local `replace`; tracked `go.mod`/`go.sum` stay
unchanged. Generated abaplint sources stay in the external directory. Plain
builds have no import or dependency on that module. The existing
`--lint-lib native/lib` build still selects ABAP linkage when `--lint-engine`
is omitted. A Go-linked binary still defaults to Node at runtime. Selecting an
engine absent from the binary yields `notProcessed`, without fallback.

`storelint.NewGoEngine` supplies the same `storecheck.Compiler` lifecycle used
by ABAP: startup prime, ordered saved-file diffs, structural re-prime, checks
before/after execution for stale inputs, deferred overlay restoration and
removal of new overlay objects. Failed prime/update/restore poisons the host
compiler; a failed check is recoverable after restoration. The typed bridge
maps through the existing `MapIssues`/`diagnosticURI`, including severity `E`.
Library globals are serialized across Checker instances; the host also holds
its compiler mutex across install/check/restore. The generated wrapper indexes
lexical readers with Go maps, dirties transitive readers, and defers parsing
until Check. Prime iterates the registry once to build that index. Counter
names are shared; Go's `reader-visits` counts indexed readers visited, while
ABAP counts entries examined in its fixed buckets, so their values can differ.
The existing non-source presence behavior and DDLS/AMDP gaps still apply.
Structural layer/config resolution still uses Node for input facts, never for
Go CHECKRUN diagnostics. The 30-second context cannot preempt generated code.

For execution-origin proof, copy the binary away from sidecar discovery and
start it with a fresh log, over a disposable complete clean store:

```sh
mkdir -p .local/step3/go-only
cp tools/gogen/.out/osgo .local/step3/go-only/osgo
OSGO_SIDECAR="$PWD/.local/step3/no-sidecar" OSD_HEAVY_RANGE=80-89 \
  tools/osd-heavy.sh .local/step3/go-only/osgo \
  -adt -lint-engine=go -root "$PWD" 2> .local/step3/osgo-go.log
```

Use the allocated port from the heavy wrapper as `GO_URL`; start the normal
Node host on the same inputs as described above. The differential CLI retains
its existing `--abap` and `--abap-log` flag names for either engine. It infers
the selected engine from the single prime line, rejects mixed origins, and
requires one completed check for each POST:

```sh
for MODE in saved overlay saved-edit; do
  node tools/step3/checkrun-diff.mjs --abap "$GO_URL" --node "$NODE_URL" \
    --abap-log .local/step3/osgo-go.log --mode "$MODE" \
    --objects "$OBJECTS_JSON" --out ".local/step3/http-go-$MODE"
done
```

`OBJECTS_JSON` is the same object list used by the ABAP-vs-Node gate. Also run
the saved `--variant broken` gate against identical broken store copies with
a fresh server/log. Preserve mismatches against the actual OSG Node version
(.73), separately from the translated core pin (.56). Record cold prime time,
warm unchanged checks, saved edits and overlay install/check/restore times plus
retained memory. M1's 48 s batch result motivates this path; it does not prove
warm latency or HTTP equality for the new library. Full generated-core linkage,
real HTTP gates and latency/memory measurements are dell's remaining acceptance
work; they were deliberately not run during this implementation.

Focused local checks (small doubles, no full generated core):

```sh
(cd tools/gogen/go && GOPROXY=off go test -race \
  ./storelint ./storecheck ./objstore ./storecompiler ./cmd/osgo)
node --test tools/gogen/lint-engine.test.mjs tools/step3/checkrun-diff.test.mjs
(cd ../abapiti-tshg && GOPROXY=off go test ./tsfront \
  -run '^TestRegistryGo(Library|ReadPolicy)$' -count=1)
```
