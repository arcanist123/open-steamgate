# Runner object-cache opt-in (step 4b)

`OSD_GOGEN_CACHE=1` enables the per-class frontend cache in `osd run` /
`tools/gogen/osabap.mjs` and the Go ABAP Unit runner. The default remains off.
`1` selects `$OSD_RUN_CACHE/frontend` (or `.local/osd-run/frontend`); any other
nonempty value selects that directory. Unit's whole-frontend snapshot cache is
independent: `--no-cache` bypasses the snapshot and still allows this explicit
object-cache opt-in. The opt-in does not change the kept report binary's key.

Ordinary cacheDir callers retain the globally guarded production lookup.
The runner opt-in also allows replay from the existing v3 dependency namespace,
only after validating its complete artifact/query closure, reusing proven
unchanged component certificates where eligible, and validating the ordered
program-state transcript. Unknown observations, missing providers,
changed named query answers, corrupt entries and nonportable payloads fall back
to lowering. No lexical source-word dependency approximation replaces those
checks. `GOGEN_PROVENANCE=1` additionally exposes provenance reporting.

`frontend-provenance-metadata.mjs` no longer emits scheduling rows as dependency
edges. Selection and other program-derived indexes are rebuilt for each program;
their reads during lowering are guarded by the ordered program-state transcript.
Replay therefore rejects a changed index answer that affects a cached class
without making every scheduled object a dependency of that class.

A runner content certificate selects whether to record dependency metadata.
An unchanged invocation uses the global content guard without repeating the
observer. An eligible existing-class edit uses scoped recording and can consult
validated v3 entries; other changes restore full recording. The certificate
hashes raw input bytes, logical relative filenames, layer order and tool content; it contains no filesystem timestamps or build-root
paths. It is a performance hint, never authority to reuse IR. A stale or corrupt
certificate cannot bypass the normal global key or replay validation.
Validated dependency hits are promoted atomically into the current global
generation, so the recording-off warm run following an edit has those entries.

Cache entries and graph/index files publish by unique temporary file plus atomic
rename. Concurrent writers may lose a candidate from the bounded v3 index; this
causes a miss, not partial IR. The report binary retains its separate build lock.
Fresh-process concurrent tests cover both global and dependency modes.

## Existing-class certificate fast path (step 4b.2)

The opt-in dependency cache writes a checksummed `.certificates` index beside
each immutable provenance graph. It contains effective ordered owner/file input
hashes, dependency components and their saved certificates, forward and reverse
artifact edges, interned query specifications and answer certificates, and entry
roots. Candidate keys bind the saved components and replay guards. The compact
index is linked to its exact full graph; a missing, corrupt or incomplete index
uses the existing graph validator.

Fast validation is bounded to edits of existing CLAS owners. Inventory, object
roles, file order, configuration and CDS inputs must match; the tool namespace
must also match. Changed owners invalidate the reverse dependency closure.
Query contracts describe possible answer changes independently of former
provider edges: local discovery, selected supplied contributions and CATCH answers are rebuilt
for every round; named lookups bind unchanged inventory; provider scans have
explicit type or whole-input coverage. Uncovered contracts and newly observed
unknowns invalidate their consumers and use full validation. Additions, removals,
non-class edits and order changes retain the original validation path.

Unchanged complete roots use their saved component certificates without loading
the full graph. Affected components use the original artifact/query validator,
seeded with proven unchanged component certificates. Every reused class still
passes ordered program-state replay. Saved SCC work survives rounds, while
current query answers and current component results reset at each program
boundary. Artifact projection memos survive only within the same explicit
closed-program invocation, with unchanged input/config guards and per-artifact
identity checks. Standalone compiles retain their previous reset behavior.
Observers and lowering transcripts keep their original per-compile lifetimes;
provider observations retained by the registry keep their existing validation
rules. Closure-controller discovery runs under the scheduling role. Private
frozen selections use a membership set without changing their order; mutable
selection callers retain ordinary array membership checks.
Internal caching omits the pure `rtti-owner` reporting projection, which copies
and filters growing RTTI maps for every owner although final-output rows never
enter dependency keys. Actual RTTI construction still runs. Explicit provenance
reports retain the projection. The closure algorithm, emission and whole-file
gofmt also continue to run.

Frontend timing records carry explicit round IDs (1 onward; 0 denotes osabap invocation
phases). Per-round counters cover `graphLoading`, `certificateValidation`,
`observation`, `replay` and `finalization`; emission and gofmt are separate.
Observation counts query/row recording, inventory bookkeeping and inherited
transcript merges. It excludes cheap getter/edge/gap checks and named-query
intern hits, as well as parser/lowerer work inside observed calls. Timing every
hot getter added about 60–70% to an isolated million-read loop, so those hooks
remain outside this subcounter; their work remains in frontend time. These counters can overlap finalization, and are not
additive subdivisions of frontend time. Finalization covers cache graph/key/index
publication; graph loading includes compact-index preflight. Both `OSABAP_TIMING=1` and the opt-in
diagnostic stream expose them. Certificate diagnostics include changed owners,
invalidated nodes/entry variants and query evaluations for each graph and round.
Timing flags are sampled once per round, and redundant edge-index integrity
checks use set membership to avoid quadratic edge scans.

The fresh-process negative control deliberately drops a reverse edge after
integrity validation and requires the cold oracle to detect stale constant
readers in both line modes. A separate negative control requires the inner shadow validator to reject the
same fault. The outer byte-oracle control explicitly leaves that inner checker
off so it can observe stale bytes even under CI. Persisted edge, query-coverage
and owner corruption tests recompute the storage checksum and verify
full-validator fallback.

The final focused matrix passes 259 tests with `--preserve-symlinks
--test-concurrency=1` and CI's `GOGEN_CACHE_SHADOW_VALIDATE=1` (503.2 s), with no
failures or skips. Its CI oracle covers 60 supported mutations in 62 attempts
with zero mismatches (132.2 s). The production dependency-mode oracle with 300 generated
controls and the pinned real libraries passes 66 fresh-process observations:
64 supported mutations, two retained unsupported pool-constant attempts, and
zero mismatches (921.1 s). Both line modes, multi-edits and reverts are included.
The production-mode verification ran against implementation `67d444af`
in a 70 GiB / zero-swap scope with the 24 GiB Node heap.
The matrix includes closure scheduling, guarded round reuse, both reverse-edge
fault detectors, and real runner timing/round checks. The host boundary passes all four
tests; TypeScript and the 153-budget changed-file size gate also pass.

## Scoped recording (step 4b.2b)

The first edited invocation previously left the observer active throughout all
six frontend rounds. Reusing 3,048 classes still paid for provenance checks on
every preparation, syntax and RTTI registry read. The row-recording subcounter
excluded most getter/edge/gap checks, so its small value did not measure this
cost. Unchanged runner invocations already bypassed the observer completely.

The cache now publishes a checksummed `recording.plan` containing the effective
ordered owner/file hashes, config/CDS identity, tool identity, provider rows and
redundant forward/reverse provider edges. This is a recording plan, not authority
to reuse IR. Certificate validation, dependency keys and atomic ordered replay
remain the authorities for hits. A source edit seeds the affected providers;
their reverse closure and any provider with potentially changed or uncovered
query answers must refresh. Unchanged, covered provider observations can be
retained while the observer is idle. Complete ABAP syntax and successful
recorded DDIC construction are required before trusting a provider; stateless
DDIC getters need no fictitious cached `parsedType` field.

The program-level observations that remain necessary are:

| Observation | Recording scope and reason |
| --- | --- |
| Parser/macro expansion, global-definition construction, syntax/type resolution | Affected or uncovered providers and builds they invoke. Lowering may consume definitions, scopes, expanded statements or DDIC types that were built earlier; recording only the lowering lookups cannot recover these dependencies. |
| Supplied-signature preparation | Affected providers' declaration-owner lookups. The complete current supplied index is still rebuilt without observing unrelated providers. Its named contribution answers are recorded when a missing class consumes them, and previous answers are checked by certificate validation. |
| Local-definition discovery | Each selected discovery frame. Its answer depends on selection and test inclusion as well as source bytes, so it must refresh even without an owner edit. Provider syntax observations survive retained closure rounds. |
| Ownership safety | Affected providers' expanded-statement answer. This can change with macros and belongs in their refreshed provider metadata. Unchanged answers are retained under the provider proof. |
| Selection and actual class lowering | Selection records a temporary transcript per candidate, including function-module ownership and static-attribute lookups. Every miss, including conservative replay refusals, adopts that transcript into its complete lowering frame. All nested provider and named-answer reads are observed. Hits discard the temporary transcript, open no lowering frame and merge no old lowering transcript. |

Closure discovery, frontend preparation for other owners, certificate query
evaluation, replay, RTTI and final-output passes run with the observer idle.
Retained provider preparation keeps an idle owner frame; its proven reads
bypass recording. Replay guards and closure discovery are explicitly scheduling.
Unframed artifact queries remain observable while idle: a named or semantic
read adds a global unknown marker, and an unclassified scan retains its own
unknown marker. Both refuse current certificate reuse and make the next plan
full-only. The existing host adapters retain their synchronous invocation lifetime. No compiler-module
initialization hooks or new builtin imports are introduced. Full graph/key/index
publication still runs for newly recorded lowerings and retains validated
provider closure rows. The recording plan is atomically replaced after a
successful compile, preserving new provider edges for later edits and reverts.

Inventory additions/removals, owner roles, file order, non-class edits,
config/CDS/tool changes, missing/corrupt plans and unexplained global artifact
observations restore full recording. A supplied registry that changes its
input scope after its parse boundary gets an explicit unknown marker and
cannot publish a complete dependency entry. Unknown provider observations and
failed/unobserved construction cannot become trusted through a plan.
The published scope must match the recorder's last observed inventory/config;
inputs synthesized after that boundary make the plan full-only. Discarding a
retained build's provider rows leaves an explicit incomplete marker.

The mutation oracle now classifies its emission projections as final output
and its independent borrowed-definition replay control as scheduling. Its
production dependency mode initializes the plan before the supplied registry's
parse and reports `scopedRecording`, so a successful oracle cannot silently
exercise only full recording. The real-library smoke entered scoped mode in
both line modes with byte-identical cold output. Focused tests also cover a
newly introduced provider edge followed by an edit of that provider and a
revert, retained closure-round syntax, stateless DDIC typing, corrupt plans and
both reverse-edge negative controls.

The key computer re-reads the live provenance maps at each closure round, so
replaced maps and new unknown markers cannot be hidden by its invocation
lifetime. Immutable graph indexes remain cached across rounds. A small
eight-owner selection estimate (two simulated misses, 15 paired samples of
100 iterations) captured 16 selection rows, adopted four into the two missing
lowerings, and added about 0.03 ms per eight-owner scan (0.037 vs 0.007 ms).
This measures the selection seam, not whole-corpus build time; no new full
zlnt proof was run for these fixes.

The serial proof accepts `--baseline <source-copy>`. It primes an independent
cache for that copy, then runs baseline warm immediately before candidate warm.
The proof serializes its own large processes; other sessions may still run
concurrently and must be reported with the timings. Its report includes
recording scopes, per-round invalidations, a measured edited-disabled comparison, the 450-second
planning gate and the measured baseline warm comparison. Baseline source copies
can be made with `git archive`; no shared worktree or installed input is edited.

The matched warm comparison on implementation `163c44dd` measured `e718aa49`
at 393.2 s (317.3 s frontend), immediately followed by this branch at 364.5 s
(298.9 s frontend): 7.3% faster in total. The candidate's graph-loading,
certificate-validation and observation counters are all zero in the warm run.
The historical 346.2-versus-390.0 s comparison did not reproduce; the baseline
itself now takes 393.2 s. Those historical absolute times confounded machine/run
variation with code changes, and certificate-index work cannot explain the warm
difference because the warm path does none. This pair does not isolate the
individual causes of historical machine/run variation.

Both warm runs reuse 3,048 of 3,055 classes in the final round. Their Go and
database artifacts are byte-identical across versions. The symbol maps are also
identical except for the build stamp: the Git archive reports `unknown`, while
the checkout reports the implementation commit. All within-version oracle
comparisons retain the stamp and require byte identity for `symbols.json` too.

The unchanged-input scoped rounds refresh 14 provider ledgers: eleven domains
without observed type construction, the round-dependent local discovery owner,
and its two reverse-dependent core providers. The other 3,979 provider ledgers
stay retained. These are conservative metadata refreshes, not fourteen class
cache misses.

### Resumed full-shard measurements (step 4b.2b)

Measured on 2026-10-17 at implementation `163c44dd`, with installed
`zlnt-system` v0.5.2, copied inputs, six closure rounds, a 24 GiB Node heap,
and a separate 70 GiB / zero-swap systemd scope for every large child.
Go compilation was skipped. Each total is the child’s `total` phase.

The six completed pre-reset cases were retained. The interrupted edited
attempt was discarded: it had already replaced the recording plan, published
3,077 cache payloads and changed four dependency candidate indexes. The plan
checksum passed, but the pre-edit state could not be reconstructed reliably.
One fresh cold-enabled recovery rebuilt that state before edited-enabled and
edited-disabled ran back to back in separate processes. The recovery artifacts
match the original cold-enabled artifacts byte for byte. No completed case was
rerun as a replacement measurement.

**Concurrent-load caveat:** These are shared-host timings. The pre-reset cases
have incomplete concurrent-load history; the abandoned partial edit is not a
measurement. Before recovery, uptime was 16 minutes, load was 2.99 / 2.15 / 1.54,
106 GiB memory was available and swap use was zero. Other sessions were running
abapiti step4 frontend/self-host jobs (including Go compilation), and HANA
services were active. Light validation overlapped only recovery and finished
before the edited pair. The resumed timings below also carry a concurrent-load
caveat; the load snapshots are in the local
evidence. The pair is observational and does not isolate the effect of load.

The 30-second load samples during the edited pair show:

| Run | One-minute load range | Minimum available memory (GiB) |
| --- | ---: | ---: |
| edited-enabled | 3.74–10.70 | 91.5 |
| edited-disabled | 4.06–9.06 | 89.6 |

| Run | Cache | Frontend (s) | Emission + gofmt (s) | Total (s) |
| --- | --- | ---: | ---: | ---: |
| Cold | on | 1,227.9 | 63.3 | 1,293.3 |
| Baseline `e718aa49` cold | on | 1,578.6 | 60.6 | 1,641.3 |
| Baseline `e718aa49` warm | on | 317.3 | 72.5 | 393.2 |
| Warm | on | 298.9 | 63.1 | 364.5 |
| Cold | off | 524.6 | 54.7 | 581.4 |
| Warm | off | 507.1 | 57.8 | 567.1 |
| Recovery cold | on | 1,246.1 | 64.0 | 1,313.2 |
| Edited | on | 566.5 | 104.0 | 672.6 |
| Edited | off | 541.6 | 60.8 | 604.6 |

Edited-enabled does not beat edited-disabled: 672.6 s versus 604.6 s (11.3% slower).
The 450 s planning gate is missed. Enabled/disabled emission is 83.836 /
39.488 s; gofmt is 20.205 / 21.318 s. The frontend difference is 24.844 s.
The larger emission difference is measured under the changing load above;
this pair cannot attribute it to a code change.

`edited-enabled` reports `dependencyRecording=true`, 9 lowered and 3,046 reused
in its final round. `edited-disabled` reports `dependencyRecording=false`,
3,055 lowered and 0 reused in its final round.

Edited-enabled per-round `OSABAP_TIMING` counters (seconds):

| Round | Graph loading | Certificate validation | Observation rows | Replay | Finalization | Lowered / reused | Refresh / retained providers |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 25.677 | 20.544 | 0.082 | 5.989 | 49.727 | 13 / 2997 | 17 / 3962 |
| 2 | 7.218 | 20.948 | 0.088 | 1.891 | 15.839 | 12 / 3009 | 14 / 3979 |
| 3 | 8.880 | 0.775 | 0.079 | 2.125 | 1.380 | 25 / 3012 | 14 / 3979 |
| 4 | 6.794 | 0.177 | 0.063 | 1.937 | 1.342 | 21 / 3030 | 14 / 3979 |
| 5 | 7.280 | 0.115 | 0.062 | 1.827 | 1.451 | 10 / 3044 | 14 / 3979 |
| 6 | 8.037 | 0.046 | 0.064 | 2.162 | 1.204 | 9 / 3046 | 14 / 3979 |

These counters overlap and do not partition frontend time. Edited-disabled
has zero for all five counters in every round. Dependency recording remains
enabled throughout the edited-enabled invocation; scoped idle regions account
for its reduced observation work, rather than disabling dependency validation.

The source edit is `CLAS ZCL_LNT_ADD_MODULE`, changing the existing test literal
from `add 2` to `add 3`. Round 1 refreshes that provider and its affected
`ZCL_LNT_P_STATEMENTS_DEL` / `ZCL_LNT_P_STATEMENTS_FAC` providers, together with
the conservative refresh set. Later rounds refresh fourteen providers: eleven
domains without observed type construction, the local discovery owner
`CL_ABAP_UNIT_ASSERT`, and `CL_ABAP_TESTDOUBLE` / `CL_AUNIT_AUTHORITY_CHECK`.
Other proven provider rows remain retained. Parser/macro, syntax/type, supplied
declaration, local-discovery and ownership observations remain recorded in
affected/selected frames; every actual lowering miss records a complete frame.
Hits still pass ordered replay and do not import old lowering transcripts.

This resumed edit follows one cold prime, without an extra unchanged warm
pass. Across all closure rounds it lowers 47 distinct classes; three lowering
decisions explicitly cite the edited owner as their dependency invalidation.
Other misses cite absent candidates, replay refusals or supplied-query changes.
They remain fully recorded and are not all source dependency invalidations.

Edited warm and edited cache-disabled cold are byte-identical for all four
artifacts: `zz_app.go`, `zz_generated.go`, `zz_db.json`, and `symbols.json`.
Only `zz_generated.go` differs from the unedited output.

| Artifact | Edited SHA-256 (both runs) |
| --- | --- |
| `symbols.json` | `123e899453e3d8cd2984fe8104150ce8ddf8dabe0a4b11f484e833e59cfc2fd8` |
| `zz_app.go` | `0f9c674325764e70e1ab344d955df38c6cfa09223864655c95d853af72d5b74c` |
| `zz_db.json` | `96f34c8d2780b008a708b9f1de6e7c5edaed9fe7aed5a15b04768b252b2d37f8` |
| `zz_generated.go` | `5d035242edf8115d0b53b3e6de9efadd7fcf587d31e340ae9bc2d9b7d6576425` |

Edited manifest SHA-256: `ee31d4a1e69d630f148899245afb252b063e4f62be17a78359833532136454a5`.

Light validation on this implementation passed 266 focused cache/runner tests
(no failures or skips), all four host-I/O tests, TypeScript, and all 153
changed-file size budgets. The explicit changed-path leak scan also passed.

Machine-local evidence: `/mnt/ssd-510/osg/stoker/tmp/c4b2b-scoped-proof/report.json`,
per-case logs/diagnostics/build roots beside it, and
`/mnt/ssd-510/osg/stoker/tmp/c4b2b-resume-load.ndjson`. Interrupted evidence has
`.interrupted` suffixes; the six-case report is `report.before-resume.json`.

### Full-shard proof for step 4b.2 (historical)

Measured on 2026-10-17 from the implementation based on `e718aa49`, with
installed `zlnt-system` v0.5.2 and tool identity `b723301a419c`. All six cases
used fresh processes and distinct build roots. The proof copied the inputs,
kept the six closure rounds, capped every large child at 70 GiB with zero swap
and a 24 GiB Node heap, and skipped Go compilation. Cold production overlapped
small regression tests; warm, edited and disabled controls ran after those tests
finished. The installed input was unchanged.

| Run | Cache | Frontend (s) | Emission (s) | gofmt (s) | Total (s) |
| --- | --- | ---: | ---: | ---: | ---: |
| Cold | off | 537.8 | 38.0 | 21.2 | 599.3 |
| Cold | on | 1,487.9 | 42.4 | 19.0 | 1,551.5 |
| Warm | off | 522.7 | 38.7 | 19.9 | 583.7 |
| Warm | on | 318.2 | 48.7 | 20.7 | 390.0 |
| Edited | off | 524.2 | 39.0 | 19.5 | 585.2 |
| Edited | on | 797.8 | 42.7 | 20.0 | 862.7 |

Totals are the child’s `total` phase; the proof also records wall time. Go build
is 0 (skipped) in every case.

| Enabled run | Graph loading (s) | Certificate validation (s) | Observation rows (s) | Replay (s) | Finalization (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold | 37.7 | 3.0 | 11.7 | 11.2 | 126.0 |
| Warm | 0.0 | 0.0 | 0.0 | 12.1 | 0.0 |
| Edited | 23.4 | 24.6 | 11.5 | 17.1 | 41.6 |

These are the defined subcounters above, aggregated over rounds 1–6. They
can overlap and do not partition frontend time.

The edit changes one existing owner, `CLAS ZCL_LNT_ADD_MODULE`. In the main
6,429-node saved graph, its reverse closure invalidates 6 nodes and
3 entry roots; the first round evaluates 73,624 round-sensitive queries.

| Saved graph | Rounds checked | Nodes | Invalidated nodes | Invalidated entry roots | Queries evaluated |
| --- | --- | ---: | ---: | ---: | ---: |
| `0df3e54490ed` | 1 | 6429 | 6 | 3 | 73624 |
| `9050128e09c5` | 1, 2 | 2747 | 0–13 | 0–13 | 436 |
| `96203a126505` | 1, 2, 3 | 378 | 0–20 | 0–20 | 387 |
| `71163e8db675` | 2, 3, 4 | 290 | 0–18 | 0–18 | 303 |
| `2b9117aeca15` | 2, 3, 4, 5 | 275 | 0–3 | 0–3 | 98 |
| `ff3ee99ea720` | 5, 6 | 21 | 0–1 | 0–1 | 1 |

Smaller saved graphs also reject query answers from a different closure-round
selection. Their context invalidations are not additional source edits.

The dependency-invalidated classes lowered are `ZCL_LNT_ADD_MODULE`, `ZCL_LNT_P_STATEMENTS_DEL`, `ZCL_LNT_P_STATEMENTS_FAC`.

Additional lowering beyond unchanged refusal cases: `CL_ABAP_UNIT_ASSERT` (ordered replay/candidate refusal).

Unchanged warm lowers 9 distinct classes and reuses
3,048/3,055 classes in the final round. Every reused class still
passes ordered replay.

All four artifacts—`zz_app.go`, `zz_generated.go`, `zz_db.json` and
`symbols.json`—are byte-identical for cold on/off, unchanged warm on/off,
and fresh-process edited warm versus edited cache-disabled cold. The edit
changes `zz_generated.go` only. Baseline manifest SHA-256: `e480151e44fe7e62c99c14bfe4a0be8f1e8538a829b950972201ff5406bde300`;
edited manifest: `2f86760fe30835c4a725952db0b233b503c6e0f3b1d893b8aeb25a435c083db8`.

**Performance gates: edited missed; unchanged warm
missed.** Edited takes 862.7 s against the
561.9 s target and 585.2 s for this run's cache-disabled edited control.
Unchanged warm takes 390.0 s against the 346.0 s ceiling.

The edited result is faster than the historical 965.1 s
cache-enabled result, and misses the 280–400 s planning range.

Certificate reuse passes the correctness checks, but the end-to-end
performance objective remains open. Remaining work is to profile and reduce
repeated artifact/query observation and parsed-program rebuilding, and avoid
redundant provenance serialization during promotion/publication. A certified
previous selection and emission caching remain separate planned steps; neither
is implemented here. Warm runs have dependency recording off, so their remaining
fixed parsing/signature/RTTI/selection and emission/gofmt costs also need work.
Ordered replay and unknown/nonportable/audit refusal paths must remain intact.

Machine-local evidence: `/mnt/ssd-510/osg/stoker/tmp/c4b2b-cert-proof-release/report.json`,
with per-case logs, round diagnostics and generated artifacts beside it. The
edited copy is `/mnt/ssd-510/osg/stoker/tmp/c4b2b-cert-input-release`.

Step 4b.2 changes these files (unqualified names below share `tools/gogen/`):

| Area | Files |
| --- | --- |
| Compact proofs and validation | `frontend-certificates.mjs` (new), `frontend-v3-key.mjs`, `frontend-v3-shadow.mjs` |
| Round lifetimes and replay integration | `frontend-closure.mjs`, `frontend-provenance.mjs`, `frontend-provenance-recorder.mjs`, `frontend-queries.mjs`, `frontend-artifact-digests.mjs`, `frontend-object-cache.mjs`, `frontend-session-types.ts`, `frontend.mjs` |
| Timing and runner proof | `frontend-timing.mjs` (new), `frontend-cache-diagnostics.mjs`, `osabap.mjs`, `cache-runner-proof.mjs` |
| Tests and CI | `frontend-certificates.test.mjs` (new), `frontend-artifact-digests.test.mjs`, `osabap.test.mjs`, `cache-oracle-capture.mjs`, `.github/workflows/gogen.yml` |
| Documentation | `docs/gogen-cache-runners.md` |

## Diagnosis

The recovered patch's 4,096-operation / 256-KiB recorder budget rejected valid
classes before the disk cache could write them. On the initial 3,010-class
statements selection, the cold-write census exactly accounts for the reported
1,844 misses:

| Refusal | Classes |
| --- | ---: |
| Transcript budget | 1,840 |
| Nonportable replay arguments | 2 |
| Circular input fingerprint | 1 |
| Nested mutation of a borrowed value | 1 |
| Persisted | 1,166 |

A smaller fresh-process reproduction selected four statements classes and two
runtime descriptors. Unchanged warm: four hits, two misses; both misses were the
same transcript-budget refusals. Tool, registry-input, config and DDLS component
hashes were unchanged, and emitted Go hashes matched. Paths, PIDs and timestamps
did not explain those misses. A separate repeated-static-call reproduction
showed the same refusal.

Recording now compacts repeated guards **before** applying bounded limits
(65,536 retained operations, 16 MiB transcript, 1 MiB per fingerprint). Reads
still fingerprint each borrowed value; aliases changed/restored between reads
and nested mutations still refuse reuse. Writes fence guard compaction. Replay
copies top-level collections only when it writes them and validates before
committing effects. Nonportable or oversized inputs still lower normally.

The tool identity now excludes generated `.out`, Go symbol maps and `zz_*`
outputs; rebuilding cannot invalidate it by rewriting build metadata. Folder
DDLS identities use logical filenames instead of absolute input roots. The
runner's generated wrapper already enters the registry with a logical filename.

The current runner closes dependencies in multiple rounds, unlike the old
single-pass measurement. Profiling the pre-fix runner also found repeated class
and method array searches during dynamic-static registration. Those lookups now
use indexes, preserving class/method emission order and first-method precedence.
Static READ-ONLY declaration scans now run only for external writes, the only
case that consumes their result; reads and owner/friend writes avoid that scan.
Emission indexes dynamic adapters and filters by the requested method before
resolving result conversions, rather than rebuilding every adapter per call.

Dependency keys now hash strongly connected components once per immutable
graph, then combine their content certificates. Traversal numbers never enter
the key; sorted symbolic members, artifact digests, query answers and child
certificates do. Mutable graphs supplied by callers are recomputed. The preserved
pre-CATCH-projection graph contains 6,184,673 artifact query rows; an offline probe computed
877 saved entry keys in 43.0 seconds, rather than revisiting the shared closure
for each entry.

The `supplied/selected-contributions` query guards its actual projection:
provider identities and the complete supplied-parameter set rebuilt from parsed
methods. An unrelated implementation-body edit no longer becomes a raw-source
dependency of every consumer of that projection. Other query contracts retain
their artifact/raw-file guards. Frozen provider lists are shared, and only
immutable scalar arrays receive memoized set certificates. Tests cover body
edits, added `IS SUPPLIED`, new implementors, dependency cycles, mutable answers
and the existing mutation oracle.

The real runner's six closure rounds exposed another overbroad guard. An
intermediate unchanged warm run still missed 57 initial classes: 42 CATCH-answer
variant evictions, seven `wanted`/signature/structure-prefix guard changes, and
the eight recording refusals. The CATCH caller consumes only whether a selected
matching subclass exists. Recording the full matching list retained unnecessary
contexts and thrashed the four-candidate index. It now records that boolean,
computed from a prebuilt current hierarchy index. Unknown hierarchy observations
still refuse dependency reuse. Tests exercise true/false transitions through
unnamed descendants, while additions leaving the predicate true keep reusing.
The twenty-member ancestry limit, cycles, local names and runtime fallback
parents retain their existing behavior.

Global entries are named by the logical program selection (sorted names); a
bounded atomic index permits cross-context fallback. This preserves differences in
ordered effects, such as which earlier class registered a shared structure.
Full replay guards still validate each variant. Dependency trials let ordered
replay fork the collections it writes, without first copying every growing map.
Dependency keys bind the class's artifact/query closure and actual program
observations.

## Reproduction and evidence

`GOGEN_CACHE_DIAGNOSTICS=<file>` appends opt-in NDJSON with per-class hit/miss,
replay refusal details and cold-write refusals. Version records expose tool,
input, config and DDLS component hashes. A diagnostic-only sidecar carries prior
write refusal reasons into the next process; it never affects cache decisions.
`OSABAP_TIMING=1` prints frontend, emission, Go build and total phase records.
`osd run` also prints execution time. Normal runs print neither diagnostic stream.

The serial proof copies inputs, changes one class literal in the copy, compares
all generated Go/JSON artifact hashes (including symbols), and saves each row
before proceeding. Each large child runs in a 70-GiB / zero-swap systemd scope
with a 24-GiB Node heap. It skips Go compilation by default; `--build` enables it.
Emission includes gofmt. Use an SSD temp directory and a pre-existing Go cache:

```sh
OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh env \
  TMPDIR=/path/to/ssd/tmp NODE_OPTIONS=--max-old-space-size=24576 \
  OSD_RUN_CACHE=/path/to/ssd/tmp/run GOCACHE=/path/to/go-build \
  node tools/gogen/cache-runner-proof.mjs .local/zlnt-system \
  /path/to/ssd/tmp/evidence /path/to/ssd/tmp/input-copy
```

Both destination directories must be fresh. The input install is read only;
source symlinks are dereferenced while copying. All measured invocations use
different build roots. The report records cache-off cold/warm controls,
cache-on cold/warm, and edited warm/cold controls. Go compilation and execution
are covered separately by the real runner and Unit tests.

## Full-shard measurements (step 4b, historical)

Measured on 2026-10-17 with installed `zlnt-system` v0.5.2, implementation
`8dc0b019`, copied inputs, separate build roots, and Go compilation disabled.
The runner grows its class selection through six rounds: 3,010, 3,021, 3,037,
3,051, 3,054 and 3,055 classes. Phase times below cover the complete invocation,
not just its final round. The old 203.5-second frontend measurement used the
earlier single-pass runner and is not a control for these measurements.

| Run | Frontend (s) | Emit/gofmt (s) | Go build (s) | Total (s) |
| --- | ---: | ---: | ---: | ---: |
| Cold, cache disabled | 510.2 | 56.4 | 0 (skipped) | 568.7 |
| Cold, cache enabled | 1,246.5 | 59.9 | 0 (skipped) | 1,308.5 |
| Unchanged warm, cache disabled | 519.5 | 61.1 | 0 (skipped) | 582.9 |
| Unchanged warm, cache enabled | 218.5 | 63.2 | 0 (skipped) | 283.8 |
| Edited cold, cache disabled | 503.4 | 56.3 | 0 (skipped) | 561.9 |
| Edited warm, cache enabled | 834.6 | 63.2 | 0 (skipped) | 900.1 |

The same proof was repeated on the final branch (after the review fixes:
shared typed guard keys, typed guard values, fail-closed unowned artifact reads,
tracked-and-untracked tool identity), rebased on `46fd4738`:

| Run | Frontend (s) | Emit/gofmt (s) | Go build (s) | Total (s) |
| --- | ---: | ---: | ---: | ---: |
| Cold, cache disabled | 497.4 | 56.8 | 0 (skipped) | 556.3 |
| Cold, cache enabled | 1,506.7 | 57.5 | 0 (skipped) | 1,566.3 |
| Unchanged warm, cache disabled | 484.4 | 54.4 | 0 (skipped) | 541.1 |
| Unchanged warm, cache enabled | 279.7 | 64.5 | 0 (skipped) | 346.2 |
| Edited cold, cache disabled | 501.7 | 58.4 | 0 (skipped) | 562.3 |
| Edited warm, cache enabled | 900.8 | 62.0 | 0 (skipped) | 965.1 |

Unchanged warm reused 3,048 of 3,055 classes in the final round; all four
artifact comparisons were byte-identical, and no `unowned-artifact-read`
refusal occurred in any run. Typed guard values cost about 60 s of the warm
run against the earlier measurement. The edited run is still slower than the
cache-off control; making it faster is the next step (certificate fast path,
then a certified previous selection, then emission caching).

The unchanged warm invocation re-lowered eight distinct classes out of 3,055:
**99.74% reuse** across the complete invocation. Every round exceeded 99%; the
lowest was the initial round, 3,002/3,010 (99.73%). Its final round reused
3,049/3,055 (99.80%). The eight initial misses were three borrowed-value mutation
refusals, two nonportable replay arguments, one circular fingerprint, and two
transcript-budget refusals. There were no misses of stored entries from key or
replay instability.

Warm-enabled total is 0.487 times warm-disabled total, meeting the 1.10-times
limit. Its frontend phase is 58% shorter. Cold recording is expensive: its
frontend takes 1,246.5 seconds versus 510.2 seconds without the cache.

Warm diagnostic timestamps place the first class lookup at 91.1 seconds, with
about 82 seconds between closure rounds. Class processing windows total about
37 seconds, including conservative re-lowering. Emission takes another 63.2
seconds. Class-IR replay alone cannot remove registry parsing, syntax/selection
work between rounds, or emission.

The edited invocation reaches content/cache setup at 76.7 seconds, the saved
dependency-component index at 143.0 seconds, and its first class decision at
189.8 seconds (process-elapsed diagnostic times). It must observe and revalidate
dependencies after an input edit. This already exceeds the 100-second edited
total target before the first decision or emission; that target is not met.

Edited total is 900.1 seconds, including 834.6 seconds frontend and 63.2 seconds
emission. Diagnostic class-processing windows, including dependency probes,
replay and conservative lowering, total about 212 seconds. Gaps between closure
rounds total about 378 seconds, and roughly
55 seconds remain after the final class decision. This observation/validation
path is more expensive than simply lowering with caching disabled; high IR
reuse does not yet make the first edited invocation faster. Its 900.1-second
total compares with 561.9 seconds for edited-cold with caching disabled.

Across all six edited rounds, the only newly lowered classes beyond the eight
unchanged refusal cases are `ZCL_LNT_ADD_MODULE`, `ZCL_LNT_P_STATEMENTS_DEL` and
`ZCL_LNT_P_STATEMENTS_FAC`. Every one reports
`dependency:CLAS ZCL_LNT_ADD_MODULE`, matching the saved graph's reverse closure.

The unchanged warm and cold-enabled outputs are byte-identical to cold-disabled
output for `zz_app.go`, `zz_generated.go`, `zz_db.json` and `symbols.json`. Their combined
manifest SHA-256 is
`f5beb3b9bf37a16a8eeb582c2eeb723de508599e0d4052266724701d39aab863`.
The disabled warm control has the same manifest. Edited-warm and edited-cold
are also byte-identical; their manifest is
`7b4f5eb91ecc371caf45bb0421e78a68810fe4cf6fd5a8f861476edbe98a01d3`.
The literal edit changes only `zz_generated.go`, and the proof asserts that
edited output differs from the unchanged baseline.

Machine-local evidence is retained at
`/mnt/ssd-510/osg/stoker/tmp/c4b2-run/result/report.json`, with per-case logs,
NDJSON diagnostics and generated artifacts beside it. The edited input copy is
`/mnt/ssd-510/osg/stoker/tmp/c4b2-in/result`; the installed input was never edited.

## Changed files (step 4b, historical)

The implementation is based on `7503cdee`; it does not require the subsequent
parse-observation work on main.

| Area | Files |
| --- | --- |
| Runner opt-in and timing | `tools/osd-run.mjs`, `tools/gogen/osabap.mjs`, `unit.mjs`, `runner-cache.mjs`, `runner-cache-recording.mjs` |
| Cache and replay | `tools/gogen/frontend.mjs`, `frontend-inventory.mjs`, `frontend-object-cache.mjs`, `frontend-replay.mjs`, `frontend-cache-diagnostics.mjs`, `frontend-cache-variants.mjs`, `frontend-cache-types.ts`, `frontend-session-types.ts`, `frontend-types.ts` |
| Dependency certificates | `tools/gogen/frontend-components.mjs`, `frontend-query-contract.mjs`, `frontend-queries.mjs`, `frontend-hierarchy.mjs`, `frontend-provenance.mjs`, `frontend-provenance-recorder.mjs`, `frontend-provenance-metadata.mjs`, `frontend-v3-key.mjs`, `frontend-v3-queries.mjs`, `frontend-v3-shadow.mjs` |
| Hot paths | `tools/gogen/frontend-dynamic-call.mjs`, `frontend-static.mjs`, `emit-dynamic-call.mjs` |
| Tests and proof | `tools/gogen/runner-cache.test.mjs`, `frontend-object-cache.test.mjs`, `frontend-replay.test.mjs`, `frontend-v3-shadow.test.mjs`, `osabap.test.mjs`, `cache-runner-proof.mjs` |
| Documentation and CI | `docs/gogen-cache-runners.md`, `docs/gogen-cache.md`, `.github/workflows/gogen.yml` |

Filenames without a directory in this table share the preceding `tools/gogen/`
prefix. `frontend.mjs` stays below the task base's line count.

## Validation (step 4b, historical)

The final implementation passed 111 focused cache/query/replay/runner tests and
82 oracle/exception/provenance/portable/binary tests. The CI mutation oracle ran
60 mutations, including multi-edits and reverts, with zero mismatches. Tests ran
with `--preserve-symlinks --test-concurrency=1`; concurrent fresh compilers shared
a cache in both global and dependency modes, including a CATCH variant index.
The binary suite also exercised simultaneous real `osd run` builds.

`tsc -p tsconfig.gogen.json`, `osd-size-budget --changed origin/main`, and the
changed-path `osd-leak-scan --paths` exit-code gate passed. The size gate checked
153 budgets; the leak gate found zero matches across 36 changed paths.
`frontend.mjs` is net -13 lines against `origin/main` (`b9e20a38`) at the final
gate. Go compilation was skipped in the large phase matrix; the small binary
tests compiled and executed reports.

## Final proof at 3619f752 (2026-10-17, rebased on 1bb46530)

This is a fresh six-case proof on the final branch, with the review fixes
included: selection rows recorded for scoped misses, idle global artifact rows
failing closed, and the provenance graph re-read in every round. The setup is
the same as the earlier runs: Go build skipped, every large child in a 70 GiB
scope.

| Run | Cache | Total (s) | Lowered / reused |
| --- | --- | ---: | ---: |
| Cold | off | 544.6 | 3,055 / 0 |
| Cold | on | 1,310.6 | 9 / 3,046 |
| Unchanged warm | off | 552.2 | 3,055 / 0 |
| Unchanged warm | on | 339.6 | 7 / 3,048 |
| Edited | off | 519.7 | 3,055 / 0 |
| Edited | on | 692.8 | 7 / 3,048 |

- **Byte-identity.** All four comparisons were byte-identical: unchanged warm
  against recorded, cold on against off, disabled control against cold, and
  edited warm against edited cold.
- **Edited run.** It is now 692.8 s, down from 965.1 s on step 4b (#800). It is
  still slower than the cache-off edited run. Most of the remaining cost repeats
  in each of the runner's six closure rounds, which is what step 4b.3
  (collapsing the rounds by certified previous selection) targets.

## Certified runner selections (step 4b.3)

The report runner's existing `OSD_GOGEN_CACHE` opt-in now also permits selection
seeding. Default-off invocations retain discovery from the original roots.
`compileClosedProgram` receives a host adapter; it imports no new builtins and
performs no module-initialization I/O. The adapter lives outside the compiler
import closure, alongside the existing runner recording certificate.

The atomically published, checksummed `runner-selection.json` binds the original
ordered roots, ordered layer-relative input names and raw content hashes, tool
identity, runner syntax/skip policy, tolerant mode and test inclusion. Its round
ledger records the input and expanded selections, lowering-time missing names,
owner/superclass edges and additions. The reader checks the derivation from the
original roots to the final selection, including a terminating closed round.
Replay derives each round's `wanted` from the CURRENT normalized loaded
registry. Cold compilation and replay call the same `prepareSelection` function
for case/namespace normalization, strict-root diagnostics, tolerant broken-object
filtering and parsed function-module/static-attribute expansion. Replay also
uses the compiler's local-class discovery and function-group identity constructors.
Round zero uses the original request and syntax policy; later rounds use the
controller's derived input list and tolerant policy. No persisted `wanted` is
used as the starting membership. Additions use the controller's current class
lookup; retained controller membership remains distinct from later per-round
expansions. Every ordered `wanted`, input list and addition must match, and the
terminating round's inputs must match the saved selection.
Validation waits for the loaded-scope check, then reconstructs all rounds under
the scheduling role with one current syntax-issue list. A mismatching ledger
discards the tentative seeded compile and restarts from the current roots before
emission. Compiler expansion and tolerant filtering are supported derivations.
The checksum is an integrity check, not authentication: the cache directory is
trusted local state, just like object-cache entries. Re-deriving round 0 from
the current request catches corruption and the simplest forgery, but a writer
who coherently rewrites the persisted `missing`/`supers` lists (or object-cache
IR) can still steer the result; that is outside this cache's threat model.
Genuine edits cannot produce a stale superset: only equal-width local string
initializer edits are certified for one-round reuse, and those cannot add or
remove a dependency.
Selection publication precedes read-grant validation, emission, gofmt and Go
build, so a later-failing invocation can leave a correct, reusable selection.
Exact-source and AST-proof digests have distinct domains; changed files must
carry a valid AST proof. Missing, malformed or inconsistent metadata starts
discovery from roots.
Supplied registries and sessions are conservatively ineligible.

The filesystem scan is a preflight, not selection authority. After compilation,
the adapter validates the normalized inputs actually loaded in the registry:
ordered owners, file order/content, dependency roles, configuration and actual
CDS identity. A scan/load mismatch discards the seed and restarts from the
original roots before emission, including an edit/revert race that a second
filesystem scan would miss. Input-scope changes between cold closure rounds
prevent certificate publication. The actual loaded scope uses the same guarded
AST proof for eligible edits; unchanged normalized files retain their evidence.

Unchanged inputs certify the previous selection directly. Across edits, this
first implementation uses a deliberately narrow AST proof: only the plain,
noninterpolated, equal-width template in a method-local
`DATA(name) = CONV string( |literal| ).` initializer may change. The parser must
recognize the complete statement and method context; macros, INCLUDEs, unknown
statements, interpolation, escape sequences and multiline literals do not
qualify. Raw text outside qualifying template values remains bound byte for
byte. Width is part of the certificate because source normalization can use
columns in generated local names. The compiler's existing raw-source probes for
local interfaces, local types and AMC markers are shared with the validator; their actual answers must also
remain identical. No new lexical dependency approximation is introduced.
The initializer's string type, declaration, references and all other
statements therefore remain unchanged. Discovery does not propagate this local
runtime value into class selection, supplied signatures or CATCH membership.
This covers the proof's existing literal edit without claiming support for
arbitrary method-body edits. Dependency, superclass, declaration, macro,
inventory and other unsupported changes restart from roots, allowing obsolete
classes to disappear. Object-cache certificates and replay still independently
validate every IR hit.

A certified invocation compiles the saved final selection once, then runs the
existing missing-class/superclass check and continues rounds if necessary.
Explicit roots retain strict syntax diagnostics; discovered dependencies remain
tolerant. Timing reports identify the actual number of executed rounds and
whether certification used exact input identity, local string initializers, or
discovery from roots. The proof still saves each completed case immediately.

The fresh-process selection oracle disables both object caching and selection
seeding on its reference side. It covers additions/removals, superclass changes,
macro-hidden references, supplied redefinitions, CATCH descendants, broken
discovered dependencies and repeated edits/reverts in both line modes. A
negative control deliberately compiles a stale closed superset and requires
its bytes to differ from discovery from roots.

Pre-proof validation passed 264 focused cache, certificate, replay, provenance,
closure and osabap tests (599.8 s), plus 30 hardened fresh-process selection tests
(91.4 s), with no failures or skips. The CI oracle inside that matrix exercised
60 supported mutations in 62 attempts with zero mismatches (123.9 s). Both
reverse-edge negative controls passed. The focused matrix enabled
`GOGEN_CACHE_SHADOW_VALIDATE=1`. Node suites used
`--preserve-symlinks --test-concurrency=1`; the four host-boundary checks,
TypeScript, the 153-budget size gate and the explicit twelve-path leak-scan exit-code gate also passed.
`frontend.mjs` is net one line and 183 bytes smaller than `origin/main`
`c9dad34f`.

A real osabap emit-only smoke closes in seven cold rounds and one exact-input
warm round, with all four generated artifacts byte-identical. Loaded-input
scan/load and edit/revert races restart from roots in both source-line modes.

### Six-case proof at `eb9ca3e5` (2026-10-17–18)

Measured with `tools/gogen/cache-runner-proof.mjs`, copied `zlnt-system` inputs,
a 24 GiB Node heap, and a separate 70 GiB / zero-swap systemd scope for every
large child. Go compilation was skipped in all six cases. Totals are the
child's `total` phase; they include runner setup. Each completed case was saved
immediately, and no completed measurement was rerun. Earlier unfinished cold
attempts stopped for certificate hardening are retained separately and are not
measurements.

| Run | Cache | Frontend (s) | Emission (s) | gofmt (s) | Total (s) | Rounds | Final-round lowered / reused |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | on | 1,389.5 | 41.3 | 18.5 | 1,451.3 | 6 | 9 / 3,046 |
| Cold | off | 466.5 | 33.3 | 18.4 | 520.2 | 6 | 3,055 / 0 |
| Warm | on | 127.8 | 41.8 | 18.5 | 190.1 | 1 | 9 / 3,046 |
| Warm | off | 462.2 | 33.4 | 18.5 | 516.2 | 6 | 3,055 / 0 |
| Edited | on | 252.6 | 39.2 | 18.4 | 312.3 | 1 | 14 / 3,041 |
| Edited | off | 457.9 | 33.3 | 18.4 | 511.6 | 6 | 3,055 / 0 |

Cold-enabled starts with 3,010 lowerings in round 1 and converges at 3,055
classes after six rounds. The class counts in the table are the final round,
not the sum across rounds. Both enabled warm and edited invocations execute
only one round.

**Targets passed.** Edited-enabled is 312.3 s versus 511.6 s disabled, 39.0%
lower and inside the 300–450 s planning range. Warm-enabled is 190.1 s, below
the 339.6 s supplied warm target. Warm final-round reuse is 99.7%, passing the
99% reuse gate. Cold-enabled remains expensive: it still records the original
six-round discovery and constructs reusable selection evidence.

**Certification actually used.** Warm-enabled reports `exact-inputs`.
Edited-enabled reports `local-string-initializers` for the existing
`ZCL_LNT_ADD_MODULE` edit from `|add 2 to lv_foo.|` to `|add 3 to lv_foo.|`.
The AST shape, template width, source-probe answers, original roots, inventory,
ordering, configuration, CDS and tool identities remain certified; the
normalized loaded-registry check also passes. Dependency recording remains
enabled in scoped mode for the edited invocation. Seventeen provider ledgers
refresh and 3,962 remain retained.

The fourteen edited lowerings comprise three dependency invalidations for the
edited owner and its two reverse-dependent parser providers, one supplied-query
miss, one ordered replay refusal, and nine no-candidate cases. Thus five
additional classes lower compared with unchanged warm; three are the expected
dependency invalidations, and the other two are conservative query/replay
refusals. Every reused IR entry still passes its ordinary cache guards.

Per-round subcounters for the two one-round invocations (seconds):

| Run | Graph loading | Certificate validation | Observation | Replay | Finalization |
| --- | ---: | ---: | ---: | ---: | ---: |
| Warm | 0.000 | 0.000 | 0.000 | 2.423 | 0.002 |
| Edited | 18.069 | 14.471 | 0.103 | 4.214 | 36.780 |

These counters overlap and do not partition frontend time. Loaded-scope
validation and selection-certificate publication are included in the overall
frontend phase.

**Byte identity passed.** All four comparisons pass for `zz_app.go`,
`zz_generated.go`, `zz_db.json` and `symbols.json`: warm equals cold-enabled,
cold-enabled equals original-roots cold-disabled, disabled repeat equals cold,
and edited-enabled equals edited-disabled. The reference side disables both
object caching and selection seeding. A final direct byte comparison also
verified the saved artifacts and their recorded SHA-256 values. The edit changes
only `zz_generated.go`.

The unchanged combined manifest SHA-256 is
`a6f3eba84d2ee7e4ed5efd296863317a66a64cecdd10c11749576041ee5ad950`.
The edited manifest is
`096a9d4afb22fe02d9f87bc7de7aa4d04d29f4210d778ac2bd24533ab1a0b1e9`.

**Shared-host caveat.** The final focused matrix overlapped part of
cold-enabled and completed before warm-enabled. No other work from this task
overlapped the warm or edited measurements; other host work was not controlled.
Thirty-second samples during the edited pair show:

| Run | One-minute load range | Minimum available memory (GiB) |
| --- | ---: | ---: |
| edited-enabled | 1.52–2.72 | 91.7 |
| edited-disabled | 1.09–2.09 | 89.8 |

The six-case report, logs, diagnostics and generated artifacts are retained at
`/mnt/ssd-510/osg/stoker/tmp/c4b3-final-proof/report.json`; validation logs and the
real-runner smoke are under its `validation/` directory. The copied inputs are
`/mnt/ssd-510/osg/stoker/tmp/c4b3-final-input`. The installed inputs and shared
libraries were not modified. Unsupported edit shapes deliberately retain
discovery from roots; broader edit certification remains future work.

Files changed in step 4b.3 (all paths except the documentation are under
`tools/gogen/`):

| Area | Files |
| --- | --- |
| Controller and compiler contracts | `frontend-closure.mjs`, `frontend-session-types.ts`, `frontend.mjs`, `frontend-source-observations.mjs` |
| Runner and host certificates | `osabap.mjs`, `runner-cache-recording.mjs`, `runner-selection-cache.mjs`, `runner-selection-evidence.mjs`, `runner-selection-scope.mjs` |
| Proof, tests and documentation | `cache-runner-proof.mjs`, `runner-selection-cache.test.mjs`, `docs/gogen-cache-runners.md` |

### Round-3 ledger replay hardening

The coherent-ledger regression recomputes the checksum after injecting an
unrequested class into the first `wanted` and consistently extending later
rounds and the final selection. Both unchanged inputs and an eligible literal
edit must rediscover from roots and match cache-disabled Go/JS output in both
source-line modes. Separate fresh-process checks cover normalized roots, later
`wanted`/input mismatches, incomplete or nonexistent additions, selection order
and termination.

At `698ac7f4`, equality with normalized raw roots rejected the genuine zlnt
ledger. Its 3,139 requested names include ten duplicates: 3,129 distinct roots
remain. Parsed CALL FUNCTION discovery adds `OPENABAP`, function-group signature
preparation adds `FUGR:OPENABAP`, and supported local discovery adds
`CL_ABAP_UNIT_ASSERT:LCL_DUMP`, yielding 3,132 first-round wanted names. No
root was filtered in this particular round. The report wrapper, statement
classes and runtime/host classes are already in the original runner request;
they are not extra host-side exceptions in replay.

The follow-up replaces that equality check with current compiler derivation.
Focused fresh-process cases now certify genuine static expansion, local and
function-group identities, duplicate/namespaced roots, superclasses and tolerant
broken dependencies, retaining the independent roots oracle in both line modes.
The coherent first-wanted forgery still restarts from roots; its discarded seed
counts as an executed round. The old synthetic replay microbenchmark does not
measure this implementation, which validates actual compiler inputs.

Follow-up validation exercised 327 distinct cache, certificate, replay,
provenance, query, runner and selection tests with
`GOGEN_CACHE_SHADOW_VALIDATE=1`. All 40 selection tests passed, including the
four coherent-ledger cases; those same four cases fail on `57cfbdbb` because
its emitted Go/JS contains the injected class. The 60-mutation oracle ran 62
attempts with zero mismatches (128.6 s), and both reverse-edge controls passed.
An overlapping tracked-test edit invalidated the first concurrent kept-binary
reuse check; the complete 25-test osabap suite was rerun with no edits and
passed (193.8 s). The four host-boundary tests, TypeScript, all 153 size budgets
and the explicit 13-path leak-scan exit-code gate passed. `frontend.mjs` is
net -2 lines and -330 bytes against `origin/main` at `c9dad34f`.

### Six-case proof at `1c788ef7` (2026-10-18)

`tools/gogen/cache-runner-proof.mjs` completed all six cases on the committed
current-registry replay implementation. A fresh cold-enabled case ran first:
the changed compiler identity prevents reusing the earlier cold namespace.
Every completed case was saved immediately; none was rerun. The source copy's
5,978 files match the earlier proof inputs apart from reverting the intended
literal edit before the cold cases. Installed inputs and shared libraries
were not modified.

| Run | Cache | Frontend (s) | Emission (s) | gofmt (s) | Total (s) | Rounds | Final-round lowered / reused |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | on | 1,446.6 | 39.2 | 18.5 | 1,506.4 | 6 | 9 / 3,046 |
| Cold | off | 457.5 | 33.5 | 18.4 | 511.5 | 6 | 3,055 / 0 |
| Warm | on | 152.7 | 42.2 | 18.4 | 215.2 | 1 | 9 / 3,046 |
| Warm | off | 457.4 | 33.5 | 18.4 | 511.4 | 6 | 3,055 / 0 |
| Edited | on | 298.8 | 62.8 | 18.5 | 382.1 | 1 | 14 / 3,041 |
| Edited | off | 457.6 | 33.3 | 18.4 | 511.3 | 6 | 3,055 / 0 |

Emission excludes gofmt in this table; the runner's aggregate `emit` phase
includes both. Totals also include runner setup. The final-round class counts
are not sums over all executed rounds.

**Real ledger accepted.** The newly written ledger again has 3,139 raw roots,
3,129 distinct roots and 3,132 first-round wanted names, including the function
group and local identities described above. Warm reports `exact-inputs`, and
edited reports `local-string-initializers`, both with one executed round.
The edited invocation retains scoped dependency recording, 14 lowerings and
3,041 guarded reuses. Warm reuse is 99.705%, meeting the 99% gate.

**Measured performance.** Warm is 215.2 s, 13.2% above the retained
190.1 s proof; edited is 382.1 s, 22.3% above the retained 312.3 s proof.
Those earlier absolute times were not reproduced. The certified one-round path
is restored on the real runner: warm takes 42.1% of its disabled control, and
edited is 25.3% faster than its disabled control. The 450 s edited
planning gate and the supplied 339.6 s warm target pass.
Current-registry ledger derivation is included in frontend time. Relative to
the retained proof, edited frontend is 46.1 s longer and emission is 23.6 s
longer; gofmt is effectively unchanged. There was no matched old-version rerun,
so these samples do not isolate validation overhead from other run variation.

**Independent byte oracle.** All four comparisons pass for `zz_app.go`,
`zz_generated.go`, `zz_db.json` and `symbols.json`: unchanged warm versus
cold-enabled, cold-enabled versus original-roots cold-disabled, disabled
repeat versus cold-disabled, and edited-enabled versus edited-disabled. Both
object caching and selection seeding are off in the independent roots oracle
invocations.
A separate verification performed all sixteen direct file-byte comparisons
and checked every saved artifact against its recorded SHA-256. Only
`zz_generated.go` changes across the literal edit.

The unchanged combined manifest SHA-256 is
`ab7a8bfde0838fd043f63bd30aa019683eb4d9a8287bd92ad2216f68cf7e7939`.
The edited manifest is
`3f8f446621f69331e115e85d47ac2941cdf84b80982a407130ad4b0ae4700965`.

The Node heap was 24 GiB, `TMPDIR=/mnt/ssd-510/osg/stoker/tmp`, and
`GOCACHE=/mnt/ssd-510/osg/go-build`. Every large child ran alone within this
proof in its own 70 GiB / zero-swap systemd scope; the actual cgroup limits were
also checked. Go compilation was explicitly skipped in all six logs. All
test suites finished before the large proof began; no test suite overlapped
these measurements. Other host work was not controlled, so the timings remain
shared-host measurements.
Thirty-second samples during the edited pair show:

| Run | One-minute load range | Minimum available memory (GiB) |
| --- | ---: | ---: |
| edited-enabled | 1.22–1.98 | 92.6 |
| edited-disabled | 1.07–1.64 | 93.1 |

The complete report, logs, diagnostics and artifacts are retained at
`/mnt/ssd-510/osg/stoker/tmp/c4b3-follow-proof/report.json`; direct-byte results
are in `verified.json` and load samples in `load.ndjson` beside it. Validation
logs, including the expected four failures on `57cfbdbb` and the clean osabap
rerun, are under `/mnt/ssd-510/osg/stoker/tmp/c4b3-follow-validation`.
The copied inputs are `/mnt/ssd-510/osg/stoker/tmp/c4b3-follow-input`.

## Step 4b.4: method-body discovery equivalence

There are now three independent proofs: the existing equal-width local string
initializer proof (`local-string-initializers`), the conservative local integer
proof (`discovery-references`), and general method-body discovery equivalence
(`method-discovery-references`). The first two remain inexpensive special cases.
The general path accepts parsed method-body statement changes with unchanged
discovery observations, including inferred locals, string processing, arithmetic,
condition changes, branch insertion and new primitive local variables.

The general path has two stages. `runner-method-projection.mjs` parses the source
with the frontend's pinned parser and retains declarations, method identities,
and named reference observations. Static member and function-module observations
come from `frontend-discovery-references.mjs`, the same readers used by
`expandProgramSelection`. A matching projection is only a **candidate**, never
authority to reuse a selection. Each evidence record also retains the parsed
source, so the second stage can reconstruct the previous owner without reading
or changing a previous worktree.

`runner-method-discovery.mjs` constructs isolated before/after registries from
the current normalized loaded files, replacing edited owners with their saved
sources on the before side. Configuration, dependency roles, inventory order,
original roots, include-test policy and CDS identity remain guarded by the
existing selection scope. All owners requiring the general proof are replaced together. Owners already
certified by the independent literal/integer proofs use their current sources
on both sides; this composes the proofs without making a fast-path edit depend
on general lowering eligibility. Separate, serial Node processes for before
and after prevent compiler globals from changing the live compilation or
retaining two registry heaps. The checker performs no filesystem writes. The real `compileProgram` builds selection, signatures, local definitions,
function-module signatures, supplied parameters and CATCH indexes for
**each saved closure-round input**. Its registries use the frontend's observed
parse boundary, so guarded compilation cannot silently rebuild them. Its probe
entry lowers only the changed owners and their local classes using the ordinary
`classIr` path, with both object caching and selection seeding disabled.

A method-only candidate fixes every declaration and every other source file.
The isolated registries therefore retain the authoritative loaded registry's
diagnostics for unchanged owners and use the parser's ordinary
`findIssuesObject` rule runner to recompute all diagnostics for each changed
owner, including its attached files. Unknown diagnostic ownership refuses the
proof. The existing diagnostics-session contract carries these answers across
round contexts; it reuses no class IR. File order, raw source, dependency roles,
configuration and registry identity are fenced throughout the check. Any
unexpected replacement, mutation or synthesized input restarts roots. This
avoids rechecking unchanged method bodies across both complete registries.
While re-deriving the saved round ledger, the parent captures each actual
`prepareSelection` result from the current loaded registry: ordered raw wanted
names, diagnostics and broken owners. The probes reuse these fenced frames,
then run the ordinary supplied/signature/CATCH/local preparation and actual owner
lowering for every historical context. Each resulting expanded selection must
match the parent's re-derived frame. No persisted selection is substituted for
current discovery, and changed-owner syntax is checked independently in both
variants. This avoids repeating whole-registry selection scans twelve times.
Per-variant parse, syntax and round-check timings are included in the optional
`method-discovery` diagnostic row and the runner proof report.

The existing `recordLowering` observer supplies the per-owner discovery reference
sequence (the certified "reference set"): operations on `wanted`, `missing`,
`caught`, `supplied`, `functionModules`, `dynStatics` and `interfaces`, including query arguments and
read answers, in first-discovery order, with repeated positions preserved.
Before and after must have identical ordered sequences; a reorder is not
certified and falls back to full rediscovery from roots. Signature observations
additionally bind the queried signature slot and its final availability (typed, unsupported or missing), rather than
memoization hit booleans that vary when a call is duplicated. `wanted` membership checks are the actual closure guards, and
`missing` additions include dependencies inferred by lowering rather than
spelled in a statement. This catches, for example, adding `CREATE OBJECT o`
when `o` already has an unchanged `TYPE REF TO` declaration. Before and after
must agree in every historical round context, including rounds where a missing
dependency prevented a method from lowering completely. Final-round edited
methods must lower successfully and contain no partial-statement stubs. An
unrecordable operation, observer budget refusal, parse/syntax failure, child
failure, or unsupported changed method refuses the general certificate.

| Discovery input | Where discovery reads it | Guard |
| --- | --- | --- |
| Superclass | `compileClosedProgram` superclass walk; `classIr` hierarchy | Declaration AST stays bound; current superclass ledger remains re-derived. |
| Interfaces, aliases, friends | `classIr`, `componentInterfaces`, signature/attribute resolution | Declaration AST stays bound, including class/interface names. |
| Static calls, external constants/types/attributes | `expandProgramSelection` static-attribute lookup; `call`, `resolveStatic`, `registerConst`, type/signature resolution | Shared owner/member reader, named AST observations and actual lowering membership reads. |
| TYPE REF TO and CREATE OBJECT TYPE | Type lowering and `createObject`/`newExpr` | Named AST observations plus inferred target's real `wanted`/`missing` operations. |
| RAISING/CATCH and implicit exception classes | Signatures, `tryStatement`, `caughtIndex`, dynamic calls, exception widening | Signature/named AST observations plus actual CATCH answers and implicit dependency additions. |
| Dynamic literal names | `dynamicStaticCall`, dynamic construction/type lookup | Dynamic AST operands stay bound; actual dispatch names and exception dependencies must agree. |
| Function modules | `prepareSelection` → `expandProgramSelection`; `functionGroupSignatures`, `callFunction` | Shared literal FM reader; actual function-module signature reads and closure dependencies. |
| DDIC/CDS | Type/database lowering, `prepareCdsRegistry`, table/lock registries | Named type/database AST references, exact non-class files and loaded CDS/inventory identity. |
| Supplied parameters | `suppliedIndex`, `suppliedMethods`, `suppliedComparison` | Declaration/signature AST, parameter-name set, the shared `suppliedComparison` reader and actual supplied-index reads. |
| Local classes and test markers | `deriveProgramWanted`, `localClasses`, local-dispatch selection | Declaration AST and test policy stay bound; local/include/test files require exact bytes. |
| INCLUDEs/macros | Parser expansion and original macro-definition scans in `expandProgramSelection` | Main files with INCLUDE/DEFINE/MacroContent have no general proof; any include/macro-file edit restarts roots. |
| Existing raw-source probes | `localInterfaceNames`, `currentTypeNames`, `amcSource` | Compare the frontend's existing probe answers; no new regex dependency parser. |
| Refusal and normalization boundaries | `normalizeSource`, `blockList`, class/method lowering | Unknown AST statements, unrecordable lowering, changed dropped/partial methods and SUBMIT files fail closed. |

Both filesystem preflight and the normalized loaded scope must agree. The
round ledger is still re-derived from the **current request and registry**;
previous `wanted` arrays do not authorize membership. Tool/config/CDS/inventory,
layer order, owner roles and roots guards are unchanged. The cache directory
remains trusted; checksums detect corruption rather than malicious replacement.
Every object-cache hit still passes its independent dependency/replay guards.
The feature remains opt-in and default off. Compiler initialization stays pure,
and the isolated host checker introduces no compiler builtin imports or
prototype changes. `frontend.mjs` is smaller than `origin/main`.

The fresh-process selection oracle disables both object caching and selection
seeding on its reference side. It covers general string/condition/arithmetic
edits, branch insertion, inferred and explicit locals, reference additions and
removals, inferred CREATE dependencies, TYPE REF/CATCH/constant/interface/
superclass/dynamic-literal changes, include/macros, multiple edits, reverts,
concurrent general-proof publishers, coherent ledger corruption and load races.
The omitted-static-reference negative control deliberately erases that reference
kind from a test-only clone of both the AST preflight and actual lowering
observations. The faulty certifier must really accept the removal and report
`method-discovery-references` in one round; the independent roots oracle then
detects the stale superset's different selection and generated bytes. Production has no fault
switch for omitting references. Both reverse-edge fault detectors remain enabled
in the certificate suite.

`cache-runner-proof.mjs` now changes a parsed condition from `=` to `<>` inside
an existing test-initialization method of an 80–800-line copied test class. This must exercise the
general proof, change generated output, take one closure round and beat its
cache-disabled control. The preceding literal edit is retained, so the logic
pair measures cumulative edits. Every case runs serially in a 70 GiB/zero-swap
scope with a 24 GiB Node heap, saves its results immediately, and skips Go build.
Ordered selections must also match. Both SHA-256 equality and direct byte comparisons cover `zz_app.go`,
`zz_generated.go`, `zz_db.json` and `symbols.json` against independent roots
runs. Source inputs are read and copied from `.local/zlnt-system`; edits are made
only in the fresh copy. Installed inputs, other worktrees and shared libraries
are never modified.

Changes from the preceding partial implementation add
`runner-method-projection.mjs` and `runner-method-discovery.mjs`, the explicit
probe contract in `frontend-session-types.ts`/`frontend.mjs`, general candidate
and loaded-scope validation in the three selection modules, broader selection
tests, condition-edit/direct-byte proof checks, and this documentation.

Validation before the large proof: the complete cache/selection/certificate/
provenance/replay matrix passed 315 tests with no failures or skips in 489.2 s,
using `--preserve-symlinks --test-concurrency=1` and shadow validation. Its oracle
ran 60 mutations in 62 attempts with zero mismatches (123.5 s); both reverse-edge
negative controls passed. A subsequent 10-test runner suite includes an emit-only
real-runner comparison of ordered selections and all four files with caching off,
cold-on and warm-on. The four host-boundary checks, TypeScript, all 153 size
budgets and the explicit 17-path leak gate passed. `frontend.mjs` is net -7 lines
and -216 bytes against `origin/main` at `60282273`. Validation logs are retained
under `/mnt/ssd-510/osg/stoker/tmp/c4b4-validation`.

The first eight-case proof at `c3e32e24` passed all five ordered-selection and
four-artifact direct-byte comparisons, but **failed the realistic performance
gate**: 772.4 s enabled versus 524.2 s off, despite taking one round. The complete
failed measurement is retained at
`/mnt/ssd-510/osg/stoker/tmp/c4b4-proof/report.json`; it is not a passing timing
claim for the final implementation. The isolated checker had parsed outside the
observed boundary, allowing registry rebuilding, and performed full diagnostics
for unchanged owners. The follow-up uses observed parsing, scoped authoritative
diagnostics and separate variant processes as described above. It also qualifies
method completeness by implementation owner and keeps CLI execution separate
from importing the host checker. New regressions cover valid local include
methods with shared names, mixed fast/general edits involving unchanged partial
statements, and unchanged broken-owner diagnostics in historical contexts.

The follow-up also covers duplicate static-call insertion and revert: insertion
now restarts roots when the ordered observations differ, while reverting can
reuse the retained exact-input certificate. It also covers loaded CDS mappings,
raw CDS invalidation and actual acceptance by the deliberately
reference-incomplete negative-control certifier.

A bounded copied-corpus probe of the optimized checker passed on the actual
7,031-file loaded registry: 129.3 s total, with before/after parsing 57.1/60.7 s
and historical-round checks 3.6/3.4 s. This is diagnostic evidence, not an
end-to-end runner timing. The optimized `frontend.mjs` is net -13 lines and
-753 bytes against `origin/main` (`60282273`).

### Final step 4b.4 runner proof

Measured on 2026-10-18 at implementation `1320af0a`, after the complete required
matrix passed. All eight cases used fresh processes and distinct build roots,
serial 70 GiB / zero-swap scopes, `NODE_OPTIONS=--max-old-space-size=24576`,
`TMPDIR=/mnt/ssd-510/osg/stoker/tmp`, and
`GOCACHE=/mnt/ssd-510/osg/go-build`. Go build was skipped in every case.
The filesystem and loaded-scope guards, ledger derivation, object-cache guards,
closure controller, emission and gofmt all ran normally.

| Case | Cache | Rounds | Frontend (s) | Emission (s) | gofmt (s) | Total (s) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Cold | on | 6 | 1,780.2 | 42.4 | 18.6 | 1,843.2 |
| Warm | on | 1 | 166.8 | 42.5 | 18.5 | 229.8 |
| Cold | off | 6 | 467.4 | 33.4 | 18.5 | 521.4 |
| Warm | off | 6 | 482.0 | 35.0 | 18.5 | 537.5 |
| Literal edit | on | 1 | 322.2 | 63.9 | 18.6 | 406.7 |
| Literal edit | off | 6 | 462.7 | 33.5 | 18.5 | 516.7 |
| Method logic edit | on | 1 | 431.7 | 39.9 | 18.6 | 492.2 |
| Method logic edit | off | 6 | 464.5 | 33.8 | 18.5 | 518.8 |

The literal edit changes the existing `add 2` initializer to `add 3` in
`zcl_lnt_add_module.clas.abap` and uses `local-string-initializers`. The realistic
edit changes `IF t2 = abap_true` to `IF t2 <> abap_true` in
`METHOD test_initialize_4` of the 234-line
`zcl_lnt_add_crrspndng_mdl.clas.abap`. It uses
`method-discovery-references`, retaining the preceding literal edit.

Warm saves 307.7 s (57.3%); the literal edit saves 110.1 s (21.3%); the
realistic edit saves 26.6 s (5.1%), each against its matching cache-disabled
control.

The realistic margin is modest: this is one serial measurement per case on a
shared host, not a claim of a fixed speedup on every run. Both edits pass the
one-round and faster-than-off gates. Cold cache population remains expensive;
this change optimizes eligible subsequent edits, not the first cache build.

The realistic certificate itself takes 124.4 s. Before/after variants spend
56.1/56.7 s parsing, 0.030/0.032 s checking changed-owner syntax, and
3.5/3.5 s checking all historical round contexts (59.7/60.3 s variant totals).
Two complete isolated parses remain its main cost. The final realistic round
lowers 13 classes and reuses 3,042. Warm lowers 9 and reuses 3,046 of 3,055
classes (99.705% reuse); literal lowers 14 and reuses 3,041.

All five comparisons pass both SHA-256 checks and direct byte comparison of
`zz_app.go`, `zz_generated.go`, `zz_db.json` and `symbols.json`. All cases have the
same ordered 3,177-entry selection. Both edit pairs match their independent
cache-disabled, unseeded roots oracle. Each edit actually changes
`zz_generated.go`; the other three required artifacts remain unchanged.

An additional independent post-run verifier rereads every compared file,
checks saved hashes, checks all eight observed memory/swap scopes, verifies all
5,978 installed source hashes are unchanged, and verifies that exactly the two
intended files differ in the fresh input copy. No installed input, other
worktree or shared library was modified.

Final validation at this implementation: **328 tests pass, zero failures or
skips**, in 581.7 s with `--preserve-symlinks --test-concurrency=1` and
`GOGEN_CACHE_SHADOW_VALIDATE=1`. The 60-mutation oracle completes 62 attempts
with zero mismatches in 126.7 s. Both reverse-edge controls and the genuinely
accepted omitted-static-reference control pass. All four host-I/O tests,
`tsc -p tsconfig.gogen.json`, all 153 size budgets, and the explicit changed-path
leak scan pass (exit 0). `frontend.mjs` remains net -13 lines / -753 bytes versus
`origin/main` at `60282273`.

Machine-local evidence: `/mnt/ssd-510/osg/stoker/tmp/c4b4-final-proof/report.json`,
`verified.json`, `input-manifest.json`, `scope-verified.json`, per-case logs,
diagnostics, generated artifacts and `monitor.ndjson`. The edited copy is
`/mnt/ssd-510/osg/stoker/tmp/c4b4-final-input`. Required-check logs are under
`/mnt/ssd-510/osg/stoker/tmp/c4b4-validation` (`release-matrix.log`,
`host-final.log`, `tsc-release.log`, `size-final.log`, `leak-final.log`).

Files changed by step 4b.4 relative to `origin/main` (unqualified names share
`tools/gogen/`):

| Area | Files |
| --- | --- |
| Shared discovery and pure compiler seam | `frontend-discovery-references.mjs`, `frontend-provenance.mjs`, `frontend-selection.mjs`, `frontend-session-types.ts`, `frontend.mjs` |
| Host edit proofs and loaded-scope validation | `runner-discovery-projection.mjs`, `runner-discovery-types.mjs`, `runner-method-projection.mjs`, `runner-method-discovery.mjs`, `runner-selection-evidence.mjs`, `runner-selection-scope.mjs`, `runner-selection-cache.mjs` |
| Runner proof and telemetry | `cache-runner-proof.mjs`, `osabap.mjs` |
| Tests and CI | `runner-selection-cache.test.mjs`, `runner-cache.test.mjs`, `.github/workflows/gogen.yml` |
| Documentation | `docs/gogen-cache-runners.md` |

Changes to declarations/signatures, hierarchy/interfaces/aliases/friends,
named references, dynamic literal targets, function modules or DDIC/CDS inputs
remain non-certifiable when their discovery observations change. Include,
macro, local/test-include edits, SUBMIT normalization, unknown syntax,
unclassified observations and unsupported/partial changed methods restart
roots. Inventory/config/tool/root/order/role changes and loaded-scope mismatches
also restart roots. The literal and integer special cases remain independently
available; the general path never grants authority to reuse cached IR.
