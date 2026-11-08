# Whole-osgo self-hosting runs: evidence

What `tools/selfhost/corpus-run.mjs` left behind for the two runs quoted in
[`docs/self-hosting.md`](../../self-hosting.md). Each folder contains the
following, copied unchanged, with no absolute paths:

- `report.json`, `timings.json` and `summary.txt` from `corpus-report.mjs`.
- `full-summary.txt`, the abapiti harness line.
- `run-first-line.txt`, the Go run's first stderr line.
- For r1 only, `traps-summary.txt` and `reached-traps.tsv`. r2 ran with `--no-traps`.

Both runs predate the strict verdict, so their `summary.txt` lines say `FAIL`
under the old rule. They would also be `FAIL` under the new one (r2:
`UNCHECKED` at best, since its trap phase was skipped). Generated Go,
logs and V8 coverage are not kept here: about 100 MB per run.

| Run | OSG | abapiti / abaplint / transpiler |
| --- | --- | --- |
| r1 | `ae541da2` | `90f2443a` / `9f7f098c` / `8b566b19` |
| r2 | `ca801c94` | same |
