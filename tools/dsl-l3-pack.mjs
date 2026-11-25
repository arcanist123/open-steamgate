#!/usr/bin/env node
// Derive a flat, admitted deploy unit from the compiler outputs, never a hand list.
import {existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import yaml from 'js-yaml';
import {compileSet, renderSet} from './dsl-l3.mjs';
import {renderCockpit} from './dsl-l3-cockpit.mjs';
import {compileRule, renderRule} from './dsl-l2.mjs';
import {DEFAULT_DDIC} from './dsl-ddic.mjs';
import {admit, objectOf, refusalMessage, refuseTmp} from './osd-deploy-manifest.mjs';
import {layout, zipInProcess} from './osd-abapgit-zip.mjs';

const receiptName = '.dsl-pack.json';
const sidecar = (f) => /\.trace(?:\.meta)?\.json$/.test(f);
const ddicFile = (f) => /\.(tabl|dtel|doma|ttyp|view)\.xml$/.test(f)
  && basename(f) === basename(f).toLowerCase() && /<abapGit\b/.test(readFileSync(f, 'utf8'));
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
function checkStage(stage) {
  refuseTmp(resolve(process.env.OSD_ROOT ?? process.cwd()), stage);
  if (!existsSync(stage)) return [];
  const names = readdirSync(stage);
  if (!names.length) return [];
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(stage, receiptName), 'utf8')); } catch { /* refuse below */ }
  if (receipt?.version !== 1 || receipt?.tool !== 'dsl-l3-pack' || !Array.isArray(receipt.files)
    || receipt.files.some((f) => typeof f !== 'string' || basename(f) !== f || f === receiptName)
    || names.some((f) => f !== receiptName && (!receipt.files.includes(f) || !statSync(join(stage, f)).isFile()))) {
    throw new Error(`${stage}: stage is not empty and has no valid pack receipt (or contains unowned files)`);
  }
  return names.filter((f) => f !== receiptName);
}

/** Plan in memory: --list writes no stage, zip, manifest or receipt (the DSL engine it renders
 *  through boots the built runtime like `dsl-l3 build` does; tools/dsl-engine.mjs). */
export async function collectSet(file, {ddic = [], include = [], withDdic = false} = {}) {
  const options = {ddic: [...DEFAULT_DDIC, ...ddic]};
  const doc = yaml.load(readFileSync(file, 'utf8'), {schema: yaml.FAILSAFE_SCHEMA});
  const entries = doc.stages ? doc.stages.flatMap((s) => s.rules) : doc.rules;
  const files = new Map();
  const groups = Object.fromEntries(['generated', 'rules', 'runtime DDIC', 'referenced-not-shipped', 'included'].map((g) => [g, new Set()]));
  function add(name, content, group) {
    if (basename(name) !== name) throw new Error(`cannot flatten ${name}`);
    if (files.has(name) && files.get(name) !== content) throw new Error(`conflicting file ${name}`);
    files.set(name, content);
    const obj = objectOf(name);
    if (!sidecar(name) && obj?.key) groups[group].add(obj.key);
  }
  // L3 checks rule hashes beside the YAML. Verify the complete committed output
  // against a fresh render before accepting those files (including disabled rules).
  for (const entry of entries) {
    const rule = resolve(dirname(file), entry.rule);
    const rendered = await renderRule(compileRule(rule, {...options, out: dirname(rule)}));
    for (const [name, content] of Object.entries(rendered.files)) {
      const source = join(dirname(rule), name);
      // Navigation metadata is optional, as in checkRule.
      if (name.endsWith('.trace.meta.json') && !existsSync(source)) { add(name, content, 'rules'); continue; }
      if (!existsSync(source) || readFileSync(source, 'utf8') !== content) {
        throw new Error(`${source}: differs from a fresh L2 build; rebuild the rule with dsl-l2.mjs build`);
      }
      add(name, readFileSync(source, 'utf8'), 'rules');
    }
  }
  const model = compileSet(file, options);
  const rendered = await renderSet(model);
  // The cockpit service and BSP apps are a separate deployment slice. Derive
  // their filenames from their renderer, rather than maintaining object names.
  const cockpitFiles = new Set(model.cockpit ? Object.keys(await renderCockpit(model)) : []);
  for (const [name, content] of Object.entries(rendered.files)) {
    if (!cockpitFiles.has(name)) add(name, content, 'generated');
  }

  for (const pattern of include) {
    const matches = [...globSync(pattern)].sort();
    if (!matches.length) throw new Error(`--include matched no files: ${pattern}`);
    for (const hit of matches) {
      refuseTmp(resolve(process.env.OSD_ROOT ?? process.cwd()), resolve(hit));
      for (const source of statSync(hit).isDirectory() ? walk(hit) : [hit]) {
        refuseTmp(resolve(process.env.OSD_ROOT ?? process.cwd()), resolve(source));
        const name = basename(source);
        // An include of one abapGit file selects its whole object and sidecars.
        const obj = objectOf(name);
        const siblings = obj?.key ? readdirSync(dirname(source)).filter((n) => objectOf(n)?.key === obj.key) : [name];
        for (const n of siblings) add(n, readFileSync(join(dirname(source), n), 'utf8'), 'included');
      }
    }
  }
  // A named hand-written adapter is part of the set even though the renderer
  // does not write it. Resolve it by the compiler's own search order.
  for (const variant of model.ports.flatMap((p) => p.variants).filter((v) => v.hand)) {
    const name = `${variant.class}.clas.abap`;
    const source = [...walk(dirname(file)), ...walk('src')].find((p) => basename(p).toLowerCase() === name);
    if (!source) throw new Error(`missing port adapter ${name}`);
    for (const sibling of readdirSync(dirname(source)).filter((n) => objectOf(n)?.key === `CLAS ${variant.class.toUpperCase()}`)) {
      add(sibling, readFileSync(join(dirname(source), sibling), 'utf8'), 'included');
    }
  }
  const index = new Map();
  const explicit = new Set(ddic.flatMap((d) => walk(d).filter(ddicFile)).map((p) => resolve(p)));
  for (const source of [...walk('src').filter(ddicFile), ...explicit]) {
    const obj = objectOf(basename(source));
    if (!/^[YZ]/.test(obj.name) && !explicit.has(resolve(source))) continue;
    // Different DDIC types may legitimately share a name (a data element and
    // its domain). Keep both; explicit folders overlay by object identity.
    if (!index.has(obj.name)) index.set(obj.name, new Map());
    index.get(obj.name).set(obj.key, {...obj, source});
  }
  const seen = new Set();
  const pending = [...files].filter(([n]) => !sidecar(n)).map(([, text]) => text);
  while (pending.length) {
    const text = pending.shift();
    const tokens = new Set(text.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? []);
    for (const obj of [...tokens].flatMap((token) => [...(index.get(token)?.values() ?? [])])) {
      if (seen.has(obj.key)) continue;
      seen.add(obj.key);
      const name = basename(obj.source);
      if (files.has(name)) continue;
      const content = readFileSync(obj.source, 'utf8');
      const runtime = resolve(obj.source).startsWith(resolve('src/dsl') + '/');
      if (runtime || withDdic && explicit.has(resolve(obj.source))) {
        add(name, content, runtime ? 'runtime DDIC' : 'included');
      } else groups['referenced-not-shipped'].add(obj.key);
      // Also report dependent domain types, even when their table is not shipped.
      pending.push(content);
    }
  }
  const objectFiles = [...files.keys()].filter((n) => !sidecar(n) && !objectOf(n)?.structural).sort();
  const objects = [...new Set(objectFiles.map((n) => objectOf(n)?.key).filter(Boolean))].sort();
  const unit = {name: model.set, sources: [], objects};
  const refused = admit({files: objectFiles, read: (n) => files.get(n), unit});
  if (refused.length) throw new Error(refusalMessage(file, refused));
  return {model, files, objectFiles, unit, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v].sort()]))};
}

export async function packSet(file, {out, stage, list = false, description, ...options} = {}) {
  if (!list && !out) throw new Error('--out <file.zip> is required');
  // Validate ownership before expensive compilation; list does not even inspect stage.
  if (stage && !list) checkStage(resolve(stage));
  const plan = await collectSet(file, options);
  if (list) return plan;
  stage = resolve(stage ?? join('.local/stage', plan.model.set));
  const old = checkStage(stage);
  out = resolve(out);
  if (out === stage || out.startsWith(stage + '/')) throw new Error('--out must be outside the stage directory');
  const scratch = mkdtempSync(join(tmpdir(), 'dsl-pack-'));
  try {
    const input = join(scratch, 'objects');
    mkdirSync(input);
    for (const name of plan.objectFiles) writeFileSync(join(input, name), plan.files.get(name));
    layout(input, join(scratch, 'repo'), description ?? `DSL L3: ${plan.model.set}`, undefined, plan.unit);
    const bytes = zipInProcess(join(scratch, 'repo'));
    mkdirSync(stage, {recursive: true});
    for (const name of old) rmSync(join(stage, name));
    for (const [name, content] of plan.files) writeFileSync(join(stage, name), content);
    writeFileSync(join(stage, receiptName), JSON.stringify({version: 1, tool: 'dsl-l3-pack', set: plan.model.set, files: [...plan.files.keys()].sort()}, null, 2) + '\n');
    mkdirSync(dirname(out), {recursive: true});
    writeFileSync(out, bytes);
    const {name, ...unit} = plan.unit;
    unit.sources = [stage];
    writeFileSync(`${out}.unit.json`, JSON.stringify({version: 1, units: {[name]: unit}}, null, 2) + '\n');
    return {...plan, stage, out, bytes: bytes.length};
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}

export async function main(args) {
  const [file, ...rest] = args;
  if (!file || file.startsWith('-')) throw new Error('usage: dsl-l3-pack.mjs <set.l3.yaml> --out <file.zip> [--stage <dir>] [--ddic <folder>]... [--with-ddic] [--include <file or glob>]... [--description "..."] [--list]');
  const options = {ddic: [], include: []};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--list') options.list = true;
    else if (flag === '--with-ddic') options.withDdic = true;
    else if (['--out', '--stage', '--ddic', '--include', '--description'].includes(flag)) {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      const key = flag.slice(2);
      if (Array.isArray(options[key])) options[key].push(value); else options[key] = value;
    } else throw new Error(`unknown argument ${flag}`);
  }
  const result = await packSet(file, options);
  for (const [group, objects] of Object.entries(result.groups)) console.log(`${group}:\n${objects.map((o) => `  ${o}`).join('\n')}`);
  if (!options.list) console.log(`${result.out}: ${result.unit.objects.length} objects, ${result.objectFiles.length + 2} zip files, ${result.bytes} bytes; stage ${result.stage}; manifest ${result.out}.unit.json`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
