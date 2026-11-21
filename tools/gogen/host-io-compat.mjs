// SPDX-License-Identifier: MIT
// Pure compatibility shapes for frontend.mjs, whose body is unchanged in this
// slice. Only UTF-8 reads and name/isDirectory are consumed; no Node object
// crosses host-io, and every typed host call keeps its declared arity.
import {basename, listDir, listEntries, readText} from "./host-io.ts";
import {SOURCE} from "../osd-source-identity-name.mjs";

// The sole frontend encoding argument is "utf8"; retain that JS call shape
// here rather than sending an extra argument across the typed extern boundary.
/** @param {string} file @param {string} _encoding @returns {string} */
export function readFileSync(file, _encoding) {
  return readText(file);
}

/** @param {string} file @returns {boolean} */
export const isSourceIdentity = (file) => basename(file) === SOURCE;
/** @param {string} dir @returns {import("./host-io.ts").DirectoryEntry[]} */
export function readdirEntries(dir) {
  return listEntries(dir).map(([name, directory]) => {
    /** @type {import("./host-io.ts").DirectoryEntry} */ const entry = {name, isDirectory: () => directory}; return entry;
  });
}
/** @param {string} dir @returns {string[]} */
export function readdirNames(dir) {
  return listDir(dir);
}

/** The gogen twin of tools/osd-inputs.mjs walkListed: every directory read
 *  over the layer list keeps the walk's own Dirent shape, and the read's own
 *  ENOENT reads as EMPTY -- a listed folder that is not on disk (H3 listed
 *  gen/hana-ddic before its first build wrote it, and a fresh clone runs the
 *  osgo host before any transpile). The rule is keyed on "listed", never on a
 *  folder name, and lives in this ONE helper: fix round 4 fixed
 *  tools/gogen/osg-build.mjs's own walk and left the compileProgram walk
 *  propagating, and gen/hana-segw -- the NEXT listed folder -- died the same
 *  death in the osgo-host job. Anything but the readdir's ENOENT (a missing
 *  source file, a permission error) still throws; the primitives underneath
 *  keep theirs, so only the walkers that ask for this rule get it. */
export function listListed(dir) {
  try {
    return readdirEntries(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return [];
  }
}
