# Self-hosting step 4: lowering traps and runtime barrier

Snapshot: 2026-10-19. The latest private candidates clear all reached
TypeScript-to-Go lowering traps while compiling gogen's `compileProgram` and
`emitGo` for `ZCL_GOGEN_T_RUNTIME`. The generated Go builds, then fails during
execution while collecting final interface method signatures in
`frontend.mjs`. A checked IR-family view failure in `fieldChainParts()` has
been cleared in a later private G candidate. The latest private candidate passes the preceding negative-predicate
conversions in `call()` and the null-array fallback in `defaultValue()`.
However, an independent runtime oracle finds a null-to-undefined boxing
regression in that compiler candidate, so **publication is on hold**. A
zero-trap scan establishes that the reached lowering paths compile; execution,
semantic parity, output equality, and the unit test still need to pass.

## Measurement and scope

The preceding measured pair is OSG `574f9d5eb1113a51f32e8b382d403763ec7d38a0`
(a **private, unmerged** G candidate based on main
`602822731dda56d5b44ce3ec5e5282e7bbdda7c8`) and unmerged abapiti core5
source `c53c35518077ac6a8aff0e4dfd8a66043f354da4`. The typed step-4 driver
has SHA-256 `c95ac603d410ad9ce284de04ef2c94cc6dd53d464cf85661622a85e8b12c924e`.
The Node-gogen reference Go has SHA-256
`b90648781967b2cf3eaa4787f6dc9d41618682c26d18092e7608db18cfff5261`;
the trap run checked that reference hash. These identifiers pin the **inputs
to the diagnostic**, not a completed self-hosting result.

That reached-function scan reported **1 root trap location, 839 hits**,
`0/35 unknown`, and **322 unreached functions**. A hit is
one occurrence attributed to a trapped root in the lowering/reachability
report; it is not an independent defect or a count of failed unit tests. The
unreached functions have not been proved compilable. Locations below refer to
the measured OSG commit; line numbers can move on later branches.

## Last reached lowering trap in the preceding candidate

| Area | Root function and hits | First reported failure | Nature and next investigation |
| --- | --- | --- | --- |
| Front end | `frontend.mjs:1743` `statement` · 839 | Recursive union literal has no admitted tag or compatible payload | IR statement construction, first reported at the `REFRESH`/`FREE` mapped `clear`/`clear_data` literals, is rejected as a recursive discriminated union. Check the produced tag and payload against the IR type, then the compiler's recursive-union admission. |

The `statement` root accounted for all 839 hits in that candidate. Hit count
is not an effort estimate. Later G changes cleared this root without adding
another reached lowering trap.

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

The next private G candidate `75e64181b3b6942103f86692a338e9cd70655081`
uses the shared IR types for local sinking and gives its empty binding-name set
a string key type. On the same core5 binary and driver, the 209-hit `method`
root disappeared: **2 / 880**, `0/35 unknown`, 322 unreached. The two
front-end roots retained their locations and hit counts. The first of the two
commits only moved `method` to a dynamic collection-key failure; the second
cleared it, so the result is credited to the pair. The final candidate passed
76 focused sink/emitter tests and direct parent-to-candidate comparison of
243 byte-identical artifacts in each of six sink/cache modes. It remains
private pending review and the required integration checks.

On published abapiti integration `964884687c516465688dfebeac49898ffdbdd2ea`,
the same G candidate reduced **5 / 1,110** to **4 / 901**. The removed root
was again `method`; `compileProgram` (one hit) and `constructor_function`
(20 hits) still need core5, while the two front-end roots remain.

The later private G `574f9d5eb1113a51f32e8b382d403763ec7d38a0`
clears the 41-hit `classIr` root on core5: **1 / 839**, `0/35 unknown`, 322
unreached. It passes method-signature fields directly, constructs the typed
signature map explicitly, checks host parameters and returning fields
separately, derives abstract methods from typed signatures, checks the AMC host
lookup, passes FIND dependencies directly, and initializes a complete method
context before helper calls. Intermediate commits moved the first error within
`classIr`; only the final commit cleared the root. The final candidate passed
35 focused frontend tests with Bun available and produced 243 byte-identical
artifacts against its G parent in each of six sink/cache modes. It remains
private pending independent review and PR checks.
On published abapiti integration `964884687c516465688dfebeac49898ffdbdd2ea`,
the same G candidate reduced **4 / 901** to **3 / 860**. The removed root was
again `classIr`; the one-hit `compileProgram` and 20-hit
`constructor_function` still depend on the unmerged core5 compiler change.

The next private G candidate, `a082e7099de980a406b2755d5b81ec674646ed0f`,
uses syntax nodes and explicit IR types in the `statement` builder. On the
same core5 compiler and pinned driver, the reachability scan reports **0
reached lowering traps**, `0/35 unknown`, and **322 unreached functions**.
This clears the previously reported 839-hit `statement` root. The generated
Go also builds successfully. The full run then panics at
`src/artifacts_rules.ts:6:3` before writing output, so the byte comparison
fails at byte one against the nonempty Node reference. These measurements
were made on the private incremental candidate; [draft PR #815](https://github.com/oisee/open-steamgate/pull/815)
has the same source tree, stacked on #812. Its checks and review are pending,
and the G changes have not landed on main.

A diagnostic build that only printed the current rule key identified
`SevenBitAsciiConf` immediately before the panic. That exported configuration
class extends `BasicRuleConfig`; the source iterates all rule exports through
an `any` value, constructs each function, and checks `getMetadata` afterward.
The generated Go instead asserts the constructed object against the `IRule`
interface before that guard. The configuration object does not implement
`IRule`, so the assertion fails. Inspection of the generated function also
shows an unconditional array push: the `getMetadata` existence guard has no
runtime branch there. The likely defect spans both premature interface
assertion and loss of the guard across the dynamic `any` boundary; that
diagnosis still needs a compiler fix and an end-to-end rerun. The diagnostic
print was removed from the generated Go after inspection.

A second **diagnostic-only** Go build skipped constructed objects that did
not implement `IRule`, allowing execution past the first panic. It then
reached `src/config.ts:93:3` and hit a lowering trap: the `JSON5` namespace
import was not a lowered local or module value, and assignment to its `parse`
property was unsupported. That constructor was among the 322 functions not
proved by the initial reached-function scan. Skipping objects by Go interface
membership is only a probe and does not establish JavaScript-equivalent
behavior. The original generated Go was restored after the probe; the
compiler needs a proper dynamic-boundary fix and then a fresh full run to
measure what remains.

An independent abapiti candidate `d4baf39cbafbe01326ae2c95a6b5a535aeb24dc1`
fixes the identity used to select source-pinned overrides for external npm
packages. The compiler had named those files by their path inside the package
while looking up overrides, but by their path relative to the gogen project
when selecting overrides. With the same G candidate and reference, the
existing rule-filter and JSON5 compatibility overrides now apply. The scan
reports **0 reached traps**, `0/11 unknown`, and 322 unreached functions, and
the Go build succeeds. The unmodified full run passes the two preceding
failures, then panics at `tools/gogen/frontend-boolx.ts:13:1` on an
**unsupported live class field conversion**: the structural `BoolxParser`
view reads its `Registry` class descriptor from the supplied core object.
The generated Go contains an explicit trap for that view read. It still
writes no Go output, so byte equality and the unit test remain unproved.
This abapiti candidate is private and awaits review and integration.

An additional private abapiti candidate `5f8c204fe90977379e271678e2fc7d3ef81e1191`
admits a class descriptor in a live class field through the existing checked
`ClassValue` conversion. It passes the focused and full Go emitter package
tests. With G `a082e7099de980a406b2755d5b81ec674646ed0f`, execution gets past
the previous live field trap and reaches a dynamic Boolean conversion in
`frontend.mjs`: the `includeTests` predicate supplies a truthy `Set` object
where the generated callback requires a Boolean.

Private G `47de828f92d16473c7cd5af414d1a761716e7cf9` spells that
predicate as an explicit Boolean for the declared `boolean | Set<string>`
inputs. It passes 51 focused frontend tests and the six-mode byte comparison
of 243 artifacts per mode against its parent. The corresponding change is on
[draft PR #815](https://github.com/oisee/open-steamgate/pull/815); review is
pending. With this G commit and abapiti `5f8c204f`, the exact
reachability scan reports **0 reached traps**, `0/11 unknown`, and **322
unreached functions**. The full Go build succeeds. Execution then stops in
`frontend-session.mjs` when the compiler's structural class view refuses a
prototype-bearing source passed through a recorder callback. It writes no
output, so the reference comparison fails at byte one and the unit test has
not run. Neither private compiler candidate is integrated.

A generated-Go-only diagnostic that removed this view's prototype guard
advanced to a callable conversion failure; that generated file was restored.
The newer G candidate on draft PR #815, head `b52e7d96`, passes a plain class
source with own typed getter functions and keeps both the local-constant walk
and flattened structure children behind explicit `instanceof` guards. Its
Node output is byte-identical to its parent in six sink/cache modes (243
artifacts per mode); focused frontend-output tests pass **51/51**. With
abapiti `5f8c204f`, the reached trap scan is still **0**, `0/11 unknown`, and
**322 unreached**. Two inline JSDoc annotations in `variable()` were not
attached to their declarations: both records widened to `e: string`, and a
`var` record acquired a payload whose view admitted only `fs`. Moving those
annotations to separate lines makes the checker retain the two literal tags
and fixes the generated payloads. The original constant-write guard is kept.
The generated Go builds and executes past the class view, local constants,
`flatChildren`, and `lvalue`. It next stops at a checked reference conversion
in `call()`, `frontend.mjs:5122:355`. The first `isExpr` predicate can
return false for an expression of a different subclass. The checker then
excludes expression nodes from the next argument, and abapiti inserts a
`TokenNode` reference conversion before the next predicate can inspect the
actual expression. An isolated regression test reproduces the premature
conversion for both a variable and an array element. A private abapiti fix
preserves the original argument when the callee accepts `unknown` or `any`;
the focused test passes. Its first form (`f4962819`) passes the `call()`
barrier in a full run but introduces a lowering error in
`StatementNode.findExpressionsAfterToken`: an evolving array's contextual
`any` type causes a necessary narrowing to be skipped before `push`. That
function is outside the Node-covered set; the corresponding scan still
reports **0 reached traps**, but now `0/12 unknown` and **323 unreached**.
The candidate is excluded. Follow-up `b7a437cad1c03f614eaab5f2f51ab53139387ea2`
restricts preservation to the argument tested by a type-predicate signature.
Its Node-versus-Go regression test covers both parameter types, variable and
array-element inputs, and guarded pushes to an inferred array. The previously
failing closure-inventory, statements/structures differential, and numeric
conversion tests also pass. Its full step-4 run builds Go and restores the
scan to **0 reached traps**, `0/11 unknown`, **322 unreached**. Execution passes
the reference conversion before the predicate, then fails at a later
`TokenNode` conversion before a common `concatTokens()` method call in the
same `call()` function. The stack offset changes from `+0x94c` to `+0xa3b`;
inspection of generated Go and the binary confirms these are different
conversions, although both diagnostics report the function's source start.
The remaining narrowing after negative predicates therefore also affects
method receivers. This compiler fix is partial and is not ready for
integration. Its full `tsfront` test suite subsequently passed (920.366 s). The generator
still writes no Go output, so byte equality and the unit
test remain unproved.
The next private abapiti candidate,
`2cb16bdb39d42b4f4122f98d13daa1b17012f470`, retains a direct method receiver's
existing interface when its common virtual slot has the same signature,
including variadic flags, as the selected method. A Node-versus-Go test
reproduces the old failure and passes with this change for variables and
array elements. Focused union, virtual-call, covariant-return, predicate,
closure-inventory and numeric-conversion checks pass. Independent adversarial
review found a semantic failure: when one union member has a rest parameter
and another takes an array, a common call returns `A2|B2` instead of Node's
`A1|B2`. Matching the selected method against the common slot is insufficient
when an implementation has a different variadic ABI. This candidate must not
be integrated unchanged. The full compiler suite remains in progress.

The exact full run of this compiler with G `50f84f00` builds Go and executes
past `call()` and `concatTokens()`. It next fails in `defaultValue()`,
`frontend.mjs:5424:170`, with **`live typed array requires array storage`**.
The cause of this array-view failure is not yet established. The generator
still writes no output. Classification with retained V8 coverage from this
exact Node reference run confirms **0 reached traps**, `0/11 unknown`, and
**322 unreached functions**. The full-run driver deletes raw coverage on exit;
the separate classifier now requires retained, nonempty coverage and refuses
to classify when it is missing.

Private abapiti `b80749609d20197d6bbd10a4f03a816da84e646e` corrects
union-slot formation to reject mixed rest/array calling conventions and makes
the shared signature check include variadic flags. Core6's independent tests
pass on the correction, including positive common-rest dispatch and checked
refusal for unsupported mixed conventions. A separate null-array conditional
join fix preserves the absent array reference instead of requesting live
storage from `null`; its Node-versus-Go regression covers null comparison,
original-array identity and empty arrays. Focused combined checks pass.
The exact candidate passes the full short compiler suite, ordinary and
`wasmlegacy` vet, and the required Grace checks. An initial independent GLM
review approved the delta, but a subsequent runtime oracle found a blocking
semantic regression; these general checks do not establish acceptance.

The exact `b8074960` + G `50f84f00` run builds Go and passes both preceding
runtime boundaries. It stops at `frontend.mjs:3416:204`, `fieldChainParts()`,
during a checked IR-family view read of `.type`. Its precise cause remains
under investigation. Classification against this run's retained Node V8
coverage confirms **0 reached traps**, `0/11 unknown`, and **322 unreached**.
The output remains empty. This family-view read is the current full-generator
runtime barrier. Separately, the following independent compiler semantic RED
also blocks acceptance:

```js
const picked = /^(foo)$/.exec("miss") ?? (flag ? ["x"] : null);
const boxed = /** @type {any} */ (picked);
String(boxed === null) + "|" + String(boxed === undefined)
  + "|" + JSON.stringify({value: boxed});
```

For `flag === false`, Node returns `true|false|{"value":null}`, while exact
`b8074960` generated Go returns `false|true|{}`. For `flag === true`, both
return `false|false|{"value":["x"]}`. Strict TypeScript checking succeeds, and
the compiler emits Go that builds and runs; the failure is silent loss of
null identity and JSON property presence. The direct typed array/null case
without the RegExp/coalesce join passes, which narrows the investigation to
that join and subsequent dynamic boxing. The parent compiler traps instead
of producing this incorrect result. This is separate from the already fixed
mixed-variadic dispatch defect. The A compiler owner is investigating the
boxing semantics; the G owner retains the `fieldChainParts()` investigation.
No null/undefined collapse or null-to-empty-array substitution is acceptable.

A private G diagnostic `b2876c97679c550927096b6f34cad8866b0d3b37` adds a
`ValueExpr` annotation to `place`. It passes type checking, front-end tests
and all six 243-artifact Node comparisons, but the exact full run introduces
**1 reached lowering trap** at the `ME->` attribute literal: its optional
`type` has not been validated before constructing the typed IR node. That
annotation-only candidate is excluded from integration. The follow-up
`772688e7a960a0b2575f5345cc63f9c3871c0942` validates `type` before
construction. It passes TypeScript checking, all 51 front-end output tests,
and all six 243-artifact Node comparisons. Its exact full run with unchanged
abapiti `b8074960` builds Go and passes the former `fieldChainParts()` barrier;
retained Node coverage confirms **0 reached traps**, `0/11 unknown`, and
**322 unreached**.

That diagnostic next fails with `live typed array requires array storage`
inside the final-output callback at `frontend.mjs:202:28`. The failing
generated operation is the conversion of the dynamic conditional
`Array.isArray(all) ? all : all.getAll()` into array storage before
`Array.from` at source line 212. The registry's `getAll()` returns a generator,
which requires iterator realization. A G follow-up reuses the existing typed
`methodDefinitions()` adapter to preserve the array/iterator branch types;
this remains under test. The self-hosted output is still empty. These runs
use the compiler with the known boxing RED for diagnosis and do not establish
compiler acceptance. The private compiler changes are not integrated on the
required main/selfhost branches.

The final target-build recipe has also been checked separately: the exact
pinned Node reference `b906…` builds in a fresh module and test runner from
the measured G source, then passes `ZCL_GOGEN_T_RUNTIME/LTCL_RUNTIME/ELAPSED`.
This validates the recipe using reference code; the self-hosted output still
needs to reach the same gate. The historical target kit pins a different
reference and must not be substituted for this check.

## Completion gate

For each candidate, compare the reached trap locations and hit counts on the
same pinned inputs, type-check gogen, run the tests for the changed path, and
compare Node output across the sink/cache modes. Moving the first reported
error inside a function is useful diagnostic progress, but does not clear its
root. Zero reached traps leaves the runtime behavior and the 322 unreached
functions unproved. The private G candidates need review before integration
into main.

Step 4 remains open until a **named OSG main commit** and a **named abapiti
selfhost commit** produce byte-equal Go for the target test, that Go builds
and passes the same unit test, and independent M1, M2 and 11,060-case corpus
checks show no regression. None of those final claims follows from this trap
snapshot.
