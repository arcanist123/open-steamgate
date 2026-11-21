sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  // The RAP draft trip demo (src/rap_r8) as a Fiori Elements V4 list report
  // and object page with draft, over the V4 facade of the transpiled
  // service ZUI_RAP_DTRIP (docs/rap-runtime.md, R9). Nothing app-specific:
  // the draft flow is the one sap.fe runs for a Common.DraftRoot set.
  return AppComponent.extend("osd.trip4.Component", {
    metadata: {manifest: "json"}
  });
});
