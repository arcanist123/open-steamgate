sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  // The demo's travels as a Fiori Elements V4 list report and object page,
  // over the V4 facade of the same transpiled service
  // (/sap/opu/odata4/sap/ZSTG_DEMO_SRV/, docs/odata-v4.md). The annotations
  // come from the service's own $metadata, like the V2 Travels app.
  return AppComponent.extend("osd.travel4.Component", {
    metadata: {manifest: "json"}
  });
});
