#!/usr/bin/env node
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {createHash} from "node:crypto";
import {parseArgs} from "node:util";

const {values} = parseArgs({options: {kit: {type: "string"}, out: {type: "string"}, config: {type: "string"}}});
if (!values.kit || !values.out) throw new Error("usage: prepare-corpus.mjs --kit M1_KIT --out NEW_DIRECTORY [--config JSON]");
const kit = resolve(values.kit);
const out = resolve(values.out);
if (existsSync(out)) throw new Error(`output already exists: ${out}`);
const lists = Object.fromEntries(["files", "deps"].map(key => [key,
  readFileSync(join(kit, `${key}.txt`), "utf8").replaceAll("\r", "").split("\n").filter(Boolean)]));
for (const path of [...lists.files, ...lists.deps]) {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) throw new Error(`not a kit-relative path: ${path}`);
}
const target = "src/adt/zcl_osd_adt_logoff.clas.abap";
if (!lists.files.includes(target)) throw new Error(`kit is missing target ${target}`);
const original = readFileSync(join(kit, target), "utf8");
const anchor = "    rv_valid = boolc( strlen( iv_id ) = 24 AND iv_id CO `0123456789abcdef` ).";
if (original.split(anchor).length !== 2 || /\bstep3_undefined\b/i.test(original)) throw new Error("target mutation anchor changed");
const broken = original.replace(anchor, "    step3_undefined = 1.\n" + anchor);
const config = readFileSync(values.config ? resolve(values.config) : join(kit, "abaplint.json"));
for (const variant of ["clean", "broken"]) {
  const root = join(out, variant);
  mkdirSync(root, {recursive: true});
  for (const path of new Set([...lists.files, ...lists.deps])) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    copyFileSync(join(kit, path), join(root, path));
  }
  for (const key of ["files", "deps"]) writeFileSync(join(root, `${key}.txt`), lists[key].join("\n") + (lists[key].length ? "\n" : ""));
  writeFileSync(join(root, "abaplint.json"), config);
  writeFileSync(join(root, "target.txt"), target + "\n");
  if (variant === "broken") writeFileSync(join(root, target), broken);
}
const sha = text => createHash("sha256").update(text).digest("hex");
writeFileSync(join(out, "corpus.json"), JSON.stringify({
  target, files: lists.files.length, deps: lists.deps.length,
  mutation: "insert step3_undefined = 1. before valid_id assignment",
  cleanSha256: sha(original), brokenSha256: sha(broken), configSha256: sha(config),
}, null, 2) + "\n");
console.log(`${out}: clean/broken, ${lists.files.length} files, ${lists.deps.length} dependencies, target ${target}`);
