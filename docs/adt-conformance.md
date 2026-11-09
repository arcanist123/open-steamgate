# Shared ADT conformance cases

The runner uses one case list for JS, osgo and an explicitly requested reference
system. This first slice covers discovery, HEAD, identity, package browsing,
search, class documents, default/active/inactive source, includes, versions,
objectstructure and five lock/session contracts. W1–W5 create disposable
classes, write inactive source, check it and delete with a lock handle.
`cases/activation.mjs` holds X1-X4: activation of the unchanged `$ZOSD_TEST`
fixture class (the plain success document), activation of a disposable class
saved with a syntax error (cancelled, a located E message, still inactive),
and ABAP Unit on the fixture's passing method and on its deliberate failure.
They pass on JS and on osgo (`go/adtactivate`, `go/adtunit`,
docs/osgo-adt-activation.md).

`cases/ddic.mjs` holds the read-only families over the `$ZOSD_TEST` fixtures
and their seed rows: D1-D7 (data element, table, table source, a structure
through the tables collection, repository type structure, virtual folder
facets and contents), P1-P5 (SQL console with a row limit, its refusal of a
write, its syntax check, table preview metadata and F8 rows) and A1 (the
inactive-objects feed). They pass on JS and on osgo, where the preview runs
through `go/adtpreview` and the feed through `go/adtread`.

`cases/families.mjs` holds the families ABAP-FS missed on both hosts
(docs/adt-abap-port/family-specs/functions-messages-xref.md): F1-F7 (a
function group's document, main program, a module's document and source, an
include's source, a 404 for a module the group lacks, the group's children in
the tree), M1-M2 (a message class's document and its text form), I1 (the
main program of an include, out of D010INC), N1-N3 (the program and include
preflights), U1-U2 (where-used over WBCROSSGT, and a 404) and G1-G2 (core
discovery with one collection per workspace, discovery grouped). They are
ABAP on both hosts; osgo seeds the cross-reference tables at build. The CDS preview
(`/datapreview/cds`) is not a case: on osgo it answers 501, because its
metadata needs `PARSE` of a DDLS, and osgo's store parses OUTLINE only.

Run heavy commands one at a time, waiting for the wrapper's slot:

```sh
OSD_HEAVY_RANGE=90-99 OSD_HEAVY_SLOTS=4 tools/osd-heavy.sh npm run transpile
OSD_HEAVY_RANGE=90-99 OSD_HEAVY_SLOTS=4 tools/osd-heavy.sh node test/adt-conformance/js.mjs
OSD_HEAVY_RANGE=90-99 OSD_HEAVY_SLOTS=4 tools/osd-heavy.sh node tools/osd-suites.mjs --group adt-conformance-only
```

Measured on the 2026-10-08 machine, the JS run takes about 14 seconds. An
OSGo conformance run takes under one second after an OSGo build of about
30 seconds and an ABAP/JavaScript transpile of about 19 seconds; those build
costs are why OSGo remains a separate advisory CI job rather than part of the
required JS fragment.

`js.mjs` starts the existing `test/start.mjs` server helper and places the
synthetic #642 outline fixture in a disposable repository view with an additional
source layer and matching active-source snapshots. The view links the existing
repository and built source evidence; fixture snapshots exist only in the
temporary view, so active requests can read the same synthetic bytes. It
pins the already-transpiled output so adding parser fixtures does not publish a
new live generation. It restores the working directory and layer/output settings
and closes the server on success or failure. Temporary runtime state is
separate; only the dependency tree `.local/lars` is linked for reading. `suite.mjs` runs the same HTTP cases
plus focused checks for the harness. The manifest registers it as required;
the group entry is a small import wrapper for selecting this fragment alone.

For an already running target:

```sh
node test/adt-conformance/run.mjs --target js --base http://127.0.0.1:8091
node test/adt-conformance/run.mjs --target osgo --base http://127.0.0.1:8091 \
  --expected test/adt-conformance/expected/osgo.json --only C1-discovery,C3-head
node test/adt-conformance/square.mjs
```

The base may include `/sap/bc/adt`. An external server must expose the repository's
`ZCL_OSD_ADT_URI` and `$STG_ADT`, plus the synthetic class/includes exported by
`test/adt-conformance/fixtures/source.mjs` in its source index for O1–O5.
Each case gets a fresh cookie jar and CSRF-fetch handshake. Cookies are updated
from every repeated Set-Cookie header. All requests have a timeout and stateful
session affinity unless a case explicitly requests stateless behavior. Additional
sessions exercise contention. Cleanup runs after assertion and setup failures;
all opened sessions log off. Transport and cleanup errors fail the suite. A
complete HTTP response from the target is a **target answer**, whatever its
status. If the mandatory
CSRF `HEAD`, mandatory discovery `GET`, or a case request returns 501, 500,
404 or another complete status, the runner records that status and the failed
assertion on the case as an observation. A known gap may therefore be observed
through the failed handshake. Connection refused, timeout, DNS, TLS and
malformed-HTTP errors remain infrastructure failures with no observation.

Case modules export arrays of `{id, point, title, setup?, request, expect, after?}`.
IDs remain stable; `point` groups the parity square. Requests take `method`
(default GET), `path`, `query`, `headers`, `body` and optionally a named `session`.
A request may be a function of the per-case context for values from setup.
`setup(ctx)` and `after(ctx, response)` may call `ctx.session.request()` and
`ctx.newSession()`. Cleanup must preserve handles before making assertions.

Expectations specify `status`, optional `contentType`, `headers`, `body` (value
or RegExp), `json` (top-level facts), `xml`, `bodyBytes` and `normalize`.
XML rules are `{xpath, value}`, `{xpath, regexp}` or `{xpath, count}`; all selected
values must satisfy the rule. XPath supports `/`, `//`, qualified element names,
`*`, an attribute equality predicate, and terminal `/@attribute` or `/text()`.
Prefixes resolve through the runner's namespace map plus `expect.namespaces`;
the response's prefix spelling does not matter. Unsupported XPath is rejected.
There is no external entity resolver. Missing matches fail. Byte assertions
compare the raw Buffer and bypass normalization.

Normalization masks host, client, user, ISO timestamps, ETags, lock handles,
session and generation IDs. JSON identity keys are masked recursively. For XML,
volatile attributes and handle/ID elements are masked; `normalize.values` allows
explicit identity substitutions and `normalize.host` replaces the target origin.
Only complete attribute names (optionally namespace-qualified) are matched;
`objectclient`, `clientXYZ` and stable `systemID` facts are retained.
Opaque identifiers keep their length. Protocol namespaces, object names and
source coordinates are retained. Assertions for handle shape use the unmasked
response so a wrong handle length cannot pass.

An assertion inside a case's `after()` checks that case's own contract (L4:
another session can reacquire after UNLOCK; L5: a lock survives a stateless
read), so it is case evidence like the request's assertions and is reported
as `after: ...`; write cleanup assertions are explicitly marked as cleanup
failures, as are transport errors and failing session close. Cleanup failures
always fail, including cases expected to be known gaps.

**osgo, 2026-10-08** (stoker's packed-column WHERE and hostclass seam,
osgo's ADT session per request, SYSTEM IDENTITY, the ENQ kernel over
go/adtenq, the logoff mount, and PARSE OUTLINE through the compiler sidecar
when CI provides `osd`): 17 pass, 6 known-gap with the observed first cause
in `expected/osgo.json`, 0 fail. Without a sidecar the five outline cases
fail: they expect passes, so a 501 refusal fails the ratchet.

**Running the osgo kit locally: run the binary where it was built.** osgo finds
the compiler sidecar through `OSGO_SIDECAR`, else `osd` beside its own
executable (`tools/gogen/.out/osd`, written by `tools/abapfs-osgo.sh`). A copy of
`tools/gogen/.out/osgo` taken elsewhere (to compare two builds, say) has no
sidecar, and exactly the eight compiler-backed cases fail: X1, C9b, O1-O5 and
W5. `-home` plays no part: measured 2026-11-09 at `bd8566cc`, in place 64/64
with and without `-home`, the copy 56/8 with and without it, and the copy with
`OSGO_SIDECAR=$PWD/tools/gogen/.out/osd` 64/64. With `-adt` the start-up log
names the sidecar it found or says it is absent.

`expected/osgo.json` maps every ID to `pass`, `known-gap: reason` or `n/a: reason`.
Unknown IDs, missing entries and invalid values are errors. JS cannot supply a
gap file. A known gap that passes fails with “update the expected file”. An n/a
entry is reported as not-applicable without running it. The suite writes
`suite-results/adt-conformance-<target>.json`; reports retain only status,
content type, byte count and assertion messages, never payloads, cookies,
credentials, tokens or handles. Exit codes: 0 expectations satisfied, 1 failed
cases (including unexpected passes) or blocking missing execution/discovery
evidence, and 2 invalid invocation or harness startup.

`discoverySucceeded` continues to mean specifically that `GET /core/discovery`
returned 200. `targetAnswered` is broader: at least one complete HTTP response
arrived from the target during the run. `handshakeStatus` is the first CSRF
`HEAD` response status, including a failed status such as 501. `executedCases`
counts only completed case requests, so an observed failed handshake can
legitimately report zero. Each observed row carries `observed: true`, its
response `actual`, and the assertion `detail`; an unobserved row carries neither
an `actual` response nor an observation claim.

Missing discovery and zero executed cases block a run whenever the expected file
holds at least one `pass` (or the target is JS, where every case is implicitly
expected to pass). While no expectation is `pass`, those
missing-evidence errors are advisory only when every eligible case was observed
through the handshake; otherwise they retain the old failure. Consequently, an
all-known-gap OSGo run whose every case observes the same 501 handshake exits 0:
its expectations are satisfied and every unexpected pass would still exit 1. A
JS run has no gap file, so it always requires the full successful handshake and
fails every non-2xx response. All-n/a runs, unreachable servers and
zero-observation runs fail.

The explicit unavailable inventory below is distinct from an HTTP run.

At main `b2190c1e`, osgo accepts `-adt` and mounts `/sap/bc/adt`. Every measured
endpoint reaches `ZCL_OSD_ADT_HANDLER`, which returns 501 at its first
`WHERE NP` trap; the expected file records that first trap plus the next known
gap behind it. Do not substitute the explicit inventory for this HTTP evidence.
It remains only for an OSGo build that cannot mount ADT:

```sh
node test/adt-conformance/run.mjs --target osgo \
  --unavailable 'osgo: not mountable on this main'
```

Every resulting row is a known gap with `observed: false`; the square labels it
unobserved. Build the osgo binary from the tested tree using
`tools/gogen/osgo.mjs`, start it with `-adt`, the wrapper's `STG_PORT`, and a
repository root, then run the same case list by URL. Promote expectations
individually with each implementation change.

O1–O5 reuse PR #642's synthetic source and hand-entered A4H 7.58 coordinates,
attributes and links. `fixtures/bytes.mjs` deterministically serializes those
facts independently of the serving serializer. Each response is compared in
full, across media negotiation and active-version requests. The expected
`xml:base` is derived from the exact request path and query, so O5 includes
`?version=active` as #642 serves it. These are our own
facts and synthetic code; no SAP-captured payload is tracked. The byte contracts
require #642's implementation, which is not on the starting main. The runner
does not replace that implementation or silently soften those assertions.

The square merger reads schema-1 reports from `suite-results/*.json`, chooses
the newest observation per target/case, and prints A4H / JS / osgo columns.
Unrelated suite report schemas are ignored. Conflicting results with the same
timestamp are rejected. Missing evidence remains `not-measured`; the renderer
never infers A4H pass from JS pass. No live SAP call is part of this runner's
local/CI verification. Future reference fixtures must use this same normalization
and clean-room facts rather than tracked captures.

CI wiring belongs to dell's separate PR; this slice changes no workflows.
That PR must keep required checks exactly `test` and `scan`, and implement
Alice's ratchet as follows:

- For the CI wiring, the required JS command is
  `node test/adt-conformance/js.mjs` after transpile. It must not receive an
  expected-gap file; any JS case failure or non-2xx handshake/discovery response
  fails the required verdict.
- The advisory osgo job must build the tested tree, start
  `tools/gogen/.out/osgo -adt -port "$STG_PORT" -root "$PWD"`, wait for health,
  and run
  `node test/adt-conformance/run.mjs --target osgo --base "http://127.0.0.1:$STG_PORT" --expected test/adt-conformance/expected/osgo.json`.
  If this main lacks mounting, publish the explicit unavailable inventory with
  all cases unobserved; never substitute it for an HTTP run when `-adt` exists.
- Keep known-gap results advisory. Promote each implemented case to expected
  `pass` in the expected file, alongside its implementation change.
- Propagate any failure of an osgo case whose expectation is `pass` into the
  required `test` verdict. Making the osgo job advisory with
  `continue-on-error` alone is insufficient: `test` must consume its report
  (and captured exit status) before completing, and fail on those regressions.
  Missing/malformed reports, HTTP infrastructure failures, unsuccessful
  discovery and zero executed cases fail `test` only while any entry
  in `expected/osgo.json` is `pass` (then they cannot prove the
  expected passes were retained). While every osgo expectation is
  `known-gap` or `n/a`, transport failures stay advisory; observed gaps satisfy
  expectations.
- Preserve the runner's non-zero status for an unexpected known-gap pass and
  surface it in the advisory osgo result until its expectation is updated.
  Read outcomes from exit code plus JSON: `pass` is `cases[].status === "pass"`,
  `known-gap` is `cases[].status === "known-gap"` with `observed: true`, `n/a`
  is `cases[].status === "not-applicable"`, and an unexpected pass is
  `cases[].status === "fail"` with `detail` naming the stale expected entry.
  Upload `suite-results/adt-conformance-js.json` and
  `suite-results/adt-conformance-osgo.json` even on failure and print the merged
  square; artifact upload or advisory handling must not erase the required
  verdict.

Round-1 verification on this branch: JS passes all 23 read/lock cases,
including O1–O5 against #642's fixture and exact request URL. The measured
OSGo run answers 501 at every case's CSRF handshake; those are 23 observed
known gaps. The focused fragment checks the harness and the same JS HTTP cases.
No six-shard run or workflow edit is part of this slice.

Write contracts follow measured class responses: empty CREATE 200, duplicate
CREATE 400 AlreadyExists, and missing or bogus PUT/DELETE handles 423
InvalidLockHandle. W1 compares active source before and after PUT. W5 requires
a processed report for the object and source coordinates on an error; clean
means zero E messages, so warnings are allowed. Same-user cross-session handles
work on A4H, while local hosts intentionally bind handles to sessions; that
divergence is outside the shared cases. JS uses a real disposable $ADT_WRITES
package and unique class names, and checks that Git status is unchanged. Its
default report directory is `.local/suite-results`; callers may supply `output`.

Write cases require a target-owned writable disposable package. Supply it with
`--write-package '$DISPOSABLE'` (or `ADT_WRITE_PACKAGE`) when running by URL,
including operator-run reference checks. JS provisions and supplies its own
package in a temporary tree. The osgo CI job stages its package alongside the
outline fixture before transpile and in the retained source snapshot, and
passes its name explicitly. No reference system package is assumed.

Before CREATE, W cases retain the attempted identity and require GET 404.
Cleanup reconciles the attempted path even after a lost response or an error:
GET, LOCK if present, DELETE with the handle, and GET 404. Pre-existing objects
and clean duplicate refusals are never deleted; unresolved cleanup fails the run.

OSGo's host write continuation now passes W1-W5: CREATE, inactive PUT under
an ABAP-session/ENQ handle, duplicate refusal, DELETE and inactive CHECK. The
shared JS and OSGo runs each pass all 30 current cases. The staged OSGo write
package is `$STG_ADT_WRITES` (the plain `src/adt-writes` folder's store name);
pass that name to `--write-package`, as CI does. JS still provisions its own
`$ADT_WRITES` layer in the disposable view.

The targeted abapfs connect/write/create run measures 6 PASS, 0 FAIL and
1 MISSING (program name validation), with no objects left behind. Its write
group is enabled in the OSGo expectations; program creation/deletion also
ratchets to PASS. Saving does not activate an executable generation. Newly
created class active skeletons are retained for the OSGo process lifetime;
see `tools/gogen/go/adtwrite/README.md` for the state and restart boundary.
