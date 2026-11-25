import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileSet, renderSet, SetError} from '../tools/dsl-l3.mjs';
import {compileRule} from '../tools/dsl-l2.mjs';
import {compileProof} from '../tools/dsl-l3-proof.mjs';
import {expandLines, readTraceFile} from '../tools/dsl-trace.mjs';
import {modulesOf} from '../tools/osd-transpile.mjs';
const DEMO = 'src/l2demo/proof_demo.l3.yaml';
const OUT = 'src/l2demo';
const PROOF = 'zcl_l3_proof_demo_proof';
const CORE = '.local/lars/open-abap-core/src';
const read = file => readFileSync(file, 'utf8');

// The same inventory and lifecycle driver used by npm run unit / CI.
function unit(filename) {
  const script = `
    import {initializeABAP} from './output/init.mjs';
    import {harnessEntries, runAll} from './tools/osd-unit-all.mjs';
    import {readFileSync} from 'node:fs';
    import {pathToFileURL} from 'node:url';
    import {resolve} from 'node:path';
    await initializeABAP();
    const entries = harnessEntries(readFileSync('output/index.mjs', 'utf8'))
      .filter(e => e.objectName.toUpperCase() === '${PROOF.toUpperCase()}');
    if (entries.length !== 1) throw new Error('proof missing from CI inventory');
    ${filename ? `entries[0].filename = ${JSON.stringify(resolve(filename))};` : ''}
    const result = await runAll(entries, f => import(pathToFileURL(resolve('output', f)).href));
    console.log('generated proof unit: ' + result.ran + ' methods, ' + result.failed.length + ' failed');
    process.exit(result.failed.length ? 1 : 0);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script],
    {encoding: 'utf8', env: {...process.env, OSD_WEB_PACKS: ''}, maxBuffer: 5e6});
}

describe('DSL L3 generated proof', function () {
  this.timeout(600000);
  let scratch, model, rendered;
  before(async () => {
    mkdirSync('.local', {recursive: true});
    scratch = mkdtempSync(resolve('.local/dsl-proof-test-'));
    model = compileSet(DEMO);
    rendered = await renderSet(model);
  });
  after(() => rmSync(scratch, {recursive: true, force: true}));

  it('derives one method per enabled rule, unions examples by date and keeps rule hashes', () => {
    assert.equal(model.proof.class, PROOF);
    assert.deepEqual(model.proof.rules.map(r => r.name), model.rules.map(r => r.name));
    const [piled, note, captains, skipped] = model.proof.rules;
    assert.deepEqual(piled.dates.map(d => d.date), ['20261001', '20261002']);
    assert.equal(piled.dates[0].tables[0].rows.length, 2);
    assert.deepEqual(captains.dates[0].expect.map(e => e.value), ['S002 Tern: 0 captains', 'S003 Heron: 1 captains']);
    assert(note.dates[0].expect[0].value.length > 200);
    assert.match(skipped.skip, /source ports do not read zosd_l2_voy/);
    const source = rendered.files[`${PROOF}.clas.testclasses.abap`];
    for (const rule of model.rules) assert(source.includes(`c_hash_${rule.index}`) || model.proof.rules.find(r => r.name === rule.name).skip);
    assert(source.includes('cl_abap_unit_assert=>skip'));
    assert(source.includes('a=dummy'));
    assert(source.includes('a=capture'));
  });

  it('supports a named proof and refuses malformed or colliding proof values at the set line', () => {
    const compiled = compileRule('src/l2demo/proof_ship.l2.yaml');
    const all = [{enabled: true, compiled, at: 7, recorded: compiled.source}];
    const fail = (line, message) => { throw new SetError(DEMO, line, message); };
    const options = {line: () => 5, fail};
    assert.equal(compileProof({class: 'ZCL_L3_NAMED_PROOF'}, {...model, rules: [model.rules[0]]}, all, options).class, 'zcl_l3_named_proof');
    for (const value of ['no', true, null, [], {}, {class: 1}, {class: 'cl_bad'}, {class: 'z'.repeat(31)}, {class: 'zok', extra: 'x'}, {class: model.class}]) {
      assert.throws(() => compileProof(value, model, all, options), /proof_demo.l3.yaml:5: proof/);
    }
    const manifest = join(scratch, 'bad.l3.yaml');
    writeFileSync(manifest, read(DEMO).replace('proof: generated', 'proof: nope').replaceAll('rule: ', `rule: ${resolve(OUT)}/`));
    assert.throws(() => compileSet(manifest), /bad.l3.yaml:5: proof is generated/);
  });

  it('keeps fleet, fleet2 and fleet3 byte-identical to their committed outputs', async () => {
    for (const set of ['fleet', 'fleet2', 'fleet3']) {
      const m = compileSet(`${OUT}/${set}.l3.yaml`);
      assert.equal(m.proof, undefined);
      const fresh = await renderSet(m);
      for (const [name, text] of Object.entries(fresh.files)) {
        if (name.endsWith('.trace.meta.json')) continue; // optional navigation, intentionally ignored by git
        assert.equal(text, read(join(OUT, name)), `${set}: ${name}`);
      }
    }
  });

  it('commits a fresh demo with ABAP Unit flag, ASCII and no ABAP line over 255 characters', () => {
    for (const [name, text] of Object.entries(rendered.files)) {
      assert.equal(text, read(join(OUT, name)), name);
      if (!name.endsWith('.abap')) continue;
      assert(!/[^\x00-\x7f]/.test(text), name);
      assert(Math.max(...text.split('\n').map(l => l.length)) <= 255, name);
    }
    assert.match(rendered.files[`${PROOF}.clas.xml`], /<WITH_UNIT_TESTS>X<\/WITH_UNIT_TESTS>/);
  });

  it('traces set entries, example rows and expected text back to their YAML lines and records skips', () => {
    const trace = readTraceFile(`${OUT}/${PROOF}.clas.testclasses.trace.json`);
    assert.equal(trace.format, 'osd-trace/1');
    const sources = trace.outputs.flatMap(o => expandLines(o.lines).flatMap(l => l.sources));
    for (const rule of model.proof.rules.filter(r => !r.skip)) {
      assert(trace.lines.some(l => l.set_line === rule.set_line && l.sources.some(s => s.file === DEMO)));
      for (const date of rule.dates) for (const exp of date.expect) {
        assert(trace.lines.some(l => l.rule_file === rule.rule_file && l.rule_line === exp.rule_line));
      }
    }
    for (const rule of model.proof.rules) for (const origin of rule.example_origins) {
      assert(sources.some(s => s.file === origin.file && s.node === origin.node && s.selector === '/'));
    }
    assert.deepEqual(trace.examples.map(e => [e.file, e.line]).sort(), model.proof.rules.flatMap(r => r.example_origins.map(e => [e.file, e.line])).sort());
    assert.equal(trace.skips.length, 1);
    assert.match(trace.skips[0].reason, /source ports do not read/);
  });

  it('runs the generated ABAP Unit through the CI driver, including piles, long literals and both dates', () => {
    const result = unit();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /generated proof unit: 4 methods, 0 failed/);
    console.log('    ' + result.stdout.match(/generated proof unit:.*/)[0] + ' (one explicit SKIP)');
  });

  it('turns red when one generated example expectation is broken, then passes the original again', async () => {
    // Mutate only the expected text in an ABAP copy, compile it and run the same CI entry.
    const mutant = 'zcl_l3_proof_demo_bad';
    const {Transpiler, core} = modulesOf(process.cwd());
    const reg = new core.Registry();
    for (const suffix of ['abap', 'xml', 'testclasses.abap']) {
      let text = rendered.files[`${PROOF}.clas.${suffix}`].replaceAll(PROOF, mutant).replaceAll(PROOF.toUpperCase(), mutant.toUpperCase());
      if (suffix === 'testclasses.abap') {
        assert(text.includes('lv_exp = `S001: maintenance`.'));
        text = text.replace('lv_exp = `S001: maintenance`.', 'lv_exp = `BROKEN example expectation`.');
      }
      reg.addFile(new core.MemoryFile(`${mutant}.clas.${suffix}`, text));
    }
    const walk = dir => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
    const deps = [...walk(CORE).filter(f => /\.(tabl|ttyp|dtel|doma)\.xml$/.test(f)),
      ...['uuid', 'exceptions', '.'].flatMap(d => readdirSync(join(CORE, d))
        .filter(f => f.endsWith('.clas.abap')).map(f => join(CORE, d, f))),
      join(CORE, 'unit/cl_abap_unit_assert.clas.abap'),
      ...walk('src/dsl').filter(f => /\.(tabl|ttyp|dtel|doma)\.xml$/.test(f)),
      ...walk(OUT).filter(f => /\.(tabl|dtel)\.xml$/.test(f)
        || /(?:zcl_l3_proof_demo|zif_l3_proof_demo|zcx_l3_proof_demo|zcl_l2_proof_ship)[a-z_]*\.(?:clas|intf)\.abap$/.test(f)),
      'src/jobs/tbtcjob.tabl.xml'];
    for (const file of deps) reg.addDependency(new core.MemoryFile(basename(file), read(file)));
    const config = JSON.parse(read('abap_transpile.json'));
    const output = await new Transpiler({...config.options, unknownTypes: 'runtimeError', ignoreSourceMap: true, skip: []}).run(reg);
    for (const object of output.objects) {
      const code = object.chunk.getCode().replace(/import\("\.\/([^"]+)"\)/g, (_, file) =>
        `import(${JSON.stringify(pathToFileURL(resolve(file.startsWith(mutant) ? scratch : 'output', file)).href)})`);
      writeFileSync(join(scratch, object.filename), code);
    }
    const bad = unit(join(scratch, `${mutant}.clas.testclasses.mjs`));
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /generated proof unit: 4 methods, 1 failed/);
    assert.match(bad.stdout, /BROKEN example expectation/);
    console.log('    broken example: 4 methods, 1 failed; original restored');
    const good = unit();
    assert.equal(good.status, 0, good.stdout + good.stderr);
  });
});
