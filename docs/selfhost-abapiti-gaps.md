# abapiti gaps found by the whole-osgo self-hosting run

The whole-osgo corpus run ([`tools/selfhost/`](../tools/selfhost/README.md),
[self-hosting milestone (a)](self-hosting.md)) found reached lowering traps in
gogen's closure that are ordinary TypeScript/JavaScript and do not come from
OSG's typing. Each item below is a minimal reproducer with where gogen meets it.
The run that found them, with its pins, is in `docs/self-hosting.md`. Nothing
here has been sent to abapiti; its session takes them from this page.

Kinds that an OSG change removes (untyped JSDoc values that lower to
`dynamic`, an optional parameter without `[name]`, `Array(n).fill`) are not
listed. They are fixed in OSG, one file at a time.

## 1. Namespace import of a relative module

```ts
// m.ts
export const T = {str: "s"};
export function lit(v: string) { return v; }
// main.ts
import * as M from "./m.ts";
console.log(M.lit("x"), M.T.str);
```

Trap: `identifier M is not a lowered local or module value`. gogen:
`import * as RIR from "../sqlscript-ir.mjs"` and `WIR` in
`tools/gogen/frontend.mjs`, `import * as abap from "./fold-scalars.ts"` in
`tools/gogen/frontend-local-constants.mjs` (10 reached roots in all).

## 2. The global `Object`

```ts
const value: Record<string, number> = {a: 1, b: 2};
const out = Object.fromEntries(Object.keys(value).map((k) => [k, value[k] * 2]));
console.log(JSON.stringify(out));
```

Trap: `identifier Object is not a lowered local or module value`
(`tools/gogen/frontend.mjs`, the `begin` value resolution).

## 3. `parseInt` with radix 16

```ts
const b = ("0aff".match(/[0-9a-fA-F]{2}/g) ?? []).map((h) => parseInt(h, 16));
console.log(b.join(","));
```

Trap: `parseInt is lowered only with an explicit radix 10`
(`tools/gogen/emit-go.mjs`, byte literals).

## 4. bigint arithmetic

```ts
const frac = "125", dec = 1;
let v = BigInt("3" + frac);
const div = 10n ** BigInt(frac.length - dec);
console.log(String(v / div), String(v % div));
```

Trap: `runtime bigint arithmetic is not lowered` (`tools/gogen/frontend.mjs`,
packed-number constants; `tools/ir-writes.mjs`, `Number(value)` on a bigint).

## 5. `Number.prototype.toFixed`

```ts
const value: number = 2.5;
console.log(value.toFixed(2));
```

Trap: `method toFixed on number is not lowered` (`tools/ir-writes.mjs`).

## 6. `Map.prototype.keys`

```ts
const given = new Map<string, number>([["A", 1], ["B", 2]]);
for (const k of given.keys()) console.log(k);
```

Trap: `method keys on map is not lowered` (`tools/gogen/frontend.mjs`,
builtin-function parameter checks; two reached roots).

## 7. Regexp flags and lookahead

```ts
console.log(/^([0-9A-F]{2})*$/i.test("0a"), /^[+-]?\d{1,15}(?![\s\S])/.test("12"));
console.log(/^(?:[IBS](?:\(|$)|INT8$)/.test("I("));
```

Trap: `not supported in the Go prototype: JavaScript regexp`. OSG rewrote the
first two into equivalent forms. The third (`tools/sqlscript-lower.mjs`) still
traps.

## 8. Recursive union literals

```ts
type E = {e: "lit", v: string} | {e: "neg", x: E} | {e: "add", l: E, r: E};
function neg(x: E): E { return {e: "neg", x}; }
console.log(JSON.stringify(neg({e: "lit", v: "1"})));
```

Trap: `recursive union literal has no admitted tag or compatible payload`.
This is the union ABI work abapiti has already planned. gogen meets it in
`tools/gogen/frontend.mjs` (8 reached roots).

## 9. `String.prototype.localeCompare`

```ts
const names = ["zcl_b.clas.abap", "zcl_a.clas.abap", "#ns#x.clas.abap"];
console.log(names.sort((x, y) => x.localeCompare(y)).join(","));
```

Runtime trap: `value outside supported numeric, ordering or conversion domain`.
This is the first runtime stop of the whole-osgo run: the folder walk at the
start of `compileProgram` (`tools/gogen/frontend.mjs`). The Node result depends
on ICU collation, so a lowering has to reproduce Node's default locale order.
Code-unit order is not enough.
