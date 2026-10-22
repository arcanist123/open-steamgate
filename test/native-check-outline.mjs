import {expect} from "chai";
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import * as lint from "@abaplint/core";
import {PARSE_KINDS} from "../tools/osd-store-destination.mjs";
import {files as classFiles, name as className} from "./adt-conformance/fixtures/source.mjs";

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
  this.timeout(120000);
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
  it("checks native snapshot, serialization, restoration and refusal contracts",()=>{
    const output=execFileSync("go",["test","./storelint","./cdscheck"],{cwd:resolve("tools/gogen/go"),encoding:"utf8"});expect(output).to.match(/ok\s+osg\/gogen\/storelint/);
  });
});
