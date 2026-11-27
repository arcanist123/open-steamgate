// R5: compositions, associations and projections on the order demo of
// src/rap_r5 (docs/rap-runtime.md, "R5"): the BO as a tree (create and read
// by association, the delete that takes the items, the root's lock and
// total change stamp on a child write) behind a projection BDEF, served over
// V2 and V4 (navigation reads, POST through the navigation, $expand). The
// generator half runs without a build; the wire half needs a transpiled
// tree (npm run transpile).
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {parseBdef} from "../tools/rap/bdef-parse.mjs";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {runtimeOutputs} from "../tools/rap/rap-runtime-gen.mjs";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const v2 = `${origin}/sap/opu/odata/sap/ZUI_RAP_ORDER`;
const v4 = `${origin}/sap/opu/odata4/sap/ZUI_RAP_ORDER`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json"};
const demo = () => walk("src/rap_r5").filter(f => /\.(abap|xml|asbdef|asddls|srvdsrv)$/.test(f))
  .map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
const swap = (files, name, from, to) => files.map(f => f.filename === name ? {...f, contents: f.contents.replace(from, to)} : f);
const refusal = (files) => {
  try {
    const {plans} = generate(files);
    runtimeOutputs(plans, files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename)));
  } catch (error) { return error.message; }
  return "accepted";
};

async function call(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body, headers: res.headers};
}

describe("RAP R5 compositions and projections (generator)", () => {
  it("parses the tree: associations, lock and etag of the child, the projection's uses", () => {
    const base = parseBdef(readFileSync("src/rap_r5/zi_rap_order.bdef.asbdef", "utf8"));
    assert.deepEqual(base.unparsed, []);
    const [order, item] = base.entities;
    assert.deepEqual(order.associations.map(a => [a.name, a.operations.map(o => o.kind)]), [["_Items", ["create"]]]);
    assert.deepEqual(item.lock, {kind: "dependent", association: "_Order"});
    assert.equal(item.numbering, "early");
    const proj = parseBdef(readFileSync("src/rap_r5/zc_rap_order.bdef.asbdef", "utf8"));
    assert.equal(proj.implementationType, "projection");
    assert.deepEqual(proj.entities[0].operations.map(o => [o.kind, o.use]), [["create", true], ["update", true], ["delete", true]]);
    assert.deepEqual(proj.entities[0].associations.map(a => [a.name, a.use]), [["_Items", true]]);
    assert.equal(proj.entities[0].useEtag, true);
  });

  it("writes the derived types of the associations and the tree into the model", () => {
    const files = demo();
    const {plans, bindings, outputs} = generate(files);
    for (const kind of ["CREATE", "READ IMPORT", "READ RESULT", "READ LINK"]) {
      assert.ok(bindings[`TABLE FOR ${kind} ZI_RAP_ORDER\\_ITEMS`], kind);
      assert.ok(bindings[`TABLE FOR ${kind} ZI_RAP_ORDITEM\\_ORDER`], kind);
      assert.ok(bindings[`POOL ZBP_RAP_ORDER FOR ${kind} ORDER\\_ITEMS`], `pool ${kind}`);
    }
    const iface = Object.entries(outputs).find(([n, s]) => n.endsWith(".intf.abap") && bindings["TABLE FOR CREATE ZI_RAP_ORDER\\_ITEMS"].startsWith(n.split(".")[0]))[1];
    assert.match(iface, /%target TYPE t_e0_x0_trow/);
    assert.match(iface, /source TYPE e0_features_key/);
    // the projection gets its own types, named as the projection spells its fields
    assert.ok(bindings["TABLE FOR UPDATE ZC_RAP_ORDITEM"]);
    assert.ok(bindings["TABLE FOR CREATE ZC_RAP_ORDER\\_ITEMS"]);
    const adapter = Object.values(runtimeOutputs(plans, files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename))))
      .find(s => s.includes("rs_model-bdef = 'ZI_RAP_ORDER'"));
    for (const text of [
      "ls_entity-root = 'ZI_RAP_ORDER'.",
      "ls_entity-parent = 'ZI_RAP_ORDER'.",
      "ls_entity-parent_assoc = '_ORDER'.",
      "ls_entity-lock = 'D'.",
      "ls_assoc-name = '_ITEMS'.",
      "ls_assoc-kind = 'C'.",
      "ls_assoc-create = abap_true.",
      "ls_assoc-numbering = 'E'.",
      "ls_pair-source = 'ORDER_ID'.",
      "WHEN 'ZI_RAP_ORDER~%NUMBERING\\_ITEMS'.",
      "CALL METHOD io_handler->('EARLYNUMBERING_CBA_ITEMS')",
      "WHEN 'ZI_RAP_ORDER~CREATE BY~_ITEMS'.",
    ]) assert.ok(adapter.includes(text), text);
    const registry = runtimeOutputs(plans, files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename)))["zcl_osd_rap_registry.clas.abap"];
    for (const text of ["WHEN 'ZC_RAP_ORDER'.", "rs_projection-base_entity = 'ZI_RAP_ORDER'.", "ls_map-name = 'ORDERID'.",
      "ls_map-base = 'ORDER_ID'.", "APPEND '_ITEMS' TO rs_projection-creates."]) assert.ok(registry.includes(text), text);
  });

  it("serves the compositions as navigation properties both ways", () => {
    const yaml = generate(demo()).outputs["zui_rap_order.stg.yaml"];
    assert.ok(yaml.includes("  Order_Items:\n    from: OrderType\n    to: ItemType\n    cardinality: \"1:N\"\n    set: Order_Items\n    constraint: {OrderId: OrderId}\n    navigation: {OrderType: to_Items}"), yaml);
    assert.ok(yaml.includes("  Item_Order:\n    from: ItemType\n    to: OrderType\n    cardinality: \"N:1\""), yaml);
    // a child set takes a POST through its parent's navigation
    assert.match(yaml, /ItemType:\n    set: Item\n[^]*?creatable: true/);
  });

  it("asks the instance features before a create by association ( features : instance )", () => {
    let files = swap(demo(), "zi_rap_order.bdef.asbdef", "association _Items { create; }", "association _Items { create ( features : instance ); }");
    assert.match(refusal(files), /features : instance without a FOR INSTANCE FEATURES method/);
    files = swap(files, "zbp_rap_order.clas.locals_imp.abap", "    METHODS set_status FOR DETERMINE ON MODIFY",
      "    METHODS get_features FOR INSTANCE FEATURES\n      IMPORTING keys REQUEST requested_features FOR order RESULT result.\n    METHODS set_status FOR DETERMINE ON MODIFY");
    const {plans, bindings} = generate(files);
    const adapter = Object.values(runtimeOutputs(plans, files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename))))
      .find(s => s.includes("rs_model-bdef = 'ZI_RAP_ORDER'"));
    assert.ok(adapter.includes("ls_assoc-feat_create = abap_true."));
    assert.ok(adapter.includes("ls_request-%assoc-_items = if_abap_behv=>mk-on."));
    assert.ok(bindings["STRUCTURE FOR INSTANCE FEATURES RESULT ZI_RAP_ORDER"]);
  });

  it("refuses what R5 leaves out, by name", () => {
    const files = demo();
    assert.equal(refusal(files), "accepted");
    assert.match(refusal(swap(files, "zi_rap_order.bdef.asbdef", "association _Order;", "association _Order { with draft; }")), /with draft; \} in a behavior definition without with draft/);
    assert.match(refusal(swap(files, "zi_rap_order.bdef.asbdef", "lock dependent by _Order", "lock master")), /lock master on a child/);
    assert.match(refusal(swap(files, "zi_rap_order.bdef.asbdef", "lock dependent by _Order", "lock dependent by _Other")), /which the behavior definition does not declare/);
    assert.match(refusal(swap(files, "zi_rap_order.bdef.asbdef", "  association _Order;\n", "")), /lock dependent by _Order, which the behavior definition does not declare/);
    assert.match(refusal(swap(files, "zc_rap_order.bdef.asbdef", "define behavior for ZC_RAP_ORDER alias Order\n", "define behavior for ZC_RAP_ORDER alias Order\nlock master\n")), /lock master in a projection/);
    assert.match(refusal(swap(files, "zc_rap_order.bdef.asbdef", "  use update;\n  use delete;\n  use association _Order;", "  use create;\n  use association _Order;")), /use create, which ZI_RAP_ORDITEM does not declare/);
    assert.match(refusal(swap(files, "zbp_rap_order.clas.locals_imp.abap", /METHODS earlynumbering_cba_items FOR NUMBERING\n\s+IMPORTING entities FOR CREATE order\\_items\./, "")), /needs one FOR NUMBERING \.\.\. FOR CREATE order\\_Items method/);
  });
});

describe("RAP R5 over OData", function () {
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

  const order = async (Description) => {
    const res = await call(`${v2}/Order`, {method: "POST", headers: write, body: JSON.stringify({Description})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.d.OrderId;
  };
  const item = (id, Product, Quantity) => call(`${v2}/Order('${id}')/to_Items`, {method: "POST", headers: write, body: JSON.stringify({Product, Quantity})});
  const get = (url) => call(url, {headers: {accept: "application/json"}});

  it("creates items through the navigation, numbered by the pool below their order (V2)", async () => {
    const id = await order("v2 order");
    let res = await item(id, "apples", 3);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.d.OrderId, id);
    assert.equal(res.body.d.ItemNo, "0010");
    assert.equal(res.body.d.Quantity, 3);
    assert.ok(Number(res.body.d.ItemChangedAt) > 0, "stamped on create");
    res = await item(id, "pears", 4);
    assert.equal(res.body.d.ItemNo, "0020");
    // a child's own validation runs in the save
    res = await item(id, "nothing", 0);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message.value, /the quantity must be positive/);
    // and a child is never created on its own: the projection does not use
    // a create of Item (the base has none either: it is created by its order)
    res = await call(`${v2}/Item`, {method: "POST", headers: write, body: JSON.stringify({OrderId: id, Product: "loose", Quantity: 1})});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message.value, "Item: the projection does not use create");
    res = await item("99999999", "orphan", 1);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message.value, /order not found/);
  });

  it("reads through the navigation both ways and expands the composition (V2)", async () => {
    const id = await order("read order");
    await item(id, "a", 1);
    await item(id, "b", 2);
    const items = await get(`${v2}/Order('${id}')/to_Items?$format=json`);
    assert.equal(items.status, 200, JSON.stringify(items.body));
    assert.deepEqual(items.body.d.results.map(r => [r.ItemNo, r.Product]), [["0010", "a"], ["0020", "b"]]);
    const up = await get(`${v2}/Item(OrderId='${id}',ItemNo='0020')/to_Order?$format=json`);
    assert.equal(up.body.d.Description, "read order");
    const deep = await get(`${v2}/Order('${id}')?$expand=to_Items&$format=json`);
    assert.deepEqual(deep.body.d.to_Items.results.map(r => r.Quantity), [1, 2]);
  });

  it("moves the root's ETag with a child write, and checks the child's own (V2)", async () => {
    const id = await order("etag order");
    await item(id, "x", 1);
    const root = await get(`${v2}/Order('${id}')?$format=json`);
    const rootTag = root.headers.get("etag");
    const child = await get(`${v2}/Item(OrderId='${id}',ItemNo='0010')?$format=json`);
    const childTag = child.headers.get("etag");
    assert.match(childTag ?? "", /^W\//);
    let res = await call(`${v2}/Item(OrderId='${id}',ItemNo='0010')`, {method: "PATCH", headers: write, body: JSON.stringify({Quantity: 2})});
    assert.equal(res.status, 428, "the child's own etag master");
    res = await call(`${v2}/Item(OrderId='${id}',ItemNo='0010')`, {method: "PATCH", headers: {...write, "if-match": childTag}, body: JSON.stringify({Quantity: 2})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const after = await get(`${v2}/Order('${id}')?$format=json`);
    assert.notEqual(after.headers.get("etag"), rootTag, "the root's lastChangedAt is the BO's total stamp");
    res = await call(`${v2}/Order('${id}')`, {method: "PATCH", headers: {...write, "if-match": rootTag}, body: JSON.stringify({Description: "stale"})});
    assert.equal(res.status, 412);
    // the boundary, said directly: a child write is guarded by the child's
    // own etag master, not by the root's tag (etag dependent is not served,
    // docs/rap-runtime.md R5): the root's tag on a child PATCH is stale for
    // the child (412), and a POST through the navigation takes no If-Match
    // of the root at all (201 with a stale root tag)
    const childNow = (await get(`${v2}/Item(OrderId='${id}',ItemNo='0010')?$format=json`)).headers.get("etag");
    res = await call(`${v2}/Item(OrderId='${id}',ItemNo='0010')`, {method: "PATCH", headers: {...write, "if-match": rootTag}, body: JSON.stringify({Quantity: 5})});
    assert.equal(res.status, 412, "the root's tag is not the child's");
    res = await call(`${v2}/Item(OrderId='${id}',ItemNo='0010')`, {method: "PATCH", headers: {...write, "if-match": childNow}, body: JSON.stringify({Quantity: 5})});
    assert.equal(res.status, 204);
    res = await call(`${v2}/Order('${id}')/to_Items`, {method: "POST", headers: {...write, "if-match": rootTag}, body: JSON.stringify({Product: "z", Quantity: 1})});
    assert.equal(res.status, 201, "a create below the root is not checked against the root's tag");
    // the projection's own read-only fields stay the base's: a status sent is refused
    const fresh = (await get(`${v2}/Order('${id}')?$format=json`)).headers.get("etag");
    res = await call(`${v2}/Order('${id}')`, {method: "PATCH", headers: {...write, "if-match": fresh}, body: JSON.stringify({Status: "X"})});
    assert.equal(res.status, 400);
    assert.match(res.body.error.message.value, /STATUS is read-only/);
  });

  it("locks the root when a child is written: another owner's lock on the order refuses it", async () => {
    const id = await order("locked order");
    await item(id, "y", 1);
    const {enqTake, enqDrop} = await import("../tools/osd-enq-host.mjs");
    const input = {mode_zosd_rap_lock: "E",
      lockhash: createHash("sha256").update(`ZI_RAP_ORDER|ZI_RAP_ORDER|8:${id}`).digest("hex").toUpperCase()};
    assert.equal(enqTake("rap-r5-holder", "OTHER", "ZOSD_RAP_LOCK", "EZOSD_RAP_LOCK", input).subrc, 0);
    try {
      const tag = (await get(`${v2}/Item(OrderId='${id}',ItemNo='0010')?$format=json`)).headers.get("etag");
      let res = await call(`${v2}/Item(OrderId='${id}',ItemNo='0010')`, {method: "PATCH", headers: {...write, "if-match": tag}, body: JSON.stringify({Quantity: 9})});
      assert.equal(res.status, 400);
      assert.match(res.body.error.message.value, new RegExp(`order ${id} is locked by another user`));
      res = await item(id, "z", 1);
      assert.equal(res.status, 400, "a create by association locks the parent's root too");
      assert.equal((await get(`${v2}/Item(OrderId='${id}',ItemNo='0010')?$format=json`)).body.d.Quantity, 1);
    } finally {
      enqDrop("rap-r5-holder", "ZOSD_RAP_LOCK", "EZOSD_RAP_LOCK", input);
    }
    const tag = (await get(`${v2}/Item(OrderId='${id}',ItemNo='0010')?$format=json`)).headers.get("etag");
    const res = await call(`${v2}/Item(OrderId='${id}',ItemNo='0010')`, {method: "PATCH", headers: {...write, "if-match": tag}, body: JSON.stringify({Quantity: 9})});
    assert.equal(res.status, 204, "the request's own lock ends with it: the next write passes");
  });

  it("deletes the items with their order", async () => {
    const id = await order("doomed order");
    await item(id, "a", 1);
    await item(id, "b", 1);
    const tag = (await get(`${v2}/Order('${id}')?$format=json`)).headers.get("etag");
    const res = await call(`${v2}/Order('${id}')`, {method: "DELETE", headers: {...write, "if-match": tag}});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await get(`${v2}/Item(OrderId='${id}',ItemNo='0010')?$format=json`)).status, 404);
    assert.equal((await get(`${v2}/Item?$filter=OrderId eq '${id}'&$format=json`)).body.d.results.length, 0);
  });

  it("does the same over V4: POST through the navigation, reads, $expand, the root's ETag", async () => {
    const post = await call(`${v4}/Order`, {method: "POST", headers: write, body: JSON.stringify({Description: "v4 order"})});
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const id = post.body.OrderId;
    const rootTag = (await call(`${v4}/Order('${id}')`)).body["@odata.etag"];
    let res = await call(`${v4}/Order('${id}')/to_Items`, {method: "POST", headers: write, body: JSON.stringify({Product: "v4 item", Quantity: 5})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.ItemNo, "0010");
    assert.equal(res.body.OrderId, id);
    assert.match(res.headers.get("location") ?? "", /\/Item\(/);
    const items = await call(`${v4}/Order('${id}')/to_Items`);
    assert.deepEqual(items.body.value.map(r => r.Product), ["v4 item"]);
    const deep = await call(`${v4}/Order('${id}')?$expand=to_Items`);
    assert.deepEqual(deep.body.to_Items.map(r => r.ItemNo), ["0010"]);
    assert.notEqual(deep.body["@odata.etag"], rootTag, "the create below moved the root's stamp");
    res = await call(`${v4}/Order('${id}')`, {method: "PATCH", headers: {...write, "if-match": rootTag}, body: JSON.stringify({Description: "stale"})});
    assert.equal(res.status, 412);
    const up = await call(`${v4}/Item(OrderId='${id}',ItemNo='0010')/to_Order`);
    assert.equal(up.body.Description, "v4 order");
  });
});
