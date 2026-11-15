import {expect} from "chai";
import {readFileSync} from "node:fs";
import * as abaplint from "@abaplint/core";
import {EXIT_TABLES, conversionExitAsks, conversionExitCalls, declaredTable} from "../tools/hana-closure-convexit.mjs";

// a model class of an island: one property unit-converted (functional and
// CALL METHOD forms), one ALPHA, one exit named only at run time
const MPC = `CLASS zcl_osd_cx_mpc DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS define IMPORTING io_property TYPE REF TO zif_osd_cx_property.
ENDCLASS.
CLASS zcl_osd_cx_mpc IMPLEMENTATION.
  METHOD define.
    DATA lv_exit TYPE string.
    io_property->set_conversion_exit( 'CUNIT' ).
    CALL METHOD io_property->set_conversion_exit EXPORTING iv_other = 'ALPHA' iv_conv_exit = 'CUNIT'.
    io_property->set_conversion_exit( 'ALPHA' ).
    io_property->set_conversion_exit( lv_exit ).
  ENDMETHOD.
ENDCLASS.
`;
const PROPERTY = `INTERFACE zif_osd_cx_property PUBLIC.
  METHODS set_conversion_exit IMPORTING iv_conv_exit TYPE string iv_other TYPE string OPTIONAL.
ENDINTERFACE.
`;

function island(source = MPC) {
  const reg = new abaplint.Registry();
  reg.addFile(new abaplint.MemoryFile("zcl_osd_cx_mpc.clas.abap", source));
  reg.addFile(new abaplint.MemoryFile("zif_osd_cx_property.intf.abap", PROPERTY));
  reg.parse();
  return reg;
}

describe("hana-closure-convexit: the tables a conversion exit reads (milestone 3)", () => {
  it("reads the literal exits an island object sets, both call forms, and skips a dynamic one", () => {
    const reg = island();
    const calls = conversionExitCalls(reg.getObject("CLAS", "ZCL_OSD_CX_MPC")).map((c) => c.exit);
    expect(calls).to.deep.equal(["CUNIT", "CUNIT", "ALPHA"]);
  });

  it("asks for the unit text table and the unit table once, named by the repo classes' constants", () => {
    const asks = conversionExitAsks(island(), [{object: "ZCL_OSD_CX_MPC", kind: "CLAS"}], process.cwd());
    expect(asks.map((a) => `${a.kind}:${a.name}`)).to.deep.equal(["tabl:T006A", "tabl:T006"]);
    expect(asks[0].finding).to.match(/^structural: conversion exit CUNIT set in ZCL_OSD_CX_MPC .* reads T006A \(ZCL_OSD_CUNIT=>C_TEXT_TABLE\)$/);
  });

  it("asks nothing for an island that sets no exit this tree implements", () => {
    const only = MPC.replace(/'CUNIT'/g, "'ALPHA'");
    expect(conversionExitAsks(island(only), [{object: "ZCL_OSD_CX_MPC", kind: "CLAS"}], process.cwd())).to.deep.equal([]);
  });

  it("fails when a declared constant is gone, instead of asking for nothing", () => {
    const d = EXIT_TABLES.CUNIT[0];
    const source = readFileSync(d.file, "utf8").replace(d.constant.toLowerCase(), "c_renamed");
    expect(() => declaredTable(source, d)).to.throw(/declares no table/);
    expect(declaredTable(readFileSync(d.file, "utf8"), d)).to.equal("T006A");
  });
});
