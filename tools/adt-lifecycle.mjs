// Disposable creation/edit/activation measurements through the pinned SDK and VSP.
// Run under osd-heavy.sh; --start owns an isolated server in this checkout.
import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
import {startLifecycleServer, lifecycleIdentity} from './adt-lifecycle-server.mjs';
import {MISSING_VALIDATIONS, checkReport, renderReport, checkVspSyntax} from './adt-lifecycle-report.mjs';
import {vspClient, CALL_TIMEOUT_S, ddlsCallTimeoutS, warmReadyTimeoutS} from './adt-lifecycle-vsp.mjs';
import {resolve, join} from 'node:path';
const url = process.env.URL ?? `http://127.0.0.1:${process.env.STG_PORT ?? 8099}`;
const target = new URL(url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.protocol !== 'http:' || target.username || target.password) throw Error('Local HTTP test server required');
const repeats = Number(process.env.OSD_LIFECYCLE_REPEATS ?? 3);
if (!Number.isInteger(repeats) || repeats < 3 || repeats > 7) throw Error('OSD_LIFECYCLE_REPEATS must be 3–7');
const sdkRoot = resolve(process.env.SDK_ROOT ?? 'tools/abapfs-conformance');
const sdk = createRequire(join(sdkRoot, 'package.json'))('abap-adt-api');
const {ADTClient, session_types} = sdk;
const c = new ADTClient(url, 'OSD', 'any', '001', 'EN');
c.stateful = session_types.stateful;
const out = resolve(process.env.OUT ?? '.local/adt-lifecycle/report');
mkdirSync(out, {recursive:true});
const results = [], owned = [], suffix = Date.now().toString(36).slice(-7).toUpperCase();
const report = {schema:1, identity:lifecycleIdentity(), repeats, complete:false, results};
let server, vsp;
const warmTypes = new Set(['CLAS', 'INTF', 'INCL']);
const defs = [
 ['DEVC', 'DEVC/K', 'packages', '$OSD_LC', null],
 ['CLAS', 'CLAS/OC', 'oo/classes', 'ZCL_OSD_LC', n => `CLASS ${n.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC. PUBLIC SECTION. CONSTANTS value TYPE i VALUE 1. ENDCLASS.\nCLASS ${n.toLowerCase()} IMPLEMENTATION. ENDCLASS.\n`],
 ['INTF', 'INTF/OI', 'oo/interfaces', 'ZIF_OSD_LC', n => `INTERFACE ${n.toLowerCase()} PUBLIC. CONSTANTS value TYPE i VALUE 1. ENDINTERFACE.\n`],
 ['PROG', 'PROG/P', 'programs/programs', 'ZOSD_LC_P', n => `REPORT ${n.toLowerCase()}.\nWRITE 'LC_ONE'.\n`],
 ['INCL', 'PROG/I', 'programs/includes', 'ZOSD_LC_I', () => `DATA lc_value TYPE i VALUE 1.\n`],
 ['DDLS', 'DDLS/DF', 'ddic/ddl/sources', 'ZLC_D', n => `@EndUserText.label: 'LC_ONE'\ndefine view entity ${n} as select from zosd_test_item\n{ key item_id }\n`],
];
const fixtures = client => defs.map(([type, objtype, path, prefix, source]) => {
 const name = `${prefix}_${client === 'ABAP-FS' ? 'A' : 'V'}_${suffix}`;
 return {client, type, objtype, name, uri:`/sap/bc/adt/${path}/${encodeURIComponent(name.toLowerCase())}`, source:source?.(name)};
});
const unchanged = (a,b) => a.replace(/\r\n/g,'\n') === b.replace(/\r\n/g,'\n');
const changed = (source, round) => source.replace('VALUE 1',`VALUE ${round + 2}`).replace('LC_ONE',`LC_EDIT_${round}`);
const assert = (ok, message) => {if (!ok) throw Error(message);};
function flush() {
 writeFileSync(join(out,'report.json'), JSON.stringify(report,null,2));
 writeFileSync(join(out,'summary.md'), renderReport(report));
}
async function step(f, operation, fn, sample) {
 const start=performance.now();
 try { const value=await fn(); const row={client:f.client,type:f.type,operation,sample,status:'PASS',ms:Math.round(performance.now()-start)}; results.push(row); console.log(JSON.stringify(row)); flush(); return {ok:true,value}; }
 catch(e) {const row={client:f.client,type:f.type,operation,sample,status:operation==='validate' && is404(e) && MISSING_VALIDATIONS.has(f.type)?'MISSING':'FAIL',ms:Math.round(performance.now()-start),note:e.message}; results.push(row); console.log(JSON.stringify(row)); flush(); return {ok:false};}
}
function na(f, operation, note) { results.push({client:f.client,type:f.type,operation,status:'N/A',note}); flush(); }
const is404 = e => e.err === 404 || e.response?.status === 404 || e.status === 404;
// Every VSP call of the DDLS family gets the measured budget (the activation
// re-runs the CDS generator and a cold build); the other families keep 90 s.
// The interface's create+write+activate gets the DDLS family's budget too: it
// measured 51-72 s on good CI runs and was cut at 90.0 s on slow runners
// (three reds on 2026-11-13); its edits and explicit activation stay at 90 s.
const vspTimeout = (f, op) => f.type === 'DDLS' || (f.type === 'INTF' && op === 'create') ? ddlsCallTimeoutS() : CALL_TIMEOUT_S;
async function absent(f) { try {await c.objectStructure(f.uri);} catch(e) {if(is404(e)) return; throw e;} throw Error('Object already exists / remains after cleanup'); }
async function write(f, source) {
 const lock=await c.lock(f.uri); assert(lock.LOCK_HANDLE,'Empty lock handle');
 try {await c.setObjectSource(`${f.uri}/source/main`,source,lock.LOCK_HANDLE);} finally {await c.unLock(f.uri,lock.LOCK_HANDLE);}
 assert(unchanged(await c.getObjectSource(`${f.uri}/source/main`),source),'Readback mismatch');
}
async function activate(f) {const r=await c.activate(f.name,f.uri); assert(r.success, JSON.stringify(r.messages));}
async function tool(name,args) {return vsp.tool(name,args);}
async function serving() {
 const r=await fetch(`${url}/osd/serving`, {signal:AbortSignal.timeout(5000)});
 assert(r.ok,`Serving status HTTP ${r.status}`);
 return r.json();
}
async function warmOperation(f, work) {
 const before=await serving();
 await work();
 if(warmTypes.has(f.type)) {
  const after=await serving();
  assert(after.warm?.swaps > before.warm?.swaps && after.warm?.generation !== before.warm?.generation,
   `${f.type} content edit did not publish a warm swap`);
 }
}
async function warmReady(f) {
 let prepared=false;
 // Inspect compiler availability rather than a fixed delay (server local status).
 const until=Date.now()+warmReadyTimeoutS()*1000;
 while(Date.now()<until) {
  const r=await serving();
  if(r.warm?.state === 'primed') return;
  if(f && r.warm?.state === 'cold' && !prepared) {
   prepared=true;
   const prep=await step(f,'prepare-baseline',()=>activate(f));
   assert(prep.ok,'Baseline activation failed');
  }
   if(!r.warm) throw Error('Server does not expose warm status');
  if(r.warm.state === 'off') throw Error('Warm compiler disabled');
  await new Promise(r=>setTimeout(r,250));
 }
 throw Error('Warm compiler did not become ready');
}
try {
 flush();
 if(process.argv.includes('--start')) {
  if (!process.env.OSD_HEAVY_SLOT) throw Error("Run --start through tools/osd-heavy.sh on its STG_PORT");
  server=await startLifecycleServer(target);
 }
 vsp=await vspClient(url);
 await c.login();
 // Create all SDK objects before activating to measure one coherent initial baseline.
 const af=fixtures('ABAP-FS');
 for(const f of af) {
  await absent(f); owned.push(f);
  const options={objtype:f.objtype,name:f.name,objname:f.name,parentName:'$TMP',parentPath:'/sap/bc/adt/packages/%24tmp',packagename:'$TMP',description:'Disposable lifecycle probe',responsible:'OSD',...(f.type==='DEVC'?{swcomp:'LOCAL',transportLayer:'',packagetype:'development'}:{})};
  await step(f,'validate',async()=>{const r=await c.validateNewObject(options);assert(r.success,r.SHORT_TEXT);});
  const made=await step(f,'create',async()=>{await c.createObject(options);await c.objectStructure(f.uri);});
  assert(made.ok,`${f.type} create failed`);
  if(made.ok && f.source) await step(f,'write-initial',()=>write(f,f.source));
  if(!f.source) {na(f,'edit','Package metadata update has no SDK/VSP source operation');na(f,'activate','Package is created active; no source activation');}
 }
 const active=af.filter(f=>f.source);
 const initial=await step({client:'ABAP-FS',type:'ALL5'},'activate-initial',async()=>{const r=await c.activate(active.map(f=>({'adtcore:name':f.name,'adtcore:uri':f.uri})));assert(r.success,JSON.stringify(r.messages));});
 assert(initial.ok,'Initial activation failed; stopping before edit measurements');
 await warmReady();
 for(const f of active) {
  for(let sample=0; sample<repeats; sample++) {
  await warmReady(f);
  const edited=changed(f.source, sample);
  await step(f,'edit',()=>write(f,edited),sample);
  await step(f,'check',async()=>{const issues=await c.syntaxCheck(`${f.uri}/source/main`,f.uri,edited);assert(!issues.some(i=>/^[EAX]/.test(i.severity)),JSON.stringify(issues));},sample);
  await step(f,'activate-edit',()=>warmOperation(f,()=>activate(f)),sample);
  await step(f,'readback-active',async()=>assert(unchanged(await c.getObjectSource(`${f.uri}/source/main`,{version:'active'}),edited),'Active source mismatch'),sample);
  }
 }
 for(const f of fixtures('VSP')) {
  await absent(f); owned.push(f);
  if(f.type==='DEVC') {
   await step(f,'create',async()=>{await tool('CreatePackage',{name:f.name,description:'Disposable lifecycle probe',parent:'$TMP'});await c.objectStructure(f.uri);});
   na(f,'edit','VSP has CreatePackage; no package metadata update tool');na(f,'activate','Created active');continue;
  }
  const made=await step(f,'create+write+activate',async()=>{await tool('WriteSource',{object_type:f.type,name:f.name,package:'$TMP',mode:'create',description:'Disposable lifecycle probe',source:f.source,timeout:vspTimeout(f,'create')});assert(unchanged(await c.getObjectSource(`${f.uri}/source/main`),f.source),'Create source mismatch');});
  if(!made.ok) continue;
  let edited;
  for(let sample=0; sample<repeats; sample++) {
  await warmReady(f); edited=changed(f.source,sample);
  await step(f,'edit+check+activate',()=>warmOperation(f,async()=>{await tool('WriteSource',{object_type:f.type,name:f.name,mode:'update',source:edited,timeout:vspTimeout(f)});assert(unchanged(await c.getObjectSource(`${f.uri}/source/main`,{version:'active'}),edited),'Active source mismatch');}),sample);
  }
  await step(f,'check-explicit',async()=>checkVspSyntax(await tool('SyntaxCheck',{object_url:f.uri,content:edited})));
  await step(f,'activate-explicit',()=>tool('Activate',{object_url:f.uri,object_name:f.name,timeout:vspTimeout(f)}));
  await step(f,'readback-vsp',async()=>{const r=await tool('GetSource',{object_type:f.type,name:f.name,include_context:false});assert(r.content?.some(b=>b.text?.includes(edited.trim())),'VSP readback mismatch');});
 }
 report.complete=true;
} catch(error) {
 report.fatal=error.message;
 console.error(error);
} finally {
 for(const f of owned.reverse()) await step(f,'delete+confirmed-404',async()=>{
  try {await absent(f);return;} catch(e) {if(!e.message.includes('already exists')) throw e;}
  const lock=await c.lock(f.uri);assert(lock.LOCK_HANDLE,'Empty delete lock handle');
  await c.deleteObject(f.uri,lock.LOCK_HANDLE);await absent(f);
 });
 await c.logout().catch(()=>{});
 await vsp?.close();
 await server?.close();
 flush();
}
const verdict=checkReport(report);
for(const error of verdict.errors) console.error(error);
process.exitCode=verdict.errors.length?1:0;
