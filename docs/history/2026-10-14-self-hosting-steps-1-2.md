# 2026-10-14: abaplint checks OSG and its own generated ABAP

Self-hosting step 1 (M1) checks OSG's ABAP with abaplint compiled by abapiti.
Step 2 (M2, the fixed point) checks the ABAP emitted for abaplint itself.
Both TS-HA@OSGO (TypeScript → HIR → ABAP on OSGo) and TS-HG@Go (direct
TypeScript → HIR → Go) produced the Node reference bytes. These are checking
milestones, not a claim that the whole ABAP-to-Go generator rebuilds itself.
The [index](../self-hosting.md) keeps the order 1 → 2 → 4 → 3 → 5.

## The measurement

The dated result and independent verification are public in abapiti's
[README at the frozen finals pin](https://github.com/oisee/abapiti/blob/3115e569b2e05e469f0a1a650f7a2101ea029f19/README.md).
The values below are transcribed evidence, not new measurements.

| Gate | Recorded workload and result | Source |
| --- | --- | --- |
| M1 Node reference | OSG `3ee404ca`, 2,785 files / 2,210 objects; 80 issues (69 naming, 6 unknown types, 5 syntax) | [abapiti #164](https://github.com/oisee/abapiti/pull/164), workload/reference proposal; frozen README confirms the accepted workload |
| M1 direct Go | Byte-identical to Node `577f875e`, 80 issues, 48 s | [abapiti #166](https://github.com/oisee/abapiti/pull/166) |
| M1 translated ABAP on OSGo | Byte-identical, 80 issues, 133 s, 2.1 GB RSS; runtime OSG `f83dc5c3` | [abapiti #167](https://github.com/oisee/abapiti/pull/167) |
| M2 fixed point with dependencies | 4,676 generated files + 716 deps, v755; Node `577f875e`, zero issues, byte-identical on both translated paths; OSGo 1,379 s / 17 GB, Go 435 s / 43 GB, Node 63 s | [frozen abapiti README](https://github.com/oisee/abapiti/blob/3115e569b2e05e469f0a1a650f7a2101ea029f19/README.md) |
| Later M1 finals | PASS, byte-equal `95d37bc6`, 27.0 s | [step-4 finals record](2026-10-20-self-hosting-step4.md#the-measurement), abapiti `3115e569`, OSGo runtime `0171e92b` |
| Later M2 finals | PASS, byte-equal `9a271f2a`, 264.5 s, peak 10.7 GB; same 4,676 files / 716 deps | Same [step-4 finals record](2026-10-20-self-hosting-step4.md#the-measurement); its preceding pin measured 270.4 s |

M1 uses the OSG source tree, its locked libraries and default packs, OSG's
syntax settings and the zabapgit kit's six-rule configuration. The frozen
[step-3 fixture description](../../tools/step3/README.md#prepare-corpora-and-export-the-effective-adt-configuration)
confirms that M1's libraries are checkable inputs, with zero dependencies.
A file count from this fixture is not the size of today's build.

M2's zero-issue result proves completed checks with the same verdict but is a
weaker discriminator than M1's nonempty report. The no-dependency stress
variant in [abapiti #169](https://github.com/oisee/abapiti/pull/169) had 20,179
Node issues and a Go OOM rather than a completed equality result. Its inventory
counts 4,678 files / 2,339 objects for the zip; that is a different inventory
boundary from the accepted 4,676-file checking workload. It does not supersede
the with-dependencies gate or prove the stronger stress variant passed.

## How it got there

| Evidence | Change | Merge commit/status |
| --- | --- | --- |
| [abapiti #164](https://github.com/oisee/abapiti/pull/164) | Freeze workload, config, per-file hashes and Node reference | Open proposal; no merge SHA |
| [abapiti #166](https://github.com/oisee/abapiti/pull/166) | DDIC VIEW handling, boolean record read, Go RegExp.source escaping; M1 direct-Go result | `81e9d0e72cd1e5fb309f063ebfa26bbd86469a5d` |
| [abapiti #167](https://github.com/oisee/abapiti/pull/167) | Native --files LIST; M1 translated-ABAP result | `5464321a5fab7399ce95c937b26805ba29f8d07d` |
| [abapiti #169](https://github.com/oisee/abapiti/pull/169) | M2 inventory and separate no-deps stress test | Open proposal; no merge SHA |
| [OSG #823](https://github.com/oisee/open-steamgate/pull/823) | Tracked history with later M1/M2 finals | `756f46dde84048e39879a0cd051f0e580a2f5d38` |

The private completion summary is recorded in a private handover. No private
transcript or artifact is required to support the public results above. The
public fixed-point completion evidence is the frozen README and tracked gate
rows; no separate merged M2 completion PR is asserted here.

## Pins

- M1 workload: OSG `3ee404ca1260464221f5eba7d86a06a38eabc6c4` and its
  [`libs.lock.json`](https://github.com/oisee/open-steamgate/blob/3ee404ca1260464221f5eba7d86a06a38eabc6c4/libs.lock.json).
  The translated-ABAP M1 runtime in #167 is separately OSG
  `f83dc5c3e05bfaea71268fd6ad0e9ff88532cce6`.
- Node/translated core reference: abaplint
  `577f875ebec44cfaf64841cfe71c8ab8dc32622e`, **2.120.56** (#164).
- Later regression finals: abapiti
  `3115e569b2e05e469f0a1a650f7a2101ea029f19`, OSGo runtime
  `0171e92b2974854153a5ab4d645f0e53b6f27092`, as recorded in the step-4
  history. Its successor `c2f41e69` had byte-identical generated outputs per
  that record; these finals do not retroactively identify the original run's
  complete compiler SHA.

## What is next

Preserve these frozen, version-aligned check gates while broadening generation.
The [whole-corpus proposal](../self-hosting.md#next-milestone-proposal) extends
the single-class step-4 result and defines the step-5 transpiler inventory.
