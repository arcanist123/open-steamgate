// A fresh registry over one generation's frozen inputs. No live tree reads.
import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import {layout} from "./osd-build.mjs";
import {selectedModules, outputFiles, isBinaryFilename} from "./osd-transpile.mjs";
import {generationIdentity} from "./osd-warm-verification.mjs";
import {pinVerification} from "./osd-verify-pin.mjs";
import {readCompileInputs, MissingCompileInputs} from "./osd-compile-snapshot.mjs";
import {compareGenerations} from "./osd-generation-diff.mjs";
import {assertToolchain} from "./osd-transpiler.mjs";
import {mapStatementStarts} from "./osd-source-map-starts.mjs";
import {lowerDerived} from "./rap/lower-derived.mjs";
import {lowerNarrowSubmit} from "./osd-narrow-submit.mjs";
import {orderRegistry} from "./osd-warm-order.mjs";

export async function verifyGeneration(hash, root = resolve(process.env.OSD_ROOT ?? process.cwd())) {
  const paths = layout(root), generation = join(paths.byInput, hash);
  const tmp = join(paths.tmp, `${hash}.${process.pid}.verify`);
  const started = Date.now();
  let unpin;
  try {
    unpin = await pinVerification(root, hash, basename(tmp));
    const identity = generationIdentity(generation);
    const {config, files, libs, rapBindings} = readCompileInputs(root, generation);
    const loaded = selectedModules(root);
    assertToolchain(root, loaded);
    if (JSON.parse(readFileSync(join(generation, "manifest.json"), "utf8")).toolchain !== loaded.identity) {
      throw new Error("the frozen generation's transpiler/runtime identity differs from the verifier");
    }
    const {Transpiler, Chunk, core, plugin} = loaded;
    if (config.write_source_map === true) mapStatementStarts(Chunk);
    const sources = files.map(f => ({...f, contents: lowerDerived(lowerNarrowSubmit(f.bytes.toString(isBinaryFilename(f.filename) ? "latin1" : "utf8"), f.filename, core), f.filename, rapBindings)}));
    const reg = new core.Registry();
    for (const f of sources) reg.addFile(new core.MemoryFile(f.filename, f.contents));
    const libraries = libs.map(f => ({...f, contents: f.bytes.toString(isBinaryFilename(f.filename) ? "latin1" : "utf8")}));
    for (const f of libraries) reg.addDependency(new core.MemoryFile(f.filename, f.contents));
    orderRegistry(reg, core, sources, libraries);
    const settings = {...config.options};
    if (config.write_source_map !== true) settings.ignoreSourceMap = true;
    const output = await new Transpiler(settings, plugin).run(reg);
    mkdirSync(join(tmp, "output"), {recursive: true});
    for (const f of outputFiles(output, config, join(tmp, "output"), sources)) {
      writeFileSync(f.path, f.contents, isBinaryFilename(f.path) ? {encoding: "latin1"} : undefined);
    }
    if (generationIdentity(generation) !== identity) return {verdict: "superseded", why: "generation replaced during verification"};
    const v = compareGenerations(join(generation, "output"), join(tmp, "output"));
    if (v.missing || v.files === 0) return {verdict: "inconclusive", why: v.missing
      ? `missing output under verification: ${v.missing}` : "zero output files compared under verification"};
    if (generationIdentity(generation) !== identity) return {verdict: "superseded", why: "generation replaced during comparison"};
    const differing = [...v.differing, ...v.onlyInA, ...v.onlyInB];
    return {verdict: differing.length ? "differs" : "same", files: v.files, differing: differing.slice(0, 20), count: differing.length, ms: Date.now() - started};
  } catch (error) {
    if (error instanceof MissingCompileInputs) return {verdict: "inconclusive", why: error.message};
    throw error;
  } finally {
    rmSync(tmp, {recursive: true, force: true});
    unpin?.();
  }
}
