# src/rap_draftadm -- the draft administrative data a service serves

What a draft-enabled RAP service serves as `DraftAdministrativeData`
([docs/rap-runtime.md](../../docs/rap-runtime.md), R9): one row per draft of
a root, read from `ZOSD_DRAFT_ADM` (the table the runtime in `src/rap`
writes).

- `zosd_i_draftadm` -- the view: the table's columns under the element names
  of the public draft vocabulary (`DraftUUID`, `CreatedByUser`,
  `InProcessByUser`, `LastChangeDateTime`, ...) and six virtual elements.
- `zcl_osd_draft_adm_calc` -- fills the virtual elements: the user
  descriptions (the user name: there is no user master) and
  `DraftIsCreatedByMe`, `DraftIsLastChangedByMe`, `DraftIsProcessedByMe`
  against the request's user (`src/logon`).

`tools/rap/srvd-gen.mjs` adds the view to every service with a draft BO as
the entity set `DraftAdministrativeData` and gives each draft entity the
navigation to it; `zcl_stg_sadl_dpc` resolves the navigation. Kept apart
from `src/rap` because it is served through SADL (virtual elements, the
CDS source), which the runtime itself does not depend on.
Tests: `test/rap-r9.mjs`.
