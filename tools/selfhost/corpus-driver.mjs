// Run from the checkout root; stdout is exactly the unformatted generated Go.
// The whole-osgo variant of the step-4 driver: the same compileProgram +
// emitGo path, with the options compileOsg and writeGo use (tolerant, no
// test classes, package main, no layers, no unit build). corpus-run.mjs
// installs it as .local/step4/step4-driver.mjs; abapiti's selfhost-step4.py
// rewrites only its three host lines (fs import, inputs path, stdout).
import {readFileSync} from 'node:fs';
import {compileProgram} from '../../tools/gogen/frontend.mjs';
import {emitGo} from '../../tools/gogen/emit-go.mjs';
import {symbolCollector} from '../../tools/gogen/symbols.ts';
const inputs = JSON.parse(readFileSync(new URL('./step4-inputs.json', import.meta.url), 'utf8'));
/** @type {Set<string>} */ const skippedPaths = new Set(inputs.skippedPaths);
const program = /** @type {import('../../tools/gogen/ir.ts').Program} */ (/** @type {unknown} */ (compileProgram({
  folders: inputs.folders,
  objects: inputs.objects,
  tolerant: true,
  includeTests: false,
  skip: path => skippedPaths.has(path),
})));
process.stdout.write(emitGo(program, 'main', null, false, symbolCollector(program, 'main', new Map())));
