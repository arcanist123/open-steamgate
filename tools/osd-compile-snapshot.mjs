// Exact compiler input order, raw source digests and source-map locations.
// The bytes share the existing source-by-digest cache and provenance map.
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {basename, join, relative, resolve, sep} from "node:path";
import {writeSourceSnapshot} from "./osd-source-snapshot.mjs";

export function keepCompileInputs(root, generation, config, files, libs, overlay) {
  const shared = join(root, "build", "source-by-digest");
  mkdirSync(shared, {recursive: true});
  const copies = resolve(root, overlay?.folder ?? "build/inactive/active") + sep;
  const record = join(generation, "source-inputs.json");
  const inputs = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : {};
  const retain = file => {
    const digest = file.sourceDigest ?? createHash("sha256").update(file.contents).digest("hex");
    const actual = resolve(file.path);
    const logical = actual.startsWith(copies) ? resolve(root, actual.slice(copies.length)) : actual;
    let source = relative(root, logical).split(sep).join("/");
    if (source.startsWith("../")) source = `__external/${digest}/${basename(actual)}`;
    const target = join(shared, digest);
    if (!existsSync(target)) {
      // URL-cloned libraries have already had their temporary clone removed.
      const bytes = file.sourceBytes ?? readFileSync(actual);
      if (createHash("sha256").update(bytes).digest("hex") !== digest) {
        throw Object.assign(new Error(`source changed while retaining compiler input: ${source}`), {code: "INPUT_CHANGED"});
      }
      writeSourceSnapshot(target, bytes);
    }
    inputs[source] = digest;
    return {filename: file.filename, relative: file.relative, source, digest};
  };
  // The output location is already captured by each source-map relative path.
  // Keep the config independent of a build's scratch path and process ID, as
  // abap_transpile.json is, so two packages of identical inputs share a seed ID.
  const frozen = {version: 1, config: {...config, output_folder: "output"}, files: files.map(retain), libs: libs.map(retain)};
  writeFileSync(record, JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)))));
  writeFileSync(join(generation, "compile-inputs.json"), JSON.stringify(frozen));
}

export class MissingCompileInputs extends Error {}

export function readCompileInputs(root, generation) {
  const manifest = join(generation, "compile-inputs.json");
  const sourceInputs = join(generation, "source-inputs.json");
  if (!existsSync(manifest) || !existsSync(sourceInputs)) throw new MissingCompileInputs("missing frozen compiler input manifest");
  const frozen = JSON.parse(readFileSync(manifest, "utf8"));
  if (frozen.version !== 1) throw new Error(`unsupported frozen compiler input version ${frozen.version}`);
  const inputs = JSON.parse(readFileSync(sourceInputs, "utf8"));
  const read = file => {
    if (inputs[file.source] !== file.digest) throw new Error(`frozen source provenance differs: ${file.source}`);
    const shared = join(root, "build", "source-by-digest", file.digest);
    const local = join(generation, "source", file.source);
    const from = existsSync(shared) ? shared : local;
    if (!existsSync(from)) throw new MissingCompileInputs(`missing frozen source: ${file.source} (${file.digest})`);
    const bytes = readFileSync(from);
    if (createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new Error(`frozen source digest differs: ${file.source}`);
    return {...file, bytes};
  };
  const rapSource = "gen/rap/bindings.json";
  const rapBindings = inputs[rapSource] === undefined ? {} : JSON.parse(read({source: rapSource, digest: inputs[rapSource]}).bytes.toString("utf8"));
  return {config: frozen.config, files: frozen.files.map(read), libs: frozen.libs.map(read), rapBindings};
}
