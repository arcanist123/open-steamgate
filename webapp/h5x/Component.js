sap.ui.define(["sap/suite/ui/generic/template/lib/AppComponent"], function (AppComponent) {
  "use strict";
  // A read-only Fiori Elements V2 list report -> object page -> sub-list,
  // served by tools/hana-serve.mjs over the twin service of test/hana-m2
  // (ZOSD_H5X_APP_SRV). The same app shape, with another manifest and
  // annotation file kept outside the tree, runs against a real service on
  // the bed (docs/hana-milestone-3.md). No controller code.
  return AppComponent.extend("osd.h5x.Component", {
    metadata: {manifest: "json"},
  });
});
