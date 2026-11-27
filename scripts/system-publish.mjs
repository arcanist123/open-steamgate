#!/usr/bin/env node
import {publishChildEnv} from '../tools/osd-env.mjs';
import {layerEnvironment} from '../tools/osd-layer-env.mjs';
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {stageSystem} from './system-stage.mjs';
import {push, pushBlob, pushManifest, client, manifest, sha256, treeDigest, formatRef, parseRef} from '../tools/osd-oci.mjs';
import {runsAs} from '../tools/osd-main.mjs';
import {fullCommit} from '../tools/osd-release-git.mjs';
import {suggestedTag} from './release-version-source.mjs';
import {assertPrivateTarget, build, leakGate, prepareSystem, readLeakAllow} from '../tools/osd-layer.mjs';
import {assertPublicSystem} from '../tools/osd-system.mjs';

export const OMITTED = {
  lsd: 'Repository-only content requires leak exceptions unavailable to public layers; whole pack omitted.',
  zvdb: 'Repository-only vectors require leak exceptions unavailable to public layers; whole pack omitted.',
};
export function releaseTag(tag) {
  const prefix = typeof tag === 'string' && tag.startsWith('vscode-stable-v') ? 'vscode-stable-v' : 'vscode-v';
  const parts = typeof tag === 'string' && tag.startsWith(prefix) ? tag.slice(prefix.length).split('.') : [];
  if (parts.length !== 3 || parts.some(part => !part || [...part].some(c => !'0123456789'.includes(c)))) throw new Error('expected a release tag');
  return tag;
}
export function assertRelease(root, tag, expectedSha) {
  releaseTag(tag);
  const git = args => execFileSync('git', args, {env: publishChildEnv('git'), cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('release publication refuses a dirty checkout');
  if (git(['rev-parse', '--verify', '--end-of-options', `refs/tags/${tag}^{commit}`]) !== git(['rev-parse', 'HEAD'])) throw new Error('release tag must name HEAD');
  if (expectedSha !== undefined && (!fullCommit(expectedSha) || git(['rev-parse', 'HEAD']) !== expectedSha)) throw new Error('release HEAD differs from tested commit');
  const version = suggestedTag(root, true).slice('vscode-v'.length);
  if (tag.replace('vscode-stable-v', 'vscode-v') !== `vscode-v${version}`) throw new Error('release tag disagrees with stamped VSIX version');
  return git(['rev-parse', 'HEAD']);
}
// Refresh the actual tag, including annotated tags; a deleted tag fails closed.
export function assertTestedRelease(root, tag, sha) {
  releaseTag(tag);
  if (!fullCommit(sha)) throw new Error('tested commit SHA is required');
  execFileSync('git', ['fetch', '--force', '--no-tags', '--', 'origin', `refs/tags/${tag}:refs/tags/${tag}`],
    {env: publishChildEnv('git'), cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  return assertRelease(root, tag, sha);
}
export function publishPlan(root, temp, {tag, repository, sha}) {
  assertPublicSystem(root);
  const commit = sha === undefined ? assertRelease(root, tag) : assertTestedRelease(root, tag, sha);
  for (const key of Object.keys(layerEnvironment(root))) if (['OSD_PACKS', 'OSD_WEB_PACKS', 'OSD_LAYERS'].includes(key) || key.startsWith('OSD_LIB_')) throw new Error(`release refuses ${key}`);
  const staged = stageSystem(root, temp), omitted = [], layers = [];
  for (const layer of staged) {
    if (layer.kind === 'pack' && Object.hasOwn(OMITTED, layer.name)) {
      omitted.push({name: layer.name, reason: Object.entries(OMITTED).find(([name]) => name === layer.name).at(1)});
      continue;
    }
    const layerRepo = `${repository}/${layer.kind}-${layer.name.toLowerCase()}`;
    layers.push({...layer, target: `${layerRepo}:${tag}`, source: layer.source ?? `https://github.com/${repository.split('/').slice(1).join('/')}@${commit}:${layer.kind === 'pack' ? `packs/${layer.name}` : layer.name}`});
  }
  if (new Set(layers.map(layer => layer.target)).size !== layers.length) throw new Error('duplicate layer repository');
  return {tag, commit, layers, omitted, target: `${repository}/osd-system:${tag}`};
}
// Archive construction/validation is preparation too: finish it before the
// workflow installs the identifier file. Publication reads these bytes only.
export function preparePublication(root, temp, options) {
  const plan = publishPlan(root, temp, options);
  const annotations = {'org.opencontainers.image.source': `https://github.com/${options.repository.split('/').slice(1).join('/')}`};
  for (const [index, layer] of plan.layers.entries()) {
    const built = build(layer.folder, {...layer, annotations});
    const artifact = join(temp, 'artifacts', String(index));
    mkdirSync(artifact, {recursive: true});
    for (const [name, bytes] of [['payload.zip', built.zip], ['config.json', built.configBytes], ['manifest.json', built.manifestBytes]]) writeFileSync(join(artifact, name), bytes);
    writeFileSync(join(artifact, 'files.json'), JSON.stringify(built.files.map(file => file.path)));
    built.files.forEach((file, i) => writeFileSync(join(artifact, `file-${i}`), file.bytes));
    layer.artifact = artifact;
    layer.digest = built.digest;
  }
  return plan;
}
function readPrepared(layer) {
  const zip = readFileSync(join(layer.artifact, 'payload.zip'));
  const configBytes = readFileSync(join(layer.artifact, 'config.json'));
  const manifestBytes = readFileSync(join(layer.artifact, 'manifest.json'));
  const config = JSON.parse(configBytes), manifest = JSON.parse(manifestBytes);
  const files = JSON.parse(readFileSync(join(layer.artifact, 'files.json')))
    .map((path, i) => ({path, bytes: readFileSync(join(layer.artifact, `file-${i}`))}));
  if (sha256(manifestBytes) !== layer.digest || sha256(configBytes) !== manifest.config.digest
    || sha256(zip) !== manifest.layers[0].digest || treeDigest(files.map(file => [file.path, file.bytes])) !== config.treeDigest) {
    throw new Error('prepared publication bytes changed');
  }
  return {zip, configBytes, manifestBytes, config, manifest, files, digest: layer.digest};
}
export async function publishSystem(root, temp, options) {
  const plan = options.plan ?? preparePublication(root, temp, options), layers = [];
  if (plan.tag !== options.tag || plan.target !== `${options.repository}/osd-system:${options.tag}`
    || (options.sha !== undefined && plan.commit !== options.sha)) throw new Error('staged release plan differs from publication');
  assertRelease(root, plan.tag, plan.commit);
  const allow = options.allowFile ? readLeakAllow(resolve(root, options.allowFile)) : [];
  for (const entry of allow) {
    if (!plan.layers.some(layer => layer.name === entry.layer)) throw new Error('release allow entry must name an included layer');
  }
  for (const pack of plan.omitted) console.log(`OMITTED pack ${pack.name}: ${pack.reason}`);
  const prepared = plan.layers.map(layer => ({...layer, built: readPrepared(layer)}));
  for (const layer of prepared) assertPrivateTarget(layer.target, [layer.built]);
  for (const layer of prepared) leakGate([layer.built.files], {destination: layer.target, config: layer.built.config, manifest: layer.built.manifest},
    [layer.built.configBytes, layer.built.manifestBytes], allow.filter(e => e.layer === layer.name), [layer.name], layer.built.config.private === true);
  const annotations = {
    'org.opencontainers.image.source': `https://github.com/${options.repository.split('/').slice(1).join('/')}`,
    'org.osd.osg.commit': plan.commit,
    'org.osd.release.tag': plan.tag,
    'org.osd.release.omitted-packs': JSON.stringify(plan.omitted),
  };
  // This is the same system gate used by pushSystem, using the exact built bytes.
  const index = prepareSystem(plan.target, prepared.map(({built}) => ({files: built.files, layer: {config: built.config, configBytes: built.configBytes,
    manifest: {json: built.manifest, bytes: built.manifestBytes}}})), {root, annotations, allow, release: true});
  const indexBytes = Buffer.from(JSON.stringify(index));
  await assertPublicationTargets([...prepared.map(layer => ({target: layer.target, digest: layer.built.digest})),
    {target: plan.target, digest: sha256(indexBytes)}], options);
  // Refresh the remote tag after every gate, immediately before the first upload.
  assertTestedRelease(root, plan.tag, plan.commit);
  for (const layer of prepared) {
    const digest = await push(layer.target, layer.built);
    const ref = formatRef({...parseRef(layer.target), digest});
    layers.push({name: layer.name, kind: layer.kind, ref});
    console.log(ref);
  }
  // Reuse the exact gated bytes. No registry pull or archive unpacking here.
  const c = client(plan.target, {push: true});
  for (const {built} of prepared) {
    for (const bytes of [built.configBytes, built.zip]) await pushBlob(plan.target, bytes, {client: c});
    await pushManifest(formatRef({...parseRef(plan.target), digest: built.digest}), built.manifestBytes, {client: c});
  }
  const digest = await pushManifest(plan.target, indexBytes, {client: c});
  const ref = formatRef({...parseRef(plan.target), digest});
  console.log(ref);
  return {tag: plan.tag, commit: plan.commit, ref, layers, omitted: plan.omitted};
}
// Resolve every discovery tag before any write, hashing the returned bytes.
// Only absence is acceptable; authentication/transport errors fail closed.
export async function assertPublicationTargets(targets, {registryClient = client} = {}) {
  for (const {target, digest} of targets) {
    const c = registryClient(target, {push: true});
    let existing;
    try { existing = await manifest(target, {client: c, resolve: true}); }
    catch (error) { if (error.code === 'NOT_FOUND') continue; throw error; }
    if (existing.digest !== digest) throw new Error('release tag already holds a different digest');
  }
}
export function publicationText(report) {
  return `OCI system release ${report.tag}\n\n${report.ref}\n\nLayers (in order):\n${report.layers.map(layer => `${layer.kind} ${layer.name}: ${layer.ref}`).join('\n')}\n\nOmitted packs:\n${report.omitted.map(pack => `${pack.name}: ${pack.reason}`).join('\n') || 'None'}\n`;
}
if (runsAs('system-publish.mjs')) {
  const args = process.argv.slice(2);
  const preparing = args[0] === '--prepare';
  if (preparing) args.shift();
  const [tag, owner, output, ...flags] = args;
  const root = resolve(process.env.OSD_ROOT ?? process.cwd());
  const temp = mkdtempSync(join(tmpdir(), 'system-publish-'));
  try {
    const validFlags = preparing ? flags.length === 0 : flags.length === 4 && flags[0] === '--leak-allow' && flags[2] === '--plan';
    if (!validFlags || !owner || !output || [...owner].some(c => !'abcdefghijklmnopqrstuvwxyz0123456789-'.includes(c))) throw new Error('usage: system-publish.mjs <release-tag> <lowercase-owner> <report.json> --leak-allow <file> --plan <staged-plan.json>');
    const sha = process.env.TESTED_SHA;
    if (!sha) throw new Error('tested commit SHA is required');
    const repository = `ghcr.io/${owner}/open-steamgate`;
    if (preparing) {
      // Keep the stage for the next step; it runs before the secret is installed.
      const stage = mkdtempSync(join(tmpdir(), 'system-release-stage-'));
      const plan = preparePublication(root, stage, {tag, repository, sha});
      writeFileSync(output, JSON.stringify(plan));
    } else {
      const plan = JSON.parse(readFileSync(flags[3], 'utf8'));
      const report = await publishSystem(root, temp, {tag, repository, allowFile: flags[1], sha, plan});
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
      writeFileSync(`${output}.txt`, publicationText(report));
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, publicationText(report));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { rmSync(temp, {recursive: true, force: true}); }
}
