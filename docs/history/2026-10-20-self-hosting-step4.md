# 2026-10-20: gogen compiles itself into Go

gogen is the ABAP-to-Go compiler in `tools/gogen`, written in JavaScript with
JSDoc and TypeScript types. On 2026-10-20 the TypeScript compiler of
[abapiti](https://github.com/oisee/abapiti) compiled gogen's own path,
`compileProgram` + `emitGo`, into a Go program. That program compiled the
reference class `ZCL_GOGEN_T_RUNTIME` and emitted **the same Go, byte for
byte, as gogen running on Node**. That Go builds and passes the class's unit
test. gogen no longer needs Node to do its job. This is step 4 of the
self-hosting order decided on 2026-10-14 (1 → 2 → 4 → 3 → 5).

## The measurement

On an OSG commit that is wholly in `main`, with the published abapiti pin:

| | |
| --- | --- |
| OSG (gogen, G) | `0b925177a19574a5f127da9c9ba355e344515b5c` (`main`, merge of #817) |
| abapiti (A) | `3115e569b2e05e469f0a1a650f7a2101ea029f19` (`integ/step4-abapiti`, core25) |
| harness | `tools/selfhost-step4.py` with the body-trap classifier (3cb7e0d7) |
| reference | Node-gogen `ref.go`, recomputed on the same commit: `b90648781967b2cf…5261` |

```
step4-traps: 0 reached (0/11 unknown) 322 unreached
step4: build=ok run=ok cmp=equal ref=b90648781967b2cf out=b90648781967b2cf
PASS: ZCL_GOGEN_T_RUNTIME/LTCL_RUNTIME/ELAPSED
```

The pull-request head `1dbd12c7` with abapiti `e054a615` (core23) gave the
same result first, on i10, and abapiti reproduced `cmp=equal` independently
on u7. abapiti's finals then caught two regressions of its own in the other
directions (an integer-range proof in TS-HG, readonly views without an ABAP
emitter in TS-HA); core24 and core25 fixed them, and the run above was
repeated on each new pin with the same result.

abapiti's finals on `3115e569` (OSGo runtime pin `0171e92b`):

| gate | result |
| --- | --- |
| M1 | PASS, byte-equal `95d37bc6`, 27.0 s |
| M2 (4,676 files, 716 deps) | PASS, byte-equal `9a271f2a`, 264.5 s (270.4 s on the previous pin), peak 10.7 GB |
| abaplint Go traps | 2 (the two known ones) |
| TS-HG@Go | 11,060 / 11,060, 0 failed, 0 trapped, strict audit PASS |
| TS-HA@OSGO | 11,060 / 11,060, 0 failed, 0 trapped |

TS-HA@OSGO ran as one full run of 17 shards, where 16 passed (7,911 tests)
and the Node runner of the `rules` shard ran out of an 8 GiB heap before
registering its tests; `rules` was rerun alone with a 12 GiB heap: 3,149 /
3,149, registration parity, peak 10.8 GB. The heavier heap is a follow-up.

The next abapiti pin, `c2f41e69` (core26), fixes two CI failures outside
this path (ABAP named regexp groups now need the dynamic runtime only where
it exists, and a Grace golden) and emits the same output: abapiti found the
gogen Go, the abaplint Go and the 5,662 TS-HA ABAP files of the
`abap/syntax` + `rules` closure byte-identical to `3115e569`, so the finals
carry over. Rerun here on `0b925177`, the same lines:

```
step4-traps: 0 reached (0/11 unknown) 322 unreached
step4: build=ok run=ok cmp=equal ref=b90648781967b2cf out=b90648781967b2cf
PASS: ZCL_GOGEN_T_RUNTIME/LTCL_RUNTIME/ELAPSED
```

The owner of the cache domain approved it on `0b925177`: two reviewed lines
differ from the proven `61f25917`, and her re-proof there is 5/5 byte-equal.

## How it got there

About twenty full runs from 19 to 21 October. Each run either stopped at a
lowering trap (abapiti refusing to translate a construct) or at a run-time
trap in the generated Go; each one was diagnosed, with an instrumented
build of the generated Go where the location alone was not enough, and
assigned to one side:

- **G, gogen's own code (PR #817, 13 files, +42/−28):** types that said
  something the values do not have. A JSDoc cast claimed the variable arm of
  an assignment target that can be any place; a set was declared of fields
  and held attributes; an interface's signatures were passed off as a
  different type through `unknown`; an intersection alias gave the compiler
  no shape where an `interface … extends` does. Every G change kept the Node
  output byte-identical: the reference was recomputed on every commit and
  never moved.
- **A, abapiti (core14 to core25):** ordinary JavaScript it did not yet
  lower faithfully. Capture groups of `RegExp.exec` that did not match are
  `undefined`; readonly containers are covariant; `{}` as an identity token
  of type `object`; a read past the end of an array is `undefined`; a cast
  of a class value to a compatible object type is a structural view.

Two tools came out of it. A lint of the patterns that had trapped (R1–R7:
`Extract` casts on values, bridges through `unknown`, intersection aliases,
optional keys into `Map.has`, tuple casts on literals, required-field probe
casts, plain `object`) found 50 sites at once; abapiti triaged them, and the
lint named the site of the next run-time trap before the run reached it.
And `@ts-check` branches for `emit-go.mjs`, `frontend.mjs` and eighteen
smaller files: strict TypeScript with 0 errors, runtime text byte-identical,
the abapiti trap scan at 0. They wait for after step 4.

## What is next

Step 3, the ADT syntax check served by abaplint-in-ABAP on OSGo, and
step 5, the open-abap transpiler through abapiti. The typing forms abapiti
does not lower yet are in its backlog; the `@ts-check` branches and the
lint go in after this milestone.
