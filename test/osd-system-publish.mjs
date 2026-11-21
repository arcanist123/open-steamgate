import {expect} from 'chai';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {toolCommand, setHostedLeakScanner} from '../tools/osd-host.mjs';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registry, listening} from './helpers/oci-registry.mjs';
import {publishPlan, publishSystem, publicationText, assertRelease, assertTestedRelease, releaseTag, assertPublicationTargets, preparePublication} from '../scripts/system-publish.mjs';
import * as publicCheck from '../scripts/system-public-check.mjs';
const {checkPublic} = publicCheck;
import {runNode} from '../scripts/system-run-node.mjs';
import {verdict as waitVerdict} from '../tools/osd-ci-wait-tests.mjs';
import {build as buildRuntime} from '../tools/osd-build.mjs';
import {sha256} from '../tools/osd-oci.mjs';
import {stageSystem} from '../scripts/system-stage.mjs';
import {inspect, build} from '../tools/osd-layer.mjs';
import {manifest, pull} from '../tools/osd-oci.mjs';
import {fetchSystem} from '../tools/osd-system-fetch.mjs';
import {activeSystem} from '../tools/osd-system.mjs';
import {verifySystem} from '../tools/osd-system-verify.mjs';

const write = (path, value) => { mkdirSync(join(path, '..'), {recursive: true}); writeFileSync(path, value); };
describe('release system publication', function () {
  this.timeout(180000);
  let root, temp, oldList, oldSelf;
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: 'pipe'}).trim();
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'osd-publish-test-'));
    root = join(temp, 'root'); mkdirSync(root);
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    write(join(root, 'editors/vscode/package.json'), JSON.stringify({version: '1.2.0'}));
    write(join(root, '.gitignore'), '.local/\n');
    write(join(root, 'src/sample.abap'), '* fixture\n');
    write(join(root, 'test/test.abap'), '* test\n');
    write(join(root, 'data/seed.txt'), 'seed'); write(join(root, 'webapp/index.html'), 'page');
    for (const [order, name] of ['lsd', 'demo', 'zvdb'].entries()) {
      write(join(root, `packs/${name}/osd-pack.json`), JSON.stringify({name, order, abap: ['src']}));
      write(join(root, `packs/${name}/src/sample.abap`), '* pack\n');
    }
    const lib = join(root, '.local/lars/library'); mkdirSync(lib, {recursive: true});
    execFileSync('git', ['init', '-q'], {cwd: lib});
    write(join(lib, 'src/library.abap'), '* library\n');
    execFileSync('git', ['add', '.'], {cwd: lib});
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], {cwd: lib});
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: lib, encoding: 'utf8'}).trim();
    write(join(root, 'libs.lock.json'), JSON.stringify({transpiler: {repo: 'example/transpiler', ref}, libraries: [{folder: 'library', repo: 'example/library', ref}]}));
    git('add', '.'); git('commit', '-qm', 'fixture'); git('tag', 'vscode-v1.2.1'); git('tag', 'vscode-stable-v1.2.1');
    const origin = join(temp, 'origin.git');
    execFileSync('git', ['clone', '--bare', root, origin], {stdio: 'pipe'});
    git('remote', 'add', 'origin', origin);
    oldList = process.env.OSD_LEAK_IDENTIFIERS; oldSelf = process.env.OSD_SELF;
    write(join(temp, 'identifiers.json'), JSON.stringify({test: ['forbidden_publish_identifier']}));
    process.env.OSD_LEAK_IDENTIFIERS = join(temp, 'identifiers.json');
    process.env.OSD_SELF = JSON.stringify([process.execPath, join(process.cwd(), 'test/helpers/osd-layer-host.mjs')]);
  });
  afterEach(() => {
    setHostedLeakScanner(undefined);
    for (const [key, value] of [['OSD_LEAK_IDENTIFIERS', oldList], ['OSD_SELF', oldSelf]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(temp, {recursive: true, force: true});
  });
  it('shares complete staging and preserves resolved folders while removing fetch identities and sources', () => {
    const pack = join(root, 'packs/demo');
    write(join(pack, 'upstream/sample.abap'), '* resolved');
    write(join(pack, 'upstream/.osd-source.json'), '{}');
    write(join(pack, '.osd-fetched.json'), '{}');
    // Empty sources still exercises stripping without requiring any source network.
    write(join(pack, 'osd-pack.json'), JSON.stringify({name: 'demo', order: 1, abap: ['src', 'upstream'], sources: []}));
    const layers = stageSystem(root, join(temp, 'stage'));
    expect(layers.map(l => l.name)).to.deep.equal(['library', 'src', 'test', 'lsd', 'demo', 'zvdb']);
    const staged = layers.find(l => l.name === 'demo').folder;
    expect(JSON.parse(readFileSync(join(staged, 'osd-pack.json')))).not.to.have.property('sources');
    expect(existsSync(join(staged, 'upstream/.osd-source.json'))).to.equal(false);
    expect(existsSync(join(staged, '.osd-fetched.json'))).to.equal(false);
    expect(readFileSync(join(staged, 'upstream/sample.abap'), 'utf8')).to.equal('* resolved');
    const own = build(layers[1].folder, layers[1]);
    expect(own.files.map(f => f.path)).to.include.members(['src/sample.abap', 'data/seed.txt', 'webapp/index.html']);
  });
  it('refuses a private prepared layer at a public host spelling before release uploads', async () => {
    const repository = 'ghcr.io:443/example/open-steamgate', tag = 'vscode-v1.2.1';
    const plan = preparePublication(root, join(temp, 'private-prepared'), {tag, repository});
    const layer = plan.layers[0];
    const config = JSON.parse(readFileSync(join(layer.artifact, 'config.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(layer.artifact, 'manifest.json'), 'utf8'));
    config.private = true;
    const configBytes = Buffer.from(JSON.stringify(config));
    manifest.config = {...manifest.config, digest: sha256(configBytes), size: configBytes.length};
    manifest.annotations['org.osd.layer.private'] = 'true';
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(layer.artifact, 'config.json'), configBytes);
    writeFileSync(join(layer.artifact, 'manifest.json'), manifestBytes);
    layer.digest = sha256(manifestBytes);
    const old = process.env.OSD_PRIVATE_REGISTRIES;
    process.env.OSD_PRIVATE_REGISTRIES = 'GHCR.IO:443';
    try {
      let error;
      try { await publishSystem(root, join(temp, 'private-prepared'), {tag, repository, plan}); } catch (e) { error = e; }
      expect(error?.code).to.equal('PRIVATE_LAYER');
    } finally {
      if (old === undefined) delete process.env.OSD_PRIVATE_REGISTRIES;
      else process.env.OSD_PRIVATE_REGISTRIES = old;
    }
  });
  it('refuses an installed private system before staging a public release', () => {
    const identity = {order: 0, name: 'smoke', kind: 'input', private: true,
      digest: `sha256:${'1'.repeat(64)}`, treeDigest: `sha256:${'2'.repeat(64)}`, path: 'inputs/smoke'};
    write(join(root, '.local/system/.osd-system.json'), JSON.stringify({digest: `sha256:${'3'.repeat(64)}`, layers: [identity]}));
    write(join(root, '.local/system/inputs/smoke/.osd-layer.json'), JSON.stringify(identity));
    expect(() => publishPlan(root, join(temp, 'private-plan'), {tag: 'vscode-v1.2.1', repository: 'ghcr.io/example/open-steamgate'}))
      .to.throw(/private layer smoke/);
  });
  it('publishes ordered named layers through real gates to loopback, records omissions, installs and verifies', async () => {
    const r = registry(), host = await listening(r);
    try {
      const report = await publishSystem(root, join(temp, 'stage'), {tag: 'vscode-v1.2.1', repository: `${host}/example/open-steamgate`});
      expect(report.layers.map(l => [l.name, l.kind])).to.deep.equal([['library', 'lib'], ['src', 'input'], ['test', 'input'], ['demo', 'pack']]);
      expect(report.layers.map(l => l.ref.split('@')[0])).to.deep.equal(['lib-library', 'input-src', 'input-test', 'pack-demo'].map(name => `${host}/example/open-steamgate/${name}`));
      const index = await inspect(report.ref);
      const library = await pull(report.layers[0].ref);
      expect(library.manifest.json.annotations['org.opencontainers.image.source']).to.equal('https://github.com/example/open-steamgate');
      expect(library.config.source.repo).to.equal('https://github.com/example/library');
      expect((await manifest(`${host}/example/open-steamgate/input-src:vscode-v1.2.1`, {resolve: true})).digest).to.equal(report.layers[1].ref.split('@')[1]);
      expect(index.layers.map(l => l.name)).to.deep.equal(report.layers.map(l => l.name));
      expect(JSON.parse(index.annotations['org.osd.release.omitted-packs'])).to.deep.equal(report.omitted);
      expect(report.omitted.map(p => p.name)).to.deep.equal(['lsd', 'zvdb']);
      for (const pack of report.omitted) expect(publicationText(report)).to.include(`${pack.name}: ${pack.reason}`);
      const scratch = join(temp, 'scratch'); mkdirSync(scratch);
      await fetchSystem(scratch, report.ref);
      expect(verifySystem(scratch, activeSystem(scratch)).layers).to.equal(4);
      write(join(scratch, '.local/system/inputs/src/webapp/index.html'), 'tampered');
      expect(() => verifySystem(scratch, activeSystem(scratch))).to.throw('modified');
      const stable = publishPlan(root, join(temp, 'stable'), {tag: 'vscode-stable-v1.2.1', repository: `${host}/example/open-steamgate`});
      expect(stable.layers.every(l => l.target.endsWith(':vscode-stable-v1.2.1'))).to.equal(true);
      expect(stable.target).to.equal(`${host}/example/open-steamgate/osd-system:vscode-stable-v1.2.1`);
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('refuses conflicting layer and system discovery tags before any upload, with idempotent retries', async () => {
    const r = registry(), host = await listening(r);
    const options = {tag: 'vscode-v1.2.1', repository: `${host}/example/open-steamgate`};
    try {
      const first = await publishSystem(root, join(temp, 'first'), options);
      const second = await publishSystem(root, join(temp, 'second'), options);
      expect(second.ref).to.equal(first.ref);
      for (const ref of [first.layers[0].ref, first.ref]) {
        const target = ref.split('@')[0].slice(host.length + 1) + ':' + options.tag;
        const original = r.tags.get(target);
        const bytes = Buffer.from('{"conflicting":true}'), digest = sha256(bytes);
        r.manifests.set(`${ref.split('@')[0].slice(host.length + 1)}@${digest}`, bytes);
        r.tags.set(target, digest);
        const uploads = r.uploads;
        let failure;
        try { await publishSystem(root, join(temp, `conflict-${uploads}-${ref === first.ref}`), options); } catch (error) { failure = error; }
        expect(failure?.message).to.include('different digest');
        expect(r.uploads).to.equal(uploads);
        r.tags.set(target, original);
      }
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('refuses prepared-byte changes before scanning or writing to the registry', async () => {
    const r = registry(), host = await listening(r);
    const options = {tag: 'vscode-v1.2.1', repository: `${host}/example/open-steamgate`};
    try {
      for (const name of ['payload.zip', 'config.json', 'manifest.json', 'file-0']) {
        const plan = preparePublication(root, join(temp, `tampered-${name}`), options);
        writeFileSync(join(plan.layers[0].artifact, name), name.endsWith('.json') ? '{}' : 'changed');
        let failure;
        try { await publishSystem(root, join(temp, 'publish'), {...options, plan}); } catch (error) { failure = error; }
        expect(Boolean(failure)).to.equal(true);
        expect(r.requests).to.equal(0);
      }
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('checks existing tag digests using a fake registry client and propagates lookup failures', async () => {
    const bytes = Buffer.from('{"fixture":true}'), digest = sha256(bytes);
    for (const target of ['ghcr.io/example/lib-a:vscode-v1.2.1', 'ghcr.io/example/osd-system:vscode-v1.2.1']) {
      for (const mode of ['absent', 'same', 'different', 'unauthorized']) {
        let failure;
        const registryClient = () => ({ref: {tag: 'vscode-v1.2.1'}, get: async () => {
          if (mode === 'absent' || mode === 'unauthorized') throw Object.assign(new Error('lookup failure'), {code: mode === 'absent' ? 'NOT_FOUND' : 'UNAUTHORIZED'});
          return new Response(mode === 'same' ? bytes : '{"fixture":false}');
        }});
        try { await assertPublicationTargets([{target, digest}], {registryClient}); } catch (error) { failure = error; }
        expect(Boolean(failure)).to.equal(['different', 'unauthorized'].includes(mode));
      }
    }
  });
  it('passes scoped digest exceptions through both layer and system push gates', async () => {
    const value = 'forbidden_publish_identifier';
    const digest = createHash('sha256').update(value).digest('hex');
    const entries = [
      ['library', '.local/lars/library/src/library.abap', 'src/library.abap'],
      ['src', 'src/sample.abap', 'src/sample.abap'],
      ['test', 'test/test.abap', 'src/test.abap'],
      ['demo', 'packs/demo/src/sample.abap', 'src/sample.abap'],
    ];
    for (const [, file] of entries) write(join(root, file), value);
    const lib = join(root, '.local/lars/library');
    execFileSync('git', ['add', '.'], {cwd: lib});
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'public fixture'], {cwd: lib});
    const lock = JSON.parse(readFileSync(join(root, 'libs.lock.json')));
    lock.libraries[0].ref = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: lib, encoding: 'utf8'}).trim();
    write(join(root, 'libs.lock.json'), JSON.stringify(lock));
    const allowFile = '.leak-allow.release.json';
    const allow = entries.map(([layer, , file]) => ({layer, file, fileSha256: `sha256:${digest}`, category: 'identifier', count: 1, reason: 'Class B: synthetic gate fixture'}));
    write(join(root, allowFile), JSON.stringify({allow}));
    git('add', '.'); git('commit', '-qm', 'reviewed fixture'); git('tag', 'vscode-v1.2.2');
    git('push', 'origin', 'refs/tags/vscode-v1.2.2');
    const r = registry(), host = await listening(r);
    try {
      const options = {tag: 'vscode-v1.2.2', repository: `${host}/example/open-steamgate`, allowFile};
      const report = await publishSystem(root, join(temp, 'allowed'), options);
      expect(report.layers.length).to.equal(4);
      // The smoke/manual default has no release exceptions.
      let failure;
      try { await publishSystem(root, join(temp, 'no-allow'), {...options, allowFile: undefined}); } catch (e) { failure = e; }
      expect(failure?.message).to.include('publish refused');
      for (const bad of [{...allow[0], layer: 'omitted'}, {...allow[0], layer: undefined}, {...allow[0], value}]) {
        write(join(root, allowFile), JSON.stringify({allow: [bad]}));
        git('add', '.'); git('commit', '-qm', 'invalid fixture');
        const tag = `vscode-v1.2.${git('rev-list', '--count', 'HEAD')}`; git('tag', tag);
        failure = undefined;
        try { await publishSystem(root, join(temp, `bad-${tag}`), {...options, tag}); } catch (e) { failure = e; }
        expect(failure?.message).to.match(/release allow entry|unknown key|non-empty layer/);
      }
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('refuses a moved same-version sibling tag despite successful tests for the original commit', async () => {
    const base = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-qm', 'tested sibling');
    const tested = git('rev-parse', 'HEAD'), tag = 'vscode-v1.2.1';
    git('tag', '-f', tag);
    git('remote', 'remove', 'origin');
    const origin = join(temp, 'moved-origin.git');
    execFileSync('git', ['clone', '--bare', root, origin], {stdio: 'pipe'});
    git('remote', 'add', 'origin', origin);
    const sibling = git('commit-tree', 'HEAD^{tree}', '-p', base, '-m', 'untested sibling');
    execFileSync('git', ['--git-dir', origin, 'fetch', root, sibling], {stdio: 'pipe'});
    expect(waitVerdict({status: 'completed', conclusion: 'success', head_sha: tested})).to.equal('success');
    execFileSync('git', ['--git-dir', origin, 'tag', '-f', tag, sibling], {stdio: 'pipe'});
    const r = registry(), host = await listening(r);
    try {
      // Both the pinned checkout and an accidental checkout of the moved tag refuse.
      for (const checkout of [tested, sibling]) {
        git('checkout', '--detach', checkout);
        let failure;
        try { await publishSystem(root, join(temp, `moved-${checkout}`), {tag, sha: tested, repository: `${host}/example/open-steamgate`}); } catch (e) { failure = e; }
        expect(failure?.message).to.match(/HEAD|tested commit/);
      }
      expect(r.requests).to.equal(0);
      expect(r.uploads).to.equal(0);
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('refuses a prepared plan when the remote tag moves during scanning before any upload', async () => {
    const tested = git('rev-parse', 'HEAD'), tag = 'vscode-v1.2.1';
    git('remote', 'remove', 'origin');
    const origin = join(temp, 'moved-origin.git');
    execFileSync('git', ['clone', '--bare', root, origin], {stdio: 'pipe'});
    git('remote', 'add', 'origin', origin);
    const moved = git('commit-tree', 'HEAD^{tree}', '-p', tested, '-m', 'same stamp');
    execFileSync('git', ['--git-dir', origin, 'fetch', root, moved], {stdio: 'pipe'});
    expect(assertTestedRelease(root, tag, tested)).to.equal(tested);
    // The scanner still runs normally, while the fixture moves the remote tag during gating.
    const wrapper = join(temp, 'move-during-scan.mjs');
    write(wrapper, `import {execFileSync, spawnSync} from 'node:child_process';
      execFileSync('git', ${JSON.stringify(['--git-dir', origin, 'tag', '-f', tag, moved])}, {stdio: 'pipe'});
      const result = spawnSync(process.execPath, ${JSON.stringify([join(process.cwd(), 'test/helpers/osd-layer-host.mjs')])}.concat(process.argv.slice(2)), {stdio: 'inherit'});
      process.exit(result.status ?? 1);`);
    process.env.OSD_SELF = JSON.stringify([process.execPath, wrapper]);
    setHostedLeakScanner((cwd, paths) => {
      const [command, ...args] = toolCommand('tools/osd-leak-scan.mjs', ['--redact', '--publication-allow', '--paths', ...paths]);
      return spawnSync(command, args, {cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    });
    const r = registry(), host = await listening(r);
    try {
      const repository = `${host}/example/open-steamgate`;
      const plan = preparePublication(root, join(temp, 'prepared'), {tag, sha: tested, repository});
      let failure;
      try { await publishSystem(root, join(temp, 'late-move'), {tag, sha: tested, repository, plan}); } catch (error) { failure = error; }
      expect(failure?.message).to.equal('release tag must name HEAD');
      expect(git('rev-parse', `refs/tags/${tag}^{commit}`)).to.equal(moved);
      expect(r.uploads).to.equal(0);
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('public-check refuses a tag moved during upload while published bytes retain the tested SHA', async () => {
    const tested = git('rev-parse', 'HEAD'), tag = 'vscode-v1.2.1';
    git('remote', 'remove', 'origin');
    const origin = join(temp, 'moved-origin.git');
    execFileSync('git', ['clone', '--bare', root, origin], {stdio: 'pipe'});
    git('remote', 'add', 'origin', origin);
    const moved = git('commit-tree', 'HEAD^{tree}', '-p', tested, '-m', 'same stamp');
    execFileSync('git', ['--git-dir', origin, 'fetch', root, moved], {stdio: 'pipe'});
    const r = registry(), host = await listening(r);
    let tagMoved = false;
    r.server.on('request', req => {
      if (!tagMoved && req.method === 'PUT') {
        execFileSync('git', ['--git-dir', origin, 'tag', '-f', tag, moved], {stdio: 'pipe'});
        tagMoved = true;
      }
    });
    try {
      const report = await publishSystem(root, join(temp, 'mid-upload'), {tag, sha: tested, repository: `${host}/example/open-steamgate`});
      expect(tagMoved).to.equal(true);
      expect(r.uploads).to.be.greaterThan(0);
      expect(report.commit).to.equal(tested);
      expect((await inspect(report.ref)).annotations['org.osd.osg.commit']).to.equal(tested);
      expect(git('rev-parse', 'HEAD')).to.equal(tested);
      // This is the assertion invoked by the public-check job after publication.
      expect(() => assertTestedRelease(root, tag, tested)).to.throw('HEAD');
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('refuses dirty trees, non-release refs, missing tags and tags not naming HEAD', () => {
    expect(() => assertRelease(root, 'main')).to.throw('release tag');
    expect(() => assertRelease(root, 'vscode-vmissing')).to.throw();
    write(join(root, 'untracked'), 'dirty');
    expect(() => assertRelease(root, 'vscode-v1.2.1')).to.throw('dirty');
    git('add', '.'); git('commit', '-qm', 'next');
    expect(() => assertRelease(root, 'vscode-v1.2.1')).to.throw('HEAD');
  });
  it('rejects arbitrary suffixes and numeric tags that disagree with the VS Code stamp', () => {
    expect(() => releaseTag('vscode-vscratch')).to.throw();
    git('tag', 'vscode-v1.2.999');
    expect(() => assertRelease(root, 'vscode-v1.2.999')).to.throw('stamped VSIX version');
  });
  it('gates system metadata before uploading any earlier layers', async () => {
    // Only the system target contains this category hit.
    write(join(temp, 'identifiers.json'), JSON.stringify({test: ['osd-system']}));
    const r = registry(), host = await listening(r);
    try {
      let error;
      try { await publishSystem(root, join(temp, 'stage'), {tag: 'vscode-v1.2.1', repository: `${host}/example/open-steamgate`}); } catch (e) { error = e; }
      expect(Boolean(error)).to.equal(true);
      expect(r.uploads).to.equal(0);
      expect(r.requests).to.equal(0);
    } finally { await new Promise(done => r.server.close(done)); }
  });
  it('builds and executes generated initialization, refusing a missing setup hook', async () => {
    for (const missing of [false, true]) {
      const scratch = join(temp, `init-${missing}`);
      let installed = false, built = false, failure;
      try {
        await publicCheck.verifyPublishedSystem({ref: 'pinned-fixture'}, scratch, {
          verify: () => expect(installed).to.equal(true),
          run: async (at, args) => {
            if (args.includes('--system')) {
              expect(args.at(-1)).to.equal('pinned-fixture');
              installed = true;
              expect(readFileSync(join(at, 'test/setup.mjs'), 'utf8')).to.equal(readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8'));
              write(join(at, 'abap_transpile.json'), JSON.stringify({input_folder: ['src'], output_folder: 'output', options: {setup: {filename: '../test/setup.mjs', preFunction: 'setup'}}}));
              write(join(at, 'src/zcl_boot.clas.abap'), 'CLASS zcl_boot DEFINITION PUBLIC. ENDCLASS. CLASS zcl_boot IMPLEMENTATION. ENDCLASS.');
              // A minimal database hook for this real transpiler fixture.
              write(join(at, 'test/setup.mjs'), `export async function setup() { abap.context.databaseConnections.DEFAULT = {select: async () => ({rows: [{smoke: 1}]}), disconnect: async () => {}}; }`);
            } else if (args[0].endsWith('/osd-build.mjs')) {
              await buildRuntime({root: at, generators: false});
              built = true;
              if (missing) rmSync(join(at, 'test/setup.mjs'));
            } else {
              await runNode(at, args);
            }
          },
        });
      } catch (e) { failure = e; }
      expect(built).to.equal(true);
      expect(Boolean(failure)).to.equal(missing);
    }
  });
  it('checks each GHCR repository and system digest using only anonymous pull tokens', async () => {
    const bytes = Buffer.from('{"fixture":true}'), digest = sha256(bytes);
    const report = {layers: [{ref: `ghcr.io/example/open-steamgate/input-src@${digest}`}], ref: `ghcr.io/example/open-steamgate/osd-system@${digest}`};
    const calls = [];
    await checkPublic(report, async (url, options) => {
      calls.push({url: new URL(url), options});
      return new Response(new URL(url).pathname === '/token' ? JSON.stringify({token: 'anonymous-fixture'}) : bytes);
    });
    expect(calls.length).to.equal(4);
    for (const call of [calls[0], calls[2]]) {
      expect(call.options.headers).to.equal(undefined);
      expect(call.url.searchParams.get('scope')).to.include(':pull');
    }
    expect(calls[2].url.searchParams.get('scope')).to.equal('repository:example/open-steamgate/osd-system:pull');
    expect(calls[3].url.pathname).to.equal(`/v2/example/open-steamgate/osd-system/manifests/${digest}`);
    for (const failure of ['private', 'tampered']) {
      let error;
      try {
        await checkPublic(report, async url => new URL(url).pathname === '/token'
          ? new Response(JSON.stringify({token: 'anonymous-fixture'}))
          : new Response('bad', {status: failure === 'private' ? 403 : 200}));
      } catch (e) { error = e; }
      expect(error?.message).to.include('not anonymously readable');
    }
  });
  it('fails closed on an additional leaking pack instead of silently leaving it out', async () => {
    write(join(root, 'packs/demo/src/sample.abap'), 'forbidden_publish_identifier');
    git('add', '.'); git('commit', '-qm', 'leak fixture'); git('tag', 'vscode-v1.2.2');
    git('push', 'origin', 'refs/tags/vscode-v1.2.2');
    const r = registry(), host = await listening(r);
    try {
      let failure;
      try { await publishSystem(root, join(temp, 'stage'), {tag: 'vscode-v1.2.2', repository: `${host}/example/open-steamgate`}); } catch (e) { failure = e; }
      expect(failure?.message).to.include('publish refused');
      expect(r.uploads).to.equal(0);
      expect(r.requests).to.equal(0);
    } finally { await new Promise(done => r.server.close(done)); }
  });
});
