// A folder kept as bytes and put back exactly. A test that runs through
// code writing under build/ (a Save leaves its object's active copy and its
// name in build/inactive/) takes a snapshot before and restores it after,
// so the next file in the same checkout starts from the state this one
// found. Both halves are synchronous, so a restore can also run from
// undoOnExit on an interrupted run.
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, relative} from "node:path";

// The folder as bytes per relative path, or null when it does not exist.
export const snapshotTree = (root) => {
  if (!existsSync(root)) return null;
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path); else files.set(relative(root, path), readFileSync(path));
    }
  };
  walk(root);
  return files;
};

// Replaces the folder with what snapshotTree saw; null removes it.
export const restoreTree = (root, files) => {
  rmSync(root, {recursive: true, force: true});
  if (files === null) return;
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), bytes);
  }
};
