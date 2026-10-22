#!/usr/bin/env node
// Check the adapter against actual zlnt declarations without parsing 48 MB of
// generated implementations. This does not build or execute the native engine.
import * as lint from "@abaplint/core";
import {readFileSync, readdirSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import {parseArgs} from "node:util";

const {values} = parseArgs({options: {
  zlnt: {type: "string"}, "core-lib": {type: "string"}, version: {type: "string"},
}});
if (!values.zlnt || !values["core-lib"]) throw new Error("usage: lint-source.mjs --zlnt NATIVE_LIB --core-lib OPEN_ABAP_CORE [--version v750]");
const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(readFileSync(join(root, "abaplint.jsonc"), "utf8")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n"));
config.global = {files: "/**/*.*"};
delete config.dependencies;
if (values.version) config.syntax.version = values.version;
const registry = new lint.Registry(new lint.Config(JSON.stringify(config)));
const walk = dir => readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
for (const file of walk(join(import.meta.dirname, "abap"))) {
  registry.addFile(new lint.MemoryFile(file, readFileSync(file, "utf8")));
}
for (const dir of [resolve(values.zlnt), resolve(values["core-lib"])]) {
  for (const file of walk(dir)) {
    if (!/\.(clas\.abap|intf\.abap|xml)$/.test(file)) continue;
    let raw = readFileSync(file, "utf8");
    if (file.endsWith(".clas.abap")) {
      // A global class requires an implementation block to parse. Preserve
      // every declaration verbatim; dependency method bodies are not checked.
      raw = raw.split(/\bCLASS\s+\w+\s+IMPLEMENTATION\s*\./i)[0]
        + `\nCLASS ${basename(file).split(".")[0]} IMPLEMENTATION.\nENDCLASS.\n`;
    }
    registry.addDependency(new lint.MemoryFile(file, raw));
  }
}
registry.parse();
const issues = registry.findIssues();
for (const issue of issues) console.error(
  `${issue.getKey()} ${issue.getFilename()}:${issue.getStart().getRow()}:${issue.getStart().getCol()} ${issue.getMessage()}`);
console.log(`${config.syntax.version}: ${issues.length} issues`);
process.exitCode = issues.length ? 1 : 0;
