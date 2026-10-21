# abapiti type-form guard

abapiti lowers gogen to Go and ABAP. Casts are runtime-checked claims, and
declaration types drive inference. A type annotation that pleases TypeScript
can therefore change generated behavior. `abapiti form pending` markers are
abapiti's queue.

| Rule | Bad example | Safe form | Trap |
| --- | --- | --- | --- |
| R1 extract-cast | `/** @type {Extract<Node, {kind: "stmt"}>} */ (n)` | Narrow by the discriminant before using the arm. | An ExpressionNode claimed as StatementNode traps at runtime. |
| R2 unknown-bridge | `/** @type {T} */ (/** @type {unknown} */ (x))` | Validate the value and construct the actual shape. | Bridging hides a false runtime type claim. |
| R3 intersection-alias | `type T = Base & {token: string}` | Declare a named interface with explicit fields. | An intersection alias has no lowerable shape. |
| R4 optional-map-key | `m.get(x?.name)` | Read the key, check it is defined, then call `m.get(key)`. | An optional key does not match the map's concrete key type. |
| R5 tuple-literal-cast | `/** @type {[string, number]} */ ([s, n])` | Use a named record with fields. | An array claimed as a tuple does not gain a tuple representation. |
| R6 cast-to-probe | `/** @type {{name: string}} */ (x)` | Check the field or expose an explicit optional-field view. | A probe with required fields claims data the value may not carry. |
| R7 object-typed | `/** @param {object} x */` | Name the concrete shape (or a typedef with properties). | Bare object erases the shape; generated values become dynamic. |
| R8 typeof-namespace-member | `import * as NS from "./n.mjs";` then `ReturnType<typeof NS.member>` | Import and use the named result type. | The namespace becomes a value: `unsupported-namespace-export`. |
| R9 cast-count | `/** @type {T} */ (x)`, `x as T`, or `<T>x` | Prefer narrowing or a correctly typed declaration. | Even a cast outside R1–R8 can introduce a runtime assertion. |

The guard scans top-level `tools/gogen/*.{mjs,ts}`, excluding `*.test.mjs`
and itself, matching the original lint's scope. R1–R8 are syntactic warnings,
not a type checker; R9 counts each cast once, including nested casts.

`node tools/gogen/abapiti-lint.mjs --check` compares every (file, rule) count
with `abapiti-lint.json`, initially generated from the recorded `origin/main`
commit. Missing entries have budget zero. Growth exits 1; equal or smaller
counts pass. After cleanup, `--update` lowers the baseline, never raises it.
Baseline changes remain reviewable in Git.

`--check --changed <ref>` judges files touched since the merge base (including
working edits); inherited breaches print and pass. Without a merge base it
checks the whole tree. `--warn` reports breaches as advisory and exits 0.
Pre-commit warns in yellow, pre-push blocks in red, and CI is advisory.
Without these flags, `[--out file.tsv] [file...]` retains the diagnostic TSV.
