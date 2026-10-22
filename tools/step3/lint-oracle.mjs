#!/usr/bin/env node
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import {join, resolve} from "node:path";
import {parseArgs} from "node:util";
import {isDeepStrictEqual} from "node:util";

const {values} = parseArgs({options: {
  files: {type: "string"}, deps: {type: "string"}, config: {type: "string"},
  target: {type: "string"}, core: {type: "string"},
  "export-adt-config": {type: "boolean"}, root: {type: "string"},
}});

if (values["export-adt-config"]) {
  // Call the real store factory so rule options and allow-lists cannot drift.
  const {configuredRegistry} = await import("../osd-store-registry.mjs");
  const {registry} = configuredRegistry({root: resolve(values.root ?? ".")}, values.config ?? "abaplint.jsonc");
  process.stdout.write(JSON.stringify(registry.getConfig().get(), null, 2) + "\n");
} else {
  for (const key of ["files", "config", "target"]) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  const core = resolve(values.core ?? process.env.ABAPLINT_CORE ?? join(homedir(), "dev/abaplint/packages/core"));
  const require = createRequire(join(core, "package.json"));
  const pkg = require("./package.json");
  const lint = require(core);
  if (pkg.version !== "2.120.73" || lint.Registry.abaplintVersion() !== "2.120.73") {
    throw new Error(`oracle requires core 2.120.73 built from 9f7f098c; see tools/step3/README.md (${core})`);
  }
  const paths = file => file ? readFileSync(file, "utf8").replaceAll("\r", "").split("\n").filter(Boolean) : [];
  const registry = new lint.Registry(new lint.Config(readFileSync(values.config, "utf8")));
  // Lists and target are relative to cwd; logical names retain their paths,
  // including dependencies (unlike the old native batch report's basenames).
  for (const [list, dependency] of [[values.files, false], [values.deps, true]]) {
    for (const file of paths(list)) {
      const input = new lint.MemoryFile(file.replaceAll("\\", "/"), readFileSync(file, "utf8"));
      if (dependency) registry.addDependency(input);
      else registry.addFile(input);
    }
  }
  const started = performance.now();
  registry.parse();
  const primed = performance.now();
  const target = registry.getFileByName(values.target.replaceAll("\\", "/"));
  if (!target) throw new Error(`file is not in the registry: ${values.target}`);
  const object = registry.findObjectForFile(target);
  if (!object) throw new Error(`object is not in the registry: ${values.target}`);
  const check = () => registry.findIssuesObject(object).map(issue => [
    issue.getKey(), issue.getSeverity(), issue.getFilename(),
    `${issue.getStart().getRow()}:${issue.getStart().getCol()}`,
    `${issue.getEnd().getRow()}:${issue.getEnd().getCol()}`, issue.getMessage(),
  ].join("|"));
  const first = check();
  const checked = performance.now();
  const second = check();
  const finished = performance.now();
  if (!isDeepStrictEqual(first, second)) throw new Error("repeated object check changed its ordered issues");
  for (const [label, rows] of [["check1", first], ["check2", second]]) {
    process.stdout.write(`# ${label} issues=${rows.length}\n`);
    for (const row of rows) process.stdout.write(row + "\n");
  }
  const ms = n => n.toFixed(3);
  process.stdout.write(`# ms prime=${ms(primed - started)} check1=${ms(checked - primed)} check2=${ms(finished - checked)}\n`);
}
