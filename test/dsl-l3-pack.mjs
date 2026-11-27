import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packSet, collectSet, main} from '../tools/dsl-l3-pack.mjs';
import {compileSet, renderSet} from '../tools/dsl-l3.mjs';
import {renderCockpit} from '../tools/dsl-l3-cockpit.mjs';
import {objectOf, loadManifest, unitFor, admit} from '../tools/osd-deploy-manifest.mjs';
import {layout, zipInProcess} from '../tools/osd-abapgit-zip.mjs';

const fleet = 'src/l2demo/fleet.l3.yaml';
const keys = (files) => [...new Set(files.filter((f) => !/\.trace(?:\.meta)?\.json$/.test(f)).map((f) => objectOf(f)?.key).filter(Boolean))].sort();
describe('DSL L3 pack', function () {
  this.timeout(600000);
  let scratch, first, second, fleet2, oldPacks;
  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'dsl-l3-pack-test-'));
    // The renderer needs only the template engine, not optional demo pack seeds.
    oldPacks = process.env.OSD_WEB_PACKS;
    process.env.OSD_WEB_PACKS = '';
    first = await packSet(fleet, {out: join(scratch, 'first.zip'), stage: join(scratch, 'stage')});
    second = await packSet(fleet, {out: join(scratch, 'second.zip'), stage: join(scratch, 'stage2')});
    fleet2 = await collectSet('src/l2demo/fleet2.l3.yaml');
  });
  after(() => {
    if (oldPacks === undefined) delete process.env.OSD_WEB_PACKS; else process.env.OSD_WEB_PACKS = oldPacks;
    rmSync(scratch, {recursive: true, force: true});
  });
  it('derives the unit from actual generated outputs, rules and runtime DDIC for both fleet sets', async () => {
    for (const [file, plan] of [[fleet, first], ['src/l2demo/fleet2.l3.yaml', fleet2]]) {
      const model = compileSet(file);
      const generated = await renderSet(model);
      const cockpit = new Set(model.cockpit ? Object.keys(await renderCockpit(model)) : []);
      assert.deepEqual(plan.groups.generated, keys(Object.keys(generated.files).filter((f) => !cockpit.has(f))));
      assert.deepEqual(plan.unit.objects, [...new Set([...plan.groups.generated, ...plan.groups.rules, ...plan.groups['runtime DDIC'], ...plan.groups.included])].sort());
      for (const rule of [...plan.model.rules, ...plan.model.disabled]) assert(plan.unit.objects.includes(`CLAS ${rule.check_class.toUpperCase()}`));
      assert(plan.unit.objects.includes(`PROG ${plan.model.report.toUpperCase()}`));
      const runtime = [...plan.files.values()].join('\n').toUpperCase().match(/\bZOSD_L3_[A-Z0-9_]+\b/g) ?? [];
      for (const name of new Set(runtime)) {
        if (existsSync(`src/dsl/${name.toLowerCase()}.tabl.xml`)) assert(plan.unit.objects.includes(`TABL ${name}`), name);
      }
    }
  });
  it('picks up the opted-in proof as a generated class with its test include', async () => {
    const plan = await collectSet('src/l2demo/proof_demo.l3.yaml');
    assert(plan.groups.generated.includes('CLAS ZCL_L3_PROOF_DEMO_PROOF'));
    assert(plan.files.has('zcl_l3_proof_demo_proof.clas.testclasses.abap'));
  });
  it('reports no missing set-related objects from the manual l3demo unit', () => {
    assert(fleet2.groups.included.includes('CLAS ZCL_L3_FLEET2_AUTOCLOSE'));
    const hand = loadManifest().units.l3demo.objects;
    const derived = new Set([...first.unit.objects, ...fleet2.unit.objects]);
    // Explicitly outside the slice: cockpit objects, domain DDIC, seed and proof.
    const relevant = hand.filter((k) => !/^(?:(?:TABL|DTEL) ZOSD_L2_|IWPR |IWSV |IWMO |WAPA |SICF |CLAS ZCL_ZL3C_)/.test(k))
      .filter((k) => !/_(?:SEED|PROOF)$/.test(k));
    const missing = relevant.filter((k) => !derived.has(k));
    console.log(`    manual l3demo set-related objects missing: ${missing.length ? missing.join(', ') : 'none'}`);
    assert.deepEqual(missing, []);
  });
  it('writes identical zip bytes across different stage paths', () => {
    assert.deepEqual(readFileSync(first.out), readFileSync(second.out));
  });
  it('ships exactly the unit plus repository metadata, with complete classes and no sidecars', () => {
    const names = execFileSync('unzip', ['-Z1', first.out], {encoding: 'utf8'}).trim().split('\n');
    assert.deepEqual(names, ['.abapgit.xml', ...first.objectFiles.map((f) => `src/${f}`), 'src/package.devc.xml'].sort());
    assert(!names.some((n) => /trace|dsl-pack/.test(n)));
    for (const key of first.unit.objects.filter((k) => k.startsWith('CLAS '))) {
      for (const ext of ['abap', 'xml']) assert(names.includes(`src/${key.slice(5).toLowerCase()}.clas.${ext}`));
    }
    assert.deepEqual(keys(names.filter((n) => n !== 'src/package.devc.xml').map((n) => n.replace(/^src\//, ''))), first.unit.objects);
    assert(readdirSync(first.stage).some((f) => f.endsWith('.trace.json')));
  });
  it('writes a manifest accepted by the proof tool manifest loader and stages a reusable repository', () => {
    const unit = unitFor(loadManifest(`${first.out}.unit.json`), first.stage, first.model.set);
    assert.deepEqual(unit.objects, first.unit.objects);
    const folder = join(scratch, 'proof-layout');
    layout(first.stage, folder, 'DSL L3: fleet', undefined, unit);
    assert.deepEqual(zipInProcess(folder), readFileSync(first.out));
    assert.deepEqual(admit({files: first.objectFiles, read: (f) => first.files.get(f), unit}), []);
  });
  it('ships referenced demo DDIC only with both explicit folder and --with-ddic', async () => {
    const metadata = await collectSet(fleet, {ddic: ['src/l2demo']});
    const enabled = await collectSet(fleet, {ddic: ['src/l2demo'], withDdic: true});
    assert(metadata.groups['referenced-not-shipped'].includes('TABL ZOSD_L2_SHIP'));
    assert(!metadata.unit.objects.includes('TABL ZOSD_L2_SHIP'));
    assert(!first.unit.objects.includes('TABL ZOSD_L2_SHIP'));
    for (const key of ['TABL ZOSD_L2_SHIP', 'TABL ZOSD_L2_CARGO', 'DTEL ZOSD_L2_WEIGHT']) assert(enabled.unit.objects.includes(key), key);
    assert(!enabled.groups['referenced-not-shipped'].includes('TABL ZOSD_L2_SHIP'));
  });
  it('collects a domain and data element sharing a name without conflating object types', async () => {
    const ddic = join(scratch, 'ddic'); mkdirSync(ddic);
    writeFileSync(join(ddic, 'zosd_l2_weight.doma.xml'), '<abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DD01V><DOMNAME>ZOSD_L2_WEIGHT</DOMNAME><DATATYPE>DEC</DATATYPE><LENG>000015</LENG><DECIMALS>000002</DECIMALS></DD01V></asx:values></asx:abap></abapGit>');
    const plan = await collectSet(fleet, {ddic: ['src/l2demo', ddic], withDdic: true});
    assert(plan.unit.objects.includes('DTEL ZOSD_L2_WEIGHT'));
    assert(plan.unit.objects.includes('DOMA ZOSD_L2_WEIGHT'));
  });
  it('includes an entire proof object from a single file or glob', async () => {
    for (const include of [['src/l3proof/zcl_l3_fleet_proof.clas.abap'], ['src/l3proof/zcl_l3_fleet_proof.clas.*']]) {
      const plan = await collectSet(fleet, {include});
      assert(plan.groups.included.includes('CLAS ZCL_L3_FLEET_PROOF'));
      assert(plan.files.has('zcl_l3_fleet_proof.clas.xml'));
    }
  });
  it('refuses an SAP-owned included object with the existing manifest message', async () => {
    const dir = join(scratch, 'sap'); mkdirSync(dir);
    writeFileSync(join(dir, 'cl_osd_pack.clas.abap'), 'CLASS cl_osd_pack DEFINITION PUBLIC. ENDCLASS. CLASS cl_osd_pack IMPLEMENTATION. ENDCLASS.');
    writeFileSync(join(dir, 'cl_osd_pack.clas.xml'), '<VSEOCLASS><CLSNAME>CL_OSD_PACK</CLSNAME></VSEOCLASS>');
    const out = join(scratch, 'refused.zip');
    await assert.rejects(packSet(fleet, {out, stage: join(scratch, 'refused-stage'), include: [dir]}), /CL_\/IF_\/CX_ is SAP's public API/);
    assert(!existsSync(out)); assert(!existsSync(join(scratch, 'refused-stage')));
  });
  it('refuses unowned stages and preserves their contents', async () => {
    const stage = join(scratch, 'unowned'); mkdirSync(stage); writeFileSync(join(stage, 'keep'), 'keep');
    await assert.rejects(packSet(fleet, {out: join(scratch, 'bad.zip'), stage}), /stage is not empty/);
    assert.equal(readFileSync(join(stage, 'keep'), 'utf8'), 'keep');
    writeFileSync(join(first.stage, 'keep'), 'keep');
    await assert.rejects(packSet(fleet, {out: first.out, stage: first.stage}), /unowned files/);
    rmSync(join(first.stage, 'keep'));
  });
  it('reuses a receipt and removes obsolete generated files', async () => {
    const receiptFile = join(second.stage, '.dsl-pack.json');
    const receipt = JSON.parse(readFileSync(receiptFile));
    receipt.files.push('zosd_old.tabl.xml');
    writeFileSync(receiptFile, JSON.stringify(receipt)); writeFileSync(join(second.stage, 'zosd_old.tabl.xml'), 'obsolete');
    await packSet(fleet, {out: second.out, stage: second.stage});
    assert(!existsSync(join(second.stage, 'zosd_old.tabl.xml')));
    assert.deepEqual(readFileSync(first.out), readFileSync(second.out));
  });
  it('--list prints all groups and writes no stage, zip, manifest or receipt', async () => {
    const before = readdirSync(scratch).sort();
    const output = []; const log = console.log;
    try {
      console.log = (...args) => output.push(args.join(' '));
      await main([fleet, '--list', '--out', join(scratch, 'list.zip'), '--stage', join(scratch, 'list-stage')]);
    } finally { console.log = log; }
    assert.deepEqual(readdirSync(scratch).sort(), before);
    for (const group of Object.keys(first.groups)) assert(output.some((s) => s.startsWith(`${group}:`)));
    assert(!existsSync(join(scratch, 'list.zip.unit.json')));
  });
});
