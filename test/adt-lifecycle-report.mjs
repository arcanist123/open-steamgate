import {expect} from "chai";
import {checkReport, metrics, renderReport, checkVspSyntax, timingReference, TIMING_RULE} from "../tools/adt-lifecycle-report.mjs";
import {CALL_TIMEOUT_S, ddlsCallTimeoutS, warmReadyTimeoutS} from "../tools/adt-lifecycle-vsp.mjs";
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
function fixture() {
 const results=[];
 const add=(client,type,operation,sample)=>results.push({client,type,operation,sample,status:"PASS",ms:2000});
 for(const client of ["ABAP-FS","VSP"]) for(const type of ["DEVC","CLAS","INTF","PROG","INCL","DDLS"]) {
  const ops=type==="DEVC"?["create","delete+confirmed-404"]:client==="ABAP-FS"?["create","write-initial","delete+confirmed-404"]:["create+write+activate","check-explicit","activate-explicit","readback-vsp","delete+confirmed-404"];
  ops.forEach(op=>add(client,type,op));
  if(client==="ABAP-FS") add(client,type,"validate");
  if(type!=="DEVC") for(const op of client==="ABAP-FS"?["edit","check","activate-edit","readback-active"]:["edit+check+activate"]) for(let i=0;i<3;i++) add(client,type,op,i);
 }
 add("ABAP-FS","ALL5","activate-initial");
 return {schema:1,complete:true,repeats:3,identity:{recipe:1,sdk:"8.4.3",vsp:"pin",runtime:"pin",node:"22",platform:"linux",arch:"x64"},results};
}
function realFixture(number) {
 const data = JSON.parse(readFileSync(new URL(`./fixtures/adt-lifecycle-timing/${number}.json`, import.meta.url), "utf8"));
 const complete = timed => {
  const report = fixture();
  report.results = [...report.results.filter(row => row.sample === undefined), ...timed.results];
  return report;
 };
 return {current: complete(data.current), baseline: complete(data.baseline)};
}
function slowOperation(report, factor, type = "CLAS", operation = "activate-edit") {
 report.results.filter(row => row.type === type && row.operation === operation).forEach(row => row.ms *= factor);
 return report;
}
function cli(report, history, rawHistory) {
 const dir = mkdtempSync(join(tmpdir(), "lifecycle-report-"));
 try {
  const current = join(dir, "report.json"), baselines = join(dir, "baselines.json"), summary = join(dir, "summary.md");
  writeFileSync(current, JSON.stringify(report));
  writeFileSync(baselines, rawHistory ?? JSON.stringify(history));
  const run = spawnSync(process.execPath, ["tools/adt-lifecycle-report.mjs", current, baselines, summary], {encoding: "utf8"});
  return {...run, summary: readFileSync(summary, "utf8")};
 } finally { rmSync(dir, {recursive: true, force: true}); }
}
describe("ADT lifecycle evidence and timing advisory",()=>{
 it("rejects syntax errors inside a successful VSP MCP response",()=>{
  const response = diagnostics => ({content:[{type:"text",text:JSON.stringify(diagnostics)}]});
  expect(()=>checkVspSyntax(response([{severity:"E",text:"Syntax error"}]))).to.throw("VSP syntax errors");
  expect(()=>checkVspSyntax(response([]))).not.to.throw();
  expect(()=>checkVspSyntax(response(null))).not.to.throw();
  expect(()=>checkVspSyntax(response({}))).to.throw("Invalid VSP syntax diagnostics");
 });
 it("accepts complete functional evidence and matching baseline",()=>{
  const r=fixture(); expect(checkReport(r,r).errors).to.deep.equal([]);
 });
 it("uses median so a single slow runner sample is tolerated",()=>{
  const r=fixture(); r.results.find(x=>x.operation==="activate-edit").ms=50000;
  expect(checkReport(r,fixture()).timing.status).to.equal("QUIET");
 });
 it("warns without failing on a sustained slowdown and names the operation",()=>{
  const r=slowOperation(fixture(), 2);
  const verdict=checkReport(r,fixture());
  expect(verdict.errors).to.deep.equal([]);
  expect(verdict.warnings.join("\n")).to.contain("ABAP-FS/CLAS/activate-edit: 4000 ms");
  const run=cli(r, {reports:[fixture()]});
  expect(run.status).to.equal(0);
  expect(run.stdout).to.contain("::warning title=ADT lifecycle timing::");
  expect(run.summary).to.contain("### ADT lifecycle: PASS").and.contain("Timing advisory: ⚠️ WARN").and.contain("2.000x");
 });
 for (const number of [635,633,636]) {
  it(`keeps real run #${number} quiet against its printed main baseline`,()=>{
   const {current,baseline}=realFixture(number);
   const verdict=checkReport(current,[baseline]);
   expect(verdict.errors).to.deep.equal([]);
   expect(verdict.warnings).to.deep.equal([]);
   expect(verdict.timing.status).to.equal("QUIET");
   expect(verdict.comparisons).to.have.length(25);
  });
 }
 it("keeps a uniformly 1.6x slower real run quiet",()=>{
  const {current}=realFixture(635), slower=structuredClone(current);
  slower.results.forEach(row=>row.ms*=1.6);
  const verdict=checkReport(slower, [current]);
  expect(verdict.errors).to.deep.equal([]);
  expect(verdict.timing.status).to.equal("QUIET");
  for(const comparison of verdict.comparisons) expect(comparison.ratio).to.be.closeTo(1,1e-12);
 });
 it("warns on a 2x operation slowdown in an otherwise unchanged real run",()=>{
  const {current}=realFixture(636);
  expect(checkReport(slowOperation(structuredClone(current),2), [current]).timing.status).to.equal("WARN");
 });
 it("requires two operations strictly above 1.3x or one at least 2x",()=>{
  expect(TIMING_RULE).to.deep.equal({baselines:5,margin:1.3,several:2,large:2});
  const r=slowOperation(fixture(),1.3);
  slowOperation(r,1.3,"INTF");
  expect(checkReport(r,fixture()).timing.status).to.equal("QUIET");
  const single=slowOperation(fixture(),1.5);
  expect(checkReport(single,fixture()).timing.status).to.equal("QUIET");
  slowOperation(single,1.5,"INTF");
  expect(checkReport(single,fixture()).timing.status).to.equal("WARN");
  expect(checkReport(slowOperation(fixture(),1.999),fixture()).timing.status).to.equal("QUIET");
 });
 it("takes the median of per-run normalized metrics across five main runs",()=>{
  const {current}=realFixture(635);
  const history=[0.8,1,1.2,1.6,2].map((scale,i)=>{
   const r=structuredClone(current);
   r.results.forEach(row=>row.ms*=scale);
   return slowOperation(r,[0.8,1,1.2,1.4,20][i]);
  });
  // A sixth (older) outlier must not join the five-run reference.
  history.push(slowOperation(structuredClone(current),100));
  const verdict=checkReport(current,history);
  expect(verdict.timing.baselines).to.have.length(5);
  const operation=verdict.comparisons.find(row=>row.key==="ABAP-FS/CLAS/activate-edit");
  expect(operation.baselineCount).to.equal(5);
  expect(operation.ratio).to.be.closeTo(1/1.2,1e-12);
 });
 it("uses exactly the four CLAS/INTF edit/readback control medians",()=>{
  const {current}=realFixture(636);
  expect(timingReference(current)).to.equal(60.5); // median of 92,29,92,20
  slowOperation(current,100,"PROG","readback-active");
  expect(timingReference(current)).to.equal(60.5);
 });
 it("keeps zero controls pending and never creates nonfinite ratios",()=>{
  const r=fixture();
  r.results.filter(row=>row.type==="CLAS" && row.operation==="edit").forEach(row=>row.ms=0);
  expect(checkReport(r,fixture()).timing.status).to.equal("PENDING");
  expect(checkReport(fixture(),r).timing.status).to.equal("PENDING");
 });
 it("fails on missing cleanup evidence",()=>{
  const r=fixture(); r.results=r.results.filter(x=>!(x.type==="CLAS" && x.operation==="delete+confirmed-404"));
  expect(checkReport(r).errors.join("\n")).to.contain("delete+confirmed-404");
 });
 it("does not hide failed validation or active readback",()=>{
  for(const operation of ["validate","readback-active"]) {
   const r=fixture(); r.results.find(x=>x.operation===operation).status="FAIL";
   expect(checkReport(r).errors.length).to.be.greaterThan(0);
  }
 });
 it("allows only the three observed missing preflights and reports them",()=>{
  const r=fixture(); r.results.find(x=>x.type==="PROG" && x.operation==="validate").status="MISSING";
  expect(checkReport(r).errors).to.deep.equal([]); expect(renderReport(r)).to.contain("1 MISSING");
  r.results.find(x=>x.type==="CLAS" && x.operation==="validate").status="MISSING";
  expect(checkReport(r).errors.length).to.be.greaterThan(0);
 });
 it("excludes incompatible or unfinished history without failing current evidence",()=>{
  const base=fixture(); base.identity.vsp="other";
  const mismatch=checkReport(fixture(),base);
  expect(mismatch.errors).to.deep.equal([]);
  expect(mismatch.timing.notes.join("\n")).to.contain("Incompatible baseline identity: vsp");
  base.complete=false;
  const partial=checkReport(fixture(),[base,fixture()]);
  expect(partial.errors).to.deep.equal([]);
  expect(partial.timing.notes.join("\n")).to.contain("Baseline lifecycle evidence is invalid");
  expect(partial.timing.baselines).to.have.length(1);
 });
 it("still exits nonzero for a failed active readback with advisory timing",()=>{
  const r=slowOperation(fixture(),2);
  r.results.find(row=>row.operation==="readback-active").status="FAIL";
  const run=cli(r,{reports:[fixture()]});
  expect(run.status).to.equal(1);
  expect(run.summary).to.contain("### ADT lifecycle: FAIL").and.contain("readback-active");
 });
 it("keeps unreadable timing history advisory in the actual CLI",()=>{
  const run=cli(fixture(),null,"{broken json");
  expect(run.status).to.equal(0);
  expect(run.summary).to.contain("comparison pending").and.contain("Unreadable timing history");
 });
 it("skips malformed history shapes without changing the functional result",()=>{
  for(const history of [{reports:{}},[null,{results:{}},"broken"],{reports:null}]) {
   const verdict=checkReport(fixture(),history);
   expect(verdict.errors).to.deep.equal([]);
   expect(verdict.timing.status).to.equal("PENDING");
   expect(verdict.timing.notes).to.have.length.greaterThan(0);
  }
 });
 for (const failing of [false,true]) {
  it(`skips malformed report-shaped baselines with warnings for a ${failing ? "failing" : "passing"} current run in checkReport and CLI`,()=>{
   const current=fixture();
   if(failing) current.results.find(row=>row.operation==="readback-active").status="FAIL";
   const invalid=change=>{const report=fixture();change(report);return report;};
   const malformed=[
    invalid(report=>report.results=[null]),
    invalid(report=>report.results.push(false,123,[])),
    invalid(report=>report.results.push({})),
    invalid(report=>delete report.results[0].client),
    invalid(report=>report.results[0].operation=123),
    invalid(report=>report.results[0].status="UNKNOWN"),
    invalid(report=>report.results[0].ms="2000"),
    invalid(report=>delete report.results[0].ms),
    invalid(report=>report.results[0].sample="0"),
    invalid(report=>delete report.results.find(row=>row.sample===0).sample),
    invalid(report=>report.results[0].note={}),
    invalid(report=>delete report.repeats),
    invalid(report=>report.complete="true"),
    invalid(report=>report.fatal={toString:null}),
    invalid(report=>report.identity.commit={toString:null}),
   ];
   for (const reports of [malformed,[...malformed,fixture()]]) {
    const history={reports}, verdict=checkReport(current,history);
    expect(verdict.errors).to.deep.equal(checkReport(current).errors);
    expect(verdict.timing.baselines).to.have.length(reports.length===malformed.length?0:1);
    expect(verdict.timing.status).to.equal(reports.length===malformed.length?"PENDING":"QUIET");
    expect(verdict.timing.notes).to.have.length(malformed.length);
    expect(verdict.timing.notes.every(note=>note==="Warning: skipping timing baseline: Baseline lifecycle evidence is invalid")).to.equal(true);
    const run=cli(current,history);
    expect(run.status).to.equal(failing?1:0);
    expect(run.stderr).to.equal("");
    expect(run.summary).to.contain(`### ADT lifecycle: ${failing?"FAIL":"PASS"}`).and.contain("Warning: skipping timing baseline");
    expect(run.stdout).to.contain("::warning title=ADT lifecycle timing history::");
    if(failing) expect(run.summary).to.contain("readback-active");
   }
  });
 }
 it("requires distinct repeated samples",()=>{
  const r=fixture(); r.results.find(x=>x.sample===1).sample=0;
  expect(checkReport(r).errors.length).to.be.greaterThan(0);
 });
 it("labels missing baselines as pending and preserves raw samples",()=>{
  const r=fixture(); expect(renderReport(r)).to.contain("comparison pending");
  expect(metrics(r)["ABAP-FS/CLAS/activate-edit"].samples).to.deep.equal([2000,2000,2000]);
 });
});


describe("CI lifecycle timing history collection",()=>{
 const require=createRequire(import.meta.url);
 const workflow=require("js-yaml").load(readFileSync(".github/workflows/tests.yml","utf8"));
 const steps=workflow.jobs["adt-lifecycle"].steps;
 const collection=steps.find(step=>step.name==="Collect up to five compatible green main timing runs");
 const script=collection.with.script;
 const execute=async (apiFailure=false,artifactFailure,timeoutAt,scanCap=false)=>{
  const {current}=realFixture(635), writes=new Map(), calls=[], downloads=[];
  let elapsed=0;
  const fs={readFileSync:()=>JSON.stringify(current),writeFileSync:(file,data)=>writes.set(file,data)};
  const cp={spawnSync:(_command,args,options)=>{
   expect(options.timeout).to.be.within(1,170000);
   const data=writes.get(args[1]).toString();
   return {status:data==="unreadable zip"?1:0,stdout:data};
  }};
  const actions={
   listWorkflowRuns:async args=>{
    expect(args).to.include({branch:"main",event:"push",status:"success",per_page:30});
    expect(args.request.timeout).to.be.within(1,170000);
    expect(args.request.signal).to.be.instanceOf(AbortSignal);
    if(timeoutAt==="runs") { elapsed=170000; throw Error("request timed out"); }
    if(apiFailure) throw Error("history API unavailable");
    if(scanCap) return {data:{workflow_runs:Array.from({length:100},(_,id)=>({id:id+100,head_sha:`commit-${id}`}))}};
    return {data:{workflow_runs:[90,10,9,8,7,6,5,4,3,2,1].map(id=>({id,head_sha:`commit-${id}`}))}};
   },
   listWorkflowRunArtifacts(){},
   downloadArtifact:async ({artifact_id:id,request})=>{
    downloads.push(id);
    expect(request.timeout).to.be.within(1,170000);
    if(timeoutAt===id) { elapsed=170000; throw Error("request timed out"); }
    if(id===82) {
     if(artifactFailure) return {data:Buffer.from(artifactFailure)};
     throw Error("artifact expired during download");
    }
    const report=structuredClone(current);
    if(Math.floor(id/10)===7) report.identity.sdk="other";
    if(Math.floor(id/10)===6) report.complete=false;
    report.identity.commit=`artifact-${id}`;
    return {data:Buffer.from(JSON.stringify(report))};
   },
  };
  const github={rest:{actions},paginate:async (_method,{run_id:id,request})=>{
   calls.push(id);
   expect(request.timeout).to.be.within(1,170000);
   if(scanCap) return [];
   if(timeoutAt==="artifacts") { elapsed=170000; throw Error("request timed out"); }
   if(id===10) return [];
   if(id===9) return [{id:91,name:"adt-lifecycle-attempt-1",expired:true}];
   const artifact=attempt=>({id:id*10+attempt,name:`adt-lifecycle-attempt-${attempt}`,expired:false});
   return [artifact(1),artifact(2)];
  }};
  await new (Object.getPrototypeOf(async function(){}).constructor)("require","github","context","core","process","performance",script)(
   name=>name==="node:fs"?fs:name==="node:child_process"?cp:require(name),github,
   {repo:{owner:"fixture",repo:"fixture"},runId:90},{info(){}},
   {cwd:()=>process.cwd(),env:{RUNNER_TEMP:"/tmp"}},{now:()=>elapsed});
  return {history:JSON.parse(writes.get(".local/adt-lifecycle/baselines.json")),calls,downloads};
 };
 it("scans no more than 30 runs even if the API returns extra runs",async()=>{
  const {history,calls}=await execute(false,undefined,undefined,true);
  expect(calls).to.have.length(30);
  expect(calls.at(-1)).to.equal(129);
  expect(history.reports).to.deep.equal([]);
 });
 it("computes the required verdict before bounded optional history and renders after collection failure or timeout",()=>{
  const functional=steps.find(step=>step.id==="functional_report");
  const advisory=steps.find(step=>step.name==="Report normalized timing advisory and functional result");
  expect(steps.indexOf(functional)).to.be.lessThan(steps.indexOf(collection));
  expect(steps.indexOf(collection)).to.be.lessThan(steps.indexOf(advisory));
  expect(functional.if).to.equal("always()");
  expect(functional.run).to.contain("report.json ''").and.contain("report/summary.md");
  expect(functional["continue-on-error"]).not.to.equal(true);
  expect(collection).to.include({"timeout-minutes":3,"continue-on-error":true});
  expect(advisory.if).to.equal("${{ !cancelled() && steps.functional_report.outcome == 'success' }}");
  expect(advisory).to.include({"timeout-minutes":1,"continue-on-error":true});
  expect(advisory.run).to.contain("report/advisory-summary.md\nmv");
 });
 for (const timeoutAt of ["runs","artifacts",52]) {
  it(`stops on the elapsed budget during ${timeoutAt}, retaining partial history and the functional verdict`,async()=>{
   const {history,calls,downloads}=await execute(false,undefined,timeoutAt);
   expect(history.reports).to.have.length(timeoutAt===52?1:0);
   expect(history.notes.join("\n")).to.contain("request timed out");
   if(timeoutAt!=="runs") expect(history.notes.join("\n")).to.contain("170-second budget");
   expect(calls).not.to.include(4);
   if(timeoutAt===52) expect(downloads).not.to.include(51);
   expect(checkReport(fixture(),history).errors).to.deep.equal([]);
   const failed=fixture();failed.results.find(row=>row.operation==="readback-active").status="FAIL";
   expect(checkReport(failed,history).errors).to.deep.equal(checkReport(failed).errors);
  });
 }
 it("collects five distinct usable runs despite unavailable artifacts and invalid history",async()=>{
  const {history,calls}=await execute();
  expect(history.reports.map(report=>report.identity.commit)).to.deep.equal(["artifact-81","artifact-52","artifact-42","artifact-32","artifact-22"]);
  expect(calls).not.to.include(90).and.not.to.include(1);
  expect(history.notes.join("\n")).to.contain("artifact expired during download").and.contain("Incompatible baseline identity").and.contain("evidence is invalid");
 });
 for(const data of ["unreadable zip","{invalid json"]) {
  it(`falls back from a corrupt artifact: ${data}`,async()=>{
   const {history}=await execute(false,data);
   expect(history.reports[0].identity.commit).to.equal("artifact-81");
   expect(history.reports).to.have.length(5);
   expect(history.notes).to.have.length.greaterThan(0);
  });
 }
 it("retains an explicit pending explanation when the history API is unavailable",async()=>{
  const {history}=await execute(true);
  expect(history.reports).to.deep.equal([]);
  expect(history.notes).to.deep.equal(["Main timing history unavailable: history API unavailable"]);
  expect(checkReport(fixture(),history).errors).to.deep.equal([]);
  expect(renderReport(fixture(),history)).to.contain("comparison pending").and.contain("history API unavailable");
 });
});


describe("DDLS call timeout margin",()=>{
 const lifecycle = readFileSync("tools/adt-lifecycle.mjs","utf8");
 const vspClient = readFileSync("tools/adt-lifecycle-vsp.mjs","utf8");
 it("keeps 90 s for the other families and floors the DDLS budget at 240 s under the measured-speed factor",()=>{
  expect(CALL_TIMEOUT_S).to.equal(90);
  // Forced factors, as a CI job that knows its runner would set them. The
  // factors CI has measured are 1.00-1.29: the budget those runners receive
  // is 240-310 s.
  expect(ddlsCallTimeoutS({OSD_WARM_SPEED_FACTOR:"1"})).to.equal(240);
  expect(ddlsCallTimeoutS({OSD_WARM_SPEED_FACTOR:"1.29"})).to.equal(310);
  expect(ddlsCallTimeoutS({OSD_WARM_SPEED_FACTOR:"2"})).to.equal(480);
  expect(ddlsCallTimeoutS({OSD_WARM_SPEED_FACTOR:"8"})).to.equal(480);
  // 240 s is the floor, not the ceiling: the calibration runs idle in the
  // harness while the activation builds under the lifecycle's own load, and
  // across the failing runs it moved 1.00-1.29 while the DDLS cost moved
  // 1.7-2x -- a budget derived from it must never land under 240 s. A factor
  // below one is clamped to the floor by warm-deadline first.
  expect(ddlsCallTimeoutS({OSD_WARM_SPEED_FACTOR:"0.5"})).to.equal(240);
 });
 it("gives every VSP call of the DDLS family the measured budget and keeps the others at 90 s",()=>{
  const budget = String.raw`timeout:vspTimeout\(f(,'create')?\)`;
  expect(lifecycle.match(new RegExp(budget,"g"))).to.have.length(3);
  // the create call names itself, so the interface's create gets the budget
  // and its edits do not
  expect(lifecycle.match(/timeout:vspTimeout\(f,'create'\)/g)).to.have.length(1);
  expect(lifecycle).to.contain("const vspTimeout = (f, op) => f.type === 'DDLS' || (f.type === 'INTF' && op === 'create') ? ddlsCallTimeoutS() : CALL_TIMEOUT_S");
  expect(lifecycle).not.to.match(/timeout:\s*90\b/);
  expect(lifecycle).to.contain("import {vspClient, CALL_TIMEOUT_S, ddlsCallTimeoutS, warmReadyTimeoutS}");
 });
 it("gives the interface's create+write+activate the same budget (slow runners cut it at 90.0 s)",()=>{
  const vspTimeout = new Function("ddlsCallTimeoutS","CALL_TIMEOUT_S",
   "return " + /const vspTimeout = (\(f, op\) => [^;]+);/.exec(lifecycle)[1])(() => 240, 90);
  expect(vspTimeout({type:"INTF"},"create")).to.equal(240);
  expect(vspTimeout({type:"INTF"})).to.equal(90);
  expect(vspTimeout({type:"CLAS"},"create")).to.equal(90);
  expect(vspTimeout({type:"DDLS"})).to.equal(240);
 });
 it("waits for the warm compiler as long as a DDLS call may take (the #942 slow runner ran out at 90 s)",()=>{
  expect(warmReadyTimeoutS({OSD_WARM_SPEED_FACTOR:"1"})).to.equal(240);
  expect(warmReadyTimeoutS({OSD_WARM_SPEED_FACTOR:"1.19"})).to.equal(286);
  expect(lifecycle).to.contain("const until=Date.now()+warmReadyTimeoutS()*1000;");
  expect(lifecycle).not.to.match(/Date\.now\(\)\+90000/);
 });
 it("never lets the client-side rpc ceiling be the binding budget",()=>{
  expect(vspClient).to.contain("Math.max(120000, (ddlsCallTimeoutS() + 60) * 1000)");
 });
 it("isolates the VSP child from the workstation config and survives its death",()=>{
  // A developer's ~/.vsp.json pins a real system; VSP reads it even from an
  // empty cwd and refuses the OSD logon.
  expect(vspClient).to.contain("HOME:cwd, USERPROFILE:cwd");
  expect(vspClient).to.contain('child.stdin.on("error", fail)');
 });
});
