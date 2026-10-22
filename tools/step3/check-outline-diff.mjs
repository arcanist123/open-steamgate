// Full corpus + mutation differential. A missing linked library is a refusal.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn, execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {join, dirname, resolve} from "node:path";
import {tmpdir} from "node:os";
import {createInterface} from "node:readline";
import * as lint from "@abaplint/core";
import {lintBuildSpec, goLintEngineGo, withGoLintModule} from "../gogen/lint-engine.mjs";
import {ObjectStore} from "../osd-store.mjs";
import {registryIssues, updateRegistryFiles, withSource} from "../osd-store-registry.mjs";
import {PARSE_KINDS} from "../osd-store-destination.mjs";
import {diagnostic} from "../osd-compiler-sidecar.mjs";
import {runsAs} from "../osd-main.mjs";

export async function differential({root=process.cwd(),library,out}) {
  if (!library) throw new Error("--library PATH is required: emit the pinned library and install cds-inspect first");
  root=resolve(root); library=resolve(library);
  const spec=await lintBuildSpec(root);
  const store=new ObjectStore({root});
  const types=["CLAS","INTF","PROG","INCL","DDLS","SRVD"];
  const objects=store.list().filter(o=>types.includes(o.type));
  const files=spec.files.map(Filename=>({Filename,Raw:readFileSync(join(root,Filename.slice(1)),"utf8")}));
  const scratch=mkdtempSync(join(tmpdir(),"osg-check-outline-"));
  const goRoot=resolve("tools/gogen/go"), build=join(goRoot,"cmd",scratch.split("/").at(-1));
  mkdirSync(build,{recursive:true});
  let child;
  const failures=[],counts={objects:0,checks:0,outlines:0,mutations:0,types:{}};
  const hashes={node:createHash("sha256"),go:createHash("sha256")};
  try {
    writeFileSync(join(build,"zz_lint.go"),goLintEngineGo({config:spec.config}));
    writeFileSync(join(build,"main.go"),readFileSync(new URL("./check-outline-driver/main.go.txt",import.meta.url)));
    const binary=join(scratch,"driver");
    withGoLintModule(goRoot,library,args=>execFileSync("go",["build",...args,"-o",binary,"./cmd/"+build.split("/").at(-1)],{cwd:goRoot,stdio:"inherit",env:{...process.env,GOWORK:"off",GOFLAGS:process.env.GOFLAGS??"-p=1 -gcflags=-N"}}));
    child=spawn(binary,[],{stdio:["pipe","pipe","inherit"],env:{...process.env,PATH:join(scratch,"no-node-or-bun")}});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const call=async request=>{child.stdin.write(JSON.stringify(request)+"\n");const line=await lines.next();if(line.done)throw new Error("native driver exited");const response=JSON.parse(line.value);if(response.Error)throw new Error(response.Error);return response.Value;};
    await call({Command:"prime",Root:root,Config:spec.config,Files:files});
    const registry=store.registry();
    const compare=(label,node,go)=>{
      const expected=typeof node==="string"?node:JSON.stringify(node);
      const actual=typeof go==="string"?go:JSON.stringify(go);
      hashes.node.update(label+"\n"+expected+"\n");hashes.go.update(label+"\n"+actual+"\n");
      try {assert.equal(actual,expected);}catch {failures.push({label,node,go});if(failures.length<=8) console.error("parity mismatch",label);}
    };
    const run=async(object,objectFiles,options={})=>{
      const {type:Type,name:Name}=object;
      const Input={Root:root,Type,Name,Version:options.version??"inactive",Files:objectFiles.map(f=>f.Filename.slice(1)),Logical:objectFiles.map(f=>f.Filename.slice(1))};
      if(options.source!==undefined) {Input.Source=options.source;Input.Include=options.include??"main";Input.Target=objectFiles[0]?.Filename.slice(1);}
      const replacements=options.files;
      if(!options.onlyOutline) {
        const checked=options.source===undefined?registryIssues(registry,Type,Name):withSource({registry:()=>registry},objectFiles[0].Filename.slice(1),options.source,reg=>registryIssues(reg,Type,Name));
        const diagnostics=[...new Map(checked.issues.map(i=>{const d=diagnostic({...i,type:Type,name:Name});return [JSON.stringify(d),d];})).values()];
        const rows=diagnostics.map(d=>({OBJ_TYPE:Type,OBJ_NAME:Name,FILE:d.include?"/"+d.include.replace(/^\//,""):"",LINE:d.line,COL:d.col+1,RULE:d.rule,MESSAGE:d.text}));
        const scalars={EV_COUNT:String(rows.length),...(rows.length?{}:{EV_ACTIVE:"X"}),EV_JSON:JSON.stringify({active:rows.length===0,live:false,note:"",issues:rows})};
        const got=await call({Command:"check",Input,Files:replacements});
        // Map order belongs to Go's generic JSON encoder; compare each scalar's bytes and the ordered RFC rows.
        compare(`${options.label??"saved"} CHECK ${Type} ${Name}`,{Scalars:Object.fromEntries(Object.entries(scalars).sort()),Issues:rows},got);counts.checks++;
      }
      if(options.source===undefined) {
        const snapshotRegistry=new lint.Registry(new lint.Config(spec.config));
        for(const f of objectFiles)snapshotRegistry.addFile(new lint.MemoryFile(f.Filename,f.Raw));
        snapshotRegistry.parse();
        const snapshotStore={find:()=>({name:Name}),registry:()=>snapshotRegistry,withActiveSources:(_e,fn)=>fn(snapshotRegistry)};
        const expected=await PARSE_KINDS.OUTLINE(snapshotStore,{type:Type,name:Name,version:Input.Version});
        const got=await call({Command:"outline",Input,Files:replacements});
        compare(`${options.label??"saved"} OUTLINE ${Type} ${Name} ${Input.Version}`,JSON.stringify(expected),JSON.stringify(got));counts.outlines++;
      }
    };
    for(const object of objects) {
      const parsed=registry.getObject(object.type==="INCL"?"PROG":object.type,object.name);
      const objectFiles=(parsed?.getFiles()??[]).map(f=>({Filename:f.getFilename(),Raw:f.getRaw()}));
      await run(object,objectFiles);await run(object,objectFiles,{version:"active",onlyOutline:true});counts.objects++;counts.types[object.type]=(counts.types[object.type]??0)+1;
    }
    const mutationFiles=[
      {Filename:"/src/znative_outline.clas.abap",Raw:"CLASS znative_outline DEFINITION PUBLIC FINAL. PUBLIC SECTION. METHODS run. ENDCLASS. CLASS znative_outline IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS."},
      {Filename:"/src/znative_outline.clas.locals_def.abap",Raw:"CLASS lcl_one DEFINITION. PUBLIC SECTION. METHODS run. ENDCLASS. CLASS lcl_two DEFINITION. PUBLIC SECTION. METHODS run. ENDCLASS."},
      {Filename:"/src/znative_outline.clas.locals_imp.abap",Raw:"CLASS lcl_one IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS. CLASS lcl_two IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS."},
      {Filename:"/src/znative_outline.clas.testclasses.abap",Raw:"CLASS ltc_test DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS. PRIVATE SECTION. METHODS run FOR TESTING. ENDCLASS. CLASS ltc_test IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS."},
      {Filename:"/src/znative_outline.clas.macros.abap",Raw:"DEFINE example. WRITE &1. END-OF-DEFINITION."},
    ];
    // Mutate only a disposable snapshot root, preserving the user's checkout.
    const mutationRoot=join(scratch,"mutations");mkdirSync(join(mutationRoot,"src"),{recursive:true});
    const originalRoot=root;root=mutationRoot;
    await call({Command:"prime",Root:root,Config:spec.config,Files:mutationFiles});
    let current=mutationFiles.map(f=>({...f}));
    const sync=()=>{for(const f of current){const p=join(root,f.Filename.slice(1));mkdirSync(dirname(p),{recursive:true});writeFileSync(p,f.Raw);}updateRegistryFiles(registry,mutationFiles.map(f=>[f.Filename,current.find(c=>c.Filename===f.Filename)?.Raw]));};
    const object={type:"CLAS",name:"ZNATIVE_OUTLINE"};
    for(const label of ["locals-tests-macros","edited","broken","empty","include-removed","include-added"]) {
      if(label==="edited")current[0].Raw=current[0].Raw.replace("METHOD run.","METHOD run. WRITE 'edited'.");
      if(label==="broken")current[0].Raw="CLASS znative_outline DEFINITION PUBLIC. PUBLIC SECTION. METHODS run. ENDCLASS. CLASS znative_outline IMPLEMENTATION. METHOD run. invalid statement. ENDMETHOD. ENDCLASS.";
      if(label==="empty")current[0].Raw="";
      if(label==="include-removed")current=current.filter(f=>!f.Filename.includes("locals_imp"));
      if(label==="include-added")current.push({...mutationFiles[2]});
      sync();await run(object,current,{files:current,label});counts.mutations++;
    }
    // Inline empty/broken overlays must restore the persistent registry.
    for(const source of ["",mutationFiles[0].Raw,"broken inline."]) {
      sync();await run(object,current,{source,label:"inline",files:current});await run(object,current,{label:"restored"});counts.mutations++;
    }
    // Other source types include explicit INCL/SRVD coverage even on checkouts
    // with no stored examples. Every shape is checked saved, active and inline.
    const shapes=[
      ["INTF",".intf.abap",["INTERFACE znative_mut PUBLIC. METHODS run. ENDINTERFACE.","INTERFACE znative_mut PUBLIC. DATA edited TYPE i. ENDINTERFACE.","broken interface.",""]],
      ["PROG",".prog.abap",["REPORT znative_mut. INITIALIZATION. WRITE 'init'. START-OF-SELECTION. FORM run. ENDFORM.","REPORT znative_mut. CLASS lcl_run DEFINITION. ENDCLASS. CLASS lcl_run IMPLEMENTATION. ENDCLASS.","REPORT znative_mut. broken statement.",""]],
      ["INCL",".prog.abap",["DATA value TYPE i.","DEFINE example. WRITE &1. END-OF-DEFINITION.","broken include.",""]],
      ["SRVD",".srvd.srvdsrv",["define service znative_mut { expose zmissing; }","define service znative_mut { expose zedited as edited; }","broken service",""]],
      ["DDLS",".ddls.asddls",["define view entity znative_mut as select from zmissing { key id }","define view entity znative_mut as select from zmissing { key edited }","broken view", "", "define table function znative_mut returns { id : abap.int4; } implemented by method zcl_missing=>run;", "define view entity znative_mut as select from zmissing { key id } where id = 'A'", "define view entity znative_mut as select from zmissing inner join zother on zmissing.id = zother.id { key zmissing.id }", "@ObjectModel.writeEnabled: true\ndefine view entity znative_mut as select from zmissing { key id }"]],
    ];
    for(const [type,suffix,variants] of shapes) {
      const Filename="/src/znative_mut"+suffix;
      await call({Command:"prime",Root:root,Config:spec.config,Files:[]});
      for(const [i,Raw] of variants.entries()) {
        const file={Filename,Raw};writeFileSync(join(root,Filename.slice(1)),Raw);updateRegistryFiles(registry,[[Filename,Raw]]);
        await run({type,name:"ZNATIVE_MUT"},[file],{files:[file],label:`mutation-${i}`});
        await run({type,name:"ZNATIVE_MUT"},[file],{version:"active",onlyOutline:true,label:`mutation-${i}`});
        await run({type,name:"ZNATIVE_MUT"},[file],{source:Raw,label:`inline-${i}`});counts.mutations++;
      }
      updateRegistryFiles(registry,[[Filename,undefined]]);
    }
    // Dictionary extraction: disappearing generated fields, missing keys,
    // analytical writes, virtual/cast refusals, and annotation case/spacing.
    const dictionary=[
      {Filename:"/src/zstg_demo.tabl.xml",Raw:readFileSync(join(originalRoot,"src/ddic/zstg_demo.tabl.xml"),"utf8")},
      {Filename:"/src/znative_gen.view.xml",Raw:`<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DD25V><VIEWNAME>ZNATIVE_GEN</VIEWNAME><VIEWCLASS>D</VIEWCLASS></DD25V><DD27P_TABLE><DD27P><VIEWFIELD>TRAVEL_ID</VIEWFIELD><TABNAME>ZSTG_DEMO</TABNAME><FIELDNAME>TRAVEL_ID</FIELDNAME><KEYFLAG>X</KEYFLAG></DD27P><DD27P><VIEWFIELD>OLD_FIELD</VIEWFIELD><TABNAME>ZSTG_DEMO</TABNAME><FIELDNAME>DESCRIPTION</FIELDNAME></DD27P></DD27P_TABLE></asx:values></asx:abap></abapGit>`},
    ];
    updateRegistryFiles(registry,dictionary.map(f=>[f.Filename,f.Raw]));
    const casts=[
      "key travel_id, description", "description",
      "key travel_id, cast( description as abap.char(20) ) as text",
      "key travel_id, cast( 'constant' as abap.char(20) ) as text",
      "key travel_id, cast( description as abap.unknown(20) ) as text",
      "key travel_id, @ObjectModel.virtualElement: true cast( '' as abap.char(20) ) as text",
      "key travel_id, @ObjectModel.virtualElement: true @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_TEST' cast( '' as abap.char(20) ) as text",
      "key travel_id, @ObjectModel.virtualElement: true @ObjectModel.virtualElementCalculatedBy: 'ABAP:ZCL_TEST' cast( '' as abap.unknown(20) ) as text",
    ];
    await call({Command:"prime",Root:root,Config:spec.config,Files:dictionary});
    for(const [i,fields]of casts.entries()) {
      const Raw="@AbapCatalog.sqlViewName: 'ZNATIVE_GEN'\n@ObjectModel.writeEnabled: true\ndefine view znative_mut as select from zstg_demo { "+fields+" }";
      const file={Filename:"/src/znative_mut.ddls.asddls",Raw};writeFileSync(join(root,file.Filename.slice(1)),Raw);updateRegistryFiles(registry,[[file.Filename,Raw]]);
      await run({type:"DDLS",name:"ZNATIVE_MUT"},[file],{files:[...dictionary,file],label:`dictionary-${i}`});counts.mutations++;
    }
    root=originalRoot;
    const result={counts,files:files.length,runtime:{path:"no executables on PATH",other:"panic sentinel"},hashes:{node:hashes.node.digest("hex"),go:hashes.go.digest("hex")},failures};
    if(out)writeFileSync(out,JSON.stringify(result,null,2)+"\n");
    console.log(JSON.stringify({...result,failures:failures.length},null,2));
    assert.equal(failures.length,0,"CHECK/OUTLINE differential failed");
    return result;
  } finally {child?.stdin.end();if(child){await new Promise(r=>child.once("close",r));}rmSync(build,{recursive:true,force:true});rmSync(scratch,{recursive:true,force:true});}
}
if(runsAs("check-outline-diff.mjs")) {
  const args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];
  await differential({library:args.includes("--library")?option("--library"):undefined,root:args.includes("--root")?option("--root"):process.cwd(),out:args.includes("--out")?option("--out"):undefined});
}
