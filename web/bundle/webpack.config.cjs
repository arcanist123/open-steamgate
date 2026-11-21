const path = require("node:path");
const {nodeModules, apcRoot, need} = require("./paths.cjs");
const webpack = require(need("webpack"));

// The transpiled ABAP of oisee/vivid-vibes, for a page with no server: after
// open-steamgate's webpack.config.cjs, which is after larshp/hithub's (MIT).
module.exports = {
  mode: "development",
  target: "web",
  entry: path.resolve(__dirname, "web/entry.mjs"),
  output: {path: path.resolve(__dirname, "build"), filename: "vivid.js"},
  devtool: false,
  experiments: {topLevelAwait: true},
  performance: {hints: false},
  optimization: {minimize: false},
  resolve: {
    extensions: [".mjs", ".js"],
    modules: [nodeModules, "node_modules"],
    alias: {"open-abap-apc": apcRoot},
    fallback: {
      assert: need("assert/"),
      buffer: need("buffer/"),
      crypto: need("crypto-browserify"),
      events: need("events/"),
      http: need("stream-http"),
      https: need("https-browserify"),
      os: need("os-browserify/browser"),
      path: need("path-browserify"),
      process: need("process/browser"),
      stream: need("stream-browserify"),
      string_decoder: need("string_decoder/"),
      url: need("url/"),
      util: need("util/"),
      vm: need("vm-browserify"),
      zlib: need("browserify-zlib"),
      fs: false, net: false, tls: false, constants: false,
    },
  },
  module: {rules: [{test: /\.m?js$/, resolve: {fullySpecified: false}}]},
  plugins: [
    new webpack.NormalModuleReplacementPlugin(/^node:/, (r) => {
      r.request = r.request.replace(/^node:/, "");
    }),
    // the transpiler escapes a percent in a specifier; the file carries it raw
    new webpack.NormalModuleReplacementPlugin(/%25/, (r) => {
      r.request = path.resolve(__dirname, "output", r.request.replace(/^\.\//, "").replaceAll("%25", "%"));
    }),
    new webpack.ProvidePlugin({
      Buffer: ["buffer", "Buffer"],
      process: "process/browser",
    }),
    new webpack.optimize.LimitChunkCountPlugin({maxChunks: 1}),
  ],
};
