// webpack through its Node API: the tree has webpack and no webpack-cli, and
// installing one would change a checkout that is not ours
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const {need} = require("./paths.cjs");
const webpack = require(need("webpack"));
const config = require("./webpack.config.cjs");

webpack(config, (err, stats) => {
  if (err) {
    console.error("webpack failed to start:", err.message);
    process.exit(2);
  }
  console.log(stats.toString({colors: false, modules: false, chunks: false, errorDetails: true}));
  process.exit(stats.hasErrors() ? 1 : 0);
});
