import {expect} from 'chai';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync} from 'node:fs';
import {join, basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {convertTrace, convertFiles, serializeJson, serializeTrace, readTrace, expandLines, readTraceFile} from '../tools/dsl-trace.mjs';
import {renderWithEngine} from '../tools/dsl-build.mjs';
import {buildRule, checkRule, compileRule, modelHash, renderModel, renderRule} from '../tools/dsl-l2.mjs';
import {compileSet, renderSet, ruleVersion} from '../tools/dsl-l3.mjs';
import {renderDaemonModel} from '../tools/dsl-samc.mjs';
import {renderReport} from '../tools/dsl-report.mjs';
import {renderProject as renderMpc} from '../tools/dsl-mpc.mjs';
import {renderProject as renderDpc} from '../tools/dsl-dpc.mjs';
import {ObjectStore} from '../tools/osd-store.mjs';

const source = {file:'example.l2.yaml',node:'rule/example',selector:'/class'};
const location = {recipe:'recipes/l2-check/template.tpl',anchor:'<partial>',offset:0};
const line = (n, offset=n-1) => ({line:n,sources:[source],locations:[{...location,offset}]});
const sample = {format:'osd-trace/1',outputs:[{file:'zcl_example.clas.abap',lines:[line(1),line(2),line(3)]}]};

// Compare the writer's raw bytes, without a reader/normalizer that could drop
// volatile fields. Validate inside each stability assertion even when a leaked
// position happens to have the same value in both renders.
function stableBytes(actual, expected, label='stable trace') {
  for (const text of [actual,expected]) {
    const trace=JSON.parse(text);
    expect(Object.keys(trace),label).deep.equal(['format','outputs']);
    for (const output of trace.outputs) {
      expect(Object.keys(output),label).deep.equal(['file','lines']);
      for (const row of output.lines) {
        expect(Object.keys(row),label).deep.equal([row.lines ? 'lines' : 'line','sources','locations']);
        for (const source of row.sources) expect(Object.keys(source),label).deep.equal(['file','node','selector']);
        for (const location of row.locations) expect(Object.keys(location),label).deep.equal(['recipe','anchor','offset']);
      }
    }
  }
  expect(actual,label).equal(expected);
}

describe('trace v1 contract and phase 0.7 stability', function () {
  this.timeout(900000);
  let scratch;
  before(() => {scratch=mkdtempSync(join(tmpdir(),'trace-v1-'));});
  after(() => rmSync(scratch,{recursive:true,force:true}));

  it('keeps the existing demo model hash recorded in its committed trace sidecar', () => {
    const model=compileRule('src/l2demo/maintenance_ship.l2.yaml');
    const meta=JSON.parse(readFileSync(`src/l2demo/${model.class}.clas.trace.meta.json`,'utf8'));
    expect(modelHash(renderModel(model))).equal(meta.model);
  });

  it('serializes maximal ranges, expands offsets, and uses fixed key order and decimal integers', () => {
    const text=serializeTrace(sample), parsed=JSON.parse(text);
    expect(parsed.outputs[0].lines).deep.equal([{lines:[1,3],sources:[source],locations:[location]}]);
    expect(expandLines(parsed.outputs[0].lines)).deep.equal(sample.outputs[0].lines);
    expect(text).include('          "lines": [1, 3],\n');
    expect(text).include('      "lines": [\n        {\n');
    expect(text).include('            {"recipe": "recipes/l2-check/template.tpl", "anchor": "<partial>", "offset": 0}\n');
    expect(serializeTrace({outputs:[{file:'a',lines:[line(1,Number.MAX_SAFE_INTEGER)]}]})).include('"offset": 9007199254740991');
    expect(Object.keys(parsed.outputs[0].lines[0])).deep.equal(['lines','sources','locations']);
    expect(serializeTrace({...sample,outputs:[{...sample.outputs[0],lines:[line(3),line(1),line(2)]}]})).equal(text);
    const gap={...sample,outputs:[{file:'a',lines:[line(1),line(2,0),line(3,1)]}]};
    expect(JSON.parse(serializeTrace(gap)).outputs[0].lines.map(r => r.lines ?? r.line)).deep.equal([1,[2,3]]);
  });

  it('prints every scalar array inline while preserving JSON string escaping', () => {
    const pair=convertTrace({values:[null,true,false,12,'a, [b]', 'quote"\\\\newline\n'],nested:[[1,2],{values:[3,4]}],lines:[]},{'empty.txt':''});
    const meta=JSON.parse(pair.meta);
    expect(pair.meta).include('"values": [');
    expect(pair.meta).include('[1, 2]');
    expect(pair.meta).include('"values": [3, 4]');
    expect(meta.values).deep.equal([null,true,false,12,'a, [b]', 'quote"\\\\newline\n'].sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1));
    expect(pair.meta).not.match(/\[\n\s+(?:null|true|false|[0-9]|"[^"\n]*")/);
  });

  it('prints flat objects inline and keeps every container holding a non-scalar multiline', () => {
    const flat={'quote"': 'comma, colon: bracket[] newline\n', nil:null, yes:true, no:false, number:12};
    const inline='{"quote\\\"": "comma, colon: bracket[] newline\\n", "nil": null, "yes": true, "no": false, "number": 12}';
    expect(serializeJson(flat)).equal(inline+'\n');
    expect(serializeJson({empty:{}, array:[], rows:[flat]})).equal(
      '{\n  "empty": {},\n  "array": [],\n  "rows": [\n    '+inline+'\n  ]\n}\n');
    expect(serializeJson({object:{n:1}, array:[1]})).equal(
      '{\n  "object": {"n": 1},\n  "array": [1]\n}\n');
    expect(serializeJson({omitted:undefined,n:1})).equal('{"n": 1}\n');
    const pair=convertTrace({flat,lines:[]},{'empty.txt':''});
    expect(pair.meta).include('"flat": {"nil": null, "no": false, "number": 12, "quote\\\"": "comma, colon: bracket[] newline\\n", "yes": true}');
    expect(serializeTrace(sample)).include('{"file": "example.l2.yaml", "node": "rule/example", "selector": "/class"}');
  });

  it('checks committed code and provenance with optional navigation metadata absent', async () => {
    const dir=join(scratch,'optional-meta'); mkdirSync(dir);
    const file=join(dir,'example.l2.yaml');
    writeFileSync(file,readFileSync('src/l2demo/maintenance_ship.l2.yaml','utf8'));
    const {model,files}=await buildRule(file,dir);
    for (const name of Object.keys(files).filter(f=>f.endsWith('.trace.meta.json'))) rmSync(join(dir,name));
    expect(await checkRule(file,dir)).deep.equal([]);
    expect(readTraceFile(join(dir,`${model.class}.clas.trace.json`)).lines[0].locations).not.empty;
    const set=join(dir,'example.l3.yaml');
    writeFileSync(set,'set: example\ntitle: Example\ndate: $date\nrules:\n  - rule: example.l2.yaml\n');
    expect(()=>compileSet(set)).throw('has no generated class beside it');
    writeFileSync(join(dir,`${model.class}.clas.abap`),'changed\n');
    expect(await checkRule(file,dir)).include(`${model.class}.clas.abap: differs from a fresh build`);
  });

  it('sorts and deduplicates full contributor tuples without locale dependence', () => {
    const sources=[{...source,selector:'/z'},{...source,selector:'/a'},{...source,selector:'/z'}];
    const make=rows => serializeTrace({outputs:[{file:'z',lines:[{line:1,sources:rows,locations:[location,location]}]},{file:'a',lines:[line(1)]}]});
    expect(make(sources)).equal(make([...sources].reverse()));
    const parsed=JSON.parse(make(sources));
    expect(parsed.outputs.map(o=>o.file)).deep.equal(['a','z']);
    expect(parsed.outputs[1].lines[0].sources.map(s=>s.selector)).deep.equal(['/a','/z']);
    expect(parsed.outputs[1].lines[0].locations).length(1);
  });

  it('rejects unsupported versions, duplicates, overlaps, bad ranges and invalid offsets', () => {
    expect(()=>readTrace({format:'osd-trace/2',outputs:[]})).throw('unsupported');
    expect(()=>serializeTrace({outputs:[sample.outputs[0],sample.outputs[0]]})).throw('duplicate');
    for (const record of [{...line(1),lines:[1,2]},{lines:[2,2],sources:[],locations:[location]},{lines:[2,1],sources:[],locations:[location]},line(0),line(1,-1)]) {
      expect(()=>serializeTrace({outputs:[{file:'a',lines:[record]}]})).throw();
    }
    expect(()=>serializeTrace({outputs:[{file:'a',lines:[line(1),line(1)]}]})).throw('overlapping');
  });

  it('reads both legacy forms and v1 with missing or mismatched metadata', () => {
    const old={model:'sha256:old',lines:[{line:1,node:'rule/example',template_line:8,path:'/class'}]};
    expect(readTrace(old)).deep.equal(old);
    expect(readTrace(old.lines).lines).deep.equal(old.lines);
    const pair=convertTrace(old,{'zcl_example.clas.abap':'hello\n'},{source:'example.l2.yaml',recipe:location.recipe});
    expect(readTrace(pair.trace).lines[0].sources[0].node).equal('rule/example');
    expect(readTrace(pair.trace,pair.meta,{'zcl_example.clas.abap':'hello\n'}).model).equal(old.model);
    expect(()=>readTrace(pair.trace,pair.meta,{'zcl_example.clas.abap':'changed\n'})).throw('hash mismatch');
    expect(pair.trace).not.contain('template_line'); expect(pair.trace).not.contain('sha256:');
    const hints = JSON.parse(convertTrace({lines:Array.from({length:12},(_,i)=>({line:i+1,node:'rule/example'}))}, {'a.txt':'hello\n'.repeat(12)}, {source:source.file,recipe:location.recipe}).meta).lines;
    expect(hints.map(h=>h.line)).deep.equal(Array.from({length:12},(_,i)=>i+1));
  });

  it('joins the object store and debugger file/line directly, including testclasses', () => {
    const dir=join(scratch,'store'); mkdirSync(join(dir,'src'),{recursive:true});
    for (const suffix of ['.clas.abap','.clas.testclasses.abap']) writeFileSync(join(dir,'src','zcl_example'+suffix),'first\nsecond\n');
    const store=new ObjectStore({root:dir,roots:[{path:'src',writable:true}],libs:[],excluded:[]});
    for (const include of ['main','testclasses']) {
      const served=store.read('CLAS','ZCL_EXAMPLE',include);
      const file=basename(served.file);
      const pair=convertTrace({lines:[{line:1,node:'rule/example',path:'/class'}]},{[file]:served.source},{source:source.file,recipe:location.recipe});
      const position={object:'ZCL_EXAMPLE',include,file,line:1};
      const output=JSON.parse(pair.trace).outputs.find(o=>o.file===position.file);
      expect(output.file).equal(include==='main'?'zcl_example.clas.abap':'zcl_example.clas.testclasses.abap');
      expect(expandLines(output.lines).find(r=>r.line===position.line).sources[0]).deep.equal(source);
    }
  });

  it('keeps source selectors stable when compiled list indexes and source lines move', () => {
    const build=(index,rule_line)=>{
      const model={'@id':'root',items:Array(index-1).fill({}).concat({'@id':'rule/kept',rule_line,value:'same'})};
      return convertTrace({rule:'example.yaml',lines:[{line:1,path:`/items/${index}/value`,node:'rule/kept',rule_line}]},{'a.txt':'same\n'},{model,recipe:'recipes/test.tpl'});
    };
    const a=build(1,3), b=build(2,20);
    stableBytes(a.trace,b.trace); expect(a.meta).not.equal(b.meta);
    expect(JSON.parse(a.trace).outputs[0].lines[0].sources[0].selector).equal('/value');
  });

  it('uses real engine contributors and ignores non-emitting parent/partial edits (A, G, H, I)', async () => {
    const model={'@id':'root',name:'example',items:[{'@id':'rule/one',left:'a',right:'b'}]};
    const run=async comment=>{
      const rendered=await renderWithEngine(`${comment}{{> body}}\n`,model,{body:comment+'{{#items}}{{left}} {{right}}\n{{/items}}',unused:comment},'parent');
      return {rendered,pair:convertTrace({source:'example.yaml',template:'recipes/example/parent.tpl',lines:rendered.trace},{'a.txt':rendered.text},{model})};
    };
    const a=await run(''), b=await run('{{! moved template comment }}\n');
    expect(a.rendered.trace[0].contributors.map(c=>c.template_line)).not.deep.equal(b.rendered.trace[0].contributors.map(c=>c.template_line));
    expect(a.rendered.text).equal(b.rendered.text); stableBytes(a.pair.trace,b.pair.trace);
    const sources=readTrace(a.pair.trace).lines[0].sources;
    expect(sources.filter(s=>s.node==='rule/one').map(s=>s.selector)).include('/left').and.include('/right');
    expect(readTrace(a.pair.trace).lines.every(r=>r.locations.length)).equal(true);
  });

  it('uses native default and legacy ABAP serializers (A, I) without volatile stable fields', async () => {
    await import('../output/zcl_osd_dsl_trace.clas.mjs');
    const abap=globalThis.abap, box=s=>new abap.types.String().set(s);
    const rendered=await renderWithEngine('CLASS zcl_example.\nENDCLASS.\n',{'@id':'project/example',name:'zcl_example'});
    const args={iv_generator:box('dsl-mpc'),iv_template:box('mpc_class'),iv_file:box('zcl_example.clas.abap'),io_model:rendered.json,is_result:rendered.result};
    const stable=(await abap.Classes.ZCL_OSD_DSL_TRACE.sidecar(args)).get();
    const meta=(await abap.Classes.ZCL_OSD_DSL_TRACE.metadata(args)).get();
    expect(JSON.parse(stable).format).equal('osd-trace/1');
    expect(JSON.parse(stable).outputs[0].file).equal('zcl_example.clas.abap');
    expect(readTrace(stable,meta,{'zcl_example.clas.abap':rendered.text}).lines).length(2);
    expect(stable).equal(serializeJson(JSON.parse(stable)));
    expect(meta).equal(serializeJson(JSON.parse(meta)));
    expect(stable).include('"lines": [1, 2]');
    const partials={mpc_class:'CLASS {{name}}.\nENDCLASS.\n'}, model={'@id':'project/example',name:'zcl_example'};
    const before=await renderWithEngine('{{> mpc_class}}\n',model,partials,'parent');
    const after=await renderWithEngine('{{! non-emitting parent edit }}\n{{> mpc_class}}\n',model,partials,'parent');
    expect(before.text).equal(after.text);
    const native=r=>abap.Classes.ZCL_OSD_DSL_TRACE.sidecar({...args,io_model:r.json,is_result:r.result});
    stableBytes((await native(before)).get(),(await native(after)).get());
    const interleaved=await renderWithEngine('before\n{{> body}}\nafter\n',model,{body:'child\n'},'mpc_class');
    const offsets=readTrace((await native(interleaved)).get()).lines.filter(r=>r.locations.some(l=>l.recipe.endsWith('/mpc_class.tpl'))).map(r=>r.locations.find(l=>l.recipe.endsWith('/mpc_class.tpl')).offset);
    expect(offsets).deep.equal([0,1]);
    const {ltcl_trace} = await import('../output/zcl_osd_dsl_trace.clas.testclasses.mjs');
    const unit = await new ltcl_trace().constructor_();
    await unit.FRIENDS_ACCESS_INSTANCE.node_paths(); await unit.FRIENDS_ACCESS_INSTANCE.sidecar_fields(); await unit.FRIENDS_ACCESS_INSTANCE.stable_fields();
    expect(JSON.parse((await abap.Classes.ZCL_OSD_DSL_TRACE.sidecar({...args,iv_legacy:new abap.types.Character(1).set('X')})).get()).model).match(/^sha256:/);
  });

  it('keeps real L2 output and stable provenance after source comments move rule lines', async () => {
    const dir=join(scratch,'source');mkdirSync(dir);
    const file=join(dir,'example.l2.yaml'), text=readFileSync('src/l2demo/maintenance_ship.l2.yaml','utf8');
    writeFileSync(file,text);
    const a=await renderRule(compileRule(file,{out:dir}));
    writeFileSync(file,'# unrelated source comment\n\n'+text+'\n# another unrelated comment\n');
    const b=await renderRule(compileRule(file,{out:dir}));
    for (const name of Object.keys(a.files).filter(f=>f.endsWith('.abap')||f.endsWith('.trace.json'))) {
      if (name.endsWith('.trace.json')) stableBytes(a.files[name],b.files[name],name);
      else expect(a.files[name],name).equal(b.files[name]);
    }
    expect(a.files[Object.keys(a.files).find(f=>f.endsWith('.trace.meta.json'))]).not.equal(b.files[Object.keys(b.files).find(f=>f.endsWith('.trace.meta.json'))]);
  });

  it('does not coalesce consecutive invocations of the same partial and source node', async () => {
    const model={'@id':'root',name:'same'};
    const rendered=await renderWithEngine('{{> body}}\n{{> body}}\n',model,{body:'{{name}}\n'},'parent');
    const pair=convertTrace({source:'example.yaml',template:'recipes/example/parent.tpl',lines:rendered.trace},{'a.txt':rendered.text},{model});
    const records=JSON.parse(pair.trace).outputs[0].lines;
    expect(records).length(2);expect(records.map(r=>r.line)).deep.equal([1,2]);
    expect(records.map(r=>r.locations[0].offset)).deep.equal([0,0]);
    const interleaved=await renderWithEngine('before\n{{> body}}\nafter\n',model,{body:'child\n'},'parent');
    const resumed=convertTrace({source:'example.yaml',template:'recipes/example/parent.tpl',lines:interleaved.trace},{'a.txt':interleaved.text},{model});
    expect(readTrace(resumed.trace).lines.filter(r=>r.locations.some(l=>l.recipe.endsWith('/parent.tpl'))).map(r=>r.locations.find(l=>l.recipe.endsWith('/parent.tpl')).offset)).deep.equal([0,1]);
  });

  it('keeps the stable check trace byte-identical after editing its sibling test partial (B)', async () => {
    const model=compileRule('src/l2demo/maintenance_ship.l2.yaml');
    const root=join(scratch,'rule'); mkdirSync(root); cpSync('recipes',join(root,'recipes'),{recursive:true});
    const cwd=process.cwd();
    try {
      process.chdir(root);
      const a=await renderRule(model);
      const template='recipes/l2-check-test/template.tpl';
      writeFileSync(template,'{{! sibling change }}\n'+readFileSync(template,'utf8'));
      const b=await renderRule(model);
      const output=`${model.class}.clas.abap`, trace=`${model.class}.clas.trace.json`;
      expect(a.files[output]).equal(b.files[output]); stableBytes(a.files[trace],b.files[trace]);
      // A positive edit must change the generated bytes and stable provenance.
      const check='recipes/l2-check/template.tpl';
      writeFileSync(check,readFileSync(check,'utf8').replace('PUBLIC SECTION.','PUBLIC SECTION.\n  " additional emitted line'));
      const c=await renderRule(model);
      expect(c.files[output]).not.equal(b.files[output]); expect(c.files[trace]).not.equal(b.files[trace]);
    } finally {process.chdir(cwd);}
  });

  it('renders runner, doctor, remote and cockpit traces in isolation; unrelated recipe edits leave them identical (C–F)', async () => {
    const model=compileSet('src/l2demo/fleet2.l3.yaml');
    const root=join(scratch,'set'); mkdirSync(root); cpSync('recipes',join(root,'recipes'),{recursive:true}); cpSync('src/dsl',join(root,'src/dsl'),{recursive:true});
    const cwd=process.cwd();
    try {
      process.chdir(root);
      const a=await renderSet(model);
      const sibling='recipes/l3-ports/source-mem.tpl';
      writeFileSync(sibling,'{{! sibling non-emitting change }}\n'+readFileSync(sibling,'utf8'));
      const b=await renderSet(model);
      for (const file of Object.keys(a.files).filter(f=>f.endsWith('.trace.json'))) {
        const trace=JSON.parse(a.files[file]); expect(trace.format,file).equal('osd-trace/1');
        const untouched=trace.outputs.every(o=>o.lines.every(r=>r.locations.every(l=>l.recipe!==sibling)));
        if (!untouched) continue;
        for (const o of trace.outputs) if (a.files[o.file]!==undefined) expect(a.files[o.file],o.file).equal(b.files[o.file]);
        stableBytes(a.files[file],b.files[file],file);
        for (const o of trace.outputs) if (a.files[o.file]!==undefined) expect(expandLines(o.lines).length,o.file).equal(a.files[o.file].replace(/\n$/,'').split('\n').length);
      }
      const parent='recipes/l3-set/template.tpl';
      writeFileSync(parent,'{{! non-emitting parent movement }}\n'+readFileSync(parent,'utf8'));
      const c=await renderSet(model), runner=`${model.class}.clas.trace.json`;
      expect(c.files[`${model.class}.clas.abap`]).equal(b.files[`${model.class}.clas.abap`]);
      const untouched=text=>{
        const trace=JSON.parse(text);
        trace.outputs=trace.outputs.map(o=>({...o,lines:o.lines.filter(r=>r.locations.every(l=>l.recipe!==parent))}));
        return JSON.stringify(trace);
      };
      expect(JSON.parse(untouched(b.files[runner])).outputs[0].lines.length).greaterThan(0);
      stableBytes(untouched(c.files[runner]),untouched(b.files[runner]),'untouched overlays after parent movement');
      expect(Object.keys(a.files).some(f=>f.includes('_doc.prog.trace.json'))).equal(true);
      expect(Object.keys(a.files).some(f=>f.includes('.fugr.')&&f.endsWith('.trace.json'))).equal(true);
      expect(Object.keys(a.files).some(f=>f.endsWith('.service.trace.json'))).equal(true);
      const aggregate=JSON.parse(a.files[Object.keys(a.files).find(f=>f.endsWith('.service.trace.json'))]);
      expect(aggregate.outputs.every(o=>o.lines.every(r=>r.locations.every(l=>l.recipe==='tools/dsl-l3-cockpit-service.mjs')))).equal(true);
    } finally {process.chdir(cwd);}
  });

  it('keeps runner and settings stable traces byte-identical when an unrelated template contains disabled overlay fragments', async () => {
    const model=compileSet('src/l2demo/fleet2.l3.yaml');
    await import('./start.mjs');
    const root=join(scratch,'disabled-overlay'); mkdirSync(root);
    cpSync('recipes',join(root,'recipes'),{recursive:true}); cpSync('src/dsl',join(root,'src/dsl'),{recursive:true});
    const cwd=process.cwd();
    try {
      process.chdir(root);
      const a=await renderSet(model);
      const fragments=JSON.parse(readFileSync('recipes/l3-cockpit/runner.patch.json','utf8')).map(p=>p.after.join('')).join('\n');
      const unrelated='recipes/l3-cockpit/dpc.tpl';
      writeFileSync(unrelated,'{{#never}}\n'+fragments+'\n{{/never}}\n'+readFileSync(unrelated,'utf8'));
      const b=await renderSet(model);
      for (const file of Object.keys(a.files).filter(f=>f.endsWith('.abap'))) expect(b.files[file],file+' output bytes').equal(a.files[file]);
      for (const name of [model.class,model.settings.class]) {
        const file=`${name}.clas.trace.json`;
        stableBytes(b.files[file],a.files[file],file+' stable bytes');
      }
    } finally {process.chdir(cwd);}
  });

  it('renders daemon XML and report sidecars after unrelated recipe edits (G, H)', async () => {
    const cwd=process.cwd(), root=join(scratch,'other'); mkdirSync(root);
    cpSync('recipes',join(root,'recipes'),{recursive:true});
    const daemonFile=readdirSync('recipes/samc-xml/sample').find(f=>f.endsWith('.json'));
    const input=JSON.parse(readFileSync(join('recipes/samc-xml/sample',daemonFile),'utf8'));
    const daemon=async()=>{
      const r=await renderDaemonModel(input);
      return {text:r.text,...convertTrace({generator:'dsl-daemons',model:'example.model.json',template:'template.tpl',lines:r.trace},{'example.samc.xml':r.text},{model:r.model,recipe:'recipes/samc-xml/template.tpl'})};
    };
    try {
      process.chdir(root);
      const a=await daemon();
      writeFileSync('recipes/sapc-xml/template.tpl','{{! unused sibling }}\n'+readFileSync('recipes/sapc-xml/template.tpl','utf8'));
      const b=await daemon(); expect(a.text).equal(b.text); stableBytes(a.trace,b.trace);
      const out=join(root,'help.txt'), report=join(cwd,'recipes/report-help/sample');
      const first=await renderReport('help',report,{out}); const trace=readFileSync(out+'.trace.json','utf8');
      writeFileSync('recipes/report-manpage/template.tpl','{{! unused sibling }}\n'+readFileSync('recipes/report-manpage/template.tpl','utf8'));
      const second=await renderReport('help',report,{out});
      expect(first.text).equal(second.text); stableBytes(readFileSync(out+'.trace.json','utf8'),trace);
      expect(JSON.parse(trace).format).equal('osd-trace/1');
      expect(JSON.parse(trace).outputs.flatMap(o=>o.lines.flatMap(r=>r.sources)).every(s=>s.file.endsWith('.prog.abap'))).equal(true);
    } finally {process.chdir(cwd);}
  });

  it('writes deterministic MPC/DPC provenance despite randomized temporary import projects (A)', async () => {
    for (const render of [renderMpc,renderDpc]) {
      const first=await render('test/fixtures/segw/zstg_mini.iwpr.xml',join(scratch,'first'));
      const second=await render('test/fixtures/segw/zstg_mini.iwpr.xml',join(scratch,'second'));
      expect(readFileSync(first.abapFile,'utf8')).equal(readFileSync(second.abapFile,'utf8'));
      const stable=readFileSync(first.traceFile,'utf8');
      stableBytes(stable,readFileSync(second.traceFile,'utf8'));
      expect(JSON.parse(stable).outputs[0].file).equal(basename(first.abapFile));
    }
  });

  it('finds historical rule hashes in legacy sidecars and v1 metadata and pairs output bytes', () => {
    const root=join(scratch,'history'); mkdirSync(root);
    const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});expect(r.status,r.stderr).equal(0);return r.stdout;};
    git('init','-q');
    const commit=()=>{git('add','.');git('-c','user.name=Trace fixture','-c','user.email=trace@example.invalid','commit','-q','-m','Trace fixture\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>');};
    const name='zcl_example.clas.trace.json', file='zcl_example.clas.abap';
    const entry={file:'example.l2.yaml',check_class:'zcl_example'};
    const one='sha256:'+'1'.repeat(64), two='sha256:'+'2'.repeat(64);
    writeFileSync(join(root,entry.file),'rule: example\n');writeFileSync(join(root,file),'first\n');
    writeFileSync(join(root,name),JSON.stringify({model:one,rule:entry.file,lines:[{line:1,node:'rule/example',rule_line:1}]}));commit();
    const pair=convertTrace({model:two,rule:entry.file,lines:[{line:1,node:'rule/example',path:'/class'}]},{[file]:'second\n'},{recipe:location.recipe});
    writeFileSync(join(root,file),'second\n');writeFileSync(join(root,name),pair.trace);writeFileSync(join(root,name.replace('.json','.meta.json')),pair.meta);commit();
    // Advance only the worktree, making both prior hashes historical.
    const next=convertTrace({model:'sha256:'+'3'.repeat(64),rule:entry.file,lines:[{line:1,node:'rule/example'}]},{[file]:'third\n'},{recipe:location.recipe});
    writeFileSync(join(root,file),'third\n');writeFileSync(join(root,name),next.trace);writeFileSync(join(root,name.replace('.json','.meta.json')),next.meta);
    const legacy=ruleVersion(entry,one.slice(7),root), v1=ruleVersion(entry,two.slice(7),root);
    expect(legacy.where).match(/^commit /);expect(legacy.check).equal('first\n');
    expect(v1.where).match(/^commit /);expect(v1.trace.format).equal('osd-trace/1');expect(v1.check).equal('second\n');
    writeFileSync(join(root,file),'unpaired output\n');
    expect(()=>ruleVersion(entry,'3'.repeat(64),root)).throw('hash mismatch');
  });

  it('supports the --trace-legacy flag on the real SAMC CLI', () => {
    const out=join(scratch,'legacy.samc.xml');
    const model=readdirSync('recipes/samc-xml/sample').find(f=>f.endsWith('.json'));
    const run=spawnSync(process.execPath,['tools/dsl-samc.mjs','render',join('recipes/samc-xml/sample',model),'--out',out,'--trace-legacy'],{encoding:'utf8'});
    expect(run.status,run.stderr).equal(0);
    expect(JSON.parse(readFileSync(out+'.trace.json','utf8')).format).equal(undefined);
  });

  it('supports the explicit legacy environment opt-in without metadata companions', async () => {
    const prev=process.env.OSD_TRACE_LEGACY;
    try {
      process.env.OSD_TRACE_LEGACY='1';
      const files=await renderRule(compileRule('src/l2demo/maintenance_ship.l2.yaml'));
      const trace=Object.keys(files.files).find(f=>f.endsWith('.trace.json'));
      expect(JSON.parse(files.files[trace]).format).equal(undefined);
      expect(Object.keys(files.files).some(f=>f.endsWith('.meta.json'))).equal(false);
    } finally {if(prev===undefined)delete process.env.OSD_TRACE_LEGACY;else process.env.OSD_TRACE_LEGACY=prev;}
  });
});
