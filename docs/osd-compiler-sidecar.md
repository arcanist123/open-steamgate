# Compiler sidecar

`osd compiler --stdio` implements the compiler-provider
[contract v1](../../../adt-osgo/SIDECAR-contract.md). In a source checkout,
`node tools/osd-compiler-sidecar.mjs --stdio` runs the same module. Child
launchers use `compilerCommand()` from `tools/osd-host.mjs` so a packaged host
starts its own compiler mode.

Requests and responses are NDJSON, one response per line with the request's
`id`. Stdout contains only protocol responses; tool logs go to stderr.
Malformed lines receive `BAD_REQUEST` and processing continues (a line with
no recoverable id has no response id). EOF closes the process successfully.

`hello` requires `contract: 1` and returns `contract`, `osd` (the local
`osd-version.json` version, otherwise `source`), `transpiler` (the commit pin
in the bundled `libs.lock.json`), `capabilities: ["check", "outline"]`, and `limits`:
`maxSnapshotBytes: 16777216`, `maxConcurrentRequests: 1`. Requests are serial.

`check` requires the contract's snapshot root, generation, objects, versions,
and relative file paths with SHA-256 digests. The snapshot pins the objects
osgo names; missing or changed snapshot files return `SNAPSHOT_MISMATCH`.
Listed snapshot paths are contained by `realpath`; a file or directory
symlink that resolves outside the snapshot root returns `BAD_REQUEST`.

Contract statement: the verdict is computed from exactly the registry identified
by `registryHash` (+ `configSha`); every on-disk member is re-verified before
the answer. `snapshot` pins the named objects by SHA-256 and realpath containment
and is also reverified before answering.

For the default activation mode, after applying the inactive overlay, `registryHash` is SHA-256 of the JSON
encoded sorted list of `[filename, sha256(raw)]` for every registry file:
sources, includes, `gen/`, resolved libraries (including `OSD_LIB_*` overrides)
and active copies of inactive dependencies. Filenames sort by code unit order.
`configSha` hashes the raw abaplint config file used to build that registry.
Successful answers carry both 64-character hashes, `inputCount` (all registry
members), and `virtualFiles` (filenames without disk backing, empty when none).
Before answering, each on-disk member is read from its resolved real path and
compared with the registry raw by SHA-256, and the config is re-hashed. A changed
or vanished input returns `SNAPSHOT_MISMATCH` with `inputs moved during check`.
This identifies the actual validation view, rather than claiming that the
builder's generation hash covers all check inputs.

generation = transpile output, keyed by abap_transpile.json + sources + transpiler;
lint config is not an input of the output, but is an input of every check verdict,
so verdict caches key on its sha.

By default (or with `snapshot.checkMode: "activation"`), checks use the store's
existing ACTIVATE validation, including publication rules, active dependency
overlays and the transitive reader closure. The optional `snapshot.checkMode:
"saved"` instead calls `ObjectStore.check`, the same code Node STORE CHECK uses:
all other saved inactive drafts remain in the registry, without activation's
active dependency overlay or dependent diagnostics. The Go store adapter always
selects this saved mode. The
registry is built on demand; no transpile, publication, serving database or
ABAP execution is involved.

Results contain `diagnostics` with severity, `ABAP_SYNTAX` code, text, object
identity, include path, and A4H coordinates: lines start at 1, columns at 0,
and the end points to the last character. Unknown operations receive
`UNSUPPORTED_OP`; future capabilities remain unimplemented.

| op | request | response |
|---|---|---|
| `hello` | `contract: 1` | versions, capabilities, limits |
| `check` | snapshot | diagnostics, registryHash, configSha, inputCount, virtualFiles |
| `outline` | snapshot (one object), object `{type, name, version}` | outline, registryHash, configSha, inputCount, virtualFiles |

`outline` returns exactly the JSON produced by STORE `PARSE` kind `OUTLINE`,
under `outline`, including `{found:false}` for an unknown object. It calls the
same handler and `structureOf` over a store view of a fresh snapshot-only
abaplint registry. Both active and inactive requests read the files the snapshot
names; the object identity and version must match the snapshot object. Active
copies and the working tree outside that snapshot cannot supply coordinates.
The root store index supplies object existence: an indexed object with no
proven active files uses an empty `files` array and still returns `found:true`
with Node's outline skeleton. Unavailable includes are likewise absent.
The same hash checks, realpath containment and final snapshot verification as
`check` apply. Outline also reads `abaplint.jsonc` through the same configured
registry construction used by the Node store, because syntax settings can
change declaration facts and coordinates.

For outline, `registryHash` uses the same sorted `[filename, sha256(raw)]`
encoding as check, but covers only the supplied parser files; `inputCount`
counts them and `virtualFiles` is empty. `configSha` hashes the raw
`abaplint.jsonc` bytes used to configure that parser registry, and is re-hashed
before answering. This identity describes the actual outline inputs without
claiming the validation registry or the generation covers them.

Example NDJSON request (replace the digest with SHA-256 of the named file):

```json
{"id":2,"op":"outline","snapshot":{"root":"/tmp/outline-system","generation":"fixture","objects":[{"type":"CLAS","name":"ZCL_EXAMPLE","version":"inactive","files":[{"path":"src/zcl_example.clas.abap","sha256":"<64 lowercase hex characters>"}]}]},"object":{"type":"CLAS","name":"ZCL_EXAMPLE","version":"inactive"}}
```

The answer is `{"id":2,"outline":{"found":true,...},"registryHash":"...",
"configSha":"...","inputCount":1,"virtualFiles":[]}`. Links use the existing A4H coordinates:
lines start at 1, columns at 0, and ends point to the last character.

Light verification:

```sh
OSD_HEAVY_RANGE=90-99 OSD_HEAVY_SLOTS=4 tools/osd-heavy.sh node node_modules/mocha/bin/mocha.js --require tools/osd-test-isolation.cjs test/osd-compiler-sidecar.mjs
```

## Go client (round 1)

`tools/gogen/go/compiler` provides a lazy client with one child per Client and
serialized requests. Discovery tries `OSGO_SIDECAR`, then `osd` beside the osgo
executable, and never searches PATH. With `-adt`, osgo logs the
outcome at start (`compiler     sidecar <path>`, or `sidecar absent; tried
[...]` and what cannot compile), because a binary copied away from `osd` otherwise
fails only later, request by request. `BuildSnapshot` hashes regular files
relative to the root, refuses lexical or symlink escapes and special files,
honors its context between files, and bounds the source bytes it reads.
`Check` returns diagnostics and the registry identity, or a typed refusal
preserving the protocol code.
The default check deadline is 30 seconds and covers admission, handshake, stdin
writes and response reads. Protocol anomalies, timeout and cancellation during
an operation stop the process group; cleanup waits at most 2 seconds for the
child (configurable with `KillGrace`). Idle deaths detected by the next request
use the same cleanup and backoff. Buffered final answers survive EOF. Sidecar
stderr is discarded. Both hello limits must be positive integers; response lines
are capped at 1 MiB before hello and `MaxResponseBytes` afterward, including
the newline; the client default is 64 MiB. Canceled admissions return without
updating the last error.

`osgo -compiler-status [-root <tree>]` performs hello and prints JSON containing
discovery, versions, contract, capabilities, limits, restarts and the last error.
It exits successfully even when the sidecar is absent (`found:false`).
`Status()` itself only reads state; `Hello` starts the child. Call `Close` when
the client is no longer needed. The osgo serving host injects this client into ZOSD_STORE through the
storecompiler adapter for CHECK and PARSE OUTLINE.

The Go unit tests re-execute their own test binary as a fake sidecar and need
no Node. The gogen suite registers `test/osgo-compiler.mjs`, which drives the
real Node CLI through the Go client on a single-class fixture. It checks a
clean verdict, syntax coordinates and a false snapshot hash.

## ZOSD_STORE round 2

`cmd/osgo` injects `storecompiler.Adapter` into objstore. The adapter starts the
lazy client on the first CHECK or PARSE kind OUTLINE, builds a snapshot from the
saved working files for CHECK or the explicitly requested version for OUTLINE,
and requests the advertised operation. Active snapshot files are read
from the physical generation paths, but their logical source paths produce the
same object/include names and coordinates Node reports. Their digests are also
compared with the generation's built hashes before the sidecar is called.

storecompiler.Adapter.Check filters diagnostics to the requested object, maps
include paths to FILE and zero-based columns to legacy one-based COL, and
returns objstore.Issue rows. CHECK maps these to the Node destination's issue rows and JSON,
scalars and tables. A successful outline response is passed through byte for
byte. Provider availability is resolved before object lookup or active-source
selection. An absent sidecar keeps the standalone CHECK answer (including
NOT_FOUND for missing objects) and the standalone `unknown store command PARSE`
refusal, even for missing or unproven-active objects. Other sidecar refusals—including `SNAPSHOT_MISMATCH`,
`TIMEOUT`, `BAD_REQUEST`, `CONTRACT_MISMATCH` and `UNSUPPORTED_OP`—return clear
store errors and a `NOT_SUPPORTED` JSON refusal rather than hanging.

Diagnostics may carry an optional `rule` field from a newer sidecar. It is
retained when present and omitted when absent, so an older sidecar's responses
remain valid. Operation discovery still depends on `hello` capabilities: an
older child that advertises only `check` receives no outline request.

Contract-v1 snapshots identify on-disk files by relative paths and SHA-256 hashes;
they cannot carry Node's in-memory CHECK `IV_SOURCE` buffer. Round 2 therefore
returns `UNSUPPORTED_OP` for a present sidecar rather than checking stale saved
text or mutating the object. This is the sole compiler parity gap expected by
`tools/gogen/storecmp.mjs`; if Node and Go ever agree on that path, the ratchet
fails so the expected-gap entry must be removed rather than silently widening.

Each snapshot file may additionally carry `logicalPath`, a nonempty root-relative
parser filename without parent traversal. `path` still identifies the physical
bytes for containment, size limits, hashing and final verification. When omitted,
`logicalPath` defaults to `path`; the sidecar does no generation-path rewriting.
The store supplies this mapping explicitly, using its own active-source resolver
for complete generation sources, pre-save copies (also overlay copies), shared
digest storage, archive sources backing overlays, legacy retained snapshots and
legacy working sources copied after digest proof. Thus a digest-only physical
filename or an archive filename never substitutes for the overlay's ABAP name.
For example: `{"path":"build/source-by-digest/<digest>",
"logicalPath":"src/zcl_example.clas.abap","sha256":"<digest>"}`. A `logicalPath` must name a file of the object it is listed under (abapGit name `<name>.<type>...`, `#` for `/`; the file type follows the store's type table, so an `INCL` is a `.prog` file and a `STRU` a `.tabl` file, and a package is `package.devc.xml` or `<name>.devc.xml`), so one object's bytes cannot be mapped under another object's name; otherwise the answer is `BAD_REQUEST`.

`test/osgo-storecmp.mjs` compares ten direct Go store answers with Node execute,
including saved inactive dependency CHECK, syntax issues, class includes,
active/inactive class and program outlines, missing objects, and an indexed class
without proven active sources. The same ten calls run through Node destination
call and Go ZOSD_STORE with a complete RFC caller signature; issue rows use the
existing DDIC structure (which has no FILE field), while EV_JSON remains byte
exact. This adapter proof supplies IV_JSON/EV_JSON explicitly: the generated
ABAP front's narrower signature still omits them, and its existing gap ratchets
are unchanged. It does not prove those commands through that generated front.
Absent-sidecar comparisons cover existing, missing and unproven-active CHECK and
PARSE against standalone Go. The Node sidecar suite separately compares explicit
physical/logical mapping across each active-source resolver path, with parser
registry hashes and byte-equal outline JSON. The unsaved IV_SOURCE gap remains
ratcheted. Frozen goldens record the ten Node execute answers, not RFC responses.

The focused proof is:

```sh
GOCACHE=/tmp/osgo-gocache go test ./objstore ./storecompiler ./compiler
GOCACHE=/tmp/osgo-gocache go test -race ./compiler
OSD_HEAVY_RANGE=90-99 OSD_HEAVY_SLOTS=4 tools/osd-heavy.sh node node_modules/mocha/bin/mocha.js --require tools/osd-test-isolation.cjs test/osgo-storecmp.mjs test/osgo-store-goldens.mjs test/osgo-compiler.mjs test/store-destination.mjs test/osd-compiler-sidecar.mjs
```
