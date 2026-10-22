const path = require("node:path");
const preview = require("../../../webpack.config.cjs");

module.exports = {
  ...preview,
  entry: path.resolve(__dirname, "extension.mjs"),
  output: {
    path: path.resolve(__dirname, "../dist/web"),
    filename: "extension.js",
    clean: true,
    globalObject: "self",
    library: {type: "commonjs"},
  },
  externals: {vscode: "commonjs vscode"},
  resolve: {
    ...preview.resolve,
    fallback: {
      ...preview.resolve.fallback,
      // lib.js imports launcher.js for desktop-only helpers. The browser uses
      // only its Osd/data-preview helpers, so Node process spawning is never reached.
      child_process: false,
    },
  },
};
