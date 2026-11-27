# src/rap_r8 -- the draft trip demo of RAP R8

A draft-enabled managed business object, the smallest one that exercises
draft end to end ([docs/rap-runtime.md](../../docs/rap-runtime.md), "R8"):
a root with one composition child, both with draft tables, created as a
draft, changed, prepared, activated, edited and discarded.

| construct | here |
| --- | --- |
| `with draft;` | the header |
| `draft table zrap_dtrip_d` / `zrap_dleg_d` | one column per CDS element (named as the element) and the admin columns |
| `total etag last_changed_at` | Activate refuses a draft whose active trip changed after Edit |
| `draft action Edit / Activate optimized / Discard / Resume` | run by the runtime, no handler methods |
| `draft determine action Prepare { validation CheckDescription; }` | the validation on the draft |
| `association _Legs { create; with draft; }`, `association _Trip { with draft; }` | a leg of a draft is a draft |
| `field ( numbering : managed )` | UUID keys, kept by Activate |

- `zrap_dtrip`, `zrap_dleg` -- the active tables; `zrap_dtrip_d`, `zrap_dleg_d` -- the draft tables
- `zi_rap_dtrip`, `zi_rap_dleg` -- the views; `zi_rap_dtrip.bdef` -- the behavior; `zbp_rap_dtrip` -- the pool (a determination and a validation, explicit form)
- `zui_rap_dtrip.srvd` -- served at `/sap/opu/odata4/sap/ZUI_RAP_DTRIP` (and at the V2 endpoint), with the key `IsActiveEntity`, `HasActiveEntity`, `HasDraftEntity`, the draft actions as bound actions and `Common.DraftRoot` / `DraftNode`
- the draft administrative data is `ZOSD_DRAFT_ADM` in `src/rap`, served as `DraftAdministrativeData` (R9)
- R9: the Fiori Elements V4 app over it is `webapp/trip4` (launchpad tile "Draft Trips"), tested by `test/e2e/trip4.spec.mjs`; the owner of a draft is the request's user (`src/logon`)

A description containing `INVALID` fails the validation: a draft may hold
it, Prepare reports it, Activate refuses it.

Tests: `npx mocha test/rap-r8.mjs` and `node tools/osd-unit.mjs CLAS ZCL_OSD_RAP_R8_TEST` (after `npm run transpile`).
