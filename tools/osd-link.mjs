// Link one @abaplint package straight at our clone.
//
// Not `npm link`. That resolves through the global npm directory, which is a
// third place with its own idea of which checkout is current: open-steamgate
// linked the runtime that way and got a package from a different commit than
// the CLI beside it, 1889911 against 058df744, while both package.json files
// said 2.13.86. The version strings are identical, so nothing on the surface
// can tell the two apart, and the tree builds a mixture of two trees.
//
// A symlink at the path says what it points at and cannot drift. The target
// is $TRANSPILER, or ../transpiler beside this checkout.
//
//   node tools/osd-link.mjs runtime packages/runtime
import {existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync} from "node:fs";
import {dirname, isAbsolute, join, resolve} from "node:path";

const [name, where] = process.argv.slice(2);
if (name === undefined || where === undefined) {
  console.error("usage: node tools/osd-link.mjs <package> <path within the transpiler clone>");
  process.exit(2);
}

const clone = resolve(process.env.TRANSPILER ?? "../transpiler");
const target = join(clone, where);
if (existsSync(target) === false) {
  console.error(`no ${target}: set TRANSPILER to the transpiler clone`);
  process.exit(2);
}

const at = resolve("node_modules", "@abaplint", name);
mkdirSync(dirname(at), {recursive: true});
if (existsSync(at) || lstatSync(at, {throwIfNoEntry: false})) {
  rmSync(at, {recursive: true, force: true});
}
// "junction" is read on Windows only: a directory junction needs neither
// administrator rights nor developer mode; elsewhere the type is ignored
symlinkSync(realpathSync(target), at, "junction");
console.log(`@abaplint/${name} -> ${realpathSync(at)}`);

const {describeBuild} = await import("./osd-transpiler.mjs");
console.log(describeBuild());
