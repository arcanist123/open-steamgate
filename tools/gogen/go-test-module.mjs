import {cpSync, mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join, relative, sep} from "node:path";

const source = join(import.meta.dirname, "go");

export function copyGoTestModule(destination) {
  // Ignore old test scratch directories before cpSync can descend into them.
  cpSync(source, destination, {recursive: true, filter: (path) => {
    const parts = relative(source, path).split(sep);
    // nor the osgo build's generated packages (osgo-layers.mjs), which no test imports
    return !parts.includes(".out") && !(parts[0] === "generated" && parts[1] === "osgo") && !(parts[0] === "cmd" && parts.length === 2 && /-[A-Za-z0-9]{6}$/.test(parts[1]));
  }});
}

export function createGoTestDir(prefix) {
  const goRoot = mkdtempSync(join(tmpdir(), prefix));
  try {
    copyGoTestModule(goRoot);
    const dir = join(goRoot, "cmd", basename(goRoot));
    mkdirSync(dir, {recursive: true});
    return {dir, goRoot};
  } catch (error) {
    rmSync(goRoot, {recursive: true, force: true});
    throw error;
  }
}
