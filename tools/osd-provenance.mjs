import {createHash} from "node:crypto";
import {existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, writeFileSync} from "node:fs";
import {basename, dirname, isAbsolute, join, relative, resolve} from "node:path";

const sidecar = path => lstatSync(path).isDirectory() ? join(path, ".osd-provenance.json") : `${path}.osd-provenance.json`;
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };

function filesOf(dir) {
  const files = {};
  const walk = (base, prefix = "") => {
    for (const entry of readdirSync(base, {withFileTypes: true}).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      if (!prefix && entry.name === ".osd-provenance.json") continue;
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(base, entry.name);
      if (entry.isDirectory()) walk(path, entryPath);
      else if (entry.isFile()) files[entryPath] = hash(path);
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        const actual = relative(dir, resolve(dirname(path), target));
        if (isAbsolute(actual) || actual === ".." || actual.startsWith("../"))
          fail("BAD_PROVENANCE", `artifact link escapes its directory: ${entryPath}`);
        if (existsSync(path)) {
          const final = relative(realpathSync(dir), realpathSync(path));
          if (isAbsolute(final) || final === ".." || final.startsWith("../"))
            fail("BAD_PROVENANCE", `artifact link escapes its directory: ${entryPath}`);
        }
        files[entryPath] = {link: target, sha256: createHash("sha256").update(target).digest("hex")};
      }
      else fail("BAD_PROVENANCE", `unsupported artifact entry: ${entryPath}`);
    }
  };
  walk(dir);
  return files;
}

// The live generation's own record, as written: no claim about the working
// tree. Publishing edges take provenance from tools/osd-public-tree.mjs,
// which ties this record to the bytes the tree holds now. This module stays
// free of repository imports: docker/Dockerfile verifies with it alone.
export function liveGenerationRecord(root) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, "build/live/manifest.json"), "utf8")); }
  catch { fail("BAD_PROVENANCE", "live generation manifest is missing or invalid"); }
  if (typeof manifest.systemPrivate !== "boolean" || !Array.isArray(manifest.provenance)
      || manifest.provenance.some(input => typeof input.private !== "boolean"))
    fail("BAD_PROVENANCE", "generation has no complete input privacy record");
  return {generation: manifest.hash, systemDigest: manifest.systemDigest, systemPrivate: manifest.systemPrivate,
    inputs: manifest.provenance};
}

export function writeArtefactProvenance(path, source) {
  if (source === undefined) fail("BAD_PROVENANCE", "artifact provenance needs a checked source (tools/osd-public-tree.mjs publicProvenance)");
  path = resolve(path);
  if (!existsSync(path)) fail("BAD_PROVENANCE", `artifact is missing: ${path}`);
  const directory = lstatSync(path).isDirectory();
  const {generation, systemDigest, systemPrivate, inputs} = source;
  const record = {schema: 1, artefact: basename(path), ...(directory ? {files: filesOf(path)} : {sha256: hash(path)}),
    generation, systemDigest, systemPrivate, inputs};
  writeFileSync(sidecar(path), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function verifyPublicArtefact(path) {
  path = resolve(path);
  if (!existsSync(path)) fail("BAD_PROVENANCE", `artifact is missing: ${path}`);
  let record;
  try { record = JSON.parse(readFileSync(sidecar(path), "utf8")); }
  catch { fail("BAD_PROVENANCE", `missing or invalid provenance for ${path}`); }
  if (record.schema !== 1 || record.artefact !== basename(path) || typeof record.generation !== "string"
      || !Array.isArray(record.inputs) || record.inputs.some(input => typeof input.private !== "boolean")
      || typeof record.systemPrivate !== "boolean") fail("BAD_PROVENANCE", `incomplete provenance for ${path}`);
  if (record.systemPrivate || record.inputs.some(input => input.private)) fail("PRIVATE_LAYER", `private artifact cannot be published: ${path}`);
  const actual = lstatSync(path).isDirectory() ? {files: filesOf(path)} : {sha256: hash(path)};
  if (JSON.stringify(actual.files ?? actual.sha256) !== JSON.stringify(record.files ?? record.sha256))
    fail("BAD_PROVENANCE", `artifact bytes differ from provenance: ${path}`);
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [operation, path] = process.argv.slice(2);
  try {
    // Writing needs the tree check (osd-build), which this module must not
    // import: the Dockerfile verifies with this file alone, and importing it
    // from here would be a cycle (osd-public-tree imports this module).
    if (operation === "write") fail("BAD_PROVENANCE", "write with node tools/osd-public-tree.mjs write <artifact>");
    else if (operation === "verify" && path) verifyPublicArtefact(path);
    else fail("BAD_PROVENANCE", "usage: osd-provenance.mjs verify <artifact>");
  } catch (error) {
    console.error(`${error.code ?? "BAD_PROVENANCE"}: ${error.message}`);
    process.exitCode = 2;
  }
}
