import {expect} from "chai";
import express from "express";
import {createRequire} from "node:module";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {delimiter, join} from "node:path";
import {startServer} from "./start.mjs";
import {exceptionDocument, nodeStructureDocument} from "../tools/adt-documents.mjs";
import {adtRouter, unitRunDbEnv, unitRunOptions, UNIT_RUN_DB_ENV_KEYS} from "../tools/adt-facade.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";
import {layerList} from "../tools/osd-host.mjs";
import {identity} from "../tools/osd-identity.mjs";

const {pickInspectorPort} = createRequire(import.meta.url)("../editors/vscode/launcher.js");

// The façade against the real server, the way a client meets it: the same
// listener that serves OData also serves /sap/bc/adt/**, which is the whole
// point of the address.
const PORT = process.env.STG_PORT ?? 3030;
const ADT = `http://localhost:${PORT}/sap/bc/adt`;
const BASE_URL = `http://localhost:${PORT}`;

describe("tools/adt-facade: async tree errors", () => {
  let server;
  let store;
  let facade;
  let call;
  let root;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-adt-async-"));
    store = {
      root,
      packages: () => [{name: "ZASYNC", subpackages: []}],
      package: () => ({objects: [{type: "CLAS", name: "ZCL_ASYNC"}]}),
      rootPackages: () => [{name: "ZASYNC"}],
      find: (type, name) => type === "CLAS" && name === "ZCL_ASYNC"
        ? {type, name, packages: ["ZASYNC"]} : undefined,
    };
    const app = express();
    facade = adtRouter({store, data: {}, watch: false, logMisses: false});
    app.use(facade.router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}/sap/bc/adt`;
    const handshake = await fetch(base + "/core/discovery", {
      method: "HEAD", headers: {"x-csrf-token": "fetch"}, signal: AbortSignal.timeout(1000),
    });
    const cookie = handshake.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    call = (path, body = "") => fetch(base + path, {
      method: "POST", body, signal: AbortSignal.timeout(1000),
      headers: {cookie, "x-csrf-token": handshake.headers.get("x-csrf-token")},
    });
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, {recursive: true, force: true});
  });

  for (const name of ["zcl_bad%", "zcl_bad%GG", "zcl_bad%C3%28"]) {
    it(`answers malformed nodepath object name ${name} with 400`, async () => {
      const uri = `/sap/bc/adt/oo/classes/${name}`;
      const res = await call(`/repository/nodepath?uri=${encodeURIComponent(uri)}`);
      expect(res.status).to.equal(400);
      expect(res.headers.get("content-type")).to.equal("application/xml; charset=utf-8");
      expect(await res.text()).to.equal(exceptionDocument("ExceptionInvalidRequest", "an object uri is required"));
    });
  }

  it("keeps the existing bad object URI answer", async () => {
    const res = await call("/repository/nodepath?uri=invalid");
    expect(res.status).to.equal(400);
    expect(await res.text()).to.equal(exceptionDocument("ExceptionInvalidRequest", "an object uri is required"));
  });

  it("keeps nodepath's 404 answer without recording an object miss", async () => {
    const res = await call("/repository/nodepath?uri=/sap/bc/adt/oo/classes/zcl_missing");
    expect(res.status).to.equal(404);
    expect(await res.text()).to.equal(exceptionDocument("ExceptionResourceNotFound", "CLAS ZCL_MISSING does not exist"));
    expect(facade.missed.size).to.equal(0);
  });

  it("keeps nodepath success bytes, including include and source URI normalization", async () => {
    for (const suffix of ["", "/source/main", "/includes/definitions?version=active#fragment"]) {
      const uri = `/sap/bc/adt/oo/classes/zcl_async${suffix}`;
      const res = await call(`/repository/nodepath?uri=${encodeURIComponent(uri)}`);
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.equal("application/xml; charset=utf-8");
      expect(await res.text()).to.equal(`<?xml version="1.0" encoding="utf-8"?>
<projectexplorer:nodepath xmlns:projectexplorer="http://www.sap.com/adt/projectexplorer" xmlns:adtcore="http://www.sap.com/adt/core">
  <projectexplorer:objectLinkReferences>
    <objectLinkReference adtcore:uri="/sap/bc/adt/packages/zasync" adtcore:type="DEVC/K" adtcore:name="ZASYNC" projectexplorer:category=""/>
    <objectLinkReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_async" adtcore:type="CLAS/OC" adtcore:name="ZCL_ASYNC" projectexplorer:category=""/>
  </projectexplorer:objectLinkReferences>
</projectexplorer:nodepath>
`);
    }
  });

  it("keeps virtualfolders object success bytes", async () => {
    const res = await call("/repository/informationsystem/virtualfolders/contents");
    expect(res.status).to.equal(200);
    expect(res.headers.get("content-type")).to.equal("application/vnd.sap.adt.repository.virtualfolders.result.v1+xml; charset=utf-8");
    expect(await res.text()).to.equal('<?xml version="1.0" encoding="utf-8"?>' +
      '<vfs:virtualFoldersResult objectCount="1" xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders">' +
      '<atom:link href="/sap/bc/adt/repository/informationsystem/virtualfolders?selection=" rel="http://www.sap.com/adt/relations/informationsystem/virtualfolders/selection" title="Virtual Folder Selection" xmlns:atom="http://www.w3.org/2005/Atom"/>' +
      '<vfs:object uri="/sap/bc/adt/oo/classes/zcl_async" text="ZCL_ASYNC" name="ZCL_ASYNC" package="ZASYNC" type="CLAS/OC" expandable="true">' +
      '<atom:link href="/sap/bc/adt/oo/classes/zcl_async" rel="http://www.sap.com/adt/relations/objects" title="ADT Object Reference" xmlns:atom="http://www.w3.org/2005/Atom"/>' +
      '</vfs:object></vfs:virtualFoldersResult>');
  });

  for (const method of ["packages", "package", "rootPackages"]) {
    it(`answers virtualfolders store.${method} throw with 500`, async () => {
      store[method] = () => { throw new Error("synthetic store failure <&>"); };
      const res = await call("/repository/informationsystem/virtualfolders/contents",
        '<vfs:facetorder xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders"><vfs:facet>package</vfs:facet></vfs:facetorder>');
      expect(res.status).to.equal(500);
      expect(res.headers.get("content-type")).to.equal("application/xml; charset=utf-8");
      expect(await res.text()).to.equal(exceptionDocument("ExceptionInternalError", "synthetic store failure <&>",
        {namespace: "org.open-steamgate.osd"}));
    });
  }
});

describe("tools/adt-facade: user layer", () => {
  it("reads the later --layer class through ADT", async () => {
    const root = mkdtempSync(join(tmpdir(), "osd-adt-layer-"));
    const previous = process.env.OSD_LAYERS;
    let server;
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "user"));
      writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src"]}));
      writeFileSync(join(root, "src", "zcl_layer_probe.clas.abap"), "CLASS zcl_layer_probe DEFINITION. ENDCLASS.\n");
      writeFileSync(join(root, "user", "zcl_layer_probe.clas.abap"), "CLASS zcl_layer_probe DEFINITION. \" USER_LAYER\nENDCLASS.\n");
      process.env.OSD_LAYERS = layerList(["--layer", "user"], {}, root).folders.join(delimiter);
      const app = express();
      app.use(adtRouter({store: new ObjectStore({root, libs: []}), data: {}, logMisses: false}).router);
      server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      });
      const url = `http://127.0.0.1:${server.address().port}/sap/bc/adt/oo/classes/ZCL_LAYER_PROBE/source/main`;
      const response = await fetch(url);
      expect(response.status).to.equal(200);
      expect(await response.text()).to.contain("USER_LAYER");
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (previous === undefined) delete process.env.OSD_LAYERS;
      else process.env.OSD_LAYERS = previous;
      rmSync(root, {recursive: true, force: true});
    }
  });
});

describe("tools/adt-facade: OSD answers ADT", () => {
  let server;
  let token;
  let context;

  before(async function () {
    // parsing the system is seconds over a big one, and every structure read
    // shares the one parse. Paying it here keeps it out of whichever test
    // happens to be first, where it would look like that test being slow.
    this.timeout(120000);
    server = startServer(true);
    // the handshake, once, the way a client opens a session
    const res = await fetch(ADT + "/core/discovery", {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
    token = res.headers.get("x-csrf-token");
    context = (res.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=([^;]+)/)?.[1];
    await fetch(ADT + "/oo/classes/ZCL_STG_DISPATCHER/objectstructure", {headers: {cookie: `sap-contextid=${context}`}});
  });

  after(() => server.close());

  const call = (path, options = {}) => fetch(ADT + path, {
    ...options,
    headers: {cookie: `sap-contextid=${context}`, "x-csrf-token": token, ...(options.headers ?? {})},
  });

  it("terminates a paused unit child when its debug request is disconnected", async function () {
    this.timeout(60000);
    const inspectPort = await pickInspectorPort();
    const cancellation = new AbortController();
    const request = call("/core/http/unit/object/run?type=CLAS&name=ZCL_STG_SEGW_TEST&testClass=LTCL_TREE&method=PROPERTIES_IN_FILE_ORDER", {
      method: "POST", signal: cancellation.signal,
      headers: {"content-type": "application/json"},
      body: JSON.stringify({inspectPort, waitForDebugger: true}),
    });
    try {
      const deadline = Date.now() + 30000;
      let open = false;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${inspectPort}/json/list`);
          if (response.ok) { open = true; break; }
        } catch {
          // The child has not opened its inspector yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(open, "the child reached its paused inspector").to.equal(true);
      cancellation.abort();
      try {
        await request;
        throw new Error("expected aborted request");
      } catch (error) {
        expect(error.name).to.equal("AbortError");
      }
      const exitDeadline = Date.now() + 5000;
      let closed = false;
      while (Date.now() < exitDeadline) {
        try {
          await fetch(`http://127.0.0.1:${inspectPort}/json/list`);
        } catch {
          closed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(closed, "the paused inspector closed after request cancellation").to.equal(true);
    } finally {
      cancellation.abort();
      await request.catch(() => {});
    }
  });

  // What an ABAP Cloud Project needs beyond the classic surface, written
  // against what A4H actually did behind a TLS terminator on 2026-09-14 —
  // the wizard opened, the tree filled, sources read and ABAP Unit ran.
  describe("the cloud flavour", () => {
    it("issues a reentrance ticket by sending the browser back to the client's own listener", async () => {
      const back = "http://localhost:62223/adt/redirect";
      const res = await fetch(
        `${ADT}/core/http/reentranceticket?redirect-url=${encodeURIComponent(back)}&_=12345`,
        {redirect: "manual"},
      );
      expect(res.status).to.equal(307);

      const to = new URL(res.headers.get("location"));
      expect(to.origin + to.pathname).to.equal(back);
      // the nonce comes back as it was sent: the client matches on it
      expect(to.searchParams.get("_")).to.equal("12345");
      expect(to.searchParams.get("reentrance-ticket")).to.be.a("string").with.length.greaterThan(16);

      // and the cookie is the part that actually carries the session
      // afterwards — Eclipse sent no Authorization header on any request
      const cookies = (res.headers.getSetCookie?.() ?? []).join("; ");
      expect(cookies).to.contain(`SAP_SESSIONID_${identity().sid}_${identity().adt.client}=`);
      expect(cookies).to.match(/sap-usercontext=/);
    });

    // An open redirect that mints a credential on the way out would be worth
    // having by accident exactly once. Eclipse's listener is always loopback.
    it("refuses to bounce a browser anywhere but loopback", async () => {
      for (const target of ["https://example.invalid/adt/redirect", "http://192.0.2.1/adt/redirect"]) {
        const res = await fetch(
          `${ADT}/core/http/reentranceticket?redirect-url=${encodeURIComponent(target)}`,
          {redirect: "manual"},
        );
        expect(res.status, target).to.equal(400);
      }
    });

    it("answers the session poll with the links the client watches", async () => {
      const res = await call("/core/http/sessions");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/adt\.core\.http\.session\.v3\+xml/);

      const body = await res.text();
      expect(body).to.match(/categories\/core\/http\/sessions\/securitysession/);
      expect(body).to.match(/categories\/core\/http\/sessions\/logoff/);
      expect(body).to.match(/categories\/core\/http\/system\/systeminformation/);
      expect(body).to.match(/inactivityTimeout/);
    });

    // The client polls this. A session identifier that changed per request
    // would read as the session ending over and over.
    it("names the same security session on every poll", async () => {
      const [first, second] = await Promise.all([call("/core/http/sessions"), call("/core/http/sessions")]);
      const idOf = async (res) => /sessions\/([0-9A-F]+)"/.exec(await res.text())?.[1];
      expect(await idOf(first)).to.equal(await idOf(second));
    });

    it("says who and what it is, which is what the window title shows", async () => {
      const res = await call("/core/http/systeminformation");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/systeminformation\.v1\+json/);

      const info = await res.json();
      expect(info).to.include.keys("systemID", "userName", "userFullName", "client", "language");
      expect(info.systemID).to.be.a("string").with.length(3);
    });

    it("the system id is the one id of the system: OSD unless OSD_SID (or STG_ADT_SID) says otherwise", async () => {
      // one setting for every surface (tools/osd-identity.mjs); a client
      // compares the id it stored when the project was made with the one
      // the system reports now, so the id changes only when the setting does
      const info = await (await call("/core/http/systeminformation")).json();
      const setting = [process.env.OSD_SID, process.env.STG_ADT_SID].map((v) => String(v ?? "").trim()).find((v) => v !== "");
      expect(info.systemID).to.equal(setting === undefined ? "OSD" : setting.toUpperCase());
      expect(info.systemID).to.equal(identity().sid);
      // and the feeds name the same system as their contributor
      const dumps = await (await call("/runtime/dumps")).text();
      expect(dumps).to.contain(`<atom:contributor><atom:name>${info.systemID}</atom:name></atom:contributor>`);
    });

    // A quarter of a working session's traffic, on a timer, and every one of
    // them empty because nothing had gone wrong. 404 here makes a client
    // report an error where the real answer is "nothing to report".
    it("answers the polled feeds with an empty feed, which is the true answer", async () => {
      for (const path of ["/runtime/dumps", "/runtime/systemmessages", "/gw/errorlog"]) {
        const res = await call(path);
        expect(res.status, path).to.equal(200);
        expect(res.headers.get("content-type"), path).to.match(/atom\+xml/);
        const body = await res.text();
        expect(body, path).to.match(/<atom:feed/);
        expect(body, path).to.not.match(/<atom:entry/);
      }
    });

    // The whole contract, measured: 200 and no body, to all three methods.
    it("answers the debugger poll with nothing, to every method it uses", async () => {
      for (const method of ["GET", "POST", "DELETE"]) {
        const res = await call("/debugger/listeners?debuggingMode=user", {method});
        expect(res.status, method).to.equal(200);
        expect(await res.text(), method).to.equal("");
      }
    });

    // Without this the client stops at "Pre-loading workbench object types"
    // and opens nothing at all.
    it("lists the object types it actually serves, and no others", async () => {
      const res = await call("/repository/typestructure", {method: "POST"});
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/vnd\.sap\.as\+xml/);

      const body = await res.text();
      expect(body).to.match(/<asx:abap/);
      expect(body).to.match(/<OBJECT_TYPE>CLAS\/OC<\/OBJECT_TYPE>/);
      expect(body).to.match(/<OBJECT_TYPE>DEVC\/K<\/OBJECT_TYPE>/);

      // a list naming a type this façade does not serve is a 404 waiting for
      // the first click
      for (const [, template] of body.matchAll(/<URI_TEMPLATE>([^<]+)<\/URI_TEMPLATE>/g)) {
        expect(template, "URI template").to.match(/^\/sap\/bc\/adt\/[a-z]/);
      }
    });

    // A4H answers 404 here and the wizard carries on, so the façade needs no
    // route at all — this pins that the absence is deliberate.
    it("leaves /sap/public/bc/icf/virtualhost unanswered, as the real one does", async () => {
      const res = await fetch(BASE_URL + "/sap/public/bc/icf/virtualhost");
      expect(res.status).to.equal(404);
    });
  });

  describe("wave 0: the handshake", () => {
    it("HEAD on core/discovery works, because a client tries it before GET", async () => {
      const res = await fetch(ADT + "/core/discovery", {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
      expect(res.status).to.equal(200);
      expect(res.headers.get("x-csrf-token")).to.be.a("string").with.length.greaterThan(8);
    });

    it("the discovery document is an Atom service document", async () => {
      const res = await call("/core/discovery");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("atomsvc+xml");
      const xml = await res.text();
      expect(xml).to.contain("<app:service");
      expect(xml).to.contain("<app:workspace>");
    });

    // abap-adt-api's login() calls this one resource and reads three things
    // off it: the status, the token header, and the cookies. The body it
    // never opens. So these are the assertions that decide whether a real
    // VS Code client can log on, and they are deliberately the client's
    // three and not a shape we find pleasing.
    it("the logon probe answers, which is what lets an IDE log on at all", async () => {
      const res = await fetch(ADT + "/compatibility/graph?sap-client=001&sap-language=EN", {
        headers: {"x-csrf-token": "fetch", authorization: "Basic " + Buffer.from("DEVELOPER:secret").toString("base64")},
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("x-csrf-token")).to.be.a("string").with.length.greaterThan(8);
      expect((res.headers.getSetCookie?.() ?? []).join("; ")).to.contain("sap-contextid=");
    });

    it("HEAD on the logon probe works too, since a token is fetched with it", async () => {
      const res = await fetch(ADT + "/compatibility/graph", {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
      expect(res.status).to.equal(200);
      expect(res.headers.get("x-csrf-token")).to.be.a("string").with.length.greaterThan(8);
    });

    // This test used to assert the graph was empty, on the reasoning that a
    // compatibility graph grants a client the use of features and OSD had
    // measured none, so claiming nothing was the honest answer. The reasoning
    // was careful and the conclusion was wrong: an empty graph does not read
    // as "no opinion", it reads as "supports nothing", and a client acts on
    // it. This one deleted its content handler for object references, decided
    // activation was unsupported, and stopped filling in package contents —
    // three failures that looked unrelated and were one document.
    //
    // So the graph names the features this façade serves, and the test now
    // guards the property that matters: every feature declared must be one
    // there is a resource for. Claiming a feature invites its use, and a
    // claim that breaks on the first click is worse than a missing one.
    it("declares the features it serves, under the element a client looks for", async () => {
      const xml = await (await call("/compatibility/graph")).text();
      expect(xml, "the local name is not arbitrary").to.contain("<compatibility:graph");
      expect(xml).to.match(/<node nameSpace="COM\.SAP\.ADT\.RIS" name="search"\/>/);
      expect(xml).to.match(/<node nameSpace="COM\.SAP\.ADT\.ACTIVATION" name="activate"\/>/);

      // nothing is declared that this façade cannot answer for
      const declared = [...xml.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
      for (const promised of ["classes", "programs", "checkruns", "abapunit", "search"]) {
        expect(declared, promised).to.include(promised);
      }
      expect(declared, "a feature with no resource behind it").to.not.include("codeCompletion");
    });

    // Declaring the flags was not enough on its own, and this is why.
    //
    // An obligatory edge says a feature is incomplete without its partner, so
    // a client reading one whose obligations are missing treats the feature as
    // unusable — which was "Outdated content handler ... was deleted" and
    // "Activation is not supported on this project", both at once. Every
    // obligation must therefore be met by something also declared, or the
    // declaration is worse than silence.
    it("meets every obligation it declares", async () => {
      const xml = await (await call("/compatibility/graph")).text();
      const nodes = new Set([...xml.matchAll(/<node nameSpace="([^"]+)" name="([^"]+)"\/>/g)]
        .map((m) => `${m[1]}/${m[2]}`));
      const edges = [...xml.matchAll(
        /<edge isObligatory="([^"]+)"><sourceNode nameSpace="([^"]+)" name="([^"]+)"\/><targetNode nameSpace="([^"]+)" name="([^"]+)"\/><\/edge>/g)];

      expect(edges.length, "a graph with no edges declares nothing about its features").to.be.greaterThan(0);
      for (const [, obligatory, sourceSpace, source, targetSpace, target] of edges) {
        expect(nodes, `edge from ${source}`).to.include(`${sourceSpace}/${source}`);
        expect(nodes, `${obligatory === "true" ? "obligation" : "edge"} to ${target}`)
          .to.include(`${targetSpace}/${target}`);
      }
    });

    // The invariant behind three log entries and a tree that never loaded.
    //
    // A collection with no atom:category is not a collection the client can
    // read: DiscoveryContentHandler.deserialize calls category.getScheme()
    // without a null check, so one such entry throws NullPointerException and
    // the whole discovery document fails to parse — not just that collection.
    // Three of ours had none, and every package below sat on "Loading
    // repository tree ..." while the errors named resources nobody had
    // clicked. So this is checked over all of them rather than per resource:
    // the cost of a missing one is not local.
    it("gives every collection a category, because one without kills the document", async () => {
      const xml = await (await call("/discovery")).text();
      const collections = [...xml.matchAll(/<app:collection[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/app:collection>/g)];
      expect(collections.length, "no collections at all").to.be.greaterThan(0);
      for (const [, href, body] of collections) {
        expect(body, href).to.match(/<atom:category[^>]*term="[^"]+"[^>]*scheme="[^"]+"/);
      }
    });

    // The gate, and the reason every other node in this graph was dead weight.
    //
    // Taken from the client's own bytecode, not from a guess: isNodeAvailable
    // resolves COM.SAP.ADT.COMPATIBILITY/compatibilityAvailable first and
    // answers false for whatever it was asked about if that node is not in the
    // graph this system served. A graph missing it is indistinguishable, to
    // the client, from a graph declaring nothing at all — and the failure is
    // silent, client-side, before any request, so the server logs stay clean
    // while every feature is off. That is what "Activation is not supported"
    // meant while activation, checkruns and their obligations were all
    // declared and all reachable.
    it("opens the gate the client checks before every other node", async () => {
      const xml = await (await call("/compatibility/graph")).text();
      expect(xml, "without this node the client reads the whole graph as empty")
        .to.match(/<node nameSpace="COM\.SAP\.ADT\.COMPATIBILITY" name="compatibilityAvailable"\/>/);
    });

    // The outline is gated by the graph, not by the resource behind it.
    // The client's outline provider resolves SOURCESERVICES/outline before
    // it sends anything and, told no, cancels its job silently — so a class
    // node read "Loading outline structure ..." forever while
    // /objectstructure answered 200 to anyone who asked.
    it("declares the outline, which is what makes a class node open", async () => {
      const xml = await (await call("/compatibility/graph")).text();
      expect(xml).to.match(/<node nameSpace="COM\.SAP\.ADT\.SOURCESERVICES" name="outline"\/>/);
    });

    // And behind the gate the answer must not be empty: the class outline
    // provider reads result[0] without a length check. A class made only of
    // interface implementations used to have no children, because abaplint
    // lists a class's own methods and not the ones it takes from an
    // interface.
    it("gives a class that only implements an interface a structure with its methods", async () => {
      const xml = await (await call("/oo/classes/zcl_stg_apc_demo/objectstructure?version=active&withShortDescriptions=true")).text();
      const methods = [...xml.matchAll(/adtcore:type="CLAS\/OM"[^>]*/g)].map((m) => m[0]);
      expect(methods.length, "an APC handler has methods, all of them from its interface").to.be.greaterThan(0);
      expect(xml).to.contain('adtcore:name="IF_APC_WSP_EXTENSION~ON_START"');
      expect(xml, "a method points into the source").to.match(/adtcore:type="CLAS\/OM"[\s\S]*?implementationBlock" href="\.\/source\/main#start=\d+,\d+;end=\d+,\d+"/);
      expect(xml, "the class itself is a child, as it is in a real structure").to.contain('adtcore:type="CLAS/OCX"');
    });

    // A program's structure is never empty either, for the same reader.
    //
    // The subject is `ZOSD_TEST_DEMO_PLAIN`, which is IN the system. It used
    // to be `ZDEMO_EDITOR`, under `test/fixtures/` -- a folder the build
    // excludes and the store indexed, so this test's subject was an object
    // the system did not contain.
    it("gives a two-line report a structure with its text elements, and nothing invented", async () => {
      const xml = await (await call("/programs/programs/zosd_test_demo_plain/objectstructure?version=active")).text();
      const children = [...xml.matchAll(/adtcore:type="(PROG\/[A-Z]+)"/g)].map((m) => m[1]).slice(1);
      expect(children, "PROG/PX is what the system lists for a program, and all this one has").to.deep.equal(["PROG/PX"]);
    });

    // The parts a program does have are named by the workbench's own codes
    // (the type registry of a real system: PU subroutine, PE event, PL and
    // PP local class), each pointing into the source.
    it("lists a program's subroutines, events and local classes by the workbench's codes", async () => {
      const {mkdtempSync, mkdirSync, copyFileSync} = await import("node:fs");
      const {join} = await import("node:path");
      const {tmpdir} = await import("node:os");
      const {ObjectStore} = await import("../tools/osd-store.mjs");
      const {structureOf} = await import("../tools/adt-documents.mjs");
      const root = mkdtempSync(join(tmpdir(), "osd-parts-"));
      mkdirSync(join(root, "osd"));
      copyFileSync("abaplint.jsonc", join(root, "abaplint.jsonc"));
      const store = new ObjectStore({root});
      store.write("PROG", "ZOSD_PARTS",
        "REPORT zosd_parts.\nCLASS lcl_x DEFINITION.\nENDCLASS.\nCLASS lcl_x IMPLEMENTATION.\nENDCLASS.\n" +
        "INITIALIZATION.\n  WRITE 1.\nSTART-OF-SELECTION.\n  PERFORM go.\nFORM go.\n  WRITE 2.\nENDFORM.\n");
      const parts = structureOf(store, "PROG", "ZOSD_PARTS").children.map((c) => `${c.type} ${c.name}`);
      expect(parts).to.include("PROG/PU GO");
      expect(parts).to.include("PROG/PE START-OF-SELECTION");
      expect(parts).to.include("PROG/PE INITIALIZATION");
      expect(parts).to.include("PROG/PL LCL_X");
      expect(parts).to.include("PROG/PP LCL_X");
      expect(parts[parts.length - 1]).to.equal("PROG/PX ZOSD_PARTS");
      const form = structureOf(store, "PROG", "ZOSD_PARTS").children.find((c) => c.name === "GO");
      expect(form.uri).to.match(/^source\/main#start=\d+,\d+;end=\d+,\d+$/);
    });

    // The data element editor checks its object as soon as it opens, and a
    // 400 for a URI the check did not recognise was the first thing a person
    // saw after the editor finally opened.
    it("checks a dictionary object by its presence, rather than refusing the request", async () => {
      const res = await call("/checkruns?reporters=abapCheckRun", {method: "POST",
        body: '<chkrun:checkObjectList xmlns:adtcore="http://www.sap.com/adt/core" xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
          '<chkrun:checkObject adtcore:uri="/sap/bc/adt/ddic/dataelements/icfname" chkrun:version="active"/></chkrun:checkObjectList>'});
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain('chkrun:triggeringUri="/sap/bc/adt/ddic/dataelements/icfname"');
      expect(xml).to.contain('chkrun:status="processed"');
      expect(xml, "no message invented for an object that was not really checked").to.not.contain("<chkrun:checkMessage ");
    });

    // The editor merges this structure with its own parse and, first thing,
    // takes the base link — filled only from xml:base on the root. Without
    // it: "Index 0 out of bounds for length 0" on every keystroke.
    it("roots the structure at its own address, and names members the way the client looks them up", async () => {
      const path = "/oo/classes/zcl_stg_segw_export/objectstructure?version=active&withShortDescriptions=true";
      const xml = await (await call(path)).text();
      // the address as an attribute: the & is escaped, which is how the system writes it too
      expect(xml).to.contain('xml:base="/sap/bc/adt' + path.replace("&", "&amp;") + '"');
      expect(xml, "the identifier link is the one getLink searches for").to.contain("relations/source/implementationIdentifier");
      expect(xml).to.contain("relations/source/definitionIdentifier");
      expect(xml, "text elements are an external reference, as in a real structure").to.match(/CLAS\/OCX"[^>]*isExternalRef="true"/);
    });

    it("it answers at both of its names, because a client uses both", async () => {
      const core = await call("/core/discovery");
      const plain = await call("/discovery");
      expect(core.status).to.equal(200);
      expect(plain.status).to.equal(200);
      const coreXml = await core.text();
      const plainXml = await plain.text();
      // the same collections at both names; core/discovery holds one per
      // workspace (abap-adt-api's core reader), discovery groups them
      const hrefs = (xml) => [...xml.matchAll(/<app:collection href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs(coreXml)).to.deep.equal(hrefs(plainXml));
      const count = (xml, tag) => xml.split(tag).length - 1;
      expect(count(coreXml, "<app:workspace>")).to.equal(hrefs(coreXml).length);
      expect(count(plainXml, "<app:workspace>")).to.be.below(hrefs(plainXml).length);
    });

    it("discovery advertises what is mounted and nothing else", async () => {
      const xml = await (await call("/discovery")).text();
      // served today
      expect(xml).to.contain('href="/sap/bc/adt/oo/classes"');
      expect(xml).to.contain('href="/sap/bc/adt/oo/interfaces"');
      expect(xml).to.contain('href="/sap/bc/adt/programs/programs"');
      expect(xml).to.contain('href="/sap/bc/adt/datapreview/freestyle"');
      expect(xml).to.contain('href="/sap/bc/adt/activation"');
      expect(xml).to.contain('href="/sap/bc/adt/checkruns"');
      expect(xml).to.contain('href="/sap/bc/adt/abapunit/testruns"');
      expect(xml).to.contain('href="/sap/bc/adt/cts/transportchecks"');
      // not served yet, and so not promised: this is the gatekeeper rule, and
      // it is what keeps "which tools work" answerable by asking the server
      expect(xml).to.not.contain('href="/sap/bc/adt/atc"');
      expect(xml).to.not.contain('href="/sap/bc/adt/debugger"');
    });

    it("a client scanning for hrefs finds every collection with its full path", async () => {
      const xml = await (await call("/discovery")).text();
      for (const href of [...xml.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
        expect(href).to.match(/^\/sap\/bc\/adt\//);
      }
    });

    it("gives every object-type filter the data string Eclipse splits", async () => {
      const res = await call("/repository/informationsystem/objecttypes?maxItemCount=999&name=*&data=usedByProvider");
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.match(/<nameditem:name>CLAS<\/nameditem:name>[\s\S]*?<nameditem:data>type:CLAS\/OC;usedBy:quick_search,virtual_folders<\/nameditem:data>/);
      const items = [...xml.matchAll(/<nameditem:namedItem>([\s\S]*?)<\/nameditem:namedItem>/g)].map((m) => m[1]);
      expect(items.length).to.equal(15);
      for (const type of ["SICF", "SAPC", "SAMC"]) expect(xml).not.to.include(`<nameditem:name>${type}</nameditem:name>`);
      for (const item of items) {
        expect(item, "data=null makes Eclipse call split on null").to.match(/<nameditem:data>type:[^<]+;usedBy:[^<]+<\/nameditem:data>/);
      }
    });
  });

  describe("the thin slice: one source, one table", () => {
    it("reads the source of a class", async () => {
      const res = await call("/oo/classes/ZCL_STG_DISPATCHER/source/main");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("text/plain");
      const source = await res.text();
      expect(source).to.contain("CLASS zcl_stg_dispatcher DEFINITION");
    });

    it("reads the source of an interface", async () => {
      const res = await call("/oo/interfaces/ZIF_STG_CDS_SOURCE/source/main");
      expect(res.status).to.equal(200);
      expect(await res.text()).to.contain("INTERFACE zif_stg_cds_source");
    });

    it("reads a class's test include, which ADT calls an include", async () => {
      const res = await call("/oo/classes/ZCL_STG_SEGW_TEST/includes/testclasses/source/main");
      expect(res.status).to.equal(200);
      expect(await res.text()).to.contain("CLASS ltcl");
    });

    it("a namespaced name arrives URL-encoded and still resolves", async () => {
      // the library clones carry /IWBEP/-namespaced objects; skip where they
      // are not cloned rather than fail for a reason that is not ours
      const probe = await call("/oo/classes/" + encodeURIComponent("/IWBEP/CL_MGW_ABS_DATA") + "/source/main");
      if (probe.status === 404) {
        return;
      }
      expect(probe.status).to.equal(200);
      expect((await probe.text()).toLowerCase()).to.contain("class /iwbep/cl_mgw_abs_data");
    });

    it("an object that is not there is a 404, not a 500", async () => {
      const res = await call("/oo/classes/ZCL_NOT_A_THING/source/main");
      expect(res.status).to.equal(404);
    });

    it("reads table contents through freestyle SQL", async () => {
      const res = await call("/datapreview/freestyle?rowNumber=3", {
        method: "POST",
        body: "SELECT travel_id, description FROM zstg_demo",
      });
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<dataPreview:tableData");
      expect(xml).to.contain('dataPreview:name="TRAVEL_ID"');
      expect(xml).to.contain("<dataPreview:data>T0001</dataPreview:data>");
      expect(xml).to.contain("<dataPreview:totalRows>3</dataPreview:totalRows>");
    });

    it("advertises and performs the SQL Pane syntax check", async () => {
      const discovery = await (await call("/discovery")).text();
      expect(discovery).to.contain("http://www.sap.com/adt/categories/datapreview/freestyle/check");
      expect(discovery).to.contain("/sap/bc/adt/datapreview/freestyle{?action,uniqueURI}");

      const uri = "/sap/bc/adt/datapreview/freestyle/sqlconsole0";
      const good = await call(`/datapreview/freestyle?action=checkSyntax&uniqueURI=${encodeURIComponent(uri)}`, {
        method: "POST", body: "SELECT * FROM zstg_demo",
      });
      expect(good.status).to.equal(200);
      expect(good.headers.get("content-type")).to.contain("application/vnd.sap.adt.checkmessages+xml");
      const report = await good.text();
      expect(report).to.contain(`chkrun:triggeringUri="${uri}"`);
      expect(report).to.contain('chkrun:status="processed"');
      expect(report).to.not.contain("<chkrun:checkMessage ");
      expect(report).to.not.contain("<chkrun:checkMessageList>");

      const bad = await call(`/datapreview/freestyle?action=checkSyntax&uniqueURI=${encodeURIComponent(uri)}`, {
        method: "POST", body: "SELECT definitely_missing FROM zstg_demo",
      });
      expect(bad.status, "syntax findings are a successful check report").to.equal(200);
      expect(await bad.text()).to.contain("<chkrun:checkMessage ");
    });

    it("the row limit is the client's, and it is applied", async () => {
      const res = await call("/datapreview/freestyle?rowNumber=1", {method: "POST", body: "SELECT * FROM zstg_demo"});
      expect(await res.text()).to.contain("<dataPreview:totalRows>1</dataPreview:totalRows>");
    });

    it("the cross-reference tables answer the query the client's graph layer makes", async () => {
      const res = await call("/datapreview/freestyle", {
        method: "POST",
        body: "SELECT include, name FROM wbcrossgt WHERE name LIKE 'CL_ABAP_Z%'",
      });
      expect(res.status).to.equal(200);
      expect(await res.text()).to.contain("<dataPreview:tableData");
      // the rows are derived from the files and seeded by every host at
      // start (tools/osd-xref-seed.mjs), so they are there in any checkout
      const again = await call("/datapreview/freestyle", {
        method: "POST",
        body: "SELECT include, name FROM wbcrossgt WHERE name LIKE 'CL_ABAP_Z%'",
      });
      expect(await again.text()).to.contain("CL_ABAP_ZIP");
    });

    it("a statement that is not a SELECT is refused, and is not a 403", async () => {
      const res = await call("/datapreview/freestyle", {method: "POST", body: "DROP TABLE zstg_demo"});
      expect(res.status).to.equal(400);
      expect(await res.text()).to.contain("only SELECT");
    });
  });

  describe("wave 1: the shapes the round trip asked for", () => {
    it("the object structure of a class lists its methods with their visibility", async () => {
      const res = await call("/oo/classes/ZCL_STG_DISPATCHER/objectstructure");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("objectstructure.v2+xml");
      const xml = await res.text();
      expect(xml).to.contain('adtcore:name="ZCL_STG_DISPATCHER"');
      expect(xml).to.contain('adtcore:type="CLAS/OC"');
      expect(xml).to.contain('adtcore:name="DISPATCH"');
      expect(xml).to.contain('adtcore:type="CLAS/OM"');
      // dispatch is public, origin is private: the difference is the reason a
      // client reads this document at all
      expect(xml).to.match(/adtcore:name="DISPATCH"[^>]*visibility="public"/);
      expect(xml).to.match(/adtcore:name="ORIGIN"[^>]*visibility="private"/);
    });

    it("a method carries the source position a client asks for it by", async () => {
      const xml = await (await call("/oo/classes/ZCL_STG_DISPATCHER/objectstructure")).text();
      expect(xml).to.match(/implementationBlock" href="\.\/source\/main#start=\d+,\d+;end=\d+,\d+"/);
    });

    it("a method carries the whole range of its body, both ends", async () => {
      // a client slices one method out of the main source between the two
      // ends of this range. Half a range is no range: without the end it
      // reads nothing, which is what "no implementation" meant.
      const xml = await (await call("/oo/classes/ZCL_STG_SEGW_REPO/objectstructure")).text();
      const at = xml.match(/adtcore:name="FILES"[\s\S]*?implementationBlock" href="\.\/source\/main#start=(\d+),\d+;end=(\d+),\d+/);
      expect(at, "FILES carries a start and an end").to.not.equal(null);
      const source = (await (await call("/oo/classes/ZCL_STG_SEGW_REPO/source/main")).text()).split("\n");
      expect(source[Number(at[1]) - 1].toUpperCase()).to.contain("METHOD FILES");
      expect(source[Number(at[2]) - 1].toUpperCase()).to.contain("ENDMETHOD");
      expect(Number(at[2])).to.be.greaterThan(Number(at[1]));
    });

    it("every method of a class carries a range, not only the first", async () => {
      const xml = await (await call("/oo/classes/ZCL_STG_SEGW_REPO/objectstructure")).text();
      const methods = [...xml.matchAll(/adtcore:type="CLAS\/OM"[\s\S]*?implementationBlock" href="([^"]+)"/g)].map((m) => m[1]);
      expect(methods.length).to.be.greaterThan(3);
      for (const uri of methods) {
        expect(uri, uri).to.match(/#start=\d+,\d+;end=\d+,\d+$/);
      }
    });

    it("the range a client reads is a link inside the method, not an attribute on it", async () => {
      // an attribute is where we put it first and nobody reads it there; a
      // client walks the element's links and picks the one by its relation
      const xml = await (await call("/oo/classes/ZCL_STG_SEGW_REPO/objectstructure")).text();
      const element = xml.match(/<abapsource:objectStructureElement adtcore:name="FILES"[\s\S]*?<\/abapsource:objectStructureElement>/);
      expect(element, "FILES is an element with children").to.not.equal(null);
      expect(element[0]).to.contain('rel="http://www.sap.com/adt/relations/source/implementationBlock"');
      expect(element[0]).to.contain('rel="http://www.sap.com/adt/relations/source/definitionBlock"');
      const body = element[0].match(/implementationBlock" href="\.\/source\/main#start=(\d+),\d+;end=(\d+),\d+"/);
      expect(body, "the implementation link carries a range").to.not.equal(null);
      const source = (await (await call("/oo/classes/ZCL_STG_SEGW_REPO/source/main")).text()).split("\n");
      expect(source[Number(body[1]) - 1].toUpperCase()).to.contain("METHOD FILES");
      expect(source[Number(body[2]) - 1].toUpperCase()).to.contain("ENDMETHOD");
    });

    it("the declaration link points at the whole signature, not the name alone", async () => {
      const xml = await (await call("/oo/classes/ZCL_STG_SEGW_REPO/objectstructure")).text();
      const element = xml.match(/<abapsource:objectStructureElement adtcore:name="FILES"[\s\S]*?<\/abapsource:objectStructureElement>/)[0];
      const declaration = element.match(/definitionBlock" href="\.\/source\/main#start=(\d+),\d+;end=(\d+),\d+"/);
      expect(declaration).to.not.equal(null);
      const source = (await (await call("/oo/classes/ZCL_STG_SEGW_REPO/source/main")).text()).split("\n");
      expect(source[Number(declaration[1]) - 1].toUpperCase()).to.contain("METHODS FILES");
      // a declaration with parameters runs over several lines
      expect(Number(declaration[2])).to.be.greaterThan(Number(declaration[1]));
    });

    it("test classes are nested local classes with links into their include", async () => {
      const xml = await (await call("/oo/classes/ZCL_STG_SEGW_TEST/objectstructure")).text();
      expect(xml).to.contain('adtcore:type="CLAS/OCL"');
      expect(xml).to.contain('testclass="true"');
      expect(xml).to.contain('href="./includes/testclasses#start=');
    });

    it("the object structure of an interface answers too", async () => {
      const res = await call("/oo/interfaces/ZIF_STG_CDS_SOURCE/objectstructure");
      expect(res.status).to.equal(200);
      expect(await res.text()).to.contain('adtcore:type="INTF/OI"');
    });

    // This used to assert that a class answers at its own address with an
    // object structure, written when a class would not open in VS Code
    // because the path met the catch-all. Routing it was the fix; the
    // document was the part that was guessed.
    //
    // Both halves of that guess are now disproved. VS Code, handed the
    // structure, refuses with "Operation not supported for object CLAS/OC" —
    // it recognises the type and wants a class document. And A4H, asked with
    // Accept: */* and with the versioned class type, answers class:abapClass
    // to both, so there is nothing to negotiate.
    it("an object answers at its own address, which is how a class opens", async () => {
      const res = await call("/oo/classes/ZCL_STG_DISPATCHER");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/oo\.classes\.v4\+xml/);

      const xml = await res.text();
      expect(xml).to.contain("<class:abapClass");
      // the link a client follows to the source, which is the point of asking
      expect(xml).to.match(/rel="http:\/\/www\.sap\.com\/adt\/relations\/source"/);
    });

    // A class at its own address and its structure under /objectstructure are
    // two documents for two questions. They used to be the same one.
    it("the structure keeps its own address, and is not the class document", async () => {
      const object = await (await call("/oo/classes/ZCL_STG_DISPATCHER")).text();
      const structure = await (await call("/oo/classes/ZCL_STG_DISPATCHER/objectstructure")).text();
      expect(object).to.contain("<class:abapClass");
      expect(structure).to.contain("objectStructureElement");
      expect(object).to.not.equal(structure);
    });

    // The same document whichever way it is asked for, because that is what
    // the real system does and a client should not have to know which.
    it("answers a class as a class however the question is phrased", async () => {
      const res = await call("/oo/classes/ZCL_STG_DISPATCHER", {
        headers: {Accept: "*/*"},
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.match(/oo\.classes\.v4\+xml/);

      const xml = await res.text();
      expect(xml).to.contain("<class:abapClass");
      expect(xml, "the editor follows this to the source").to.match(/rel="http:\/\/www\.sap\.com\/adt\/relations\/source"/);
      // the fields a client reads without checking whether they are there
      for (const attribute of ["adtcore:name", "adtcore:changedAt", "adtcore:version", "adtcore:responsible"]) {
        expect(xml, attribute).to.contain(attribute + "=");
      }
    });

    it("an object that is not there is a 404 at its own address too", async () => {
      expect((await call("/oo/classes/ZCL_NOPE_NOT_HERE")).status).to.equal(404);
    });

    it("a structure asked of an object that is not there is a 404", async () => {
      expect((await call("/oo/classes/ZCL_NOT_A_THING/objectstructure")).status).to.equal(404);
    });

    it("search finds objects by name and points at where they live", async () => {
      const res = await call("/repository/informationsystem/search?operation=quickSearch&query=ZCL_STG_DISPATCHER&maxResults=10");
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<adtcore:objectReferences");
      expect(xml).to.contain('adtcore:name="ZCL_STG_DISPATCHER"');
      expect(xml).to.contain('adtcore:type="CLAS/OC"');
      expect(xml).to.contain('adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_dispatcher"');
    });

    it("a star in the pattern anchors the match, the way a client means it", async () => {
      const xml = await (await call("/repository/informationsystem/search?query=" + encodeURIComponent("ZCL_STG_SEGW*") + "&maxResults=50")).text();
      const names = [...xml.matchAll(/adtcore:name="([^"]+)"/g)].map((m) => m[1]);
      expect(names.length).to.be.greaterThan(0);
      for (const name of names) {
        expect(name).to.match(/^ZCL_STG_SEGW/);
      }
    });

    it("the result count is the client's to cap", async () => {
      const xml = await (await call("/repository/informationsystem/search?query=Z&maxResults=3")).text();
      expect([...xml.matchAll(/<adtcore:objectReference /g)].length).to.be.at.most(3);
    });

    it("an explicit include-property request still gets the include document", async () => {
      const res = await call("/oo/classes/ZCL_STG_SEGW_TEST/includes/testclasses", {
        headers: {accept: "application/vnd.sap.adt.oo.classes.includes.v2+xml"},
      });
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("abapClassInclude");
      expect(xml).to.contain('class:includeType="testclasses"');
      expect(xml).to.contain("includes/testclasses/source/main");
    });

    it("a client that asks the include for text gets the source itself", async () => {
      const res = await call("/oo/classes/ZCL_STG_SEGW_TEST/includes/testclasses", {headers: {accept: "text/plain"}});
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("text/plain");
      expect(await res.text()).to.contain("CLASS ltcl");
    });

    it("packages are findable by search, which is how a client discovers the tree to open", async () => {
      const res = await call("/repository/informationsystem/search?query=" + encodeURIComponent("$STG_SEGW*") + "&objectType=DEVC%2FK&maxResults=20");
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain('adtcore:type="DEVC/K"');
      expect(xml).to.contain('adtcore:name="$STG_SEGW"');
      expect(xml).to.contain('adtcore:uri="/sap/bc/adt/packages/');
    });

    it("a package says what it is and what is above it", async () => {
      const res = await call("/packages/$STG_GEN_SEGW");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("packages.v1+xml");
      const xml = await res.text();
      expect(xml).to.contain('adtcore:name="$STG_GEN_SEGW"');
      expect(xml).to.contain('adtcore:type="DEVC/K"');
      expect(xml).to.contain('adtcore:name="$STG_GEN"');
    });

    it("a package that is not there is a 404 like any other missing object", async () => {
      expect((await call("/packages/$NOT_A_PACKAGE")).status).to.equal(404);
    });

    // A refusal the client cannot parse is worse than a refusal it dislikes.
    //
    // These 404s used to be text/plain while the catch-all beside them served
    // exc:exception, so the same façade said no in two languages. The client
    // builds a ResourceException from the body and reads its exception data
    // without checking: a body it cannot parse leaves that null, and expanding
    // a package died on "Cannot invoke IExceptionData.getNamespace()" while
    // every sibling node in the tree stayed on "Loading repository tree ..."
    // — the failure never finished failing. So the shape is the contract here,
    // not the status code.
    it("refuses in the one language the client can read", async () => {
      const res = await call("/repository/nodestructure?parent_name=" +
        encodeURIComponent("$NOT_A_PACKAGE_EITHER"), {method: "POST"});
      expect(res.status).to.equal(404);
      expect(res.headers.get("content-type"), "text/plain leaves the client with no exception data")
        .to.contain("application/xml");
      const xml = await res.text();
      expect(xml).to.contain("<exc:exception");
      expect(xml, "the namespace the client dereferences").to.contain("<namespace id=");
      expect(xml).to.contain("ExceptionResourceNotFound");
    });

    it("a subpackage appears once, not twice, though the store holds it both ways", async () => {
      const xml = await (await call("/repository/nodestructure?parent_name=" + encodeURIComponent("$STG_SEGW"), {method: "POST"})).text();
      const names = [...xml.matchAll(/<OBJECT_NAME>([^<]+)<\/OBJECT_NAME>/g)].map((m) => m[1]);
      expect(names).to.include("$STG_SEGW_DDIC");
      expect(names.filter((n) => n === "$STG_SEGW_DDIC")).to.have.length(1);
    });

    it("no row carries an empty OBJECT_URI or OBJECT_VIT_URI, so no two nodes collide as URI('')", async () => {
      // proven cause of clicking one package opening another, of the
      // neighbours being jerked, and of a node stuck on "Loading repository
      // tree ...": the client parses OBJECT_URI and OBJECT_VIT_URI as
      // new URI(value) with no empty guard, and compares nodes by their
      // path, so every empty one equals every other and the expander takes
      // the first (.local/scratch/answer-tree-identity.md). Every row here
      // must carry a distinct OBJECT_URI and omit OBJECT_VIT_URI when empty.
      for (const parent of ["$STG_SEGW", "$ZOSD_TEST", "$STG"]) {
        const xml = await (await call("/repository/nodestructure?parent_type=DEVC%2FK&parent_name=" + encodeURIComponent(parent), {method: "POST"})).text();
        expect(xml, `${parent}: an empty OBJECT_VIT_URI collides every node`).to.not.contain("<OBJECT_VIT_URI/>");
        expect(xml, `${parent}: an empty OBJECT_URI collides every node`).to.not.contain("<OBJECT_URI/>");
        const uris = [...xml.matchAll(/<OBJECT_URI>([^<]+)<\/OBJECT_URI>/g)].map((m) => m[1]);
        expect(new Set(uris).size, `${parent}: every node URI is distinct`).to.equal(uris.length);
      }
    });

    // $TMP is the local package of every ABAP system, so a client asks for
    // it by name without ever having been told it is there. The store has
    // none, because our packages are folders; the façade answers the
    // protocol's guarantee rather than letting a client meet a 404 for the
    // first node it opens.
    it("the local package resolves, because every client assumes it exists", async () => {
      const res = await call("/packages/%24TMP");
      expect(res.status).to.equal(200);
      expect(await res.text()).to.contain("$TMP");
    });

    // $TMP is what a client shows without being asked — Favorite Packages
    // holds it from the first logon — so it opens to the package above all
    // of ours, and from there to everything. Nothing is invented beyond
    // that one link: $TMP holds no objects of its own.
    it("the local package opens straight to the roots, and holds nothing itself", async () => {
      const xml = await (await call("/repository/nodestructure?parent_type=DEVC%2FK&parent_name=%24TMP", {method: "POST"})).text();
      const rows = [...xml.matchAll(/<OBJECT_TYPE>([^<]*)<\/OBJECT_TYPE><OBJECT_NAME>([^<]*)<\/OBJECT_NAME>/g)].map((m) => `${m[1]} ${m[2]}`);
      // $STG and $ZOSD_TEST are in every tree. $OSD is not: it is the parent
      // of imported repositories (tools/osd-store.mjs), and since o4d, zork
      // and lsd became packs rather than clones under local/ there is nothing
      // imported here to hang under it. An absent $OSD is therefore the
      // correct answer and not a missing root; test/osd-import.mjs is where
      // the import case is checked.
      expect(rows, "every root, with no package in between").to.include.members(["DEVC/K $STG", "DEVC/K $ZOSD_TEST"]);
      expect(rows.some((row) => row.includes("$STG/")), "a root, not a path to one").to.equal(false);
      const doc = await (await call("/packages/$TMP")).text();
      expect(doc).to.contain('adtcore:name="$TMP"');
    });

    // the simulation is one name and one failure: anything else the store
    // says is missing stays missing, or the façade would be inventing a tree
    it("a package that is genuinely absent is still a 404", async () => {
      expect((await call("/packages/%24NOPE_NOT_HERE")).status).to.equal(404);
    });

    // the instrument that decides what the next wave is. It used to see only
    // paths nothing was mounted on, so a client failing on every node it
    // opened left it empty and the empty list read as a clean bill of health
    it("a missing object is recorded, not only a missing resource", async () => {
      await call("/packages/%24NOPE_NOT_HERE");
      const missed = await (await fetch(`http://localhost:${PORT}/osd/not-served`)).json();
      const object = missed.find((m) => m.path.endsWith("NOPE_NOT_HERE"));
      expect(object, "the object miss was not recorded").to.not.equal(undefined);
      expect(object.kind).to.equal("object");
      expect(object.detail).to.contain("does not exist");
    });

    it("a resource nothing is mounted on is recorded as the other kind", async () => {
      await call("/atc/worklists");
      const missed = await (await fetch(`http://localhost:${PORT}/osd/not-served`)).json();
      expect(missed.find((m) => m.path.endsWith("/atc/worklists"))?.kind).to.equal("resource");
    });

    it("the node structure walks one level: subpackages and objects", async () => {
      const res = await call("/repository/nodestructure?parent_type=DEVC%2FK&parent_name=" + encodeURIComponent("$STG_GEN_SEGW"), {method: "POST"});
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<TREE_CONTENT>");
      expect(xml).to.contain("<OBJECT_TYPE>CLAS/OC</OBJECT_TYPE>");
      expect(xml).to.contain("<OBJECT_URI>/sap/bc/adt/oo/classes/");
    });

    it("keeps the package root flat so each visible package keeps its identity", async () => {
      const xml = await (await call("/repository/nodestructure?parent_type=DEVC&parent_name=", {
        method: "POST",
      })).text();
      const rows = [...xml.matchAll(/<SEU_ADT_REPOSITORY_OBJ_NODE>([\s\S]*?)<\/SEU_ADT_REPOSITORY_OBJ_NODE>/g)]
        .map((match) => match[1]);
      expect(rows.length, "the root fixture must exercise sibling packages").to.be.greaterThan(1);
      expect(rows.every((row) => /<OBJECT_NAME>[^<]+<\/OBJECT_NAME>/.test(row)),
        "a synthetic empty DEVC/K row aliases real package nodes").to.equal(true);
      expect(xml).to.not.contain("<CATEGORIES>");
      expect(xml).to.not.contain("<OBJECT_TYPES>");
      expect(xml).to.not.contain("<NODE_ID>");
    });

    // A subpackage is a row, not a drawer. Whenever DEVC/K appeared in
    // OBJECT_TYPES the client bound every package row to the first one — a
    // click on $STG_SEGW asked for $STG_APC — and where it was absent
    // packages opened as themselves. And the rows carry no NODE_ID, as the
    // system's do not (a4h-adt.jsonl:253): ids belong to the type entries.
    it("describes no type for subpackages, and gives object rows no node id", async () => {
      const xml = await (await call("/repository/nodestructure?parent_type=DEVC%2FK&parent_name=%24STG", {method: "POST"})).text();
      expect(xml).to.match(/<OBJECT_TYPE>DEVC\/K<\/OBJECT_TYPE><OBJECT_NAME>\$STG_SEGW<\/OBJECT_NAME>/);
      const types = [...xml.matchAll(/<SEU_ADT_OBJECT_TYPE_INFO><OBJECT_TYPE>([^<]*)<\/OBJECT_TYPE>/g)].map((m) => m[1]);
      expect(types).to.not.include("DEVC/K");
      const rows = [...xml.matchAll(/<SEU_ADT_REPOSITORY_OBJ_NODE>([\s\S]*?)<\/SEU_ADT_REPOSITORY_OBJ_NODE>/g)].map((m) => m[1]);
      expect(rows.every((row) => row.includes("<NODE_ID/>")), "an object row has no id of its own").to.equal(true);
    });

    it("labels an ungrouped DDIC type instead of leaving its drawer blank", async () => {
      const xml = await (await call("/repository/nodestructure?parent_type=DEVC%2FK&parent_name=" +
        encodeURIComponent("$EXPRESS_ICF_SHIM_DDIC"), {method: "POST"})).text();
      expect(xml).to.contain("<OBJECT_TYPE>DTEL/DE</OBJECT_TYPE>");
      expect(xml).to.contain("<CATEGORY_TAG>dictionary</CATEGORY_TAG>");
      expect(xml).to.contain("<OBJECT_TYPE_LABEL>Data Elements</OBJECT_TYPE_LABEL>");
      expect(xml).to.contain("<CATEGORY>dictionary</CATEGORY>");
      expect(xml).to.contain("<CATEGORY_LABEL>Dictionary</CATEGORY_LABEL>");
    });

    it("does not expose an unknown object-type code as a human label", () => {
      const xml = nodeStructureDocument([{type: "UNKNOWN/X", name: "ONE", uri: "/objects/one"}]);
      expect(xml).to.contain("<OBJECT_TYPE>UNKNOWN/X</OBJECT_TYPE>");
      expect(xml).to.contain("<OBJECT_TYPE_LABEL/>");
      expect(xml).to.not.contain("<OBJECT_TYPE_LABEL>UNKNOWN</OBJECT_TYPE_LABEL>");
    });

    it("returns only objects selected by a virtual tree node key", async () => {
      const path = "/repository/nodestructure?parent_type=DEVC%2FK&parent_name=" +
        encodeURIComponent("$EXPRESS_ICF_SHIM");
      const initial = await (await call(path, {method: "POST"})).text();
      const classType = /<SEU_ADT_OBJECT_TYPE_INFO><OBJECT_TYPE>CLAS\/OC<\/OBJECT_TYPE>[\s\S]*?<NODE_ID>([^<]+)<\/NODE_ID>/.exec(initial)?.[1];
      expect(classType).to.match(/^\d{6}$/);
      const selected = await (await call(path, {
        method: "POST",
        headers: {"content-type": "application/vnd.sap.as+xml"},
        body: `<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TV_NODEKEY>${classType}</TV_NODEKEY></DATA></asx:values></asx:abap>`,
      })).text();
      expect(selected).to.contain("<OBJECT_TYPE>CLAS/OC</OBJECT_TYPE>");
      expect(selected).to.not.contain("<OBJECT_TYPE>INTF/OI</OBJECT_TYPE>");
      expect(selected).to.contain("<CATEGORIES>");
      expect(selected).to.contain("<OBJECT_TYPES>");
      expect(selected).to.not.contain("<OBJECT_TYPE>DEVC/OC</OBJECT_TYPE>");
      expect(selected).to.match(/<OBJECT_TYPE>CLAS\/OC<\/OBJECT_TYPE><CATEGORY_TAG>source_library<\/CATEGORY_TAG><OBJECT_TYPE_LABEL>Classes<\/OBJECT_TYPE_LABEL><NODE_ID>\d{6}<\/NODE_ID>/);
    });

    it("a subpackage is expandable and an object is not, which is what a tree needs", async () => {
      const parent = await (await call("/repository/nodestructure?parent_name=" + encodeURIComponent("$STG_GEN"), {method: "POST"})).text();
      expect(parent).to.match(/<OBJECT_TYPE>DEVC\/K<\/OBJECT_TYPE>[\s\S]*?<EXPANDABLE>X<\/EXPANDABLE>/);
    });

    // Why a class is the exception to the line above.
    //
    // vscode-abap-fs builds a file name from the object it is showing, and its
    // AbapClass has no extension of its own: a class that is not expandable
    // takes the base ".abap" and appears as ZCL_X.abap. The ".clas.abap" a
    // person expects is the extension of the class's main *include*, which
    // only exists once the class is a folder with children. The interface next
    // to it always looked right because AbapInterface does carry its own
    // extension — which is how we knew the difference was expandability and
    // not the type code, since both codes were already what the client wanted.
    // The client's row parser accepts exactly two spellings of a version,
    // "A" and "I" (RepositoryObjectListItem#accept@535-593 in the 3.60.3
    // client), and silently leaves the version unset for anything else. So
    // "active", which reads fine to a person and to every other document
    // here, was "no version" on every object in the tree.
    it("spells an object's version the one way the client reads it", async () => {
      const xml = await (await call("/repository/nodestructure?parent_name=" +
        encodeURIComponent("$STG_SEGW"), {method: "POST"})).text();
      const versions = [...xml.matchAll(/<VERSION>([^<]*)<\/VERSION>/g)].map((m) => m[1]);
      expect(versions.length, "no object rows carry a version").to.be.greaterThan(0);
      for (const v of versions) {
        expect(["A", "I"], `VERSION=${v}`).to.include(v);
      }
    });

    it("a class is a folder for a client that builds its own tree, and a leaf for the Project Explorer", async () => {
      // an empty field is a self-closed element, so the flag is "" or "X"
      const row = (xml) => {
        const m = /<OBJECT_TYPE>CLAS\/OC<\/OBJECT_TYPE>(?:(?!SEU_ADT_REPOSITORY_OBJ_NODE>)[\s\S])*?(?:<EXPANDABLE>([^<]*)<\/EXPANDABLE>|<EXPANDABLE\/>)/.exec(xml);
        return m === null ? null : [m[0], m[1] ?? ""];
      };
      const own = await (await call("/repository/nodestructure?parent_name=" + encodeURIComponent("$STG_SEGW"),
        {method: "POST", headers: {accept: "*/*"}})).text();
      expect(row(own), "no class in the package the test reads").to.not.equal(null);
      expect(row(own)[1], "vscode-abap-fs names a class that is not a folder ZCL_X.abap").to.equal("X");
      const explorer = await (await call("/repository/nodestructure?parent_name=" + encodeURIComponent("$STG_SEGW"),
        {method: "POST", headers: {accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.RepositoryObjectTreeContent"}})).text();
      expect(row(explorer)[1], "the outline behind the arrow is parked, so no arrow").to.equal("");
    });

    // The data element editor opens on discovery alone: the client looks the
    // object's category up there before it sends anything, and without this
    // collection it offered to install software. The document is the
    // client's own model, filled from abapGit's DD04V.
    it("advertises data elements under the dictionary scheme, and serves one", async () => {
      const disco = await (await call("/discovery")).text();
      const coll = /<app:collection[^>]*href="\/sap\/bc\/adt\/ddic\/dataelements"[^>]*>([\s\S]*?)<\/app:collection>/.exec(disco);
      expect(coll, "the collection").to.not.equal(null);
      expect(coll[1]).to.contain('term="dtelde"');
      expect(coll[1]).to.contain('scheme="http://www.sap.com/wbobj/dictionary"');
      expect(coll[1]).to.contain("application/vnd.sap.adt.dataelements.v2+xml");
      const res = await call("/ddic/dataelements/icfname");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("application/vnd.sap.adt.dataelements.v2+xml");
      const xml = await res.text();
      expect(xml).to.contain("<blue:wbobj ");
      expect(xml).to.contain('adtcore:type="DTEL/DE"');
      expect(xml).to.contain("<dtel:typeKind>predefinedAbapType</dtel:typeKind>");
      expect(xml).to.contain("<dtel:dataType>CHAR</dtel:dataType>");
      expect(xml).to.contain("<dtel:dataTypeLength>15</dtel:dataTypeLength>");
      expect(xml).to.contain("<dtel:shortFieldLabel>Name</dtel:shortFieldLabel>");
      expect(xml).to.contain("<dtel:mediumFieldLabel>Service name</dtel:mediumFieldLabel>");
    });

    // One link is not a list, and the client does not check.
    //
    // abap-adt-api parses a class:include with links: e["atom:link"].map(...)
    // — .map straight on the property, where the class root beside it goes
    // through its xmlArray helper. An XML-to-object parser gives an object for
    // one child and a list for several, so a single link here is
    // "e.atom:link.map is not a function" and the class never opens. A4H emits
    // four per include and never meets the case, which is why no oracle
    // comparison would have found this.
    it("gives every class include more than one link, because one is not a list", async () => {
      const xml = await (await call("/oo/classes/zcl_stg_segw_gen")).text();
      const includes = [...xml.matchAll(/<class:include[\s\S]*?<\/class:include>/g)].map((m) => m[0]);
      expect(includes.length, "no includes in the class document").to.be.greaterThan(0);
      for (const part of includes) {
        const links = [...part.matchAll(/<atom:link[^>]*\/>/g)];
        expect(links.length, part.slice(0, 80)).to.be.greaterThan(1);
        expect(part, "the client selects by this type").to.contain('type="text/plain"');
      }
    });

    it("expanding a class answers with the includes it really has", async () => {
      const pkg = await (await call("/repository/nodestructure?parent_name=" +
        encodeURIComponent("$STG_SEGW"), {method: "POST"})).text();
      const name = /<OBJECT_TYPE>CLAS\/OC<\/OBJECT_TYPE><OBJECT_NAME>([^<]+)<\/OBJECT_NAME>/.exec(pkg)[1];
      const xml = await (await call("/repository/nodestructure?parent_type=CLAS%2FOC&parent_name=" +
        encodeURIComponent(name), {method: "POST"})).text();
      const names = [...xml.matchAll(/<OBJECT_NAME>([^<]+)<\/OBJECT_NAME>/g)].map((m) => m[1]);
      expect(names, "the main include is the one every class has").to.include(`${name}.main`);
      expect(xml).to.contain("<OBJECT_TYPE>CLAS/I</OBJECT_TYPE>");
      // and it is addressable: a node whose URI 404s is a tree that errors on click
      const uri = /<OBJECT_URI>([^<]*source\/main)<\/OBJECT_URI>/.exec(xml)[1];
      expect((await call(uri.replace("/sap/bc/adt", ""))).status).to.equal(200);
    });

    // adt-fs asks this before it writes, and a 404 here is a write that never
    // happens. The answer is "no transport, and none needed", which is true
    // rather than convenient: every package in this tree is local, and the
    // boundary to a real system is an abapGit archive, not a transport.
    it("a transport check answers that nothing has to be recorded", async () => {
      const res = await fetch(ADT + "/cts/transportchecks", {
        method: "POST",
        headers: {
          "x-csrf-token": token,
          cookie: `sap-contextid=${context}`,
          "content-type": "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData",
        },
        body: `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><URI>/sap/bc/adt/oo/classes/zcl_stg_dispatcher</URI><DEVCLASS></DEVCLASS><OPERATION>I</OPERATION></DATA></asx:values></asx:abap>`,
      });
      expect(res.status).to.equal(200);
      const xml = await res.text();
      // the pair that tells a client not to prompt for one
      expect(xml).to.contain("<RECORDING></RECORDING>");
      expect(xml).to.contain("<REQUESTS/>");
      // a message of severity E, A or X makes the client throw, so there are none
      expect(xml).to.contain("<MESSAGES/>");
      // and it knows which object it answered about
      expect(xml).to.contain("<OBJECTNAME>ZCL_STG_DISPATCHER</OBJECTNAME>");
      expect(xml).to.contain("<DEVCLASS>$STG_GATEWAY</DEVCLASS>");
    });

    it("transport checks are advertised now that they answer", async () => {
      expect(await (await call("/discovery")).text()).to.contain("cts/transportchecks");
    });

    it("search is advertised now that it answers", async () => {
      const xml = await (await call("/discovery")).text();
      expect(xml).to.contain('href="/sap/bc/adt/repository/informationsystem/search"');
      expect(xml).to.contain('href="/sap/bc/adt/packages"');
      expect(xml).to.contain('href="/sap/bc/adt/repository/nodestructure"');
    });
  });

  // The tree of a cloud project, one request per level, each checked against
  // the capture line it is modelled on (.local/capture/oracle/a4h-adt.jsonl).
  // Shapes, not strings: a drawer is an element with these attributes, a
  // count is a number, a link points where the system's does.
  describe("virtual folders, the cloud tree", () => {
    const REQ = '<vfs:virtualFoldersRequest xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders" objectSearchPattern="*">';
    const pre = (facet, ...values) => `<vfs:preselection facet="${facet}">` +
      values.map((v) => `<vfs:value>${v}</vfs:value>`).join("") + "</vfs:preselection>";
    const order = (...facets) => "<vfs:facetorder>" + facets.map((f) => `<vfs:facet>${f}</vfs:facet>`).join("") + "</vfs:facetorder>";
    const ask = async (...parts) => {
      const res = await call("/repository/informationsystem/virtualfolders/contents", {
        method: "POST", headers: {"content-type": "application/xml"}, body: REQ + parts.join("") + "</vfs:virtualFoldersRequest>",
      });
      expect(res.status).to.equal(200);
      const xml = await res.text();
      const attrs = (tag) => [...xml.matchAll(new RegExp(`<vfs:${tag} ([^>]*)>`, "g"))]
        .map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
      return {xml, count: Number(/objectCount="(\d+)"/.exec(xml)[1]), folders: attrs("virtualFolder"), objects: attrs("object")};
    };

    // a4h-adt.jsonl:44 and :232 — one package selected, package level asked
    it("opens one package to its subpackages, and to a ..drawer for its own objects", async () => {
      const {xml, folders, count} = await ask(pre("package", "$STG_SEGW"), order("package", "group", "type"));
      expect(xml).to.contain('<vfs:preselectionInfo facet="PACKAGE" hasChildrenOfSameFacet="true"/>');
      const names = folders.map((f) => f.name);
      expect(names, "the subpackage is a drawer").to.include("$STG_SEGW_DDIC");
      expect(names, "objects of the package itself sit in a ..drawer, first").to.include("..$STG_SEGW");
      expect(names[0]).to.equal("..$STG_SEGW");
      for (const f of folders) {
        expect(f.facet).to.equal("PACKAGE");
        expect(f.uri, f.name).to.match(/^\/sap\/bc\/adt\/packages\//);
        expect(Number(f.counter), f.name).to.be.a("number");
      }
      expect(folders.find((f) => f.name === "..$STG_SEGW").text).to.equal("directly assigned objects");
      // the drawer's link selects the child alone, not the parent and the child
      expect(xml).to.contain("selection=" + encodeURIComponent("package:$STG_SEGW_DDIC"));
      expect(count, "objectCount is the subtree, which is what the client shows beside the package")
        .to.equal(folders.reduce((n, f) => n + Number(f.counter), 0));
    });

    // a4h-adt.jsonl:231 — several packages selected, package level asked
    it("opens several packages to themselves, with no preselection info", async () => {
      const {xml, folders} = await ask(pre("package", "$STG_SEGW", "$STG_GEN"), order("package", "group", "type"));
      expect(xml).to.not.contain("preselectionInfo");
      expect(folders.map((f) => f.name)).to.deep.equal(["$STG_SEGW", "$STG_GEN"]);
      expect(folders[0].hasChildrenOfSameFacet, "$STG_SEGW has a subpackage").to.equal("true");
    });

    // a4h-adt.jsonl:233 — the direct-only spelling
    it("reads ..P as the objects assigned to P directly, not its subtree", async () => {
      const direct = await ask(pre("package", "..$STG_SEGW"), order("group", "type"));
      const deep = await ask(pre("package", "$STG_SEGW"), order("group", "type"));
      expect(direct.xml).to.not.contain("preselectionInfo");
      expect(direct.count).to.be.greaterThan(0);
      expect(deep.count, "the subtree holds the DDIC subpackage's objects too").to.be.greaterThan(direct.count);
      const group = direct.folders.find((f) => f.name === "SOURCE_LIBRARY");
      expect(group, "a group drawer").to.not.equal(undefined);
      expect(group.facet).to.equal("GROUP");
      expect(group.displayName).to.equal("Source Code Library");
    });

    // a4h-adt.jsonl:91 — group and package fixed, type level asked
    it("names a type drawer the way the workbench does", async () => {
      const {folders} = await ask(pre("group", "SOURCE_LIBRARY"), pre("package", "$STG_SEGW"), order("type"));
      const clas = folders.find((f) => f.name === "CLAS");
      expect(clas, "classes drawer").to.not.equal(undefined);
      expect(clas.facet).to.equal("TYPE");
      expect(clas.displayName).to.equal("Classes");
      expect(Number(clas.counter)).to.be.greaterThan(0);
      expect(clas.text).to.equal("");
    });

    // a4h-adt.jsonl:92 — everything fixed, the objects themselves
    it("lists objects with a description, a type code and no link it cannot serve", async () => {
      const {objects, count} = await ask(pre("group", "SOURCE_LIBRARY"), pre("package", "$STG_SEGW"), pre("type", "CLAS"), order());
      expect(objects.length).to.equal(count);
      expect(objects.length).to.be.greaterThan(0);
      for (const o of objects) {
        expect(o.type).to.equal("CLAS/OC");
        expect(o.expandable).to.equal("true");
        expect(o.package).to.equal("$STG_SEGW");
        expect(o.uri).to.match(/^\/sap\/bc\/adt\/oo\/classes\//);
        expect(o, "vituri points at SAP GUI for HTML, which is not here").to.not.have.property("vituri");
      }
    });

    // a4h-adt.jsonl:30 — the released-objects tree, which this façade cannot fill
    it("answers the api facet empty rather than calling everything released", async () => {
      const {folders, count} = await ask(pre("api", "USE_IN_CLOUD_DEVELOPMENT"), order("api", "group", "type"));
      expect(count).to.equal(0);
      expect(folders).to.deep.equal([]);
    });
  });

  // A table as the editor and the data preview read it, by the capture:
  // the object (a4h-adt.jsonl:403), its DDL (:405), the columns (:642) and
  // the rows (:643).
  describe("a table, opened and previewed", () => {
    it("is an object with a DDL source behind it", async () => {
      const res = await call("/ddic/tables/zstg_photo");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("application/vnd.sap.adt.tables.v2+xml");
      const xml = await res.text();
      expect(xml).to.contain("<blue:blueSource ");
      expect(xml).to.contain('adtcore:type="TABL/DT"');
      expect(xml).to.contain('abapsource:sourceUri="./zstg_photo/source/main"');
      const src = await call("/ddic/tables/zstg_photo/source/main");
      expect(src.headers.get("content-type")).to.contain("text/plain");
      const ddl = await src.text();
      expect(ddl).to.contain("define table zstg_photo {");
      expect(ddl).to.contain("key mandt");
      expect(ddl).to.match(/key mandt\s+: mandt not null;/);
      expect(ddl).to.match(/travel_id\s+: abap\.char\(8\) not null;/);
      expect(ddl).to.match(/content\s+: abap\.rawstring\(0\);/);
    });

    it("describes its columns from the dictionary, not from the first row", async () => {
      const res = await call("/datapreview/ddic/ZSTG_PHOTO/metadata");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("application/vnd.sap.adt.datapreview.table.v1+xml");
      const xml = await res.text();
      expect(xml).to.contain("<dataPreview:name>ZSTG_PHOTO</dataPreview:name>");
      expect(xml).to.match(/dataPreview:name="MANDT" dataPreview:type="C" [^/]*dataPreview:colType="CLNT"[^/]*dataPreview:length="3"/);
      expect(xml).to.match(/dataPreview:name="CONTENT" dataPreview:type="y" [^/]*dataPreview:colType="RSTR"/);
      expect(xml, "the metadata carries no rows").to.not.contain("<dataPreview:data>");
      expect(xml, "the A4H metadata offers the same max-row capability for tables and CDS")
        .to.contain("datapreview/cds/metadata/maxrows");
    });

    it("answers F8 with the rows of the table under the same columns", async () => {
      const res = await call("/datapreview/ddic?rowNumber=5&ddicEntityName=ZSTG_PHOTO", {method: "POST",
        body: "SELECT ZSTG_PHOTO~MANDT, ZSTG_PHOTO~TRAVEL_ID, ZSTG_PHOTO~MIME_TYPE FROM ZSTG_PHOTO"});
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.match(/dataPreview:name="TRAVEL_ID" dataPreview:type="C" [^/]*dataPreview:colType="CHAR"[^/]*dataPreview:length="8"/);
      expect((xml.match(/<dataPreview:data>/g) ?? []).length, "rows came back").to.be.greaterThan(0);
      const whole = await call("/datapreview/ddic?rowNumber=5&ddicEntityName=ZSTG_PHOTO", {method: "POST", body: ""});
      expect(whole.status, "no SELECT means the whole table").to.equal(200);
      expect((await call("/ddic/tables/parser/info")).status, "the system's grammar is not ours to serve").to.equal(404);
    });

    it("advertises and answers the shared row-count operation Eclipse uses for TABL and CDS", async () => {
      const discovery = await (await call("/discovery")).text();
      expect(discovery).to.contain("http://www.sap.com/adt/categories/datapreview/ddic/colcount");
      expect(discovery).to.contain("/sap/bc/adt/datapreview/ddic{?rowNumber,ddicEntityName,colNumber}");

      const res = await call("/datapreview/ddic?ddicEntityName=ZSTG_PHOTO", {method: "POST",
        body: "SELECT COUNT(*) FROM ZSTG_PHOTO"});
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.match(/<dataPreview:totalRows>1<\/dataPreview:totalRows>/);
      expect(xml).to.match(/<dataPreview:data>\d+<\/dataPreview:data>/);

      const cds = await call("/datapreview/ddic?ddicEntityName=ZC_STG_BOOKING", {method: "POST",
        body: "SELECT COUNT( * ) FROM ZC_STG_BOOKING"});
      expect(cds.status, "CDS count travels through the same DDIC relation").to.equal(200);
      expect(await cds.text()).to.match(/<dataPreview:data>\d+<\/dataPreview:data>/);
      const table = await call("/datapreview/ddic?ddicEntityName=ZSTG_PHOTO&dataAging=false", {method: "POST",
        body: "SELECT COUNT( * ) FROM ZSTG_PHOTO"});
      expect(table.status, "ADT's COUNT( * ) spelling works for TABL too").to.equal(200);
      const cdsViaRefresh = await call("/datapreview/cds?ddlSourceName=ZC_STG_BOOKING", {method: "POST",
        body: "SELECT COUNT( * ) FROM ZC_STG_BOOKING"});
      expect(cdsViaRefresh.status, "CDS count uses the associationrefresh template").to.equal(200);
      expect(await cdsViaRefresh.text()).to.match(/<dataPreview:data>\d+<\/dataPreview:data>/);
    });

    it("describes a CDS view by its element names, not its columns", async () => {
      const res = await call("/datapreview/cds/ZC_STG_BOOKING/metadata");
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("application/vnd.sap.adt.datapreview.table.v1+xml");
      const xml = await res.text();
      expect(xml).to.contain("<dataPreview:cdsEntityName>ZC_STG_BOOKING</dataPreview:cdsEntityName>");
      // the element is TravelId in the source and TRAVELID in the database,
      // and the client shows both
      expect(xml).to.match(/dataPreview:name="TRAVELID" dataPreview:camelCaseName="TravelId"/);
      // the type comes from the base table's field, because a projection
      // does not restate it
      expect(xml).to.match(/dataPreview:camelCaseName="TravelId"[^/]*dataPreview:colType="CHAR"[^/]*dataPreview:length="8"/);
      expect(xml, "a key of the view is marked as one").to.match(/dataPreview:name="BOOKINGID"[^/]*dataPreview:keyAttribute="true"/);
      expect(xml, "the metadata carries no rows").to.not.contain("<dataPreview:data>");
      expect(xml, "and offers the row-count link the client uses").to.contain("datapreview/cds/metadata/maxrows");
    });

    it("answers F8 on a CDS view with rows from the generated view", async () => {
      const res = await call("/datapreview/cds?rowNumber=3&ddlSourceName=ZC_STG_BOOKING", {method: "POST",
        body: "SELECT ZC_STG_BOOKING~TRAVELID, ZC_STG_BOOKING~BOOKINGID FROM ZC_STG_BOOKING"});
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<dataPreview:cdsCamelCaseName>");
      expect((xml.match(/<dataPreview:data>/g) ?? []).length, "rows came back").to.be.greaterThan(0);
      const whole = await call("/datapreview/cds?rowNumber=2&ddlSourceName=ZC_STG_BOOKING", {method: "POST", body: ""});
      expect(whole.status, "no SELECT means the whole entity").to.equal(200);
      const missing = await call("/datapreview/cds?ddlSourceName=ZC_NO_SUCH_VIEW", {method: "POST", body: ""});
      expect(missing.status, "a view that is not there is a 404, not an empty preview").to.equal(404);
    });

    it("advertises the CDS preview with the system's own term and templates", async () => {
      const xml = await (await call("/discovery")).text();
      expect(xml).to.contain('href="/sap/bc/adt/datapreview/cds"');
      expect(xml).to.contain('term="DatapreviewCds"');
      expect(xml).to.contain("/sap/bc/adt/datapreview/cds{?rowNumber,ddlSourceName}");
      expect(xml, "the raw preview enables its SQL Pane from the DDIC relation")
        .to.contain("http://www.sap.com/adt/categories/datapreview/ddic/launchfreestyle");
      expect(xml, "the launch template is an endpoint OSD actually serves")
        .to.contain('template="/sap/bc/adt/datapreview/freestyle"');
      expect(xml, "the CDS collection carries the system's matching launch relation")
        .to.contain("http://www.sap.com/adt/categories/datapreview/cds/launchfreestyle");
      expect(xml, "CDS count dereferences the A4H associationrefresh template")
        .to.contain('rel="http://www.sap.com/adt/categories/datapreview/cds/associationrefresh" template="/sap/bc/adt/datapreview/cds{?action,rowNumber,targetType,ddlSourceName}"');
      expect(xml, "the association walks are not served, so they are not offered")
        .to.not.contain("datapreview/cds/associationlist");
    });
  });

  describe("what the client infers from a shape", () => {
    it("a write without a token is the only 403 the façade gives", async () => {
      const res = await fetch(ADT + "/datapreview/freestyle", {method: "POST", body: "SELECT * FROM zstg_demo"});
      expect(res.status).to.equal(403);
      expect(res.headers.get("x-csrf-token")).to.equal("Required");
    });

    it("no answer is ever a redirect", async () => {
      for (const path of ["/core/discovery", "/discovery", "/oo/classes/ZCL_STG_DISPATCHER/source/main"]) {
        const res = await call(path, {redirect: "manual"});
        expect([301, 302, 303, 307, 308], path).to.not.include(res.status);
      }
    });

    it("every answer carries a token, which is how a client knows it is still logged on", async () => {
      for (const path of ["/core/discovery", "/oo/classes/ZCL_STG_DISPATCHER/source/main"]) {
        const res = await call(path);
        expect(res.headers.get("x-csrf-token"), path).to.be.a("string").with.length.greaterThan(8);
      }
    });

    it("the OData front is still on the same listener, which is why one address is enough", async () => {
      const res = await fetch(`http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
      expect(res.status).to.equal(200);
    });
  });
});

describe("tools/adt-facade: a host without a body parser", () => {
  it("still reads the node key that selects a lazy tree drawer", async () => {
    const store = {
      package: () => ({
        name: "$TEST", subpackages: [], objects: [
          {type: "CLAS", name: "ZCL_ONE", library: false},
          {type: "INTF", name: "ZIF_TWO", library: false},
        ],
      }),
    };
    const app = express();
    app.use(adtRouter({store, data: {}, logMisses: false}).router);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });

    try {
      const base = `http://127.0.0.1:${server.address().port}/sap/bc/adt`;
      const login = await fetch(base + "/core/discovery", {headers: {"x-csrf-token": "fetch"}});
      const token = login.headers.get("x-csrf-token");
      const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")])
        .filter(Boolean).map((value) => value.split(";", 1)[0]).join("; ");
      const path = base + "/repository/nodestructure?parent_type=DEVC%2FK&parent_name=%24TEST";
      const initial = await (await fetch(path, {method: "POST", headers: {"x-csrf-token": token, cookie}})).text();
      const classType = /<SEU_ADT_OBJECT_TYPE_INFO><OBJECT_TYPE>CLAS\/OC<\/OBJECT_TYPE>[\s\S]*?<NODE_ID>([^<]+)<\/NODE_ID>/.exec(initial)?.[1];
      expect(classType).to.match(/^\d{6}$/);

      const selected = await (await fetch(path, {
        method: "POST",
        headers: {"x-csrf-token": token, cookie, "content-type": "application/vnd.sap.as+xml"},
        body: `<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TV_NODEKEY>${classType}</TV_NODEKEY></DATA></asx:values></asx:abap>`,
      })).text();
      expect(selected).to.contain("<OBJECT_TYPE>CLAS/OC</OBJECT_TYPE>");
      expect(selected).to.not.contain("<OBJECT_TYPE>INTF/OI</OBJECT_TYPE>");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// "run tests on a different database" (docs/vscode-extension.md,
// "Databases"): `core/http/unit/object/run`'s own JSON body, sanitised to
// UNIT_RUN_DB_ENV_KEYS before it ever reaches `runDetached` (and from there
// a spawned child's environment) -- a fake `req` here, no server needed,
// the same shape "a host without a body parser" above already uses for the
// stream-reading fallback of `rawBody`.
describe("tools/adt-facade: unitRunDbEnv (core/http/unit/object/run's dbEnv body)", () => {
  const reqWith = (body) => ({body: Buffer.isBuffer(body) ? body : Buffer.from(body ?? "")});

  it("no body at all -- every existing caller -- is undefined, not an error", async () => {
    expect(await unitRunDbEnv(reqWith(undefined))).to.equal(undefined);
    expect(await unitRunDbEnv(reqWith(""))).to.equal(undefined);
  });

  it("a body with no dbEnv, or one that is not JSON, is undefined", async () => {
    expect(await unitRunDbEnv(reqWith(JSON.stringify({somethingElse: 1})))).to.equal(undefined);
    expect(await unitRunDbEnv(reqWith("not json"))).to.equal(undefined);
  });

  it("keeps only the allowlisted keys, string-valued, and drops the rest", async () => {
    const dbEnv = await unitRunDbEnv(reqWith(JSON.stringify({
      dbEnv: {STG_DB: "hana", HANA_SCHEMA: "OSD_TEST", PATH: "/etc/passwd", NODE_OPTIONS: "--inspect", weird: 42},
    })));
    expect(dbEnv).to.deep.equal({STG_DB: "hana", HANA_SCHEMA: "OSD_TEST"});
  });

  it("UNIT_RUN_DB_ENV_KEYS covers every env var the HANA and PostgreSQL clients read", () => {
    for (const key of ["STG_DB", "HANA_HOST", "HANA_PORT", "HANA_USER", "HANA_PASSWORD", "HANA_SCHEMA",
      "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
      expect(UNIT_RUN_DB_ENV_KEYS.has(key), key).to.equal(true);
    }
  });

  it("an empty dbEnv, or one that is entirely filtered away, is undefined", async () => {
    expect(await unitRunDbEnv(reqWith(JSON.stringify({dbEnv: {}})))).to.equal(undefined);
    expect(await unitRunDbEnv(reqWith(JSON.stringify({dbEnv: {PATH: "/x"}})))).to.equal(undefined);
  });

  it("passes a validated inspector port alongside the database config", async () => {
    expect(await unitRunOptions(reqWith(JSON.stringify({dbEnv: {STG_DB: "hana"}, inspectPort: 9444}))))
      .to.deep.equal({dbEnv: {STG_DB: "hana"}, inspectPort: 9444, waitForDebugger: false});
    expect(await unitRunOptions(reqWith(JSON.stringify({inspectPort: 9444, waitForDebugger: true}))))
      .to.deep.equal({dbEnv: undefined, inspectPort: 9444, waitForDebugger: true});
    for (const body of [{waitForDebugger: true}, {inspectPort: 9444, waitForDebugger: "true"}]) {
      try {
        await unitRunOptions(reqWith(JSON.stringify(body)));
        throw new Error("expected invalid debugger gate to fail");
      } catch (error) {
        expect(error.code).to.equal("INVALID_REQUEST");
      }
    }
    try {
      await unitRunOptions(reqWith(JSON.stringify({inspectPort: "--inspect"})));
      throw new Error("expected invalid inspector port to fail");
    } catch (error) {
      expect(error.code).to.equal("INVALID_REQUEST");
      expect(error.message).to.contain("inspector port");
    }
    try {
      await unitRunOptions(reqWith(JSON.stringify({inspectPort: true})));
      throw new Error("expected a non-numeric inspector port to fail");
    } catch (error) {
      expect(error.code).to.equal("INVALID_REQUEST");
    }
  });
});
