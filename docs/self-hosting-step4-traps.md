# Self-hosting step 4: remaining lowering traps

Snapshot: 2026-10-18. This report describes the compiler failures still seen
when abapiti compiles gogen's `compileProgram` and `emitGo` for
`ZCL_GOGEN_T_RUNTIME`. A trap means that the TypeScript-to-Go compiler could
not lower a reached function body. It does **not** mean the generated Go has
failed a test: compilation has not yet reached that stage.

## Measurement and scope

The best measured pair is OSG `e0f0f5bdf54972b0bec88121ad6dc1361e2f7da5`
(a **private, unmerged** G candidate based on main
`602822731dda56d5b44ce3ec5e5282e7bbdda7c8`) and unmerged abapiti core5
source `c53c35518077ac6a8aff0e4dfd8a66043f354da4`. The typed step-4 driver
has SHA-256 `c95ac603d410ad9ce284de04ef2c94cc6dd53d464cf85661622a85e8b12c924e`.
The Node-gogen reference Go has SHA-256
`b90648781967b2cf3eaa4787f6dc9d41618682c26d18092e7608db18cfff5261`;
the trap run checked that reference hash. These identifiers pin the **inputs
to the diagnostic**, not a completed self-hosting result.

The reached-function scan reports **3 root trap locations, 1,089 hits**,
`0/35 unknown`, and **322 unreached functions**. A hit is
one occurrence attributed to a trapped root in the lowering/reachability
report; it is not an independent defect or a count of failed unit tests. The
unreached functions have not been proved compilable. Locations below refer to
the measured OSG commit; line numbers can move on later branches.

## What is left

| Area | Root function and hits | First reported failure | Nature and next investigation |
| --- | --- | --- | --- |
| Front end | `frontend.mjs:874` `classIr` · 41 | `IMethodDefinition` interface passed where a concrete structural class shape is expected by `fn_addSig` | Method-definition typing crosses an abaplint interface/shape boundary. A broader union exposed another failure in `fn_addSig`; this needs a compatible contract or a compiler fix, not only a wider annotation. |
| Front end | `frontend.mjs:1741` `statement` · 839 | Recursive union literal has no admitted tag or compatible payload | IR statement construction, first reported at the `REFRESH`/`FREE` mapped `clear`/`clear_data` literals, is rejected as a recursive discriminated union. Check the produced tag and payload against the IR type, then the compiler's recursive-union admission. |
| Emitter | `emit-go.mjs:954` `method` · 209 | `Method` passed to `sinkLocals`, which expects `SinkMethod` | Two emitter method contracts disagree at a helper boundary. Compare the actual fields used by `sinkLocals` with both declared shapes. |

The largest remaining root, front-end `statement`, accounts for 839 of
1,089 hits. Hit count is not an effort estimate: any of the three trapped
functions can still prevent a complete generator build. The `classIr` and
`method` errors cross structural type boundaries; the recursive-union error
may require abapiti lowering support. That division remains a diagnostic
hypothesis until a candidate removes the exact root without adding another.

On the same abapiti binary and typed driver, private G candidate
`9299a46fea7274ad9a49662e23e64b8bca2042cf` had **11 roots / 5,214
hits**; `fc8b0702fc5608d1016289335df7579bfb79361e` cleared the 822-hit
`stmtLines` root for **10 / 4,392**; `2461ab76d2ec4419baa8391fb32df12f03a68ff3`
cleared the four-hit `whereOf` root for **9 / 4,388**;
`ca0f308c9bbf8d62b7a83b5cb4f3fa6fa4a37ce3` cleared the 1,740-hit
`expr` root for **8 / 2,648**;
`19fce4f9d7f765e457d0985f62540d13cea7f78e` cleared the 1,420-hit
`place` root for **7 / 1,228**; and `9251dd10f4169f43bbc16aa9364659ec7c77ba4d`
cleared the 117-hit `call` root for **6 / 1,111**. No step added a new root. Each
candidate type-checks, passes its changed-path tests, and
produces 243 byte-identical artifacts in each of six sink/cache comparison
modes against its respective parent. These G changes are still **private
and unmerged**, pending review and PR checks. The table above reports a later
private G/A pair rather than the state of main.

A separate private diagnostic, `4b315009c78f4fbd1dbb229ec409114720a78d67`,
made the `REFRESH`/`FREE` `clear` tags literal and kept their checked Go output
byte-identical to its parent. On the same pinned abapiti binary and driver,
however, the scan still found **7 roots / 1,228 hits**, with `0/35 unknown`
and 321 unreached. The 839-hit `statement` root moved from the recursive
literal error to an HIR assignment type mismatch at the
`dbWriteStatement("insert", ...)` return. This is evidence about the next
failure inside the root, not a cleared trap; that candidate is not part of
the ready G patch chain.

Adding an explicit `FrontendStmt` return contract to that branch
(`a9af15715feb03303b3567b7af4da4680779be41`) still left **7 / 1,228**;
the first `statement` error moved further to a `CONCATENATE` parts-array type
mismatch. An interface-only attempt at `call`
(`e49de8201d7ced815de18c906d8c423e2e96cce3`) added two roots, for
**9 / 2,362**, and is excluded. The measured `call` fix instead keeps the
real parser node in recursive calls. It passed 40 emitter tests and the
six-mode direct byte comparison against its parent, but remains private and
awaits review.

Two more private diagnostic branches also left the counts unchanged. Passing
the original method definition to `addSig` with a separate name override
(`9ca99cc6c05c143290b6f232fcee5b9d379fc818`) kept **6 / 1,111** on the
measured G chain: the 41-hit `classIr` root moved from the interface argument
error to a runtime call rejecting a built-in object for a structural class
shape. On the separate statement branch, declaring the `REPLACE` helper's
return type (`f704769030017286075019877e004112c5ad5e6c`) kept **7 / 1,228**;
its 839-hit root now reports `array<dynamic>` against an array of a specific
union family in a runtime call. Neither branch is a ready G fix. The shifted
failures suggest the remaining work crosses abapiti's structural-shape and
array-variance lowering, but that is an inference from the diagnostics, not
yet a confirmed compiler defect.

A further type-annotation probe on the one-hit `compileProgram` root
(`70d5db28386add832b92630e7feb97b08fda3e8f`) also kept **6 / 1,111**.
It admitted the disk-cache facade assignment, then failed at the next call:
an anonymous closure was rejected for an optional callback interface in
`prepareSelection`. This candidate remains diagnostic and unmerged.

An independent run of the same G commit `9251dd10f4169f43bbc16aa9364659ec7c77ba4d`
compared published abapiti integration `964884687c516465688dfebeac49898ffdbdd2ea`
with its unmerged core5 candidate `c53c35518077ac6a8aff0e4dfd8a66043f354da4`.
The published binary reproduced **6 / 1,111** exactly. Core5 removed only
the 20-hit `constructor_function` boxed-`Map` root: **5 reached roots / 1,091
hits**, `0/35 unknown`, 322 unreached. All five remaining reached TSV rows
were byte-identical; no root was added. This is a measured candidate result,
not the integrated compiler state or a completed generator build.

A source-contract probe on that five-root pair
(`9175ab0b`, private G) let `sinkLocals` accept the renderer's `Method` type.
Its focused tests passed **76/76**, but exact lowering regressed to **6 roots /
1,300 hits**: the 209-hit `method` root remained, and `sinkLocals` gained a
209-hit root converting an array of emitter statements to its inspection
statement family. The patch is excluded from the ready G chain; passing
TypeScript and emitter tests did not establish this compiler boundary.
Aligning its body type with the emitter's `Stmt` array (`89eb7273`) still
regressed: **6 / 1,445**. The helper then gained a 354-hit root converting
individual emitter statements to its inspection statement family, while the
209-hit `method` root advanced to a dynamic collection key. This follow-up is
also excluded.

The next private G candidate (`79be328c0e4c8ab97196ab0d40c38a595dbc1005`)
gives the disk-cache facade its existing interface type and makes the ignored
selection callback return `void`. On the unmerged core5 compiler it removed
only the one-hit `compileProgram` root: **4 roots / 1,090 hits**, `0/35
unknown`, 322 unreached, with all four remaining rows unchanged. Direct
parent-to-candidate comparison produced 243 byte-identical artifacts in each
of six sink/cache modes; all 49 focused cache and digest tests passed. On the
published compiler the same G change kept **6 / 1,111**: `compileProgram`
advanced to an unresolved `compileDiskClass` field. The G candidate is
therefore awaiting review together with core5; neither is an integrated
self-hosting result.

The later private G `e0f0f5bdf54972b0bec88121ad6dc1361e2f7da5` narrows
emitter collection and supported-attribute types. On core5 it removed only
the one-hit `emitGo` root from the preceding pair: **3 / 1,089**, with the
three remaining rows unchanged. On published abapiti integration
`964884687c516465688dfebeac49898ffdbdd2ea`, the same G change removed
`emitGo` from **6 / 1,111** to **5 / 1,110**; the other roots persisted.
Forty emitter tests passed, and direct comparison against its G parent
produced 243 byte-identical artifacts in every one of six sink/cache modes.
The typed filter now distinguishes `unsupported === undefined` from an empty
unsupported message; that edge remains for review before integration.

## Completion gate

For each candidate, compare the reached trap locations and hit counts on the
same pinned inputs, type-check gogen, run the tests for the changed path, and
compare Node output across the sink/cache modes. Moving the first reported
error inside a function is useful diagnostic progress, but does not clear its
root. The private G candidates need review before integration into main.

Step 4 remains open until a **named OSG main commit** and a **named abapiti
selfhost commit** produce byte-equal Go for the target test, that Go builds
and passes the same unit test, and independent M1, M2 and 11,060-case corpus
checks show no regression. None of those final claims follows from this trap
snapshot.
