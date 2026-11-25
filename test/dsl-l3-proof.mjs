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
function unit(filename, {foreign = []} = {}) {
  const script = `
    import assert from 'node:assert/strict';
    import {initializeABAP} from './output/init.mjs';
    import {harnessEntries, runAll} from './tools/osd-unit-all.mjs';
    import {readFileSync} from 'node:fs';
    import {pathToFileURL} from 'node:url';
    import {resolve} from 'node:path';
    await initializeABAP();
    const client = abap.context.databaseConnections.DEFAULT;
    const foreign = ${JSON.stringify(foreign)};
    for (const row of foreign) await client.execute(row.insert);
    const before = await Promise.all(foreign.map(row => client.select({select: row.select})));
    const skips = [];
    const skip = abap.Classes.CL_ABAP_UNIT_ASSERT.skip;
    abap.Classes.CL_ABAP_UNIT_ASSERT.skip = async args => {
      skips.push(args.msg.get());
      return skip(args);
    };
    const entries = harnessEntries(readFileSync('output/index.mjs', 'utf8'))
      .filter(e => e.objectName.toUpperCase() === '${PROOF.toUpperCase()}');
    if (entries.length !== 1) throw new Error('proof missing from CI inventory');
    ${filename ? `entries[0].filename = ${JSON.stringify(resolve(filename))};` : ''}
    const result = await runAll(entries, f => import(pathToFileURL(resolve('output', f)).href));
    if (foreign.length) {
      assert.equal(skips.length, entries[0].methods.length, 'the whole class must skip');
      for (const msg of skips) {
        assert.match(msg, /proof needs empty .*; found [0-9]+ foreign rows -- run it in a sandbox package\\/client/);
        assert(msg.includes('found ' + foreign.length + ' foreign rows'));
        for (const row of foreign) assert(msg.toLowerCase().includes(row.table));
      }
      const after = await Promise.all(foreign.map(row => client.select({select: row.select})));
      assert.deepEqual(after, before, 'foreign rows must survive unchanged');
      console.log('foreign rows preserved: ' + foreign.length + '; skipped: ' + skips.length);
    } else {
      assert.equal(skips.length, 1, 'only the unsupported rule should skip');
      for (const table of ['zosd_l2_ship', 'zosd_l2_note', 'zosd_l2_crew', 'zosd_l3_alert', 'zosd_l3_pile', 'zosd_l3_run']) {
        const rows = await client.select({select: 'SELECT * FROM ' + table});
        assert.equal(rows.rows.length, 0, table + ': proof left owned rows behind');
      }
    }
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
    for (const name of ['setup', 'class_setup', 'clean_runs']) {
      const proof = compileProof('generated', {...model, rules: [{...model.rules[0], name}]},
        [{...all[0], compiled: {...compiled, rule: name}}], options);
      assert.notEqual(proof.rules[0].method, name, 'rule must not become a lifecycle hook or cleanup helper');
    }
    const keyless = {...compiled, ddic: Object.fromEntries(Object.entries(compiled.ddic).map(([table, type]) => [table, {...type, keys: []}]))};
    const proof = compileProof('generated', {...model, rules: [model.rules[0]]}, [{...all[0], compiled: keyless}], options);
    assert.match(proof.rules[0].skip, /no non-client DDIC key for cleanup/);
    assert.deepEqual(proof.fixtures, []);
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

  it('passes abaplint punctuation and declaration-order rules on the rendered proof class', () => {
    const {core} = modulesOf(process.cwd());
    const config = new core.Config(JSON.stringify({
      syntax: {version: 'open-abap'},
      rules: {parser_error: true, line_only_punc: true, definitions_top: true},
    }));
    const lint = source => {
      const reg = new core.Registry(config);
      reg.addFile(new core.MemoryFile(`${PROOF}.clas.abap`, rendered.files[`${PROOF}.clas.abap`]));
      reg.addFile(new core.MemoryFile(`${PROOF}.clas.testclasses.abap`, source));
      return reg.findIssues().map(issue => issue.getKey());
    };
    const source = rendered.files[`${PROOF}.clas.testclasses.abap`];
    assert.deepEqual(lint(source), []);
    // Both mutations must be detected, so a parser/rule no-op cannot pass.
    const punc = source.replace('    clean( ).', '    clean( )\n      .');
    assert.notEqual(punc, source);
    assert(lint(punc).includes('line_only_punc'));
    const lateData = source.replace('    DATA lv_exp TYPE string.', '    CLEAR lt_exp.\n    DATA lv_exp TYPE string.');
    assert.notEqual(lateData, source);
    assert(lint(lateData).includes('definitions_top'));
  });

  it('scopes every rendered DELETE to the full fixture key or an owned run id', () => {
    const source = rendered.files[`${PROOF}.clas.testclasses.abap`].replace(/^\s*["*].*$/gm, '');
    const deletes = [...source.matchAll(/\bDELETE\s+FROM\s+(\w+)\b([^.]*)\./gi)];
    assert.equal(deletes.length, model.proof.fixtures.length + 3);
    for (const [, table, clause] of deletes) {
      assert.match(clause, /\bWHERE\b/i, table);
      const fixture = model.proof.fixtures.find(t => t.table === table);
      if (fixture) {
        for (const {column} of fixture.keys) assert.match(clause, new RegExp(`\\b${column} = ${fixture.wa}-${column}\\b`), table);
      } else {
        assert.match(clause, /\brun_id = lv_run\b/);
        assert.match(clause, /\bset_name = 'proof_demo'/);
      }
    }
    assert.match(source, /LOOP AT mt_runs INTO lv_run/);
    assert.equal((source.match(/APPEND ls_result-run_id TO mt_runs/g) ?? []).length, 3);
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

  it('skips the whole generated class for foreign source or set state and preserves every row', () => {
    const rows = [
      {table: 'zosd_l2_ship', insert: "INSERT INTO zosd_l2_ship (mandt, ship_id, name, status) VALUES ('123', 'S001', 'Foreign ship', 'M')"},
      {table: 'zosd_l2_note', insert: "INSERT INTO zosd_l2_note (mandt, ship_id, note, status) VALUES ('123', 'S001', 'Foreign note', 'A')"},
      {table: 'zosd_l2_crew', insert: "INSERT INTO zosd_l2_crew (mandt, crew_id, ship_id, role) VALUES ('123', 'C00001', 'S001', 'C')"},
      {table: 'zosd_l3_alert', insert: "INSERT INTO zosd_l3_alert (mandt, set_name, model_hash, check_date, pile_no, alert_seq, run_id, alert_text) VALUES ('123', 'proof_demo', 'foreign', '20261001', 1, 1, 'foreign-run', 'Foreign alert')"},
      {table: 'zosd_l3_pile', insert: "INSERT INTO zosd_l3_pile (mandt, run_id, rule_name, pile_no, set_name) VALUES ('123', 'foreign-run', 'foreign-rule', 1, 'proof_demo')"},
      {table: 'zosd_l3_run', insert: "INSERT INTO zosd_l3_run (mandt, set_name, check_date, run_id, status) VALUES ('123', 'proof_demo', '20261001', 'foreign-run', 'RELEASED')"},
    ].map(row => ({...row, select: `SELECT * FROM ${row.table}`}));
    // Independent cases prove neither a source nor a set-state check masks
    // another. The final case is the source + alert regression from review.
    for (const foreign of [...rows.map(row => [row]), [rows[0], rows[3]]]) {
      const result = unit(undefined, {foreign});
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`foreign rows preserved: ${foreign.length}; skipped: 4`));
    }
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
