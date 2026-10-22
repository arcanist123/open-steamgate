# storelint

`Compiler` implements `storecheck.Compiler` for saved ADT CHECKRUN using an
injected ABAP `Engine`; ordinary CHECK and OUTLINE delegate to `Other`.
`Prime` runs once before readiness. One mutex serializes access to the host's
private persistent checker Session/Statics; callbacks must not acquire the
HTTP work-process lock or start a dialog step. No ABAP runtime is imported here.

The complete store baseline and config guards must match before and after each
check. Missing/failed prime, changed inputs, unsupported sources and trapped
ABAP failures return errors for `storecheck` to serialize as `notProcessed`.
An opted-in CHECKRUN never falls back to the sidecar. `MapIssues` preserves
order, duplicates and coordinates, uses severity E and mirrors Node's URI rules.
