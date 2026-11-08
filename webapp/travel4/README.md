# Travels (OData V4)

A Fiori Elements V4 list report and object page over the demo service
`ZSTG_DEMO_SRV`, served by the OData V4 facade at
`/sap/opu/odata4/sap/ZSTG_DEMO_SRV/` ([docs/odata-v4.md](../../docs/odata-v4.md)).
It is the V4 twin of the V2 Travels app (`webapp/index.html`): same
transpiled MPC and DPC, same rows, a different wire.

- `manifest.json`: `sap.fe.templates.ListReport` on `/TravelSet` and
  `sap.fe.templates.ObjectPage` on `TravelSet({key})`, `odataVersion` 4.0,
  `autoExpandSelect`, list creation mode `NewPage`.
- `Component.js`: `sap/fe/core/AppComponent`, nothing else.
- `index.html`: SAPUI5 1.120.50 from `ui5.sap.com`, the version every other
  app here bootstraps; it carries `sap.fe` V4.
- No annotation file: list columns, filter fields, header, facets, field
  group, labels and value helps come from the service's `$metadata`, which
  the facade writes from the `annotations:` block of
  `src/demo/zstg_demo.stg.yaml`.

Edit, Save, Cancel and Create work through the facade's sticky session
(`Session.StickySessionSupported`, `ZCL_OSD_V4_STICKY`), which the demo's
YAML asks for with `sticky: true` on Travel: Fiori Elements V4 offers them
only for a draft or sticky-session entity set. Create asks for
the travel's key in a dialog (the NewAction's parameter). The demo's Travel
has an ETag (Description, Status, Seats), so every change carries
`If-Match`.

Opened standalone at `/app/travel4/index.html`, from the launchpad as the
tile "Travels (OData V4)" (`#TravelV4-manage`, BSP application
`ZOSD_TRAVEL4` in `src/bsp/apps.json`). The test is
`test/e2e/travel4.spec.mjs`:

```sh
STG_PORT=3472 npx playwright test test/e2e/travel4.spec.mjs
```

Not here: creating or editing bookings (writes through a navigation
property are not served), draft, side effects, the basic search
(`$search` is 501).
