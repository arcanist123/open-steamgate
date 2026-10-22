import {expect} from "chai";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import * as lint from "@abaplint/core";
import {ddlsIssues} from "../tools/osd-store-ddls.mjs";
import {PARSE_KINDS} from "../tools/osd-store-destination.mjs";
import {files as classFiles, name as className} from "./adt-conformance/fixtures/source.mjs";

const {describe,it}=globalThis.describe?globalThis:await import("node:test");
const pos=p=>({Row:p.getRow(),Col:p.getCol()});
function tree(n) {
  const Statement=n.constructor.name==="StatementNode";
  const Children=Statement?[]:(n.getChildren?.()??[]).map(tree);
  const bounded=Statement||Children.length>0;
  return {Kind:n.get().constructor.name,Statement,
    Start:bounded?pos(n.getFirstToken().getStart()):{Row:0,Col:0},
    End:bounded?pos(n.getLastToken().getEnd()):{Row:0,Col:0},Children,
    Tokens:Statement?n.getTokens().map(t=>({Str:t.getStr(),Start:pos(t.getStart()),End:pos(t.getEnd()),Pragma:t.constructor.name==="Pragma"})):[]};
}
describe("native CHECK and OUTLINE",function(){
  this.timeout?.(120000);
  it("matches real Node OUTLINE bytes over the public Tree shape",async()=>{
    const fixtures=[
      {type:"CLAS",name:className,files:classFiles},
      {type:"INTF",name:"ZIF_NATIVE",files:{"zif_native.intf.abap":"INTERFACE zif_native PUBLIC. METHODS run. DATA value TYPE i. ENDINTERFACE."}},
      {type:"PROG",name:"ZNATIVE",files:{"znative.prog.abap":"REPORT znative. INITIALIZATION. WRITE 'init'. START-OF-SELECTION. FORM run. WRITE 'run'. ENDFORM."}},
      {type:"INCL",name:"ZNATIVE",files:{"znative.prog.abap":"CLASS lcl_local DEFINITION. ENDCLASS. CLASS lcl_local IMPLEMENTATION. ENDCLASS."}},
      {type:"PROG",name:"ZEMPTY",files:{"zempty.prog.abap":""}},
      {type:"DDLS",name:"ZNATIVE",files:{"znative.ddls.asddls":"define view entity znative as select from t000 { key mandt }"}},
      {type:"SRVD",name:"ZNATIVE",files:{"znative.srvd.srvdsrv":"define service znative { expose znative; }"}},
    ];
    const inputs=[],expected=[];
    for(const fixture of fixtures)for(const version of ["active","inactive"]){
      const reg=new lint.Registry();for(const [file,raw]of Object.entries(fixture.files))reg.addFile(new lint.MemoryFile("/src/"+file,raw));reg.parse();
      const obj=reg.getObject(fixture.type==="INCL"?"PROG":fixture.type,fixture.name);
      const files=["CLAS","INTF"].includes(fixture.type)?obj.getSequencedFiles():obj.getABAPFiles?.()??[];
      inputs.push({Type:fixture.type,Name:fixture.name,Version:version,Files:files.map(f=>({Filename:f.getFilename(),Structure:f.getStructure()?tree(f.getStructure()):null,Statements:f.getStatements().map(tree)}))});
      expected.push(JSON.stringify(await PARSE_KINDS.OUTLINE({find:()=>({name:fixture.name}),registry:()=>reg,withActiveSources:(_e,fn)=>fn(reg)},{...fixture,version})));
    }
    const scratch=mkdtempSync(join(tmpdir(),"outline-oracle-"));
    try{
      const main=join(scratch,"main.go");writeFileSync(main,`package main
import("encoding/json";"os";"fmt";"osg/gogen/adtoutline")
func main(){var inputs []struct{Type,Name,Version string;Files []adtoutline.FileTree};if e:=json.NewDecoder(os.Stdin).Decode(&inputs);e!=nil{panic(e)};for _,i:=range inputs{fmt.Println(string(adtoutline.Document(i.Type,i.Name,i.Version,i.Files)))}}
`);
      const got=execFileSync("go",["run",main],{cwd:resolve("tools/gogen/go"),input:JSON.stringify(inputs),encoding:"utf8",maxBuffer:8*1024*1024}).trimEnd().split("\n");
      expect(got).to.deep.equal(expected);
    }finally{rmSync(scratch,{recursive:true,force:true});}
  });
  it("matches Node CDS policy over critic-shaped parser and dictionary facts",()=>{
    const table=readFileSync("src/ddic/zstg_demo.tabl.xml","utf8");
    const generated=`<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DD25V><VIEWNAME>ZGEN</VIEWNAME><VIEWCLASS>D</VIEWCLASS></DD25V><DD27P_TABLE>${["MANDT","TRAVEL_ID","OLD_FIELD"].map(name=>`<DD27P><VIEWFIELD>${name}</VIEWFIELD><TABNAME>ZSTG_DEMO</TABNAME><FIELDNAME>${name==="OLD_FIELD"?"DESCRIPTION":name}</FIELDNAME></DD27P>`).join("")}</DD27P_TABLE></asx:values></asx:abap></abapGit>`;
    const select=(fields,annotations="",source="zstg_demo")=>`@AbapCatalog.sqlViewName: 'ZGEN'\n${annotations}\ndefine view zprobe as select from ${source} { ${fields} }`;
    const virtual=(by,type="char(20)",alias="as text")=>`key travel_id, @ObjectModel.virtualElement: true ${by===null?"":`@ObjectModel.virtualElementCalculatedBy: 'ABAP:${by}'`} cast( '' as abap.${type} ) ${alias}`;
    const variants=[
      select("key travel_id").replace("'ZGEN'", "''"),
      select("key travel_id").replace("@AbapCatalog.sqlViewName: 'ZGEN'", ""),
      select("key travel_id"),select("key mandt, key travel_id"),select("key mandt as client, key travel_id"),
      select("key mandt as first_client, mandt as second_client, key travel_id"),
      ...[null,"","   ","\ufeff"," ZCL_TEST "].map(by=>select(virtual(by))),
      select(virtual("ZCL_TEST","unknown(20)")),select(virtual("ZCL_TEST","char(20)","")),
      select("key travel_id, cast( description as abap.char(20) ) as text"),
      select("key travel_id, cast( 'literal' as abap.char(20) ) as text"),
      select("key travel_id, cast( description as abap.unknown(20) ) as text"),
      select("description","@ObjectModel.writeEnabled: true"),
      ...["write","create","update","delete"].map(flag=>select("key travel_id",`@ObjectModel.${flag}Enabled: true`)),
      select("key travel_id","@ObjectModel.writeEnabled: true\n@Analytics.dataCategory: #CUBE"),
      select("key travel_id","","zmissing"),select("key travel_id","","zstg_demo as t"),
      "define view entity zprobe as select from zstg_demo { key travel_id }",
      "define view entity zprobe as select from zstg_demo { key travel_id } where travel_id = '1'",
      "define view entity zprobe as select from zstg_demo as a inner join zstg_demo as b on a.travel_id = b.travel_id { key a.travel_id }",
      "define table function zprobe returns { id: abap.int4; } implemented by method zcl_test=>run;",
      "broken CDS",
      ...["char(20)","numc(10)","sstring(20)","string","int1","int2","int4","int8","dats","tims","dec(15,2)","curr(15,2)","quan(15,2)"].map(type=>select(virtual("ZCL_TEST",type))),
    ];
    const expr=n=>({Kind:n.get().constructor.name,Text:n.concatTokens(),Children:n.getChildren().filter(c=>c.constructor.name==="ExpressionNode").map(expr)});
    const inputs=[],expected=[];
    // The pinned parser only captures nonempty SQL names. Also exercise the
    // public snapshot contract's explicit empty value against Node's ?? policy.
    variants.push({raw:select("key travel_id"),sqlView:""});
    for(const variant of variants){
      const raw=typeof variant==="string"?variant:variant.raw;
      const reg=new lint.Registry();
      for(const [file,text] of [["zstg_demo.tabl.xml",table],["zgen.view.xml",generated],["zprobe.view.xml",generated.replaceAll("ZGEN","ZPROBE")],["zprobe.ddls.asddls",raw]])reg.addFile(new lint.MemoryFile("/src/"+file,text));
      reg.parse();
      if(typeof variant!=="string"){
        const object=reg.getObject("DDLS","ZPROBE"),parsed=object.getParsedData();
        object.getParsedData=()=>({...parsed,sqlViewName:variant.sqlView});
        object.getSQLViewName=()=>variant.sqlView;
      }
      const inspect=(typ,name)=>{const o=reg.getObject(typ,name);return o?{Found:true,Files:o.getFiles().map(f=>({Filename:f.getFilename(),Raw:f.getRaw()})),Tree:o.getTree?.()?expr(o.getTree()):null,SQLView:o.getSQLViewName?.()??null,Components:o.parseType?.(reg)?.getComponents?.().map(c=>c.name)??[],Keys:o.listKeys?.(reg)??[]}:{Found:false}};
      inputs.push({Objects:Object.fromEntries([["DDLS","ZPROBE"],["TABL","ZSTG_DEMO"],["VIEW","ZGEN"],["VIEW","ZPROBE"]].map(([t,n])=>[t+":"+n,inspect(t,n)]))});
      expected.push(ddlsIssues(reg,reg.getObject("DDLS","ZPROBE")).map(i=>({Filename:i.file??"",Severity:i.severity,Message:i.message})));
    }
    const scratch=mkdtempSync(join(tmpdir(),"cds-oracle-"));
    try{
      const main=join(scratch,"main.go");writeFileSync(main,`package main
import("encoding/json";"os";"osg/gogen/cdscheck")
func main(){var inputs []struct{Objects map[string]cdscheck.Object};if e:=json.NewDecoder(os.Stdin).Decode(&inputs);e!=nil{panic(e)};out:=[][]cdscheck.Issue{};for _,i:=range inputs{out=append(out,cdscheck.Issues("ZPROBE",func(t,n string)cdscheck.Object{return i.Objects[t+":"+n]}))};json.NewEncoder(os.Stdout).Encode(out)}
`);
      const got=JSON.parse(execFileSync("go",["run",main],{cwd:resolve("tools/gogen/go"),input:JSON.stringify(inputs),encoding:"utf8",maxBuffer:8*1024*1024}));
      for(const [i,want] of expected.entries())expect(got[i],variants[i]).to.deep.equal(want);
    }finally{rmSync(scratch,{recursive:true,force:true});}
  });
  it("checks native snapshot, serialization, restoration and refusal contracts",()=>{
    const output=execFileSync("go",["test","./storelint","./cdscheck"],{cwd:resolve("tools/gogen/go"),encoding:"utf8"});expect(output).to.match(/ok\s+osg\/gogen\/storelint/);
  });
});
