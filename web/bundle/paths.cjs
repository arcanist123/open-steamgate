// Where the bundle's tools come from, without naming anybody's home directory.
// These files were a scratch build with absolute paths into one machine's
// sibling checkout; the same layout is now the default, and each piece can be
// pointed elsewhere by an environment variable.
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
// the node_modules that holds webpack, the browser polyfills and playwright:
// this repository's own unless OSD_BUNDLE_NODE_MODULES names another
const nodeModules = path.resolve(process.env.OSD_BUNDLE_NODE_MODULES ?? path.join(repoRoot, "node_modules"));
// the open-abap-apc checkout (for web/apc-socket.mjs): OPEN_ABAP_APC, else a
// sibling of this checkout
const apcRoot = path.resolve(process.env.OPEN_ABAP_APC ?? path.join(repoRoot, "..", "open-abap-apc"));

// resolve a package out of nodeModules only, never out of whatever directory
// the command was started in
const need = (id) => require.resolve(id, {paths: [path.dirname(nodeModules)]});

module.exports = {repoRoot, nodeModules, apcRoot, need};
