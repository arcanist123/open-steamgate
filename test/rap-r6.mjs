// R6: internal, determine and factory actions on the bill demo of
// src/rap_r6 (docs/rap-runtime.md, "R6"): an internal action executed IN
// LOCAL MODE by a determination and exposed nowhere, a determine action
// running a validation where its triggers hold and a determination
// ( always ), a factory action answering its copy. The generator half runs
// without a build; the wire half needs a transpiled tree (npm run
// transpile). The runtime half is ABAP Unit: ZCL_OSD_RAP_R6_TEST.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {parseBdef} from "../tools/rap/bdef-parse.mjs";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {runtimeOutputs} from "../tools/rap/rap-runtime-gen.mjs";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const v2 = `${origin}/sap/opu/odata/sap/ZUI_RAP_BILL`;
const v4 = `${origin}/sap/opu/odata4/sap/ZUI_RAP_BILL`;
const v2c = `${origin}/sap/opu/odata/sap/ZUI_RAP_BILLC`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json"};
const bill = () => walk("src/rap_r6").filter(f => /\.(abap|xml|asbdef|asddls|srvdsrv)$/.test(f))
  .map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
const pools = files => files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename));
const build = files => {
  const {outputs, plans} = generate(files);
  return {outputs, runtime: runtimeOutputs(plans, pools(files))};
};
const swap = (files, name, from, to) => files.map(f => {
  if (f.filename !== name) return f;
  assert.ok(f.contents.includes(from), `${name}: ${from}`);
  return {...f, contents: f.contents.replace(from, to)};
});
const refusal = files => { try { build(files); } catch (error) { return error.message; } return "accepted"; };
const BDEF = "zi_rap_bill.bdef.asbdef";

// the projection of the bill with other uses, for what a projection may use
const projection = (uses) => bill().map(f => f.filename !== "zc_rap_bill.bdef.asbdef" ? f
  : {...f, contents: `projection;\ndefine behavior for ZC_RAP_BILL alias Bill\n{\n  use create;\n${uses.map(u => `  use action ${u};`).join("\n")}\n}\n`});

async function call(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body, headers: res.headers};
}

describe("RAP R6 actions (generator)", () => {
  it("reads ( always ) and the three action kinds", () => {
    const model = parseBdef(bill().find(f => f.filename === BDEF).contents);
    const [e] = model.entities;
    assert.deepEqual(e.actions.map(a => [a.name, a.modifiers]), [["ReCalcTotal", ["internal"]], ["copyBill", ["factory"]]]);
    assert.deepEqual(e.determineActions[0].triggers, [
      {kind: "validation", name: "checkAmount", options: []},
      {kind: "determination", name: "countCheck", options: [{name: "always", value: null}]},
    ]);
  });

  it("writes the model: internal, factory, the determine action's members", () => {
    const {runtime} = build(bill());
    const adapter = Object.entries(runtime).find(([n, s]) => n.startsWith("zcl_rap_") && s.includes("ZI_RAP_BILL"))[1];
    for (const text of [
      "ls_callable-name = 'RECALCTOTAL'.\n    ls_callable-method = 'RECALC_TOTAL'.\n    ls_callable-internal = abap_true.",
      "ls_callable-name = 'COPYBILL'.\n    ls_callable-method = 'COPY_BILL'.\n    ls_callable-factory = abap_true.",
      "ls_callable-kind = 'X'.\n    ls_callable-name = 'CHECK'.",
      "ls_member-kind = 'V'.\n    ls_member-name = 'CHECKAMOUNT'.\n    APPEND ls_member TO ls_callable-members.",
      "ls_member-kind = 'D'.\n    ls_member-name = 'COUNTCHECK'.\n    ls_member-always = abap_true.",
      // the caller's MAPPED reaches the factory handler
      "mapped = <ls_mapped>",
      "WHEN 'ZI_RAP_BILL~ACTION IMPORT~CHECK'.",
    ]) assert.ok(adapter.includes(text), text);
    // a determine action has no handler method of its own
    assert.ok(!adapter.includes("WHEN 'ZI_RAP_BILL~CHECK'."));
  });

  it("gives a factory action's import a %cid, a determine action's none", () => {
    const iface = Object.entries(build(bill()).outputs).find(([n]) => n.startsWith("zif_rap_"))[1];
    assert.match(iface, /BEGIN OF e0_a1_import\.\n  INCLUDE TYPE e0_tky AS %tky\.\n  TYPES %cid TYPE c LENGTH 128\.\n  TYPES %cid_ref/);
    assert.match(iface, /BEGIN OF e0_a2_import\.\n  INCLUDE TYPE e0_tky AS %tky\.\n  TYPES %cid_ref/);
    assert.match(iface, /recalctotal TYPE x LENGTH 1,\n\s+copybill TYPE x LENGTH 1,\n\s+check TYPE x LENGTH 1,/);
  });

  it("exposes the factory and the determine action, never the internal action", () => {
    const yaml = build(bill()).outputs["zui_rap_bill.stg.yaml"];
    assert.match(yaml, /\n  copyBill:\n    method: POST\n/);
    assert.match(yaml, /\n  check:\n    method: POST\n/);
    assert.ok(!/ReCalcTotal/i.test(yaml), yaml);
  });

  it("lets a projection use the factory and the determine action, not the internal one", () => {
    const {runtime} = build(projection(["copyBill", "check"]));
    assert.ok(runtime["zcl_osd_rap_registry.clas.abap"].includes("APPEND 'COPYBILL' TO rs_projection-actions."));
    assert.match(refusal(projection(["ReCalcTotal"])), /use action ReCalcTotal, which is internal to ZI_RAP_BILL/);
  });

  it("refuses the action shapes R6 does not run, each by name", () => {
    const files = bill();
    const det = "determine action check { validation checkAmount; determination ( always ) countCheck; }";
    for (const [from, to, error] of [
      [det, "determine action check { determination calcTotal; }", /determination calcTotal is on modify/],
      [det, "determine action check { validation missing; }", /validation missing, which ZI_RAP_BILL does not declare/],
      // R11: a root's determine action may name members of the entities
      // below it; an entity the BDEF does not declare is still refused
      [det, "determine action check { validation Other~checkAmount; }", /validation Other~checkAmount of another entity, which this behavior definition does not declare/],
      [det, "determine action check { validation ( foo ) checkAmount; }", /options other than always/],
      [det, "draft determine action check { validation checkAmount; }", /a draft determine action in a behavior definition without with draft/],
      [det, "determine action ( features : instance ) check { validation checkAmount; }", /determine action options \(features : instance\) are outside R6/],
      [det, "determine action ( authorization : update ) check { validation checkAmount; }", /determine action options \(authorization : update\) are outside R6/],
      ["factory action copyBill [1];", "static action copyBill;", /static actions are outside R6/],
      ["factory action copyBill [1];", "factory action copyBill [1] result [1] $self;", /a factory action has no result/],
      ["factory action copyBill [1];", "factory action copyBill [0..*];", /cardinality \[1\]/],
      ["internal action ReCalcTotal;", "internal action ReCalcTotal parameter ZI_RAP_BILL;", /without parameter/],
      ["internal action ReCalcTotal;", "internal action ReCalcTotal;\n  function getTotal result [1] $self;", /functions are outside R6/],
    ]) assert.match(refusal(swap(files, BDEF, from, to)), error, `${from} -> ${to}`);
    // a qualified member of the entity itself is its own
    assert.equal(refusal(swap(files, BDEF, det, "determine action check { validation bill~checkAmount; }")), "accepted");
  });
});

// R5's order demo with a third level, a note below each item that is
// locked by its order through an association other than its parent's
const grandchild = (lock = "lock dependent by _Order") => {
  const order = walk("src/rap_r5").filter(f => /\.(abap|xml|asbdef|asddls)$/.test(f) && !/zc_rap_|\.srvd\./.test(f))
    .map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
  const table = order.find(f => f.filename === "zrap_orditem.tabl.xml").contents.replaceAll("ZRAP_ORDITEM", "ZRAP_ORDSUB")
    .replace(/<DD03P><FIELDNAME>PRODUCT<\/FIELDNAME>/, "<DD03P><FIELDNAME>SUB_NO</FIELDNAME><KEYFLAG>X</KEYFLAG><INTTYPE>N</INTTYPE><INTLEN>000008</INTLEN><DATATYPE>NUMC</DATATYPE><LENG>000004</LENG><NOTNULL>X</NOTNULL></DD03P>\n<DD03P><FIELDNAME>PRODUCT</FIELDNAME>");
  return order.map(f => {
    if (f.filename === "zi_rap_orditem.ddls.asddls") return {...f, contents: f.contents
      .replace("as select from zrap_orditem\n", "as select from zrap_orditem\n  composition [0..*] of ZI_RAP_ORDSUB as _Subs\n")
      .replace("      _Order\n", "      _Order,\n      _Subs\n")};
    if (f.filename === "zi_rap_order.bdef.asbdef") return {...f, contents: f.contents.replace("  association _Order;\n", "  association _Order;\n  association _Subs { create; }\n") + `
define behavior for ZI_RAP_ORDSUB alias sub
persistent table zrap_ordsub
${lock}
{
  update;
  field ( readonly ) order_id, item_no, sub_no;
  association _Item;
  association _Order;
  association _ItemToo;
  mapping for zrap_ordsub corresponding;
}
`};
    return f;
  }).concat([
    {filename: "zrap_ordsub.tabl.xml", contents: table},
    {filename: "zi_rap_ordsub.ddls.asddls", contents: `@EndUserText.label: 'RAP order item note (R6 test)'
define view entity ZI_RAP_ORDSUB as select from zrap_ordsub
  association to parent ZI_RAP_ORDITEM as _Item on $projection.order_id = _Item.order_id and $projection.item_no = _Item.item_no
  association [1..1] to ZI_RAP_ORDER as _Order on $projection.order_id = _Order.order_id
  association [1..1] to ZI_RAP_ORDITEM as _ItemToo on $projection.order_id = _ItemToo.order_id and $projection.item_no = _ItemToo.item_no
{
  key order_id,
  key item_no,
  key sub_no,
      product,
      _Item,
      _Order,
      _ItemToo
}
`}]);
};

describe("RAP R6 dependencies on an ancestor (generator)", () => {
  it("accepts a grandchild locked by its root through an association of its own (the flight booking supplement)", () => {
    assert.equal(refusal(grandchild()), "accepted");
    const {runtime} = build(grandchild());
    const adapter = Object.entries(runtime).find(([n, s]) => n.startsWith("zcl_rap_") && s.includes("ZI_RAP_ORDSUB"))[1];
    assert.ok(adapter.includes("ls_entity-name = 'ZI_RAP_ORDSUB'."));
    assert.match(adapter, /ls_entity-name = 'ZI_RAP_ORDSUB'\.[\s\S]*?ls_entity-root = 'ZI_RAP_ORDER'\.\n    ls_entity-parent = 'ZI_RAP_ORDITEM'\.\n    ls_entity-parent_assoc = '_ITEM'\.\n    ls_entity-lock = 'D'\./);
    assert.equal(refusal(grandchild("lock dependent by _Item\netag dependent by _Order\nauthorization dependent by _Order")), "accepted");
  });

  it("refuses a lock by an ancestor that is not the lock master", () => {
    assert.match(refusal(grandchild("lock dependent by _ItemToo")), /lock dependent by _ItemToo, whose target ZI_RAP_ORDITEM is not the lock master ZI_RAP_ORDER/);
  });
});

describe("RAP R6 actions over OData", function () {
  this.timeout(120000);
  let server;
  before(async () => {
    server = startServer(true);
    for (let i = 0; i < 600; i++) {
      try {
        if ((await fetch(`${v2}/$metadata`)).status === 200) break;
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
  });
  after(() => server.close());

  const create = (amount, discount) => call(`${v2}/Bill`, {method: "POST", headers: write, body: JSON.stringify({description: "bill", amount, discount})});
  const read = async (id) => (await call(`${v2}/Bill('${id}')?$format=json`, {headers: {accept: "application/json"}})).body.d;

  it("publishes the factory and the determine action, not the internal action (V2 and V4)", async () => {
    const xml = (await call(`${v2}/$metadata`)).body;
    assert.match(xml, /<FunctionImport Name="copyBill"[^>]*m:HttpMethod="POST"/);
    assert.match(xml, /<FunctionImport Name="check"[^>]*m:HttpMethod="POST"/);
    assert.ok(!/ReCalcTotal/i.test(xml));
    const meta = (await call(`${v4}/$metadata`)).body;
    assert.match(meta, /<Action Name="copyBill" IsBound="true"/);
    assert.match(meta, /<Action Name="check" IsBound="true"/);
    assert.ok(!/ReCalcTotal/i.test(meta));
  });

  it("computes the total through the internal action, which no client can call", async () => {
    const res = await create(100, 30);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.d.bill_id;
    assert.equal(res.body.d.total, 70);
    const patch = await call(`${v2}/Bill('${id}')`, {method: "PATCH", headers: write, body: JSON.stringify({discount: 40})});
    assert.equal(patch.status, 204, JSON.stringify(patch.body));
    assert.equal((await read(id)).total, 60);
    const v2call = await call(`${v2}/ReCalcTotal?bill_id='${id}'`, {method: "POST", headers: write});
    assert.equal(v2call.status, 404, JSON.stringify(v2call.body));
    const v4call = await call(`${v4}/Bill('${id}')/ZUI_RAP_BILL.ReCalcTotal`, {method: "POST", headers: write, body: "{}"});
    assert.equal(v4call.status, 404, JSON.stringify(v4call.body));
    assert.match(v4call.body.error.message, /Unknown operation ZUI_RAP_BILL\.ReCalcTotal/);
  });

  it("answers a factory action with the new instance (V2)", async () => {
    const id = (await create(50, 5)).body.d.bill_id;
    const res = await call(`${v2}/copyBill?bill_id='${id}'`, {method: "POST", headers: write});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const copy = res.body.d;
    assert.notEqual(copy.bill_id, id);
    assert.equal(copy.copied_from, id);
    assert.equal(copy.amount, 50);
    assert.equal(copy.total, 45);
    assert.equal((await read(copy.bill_id)).description, "bill");
    // the source is unchanged
    assert.equal((await read(id)).copied_from, "00000000");
  });

  it("answers a factory action with the new instance (V4)", async () => {
    const id = (await create(12, 2)).body.d.bill_id;
    const res = await call(`${v4}/Bill('${id}')/ZUI_RAP_BILL.copyBill`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.bill_id, id);
    assert.equal(res.body.copied_from, id);
    assert.equal(res.body.total, 10);
  });

  it("runs the determine action's ( always ) determination on a saved instance (V2 and V4)", async () => {
    const id = (await create(20, 1)).body.d.bill_id;
    // the save counted the check once: the amount was set
    assert.equal((await read(id)).checks, 1);
    let res = await call(`${v2}/check?bill_id='${id}'`, {method: "POST", headers: write});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.d.checks, 2);
    res = await call(`${v4}/Bill('${id}')/ZUI_RAP_BILL.check`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.checks, 3);
    assert.equal((await read(id)).checks, 3);
  });

  it("runs a factory action through the projection and answers the copy in the projection's names", async () => {
    const meta = (await call(`${v2c}/$metadata`)).body;
    assert.match(meta, /<FunctionImport Name="copyBill"/);
    assert.ok(!/ReCalcTotal/i.test(meta));
    const id = (await create(9, 4)).body.d.bill_id;
    const res = await call(`${v2c}/copyBill?BillId='${id}'`, {method: "POST", headers: write});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.d.BillId, id);
    assert.equal(res.body.d.CopiedFrom, id);
    assert.equal(res.body.d.Total, 5);
  });
});
