# Draft Trips (RAP draft, OData V4)

A Fiori Elements V4 list report and object page **with draft** over the RAP
R8 trip demo `ZUI_RAP_DTRIP` ([src/rap_r8](../../src/rap_r8/README.md)),
served by the OData V4 facade at `/sap/opu/odata4/sap/ZUI_RAP_DTRIP/`
([docs/rap-runtime.md](../../docs/rap-runtime.md), R9).

- `manifest.json`: `sap.fe.templates.ListReport` on `/Trip` and
  `sap.fe.templates.ObjectPage` on `Trip({key})`, `odataVersion` 4.0,
  `autoExpandSelect`, creation mode `NewPage`.
- `Component.js`: `sap/fe/core/AppComponent`, nothing else. The draft flow
  is sap.fe's own: the set is a `Common.DraftRoot`, so Create posts a draft,
  a field change patches it, Save is Prepare + Activate, Edit calls the
  Edit action, Discard reads `SiblingEntity` and deletes the draft, and the
  filter bar gets the "Editing Status" field.
- `annotations/annotations.xml`: the UI annotations (header, line item,
  facets, field group, labels, `Common.SemanticKey` for the draft indicator).
  On a system they come from the views' metadata extensions; the draft
  annotations come from the service's `$metadata`.
- `index.html`: SAPUI5 1.120.50 from `ui5.sap.com`, as the other apps.

Opened standalone at `/app/trip4/index.html`, from the launchpad as the tile
"Draft Trips" (`#DraftTrip-manage`, BSP application `ZOSD_TRIP4` in
`src/bsp/apps.json`). The browser is the system's default user; a request
with a Basic credential is that user (`src/logon`), which is how the test
makes a draft "locked by another user". The test:

```sh
STG_PORT=3472 npx playwright test test/e2e/trip4.spec.mjs
```
