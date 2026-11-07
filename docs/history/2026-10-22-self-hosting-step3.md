# 2026-10-22: ADT syntax checking in the Go process

OSGo serves ADT CHECKRUN, CHECK and PARSE OUTLINE through abaplint translated
by [abapiti](https://github.com/oisee/abapiti) and linked into Go. CHECKRUN
also has the translated-ABAP engine as a self-hosting proof. This completes
step 3 of the order 1 → 2 → 4 → 3 → 5; see the
[self-hosting index](../self-hosting.md) for the scope of each step.
Go is the default **when its optional lint library is linked**. A build without
that library still selects Node. This is syntax tooling, not native activation.

## The measurement

These are existing PR/doc measurements, transcribed without new runs. Each
row identifies its source and boundary; results from different revisions are
not one combined acceptance run.

| Gate or measurement | Recorded result | Source |
| --- | --- | --- |
| CHECKRUN, translated ABAP and direct Go engines | Each passed 12 clean saved + 12 broken saved + 14 overlay = 38/38 comparisons on 3,028 inputs, ordered diagnostics/status equal to Node | [#834](https://github.com/oisee/open-steamgate/pull/834), [measured acceptance record](../../tools/step3/README.md#measured-acceptance-record-i10-2026-10-22) |
| Emission/native build, historical Go pilot | 49.74 + 84.96 = 134.70 s; largest build process 6,315 MiB peak RSS; clean cold prime 23.023 s | [measured acceptance record](../../tools/step3/README.md#measured-acceptance-record-i10-2026-10-22), OSG `976b8823`, abapiti `5b56ecfd` |
| Automatic-Go/resolver follow-up | 12/12 clean saved comparisons; HTTP median 2,343.62 → 252.96 ms; contemporaneous Node 21.37 ms | Same [acceptance record](../../tools/step3/README.md#measured-acceptance-record-i10-2026-10-22), revisions `7a7d14ce` + `606d0bb3`; did not renew the broken/overlay gate |
| Freshness cache, synthetic no-op engine | Snapshot 186.8 → 35.6 ms; compiler CHECKRUN 393.6 → 76.3 ms; store including index 411.9 → 93.3 ms | [#836](https://github.com/oisee/open-steamgate/pull/836), 3,000-file fixture, median of three runs; these are not HTTP timings |
| Targeted index/membership delta, synthetic no-op engine | Whole saved CHECKRUN 96.1 → 51.3 ms with 300 project + 2,700 library files | [#837](https://github.com/oisee/open-steamgate/pull/837); also records 19 guard mutants failing assertions |
| Native resolver vs Node build specification | Ordered paths, file hashes and config bytes equal: 2,321 files, 1,317 library files, 9 roots, 6 packs | [#838](https://github.com/oisee/open-steamgate/pull/838), disposable checkout with seven locked libraries; empty-PATH tests and resolver exec trace |
| Linked CHECK/OUTLINE, core .73 | 432 CHECK + 793 OUTLINE comparisons, 41 mutation scenarios, equal aggregate SHA-256; 364 indexed objects | [#839](https://github.com/oisee/open-steamgate/pull/839); [#840](https://github.com/oisee/open-steamgate/pull/840) repeats parity after replacing the CDS adapter |
| Later linked differential | 1,478 CHECK + 2,879 OUTLINE comparisons, 47 mutations, 1,404 objects / 3,032 files; zero mismatches, equal aggregate hashes | [#841](https://github.com/oisee/open-steamgate/pull/841), with the scope/correction in the [tracked gate notes](../../tools/step3/README.md#native-check-and-parse-outline-gate-73) |

The linked driver runs with an empty PATH and a panic-only `Other` provider,
so delegation cannot silently satisfy the CHECK/OUTLINE comparison.
[`check-outline-diff.mjs`](../../tools/step3/check-outline-diff.mjs) compares
complete CHECK scalars and ordered RFC issues, and active/inactive OUTLINE
document bytes. [`checkrun-diff.mjs`](../../tools/step3/checkrun-diff.mjs)
compares HTTP reports and requires completed native calls in the origin log.

The tracked README corrects #841's HTTP claims: CHECK comparisons normalized
the displayed elapsed time and excluded surrounding editor HTML. Its latency
medians describe a pre-review implementation with saved-Tree reuse. That reuse
was removed after an external-INCLUDE macro counterexample, so those timings
are not evidence of corrected-code latency. OUTLINE uses an isolated checker
for the host-selected snapshot; matching the object's own files is insufficient.

## How it got there

Merge SHAs below were cross-checked with Git history and GitHub's merged PR
metadata. All these OSG PRs merged on the date in this record.

| PR | Change | Merge commit |
| --- | --- | --- |
| [#834](https://github.com/oisee/open-steamgate/pull/834) | Persistent facade; saved/overlay CHECKRUN; direct Go library, default when linked | `623a3a4140eaccbc66bb6971b9dffb40cdade8bc` |
| [#836](https://github.com/oisee/open-steamgate/pull/836) | Conservative stable-file content cache for freshness snapshots | `78ca275c6c839fff782112ec8b14b4155a6f28a6` |
| [#837](https://github.com/oisee/open-steamgate/pull/837) | Targeted CHECKRUN index and membership delta | `a246061a1e3dd5510e67dd7c0b5513cec3cfacd8` |
| [#838](https://github.com/oisee/open-steamgate/pull/838) | Native lint input resolver; no Node at runtime startup or refresh | `739022b70c4e6a2260cd05c0e16acc671d880f37` |
| [#839](https://github.com/oisee/open-steamgate/pull/839) | Native CHECK/OUTLINE and core .73 oracle alignment | `63acb9c958fade0ad7e93511a626584fe2f9b042` |
| [#840](https://github.com/oisee/open-steamgate/pull/840) | Public CDS/DDIC/Files API replaces the generated-library adapter | `9d72d8706250acc8bcc3c1d803b5647205a693b0` |
| [#841](https://github.com/oisee/open-steamgate/pull/841) | Advertise native CHECK; targeted CHECK/OUTLINE index; remove unsafe saved-Tree reuse during review | `7d8e0617a8e5ded4ead65da534acf1f1b2021863` |

## Pins

The final companion used by the tracked native CHECK/OUTLINE instructions and
`tools/gogen/lint-engine.mjs` is abapiti
[`da13e34d1df51262af02e71084f924e621cac652`](https://github.com/oisee/abapiti/commit/da13e34d1df51262af02e71084f924e621cac652),
with abaplint
[`9f7f098c21e93b8b534fff0f0148f0a900d29d16`](https://github.com/abaplint/abaplint/commit/9f7f098c21e93b8b534fff0f0148f0a900d29d16),
core **2.120.73**. The CDS API landed in
[abapiti #246](https://github.com/oisee/abapiti/pull/246), merge
`f6568f61c045d70a4cd3bdc3b6d392b92dc8e95b`.
The step-3 README's “under review” wording is historical: the upstream PR is
merged. Its merge SHA is distinct from the documented tested companion; do not
silently substitute one pin for the other.

The historical CHECKRUN pilot instead used abapiti
`5b56ecfd411651b01a7a4ef1d9c158a4c7298992` and translated core **2.120.56**,
`577f875ebec44cfaf64841cfe71c8ab8dc32622e`, against the Node **2.120.73** host.
Those measurements cannot establish version-aligned parity for every path.
The [step-3 README](../../tools/step3/README.md#pins-and-generated-member-names)
records the separately pinned historical TS-HA library as well.
`libs.lock.json` pins OSG libraries and the transpiler, not this optional
external generated lint module; linkage uses a temporary Go modfile/replace.

## What is next

The milestone closes the reported syntax routes and corpora. The historical
saved-edit HTTP gate was skipped because source PUT was unavailable; AMDP
portability warnings and Node warm-mode acceptance are separate gaps in the
[tracked notes](../../tools/step3/README.md). Structural config, pack, selector
or layer-identity changes require rebuilding the fixed generation and explicitly
refuse stale reports. The native resolver keeps source/library edits live.

The proposed next work is [whole-corpus gogen-in-Go and the step-5 inventory](../self-hosting.md#next-milestone-proposal).
