import {once} from "node:events";
import {expect} from "chai";
import express from "express";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, readFileSync, existsSync, linkSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve, win32} from "node:path";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {execFileSync} from "node:child_process";
import {ObjectStore} from "../tools/osd-store.mjs";
import {build, gc, liveHash} from "../tools/osd-build.mjs";
import {HotLoader} from "../tools/osd-hot.mjs";
import {WarmCompiler} from "../tools/osd-warm.mjs";
import {adtRouter} from "../tools/adt-facade.mjs";
import {adtAbap} from "./helpers/adt-abap.mjs";
import {classIncludeTemplates} from "../tools/adt-documents.mjs";

const REPO = resolve(".");
const main = `CLASS zcl_t05 DEFINITION PUBLIC. PUBLIC SECTION.
CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
INTERFACES if_oo_adt_classrun.
ENDCLASS.
CLASS zcl_t05 IMPLEMENTATION. METHOD run.
rv = lcl_value=>get( ).
ENDMETHOD.
METHOD if_oo_adt_classrun~main. out->write( run( ) ). ENDMETHOD.
ENDCLASS.\n`;
const def = 'CLASS lcl_value DEFINITION. PUBLIC SECTION. CLASS-METHODS get RETURNING VALUE(rv) TYPE string. ENDCLASS.\n';
const imp = value => `CLASS lcl_value IMPLEMENTATION. METHOD get. rv = '${value}'. ENDMETHOD. ENDCLASS.\n`;
const prog = value => `REPORT zt05.\n\nWRITE '${value}'.\n`;

// Critic round 2: STORE used to retain an empty placeholder when active
// source was unavailable, then mistake an empty save for those active bytes.
for (const front of ["node", "abap"]) for (const scenario of ["fresh tree", "cleaned build", "built tree"]) {
  describe(`STORE empty-source provenance: ${front}, ${scenario}`, function () {
    this.timeout(180000);
    let root, store, server, base, hash, savedClasses;
    const classMain = `CLASS zcl_empty_live DEFINITION PUBLIC. PUBLIC SECTION.
CLASS-METHODS run RETURNING VALUE(rv) TYPE string. ENDCLASS.
CLASS zcl_empty_live IMPLEMENTATION. METHOD run. rv = lcl_value=>get( ). ENDMETHOD. ENDCLASS.\n`;
    const program = "REPORT zempty_live. WRITE 'P1'.\n";
    const options = () => ({root, libs: [], roots: [{path: "src", writable: true}]});
    const objects = [
      {type: "PROG", name: "ZEMPTY_LIVE", path: "/programs/programs/zempty_live", parts: {main: program}},
      {type: "CLAS", name: "ZCL_EMPTY_LIVE", path: "/oo/classes/zcl_empty_live",
        parts: {main: classMain, definitions: def, implementations: imp("P1"), macros: ""}},
    ];
    before(async () => {
      await import("./start.mjs");
      savedClasses = Object.fromEntries(["CX_ROOT", "IF_OO_ADT_CLASSRUN", "IF_OO_ADT_CLASSRUN_OUT", "ZCL_EMPTY_LIVE"]
        .map(name => [name, abap.Classes[name]]));
      root = mkdtempSync(join(tmpdir(), "adt-empty-provenance-"));
      mkdirSync(join(root, "src"));
      const files = {"zempty_live.prog.abap": program, "zcl_empty_live.clas.abap": classMain,
        "zcl_empty_live.clas.locals_def.abap": def, "zcl_empty_live.clas.locals_imp.abap": imp("P1"),
        "zcl_empty_live.clas.macros.abap": "",
        "if_oo_adt_classrun.intf.abap": "INTERFACE if_oo_adt_classrun PUBLIC. METHODS main IMPORTING out TYPE REF TO if_oo_adt_classrun_out. ENDINTERFACE.\n",
        "if_oo_adt_classrun_out.intf.abap": "INTERFACE if_oo_adt_classrun_out PUBLIC. METHODS write IMPORTING data TYPE any. ENDINTERFACE.\n",
        "cx_root.clas.abap": "CLASS cx_root DEFINITION PUBLIC. ENDCLASS. CLASS cx_root IMPLEMENTATION. ENDCLASS.\n"};
      for (const [file, source] of Object.entries(files)) writeFileSync(join(root, "src", file), source);
      writeFileSync(join(root, "package.json"), "{}");
      symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
      writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: "src", output_folder: "output", libs: [],
        options: {ignoreSyntaxCheck: false, addCommonJS: true, unknownTypes: "compileError"}}));
      if (scenario !== "fresh tree") {
        hash = (await build({root, generators: false})).hash;
        await import(pathToFileURL(join(root, "output/zcl_empty_live.clas.mjs")));
      }
      if (scenario === "built tree") {
        // First STORE saves must recover generation-backed input digests,
        // including the empty macro include, before retaining active copies.
        rmSync(join(root, "build/by-input", hash, "source"), {recursive: true});
        rmSync(join(root, "build/source-by-digest"), {recursive: true});
      }
      store = new ObjectStore(options());
      if (hash) store.served = {running: true, generation: hash};
      if (scenario === "cleaned build") {
        // The loaded P1 remains executable, but its source proof is gone.
        writeFileSync(join(root, "src/zcl_empty_live.clas.locals_imp.abap"), imp("P2"));
        writeFileSync(join(root, "src/zempty_live.prog.abap"), program.replace("P1", "P2"));
        rmSync(join(root, "build"), {recursive: true});
      }
    });
    after(async () => {
      if (server) await new Promise(done => server.close(done));
      Object.assign(abap.Classes, savedClasses);
      if (root) rmSync(root, {recursive: true, force: true});
    });
    const serve = async reader => {
      if (server) await new Promise(done => server.close(done));
      const app = express();
      app.use(adtRouter({store: reader, watch: false, abap: front === "abap" ? await adtAbap() : undefined}).router);
      server = await new Promise(done => {const s = app.listen(0, () => done(s));});
      base = `http://localhost:${server.address().port}/sap/bc/adt`;
    };
    const verify = async (object, expected, version) => {
      for (const reader of [store, new ObjectStore(options())]) {
        if (hash) reader.served = {running: true, generation: hash};
        await serve(reader);
        for (const [include, source] of Object.entries(expected)) {
          const path = object.path + (include === "main" ? "" : `/includes/${include}`) + "/source/main";
          const active = await fetch(base + path + "?version=active");
          // Unknown main source is a 404; absent standard includes generate
          // their measured template from READ's per-version absence flag.
          const template = object.type === "CLAS" && scenario !== "built tree" ? classIncludeTemplates[include] : undefined;
          expect(active.status).to.equal(scenario === "built tree" || template !== undefined ? 200 : 404);
          const body = await active.text();
          if (scenario === "built tree" || template !== undefined) expect(body).to.equal(template ?? source);
          else expect(body).to.include("ExceptionResourceNotFound");
          if (template !== undefined) expect(reader.read(object.type, object.name, include, "active").empty).to.equal(true);
          expect(reader.read(object.type, object.name, include).source).to.equal(scenario === "built tree" ? source : "");
        }
        const doc = await fetch(base + object.path);
        expect(doc.status).to.equal(200);
        expect(await doc.text()).to.include(`adtcore:version="${version}"`);
        expect(reader.stateOf(reader.find(object.type, object.name)).version).to.equal(version);
      }
    };
    for (const object of objects) it(`${object.type}: empty STORE saves and reopen preserve source provenance`, async () => {
      if (scenario === "built tree") {
        for (const [include, source] of Object.entries(object.parts)) store.write(object.type, object.name, source, include);
        await verify(object, object.parts, "active");
        for (const include of Object.keys(object.parts)) store.write(object.type, object.name, "", include);
        expect(store.stateOf(store.find(object.type, object.name)).version).to.equal("inactive");
        for (const [include, source] of Object.entries(object.parts)) store.write(object.type, object.name, source, include);
        await verify(object, object.parts, "active");
      } else {
        expect(store.stateOf(store.find(object.type, object.name)).version).to.equal("inactive");
        for (const include of Object.keys(object.parts)) store.write(object.type, object.name, "", include);
        await verify(object, Object.fromEntries(Object.keys(object.parts).map(include => [include, ""])), "inactive");
        if (scenario === "cleaned build") expect((await abap.Classes.ZCL_EMPTY_LIVE.run()).get()).to.equal("P1");
      }
    });
    if (scenario === "built tree") it("a proven empty include stays active from pre-save copies after reopen", async () => {
      // A pre-save copy of proven empty bytes is still valid without build proof.
      rmSync(join(root, "build/by-input", hash), {recursive: true});
      store.write("CLAS", "ZCL_EMPTY_LIVE", "* pending macro\n", "macros");
      store.write("CLAS", "ZCL_EMPTY_LIVE", "", "macros");
      await verify(objects[1], objects[1].parts, "active");
    });
  });
}

describe("generation source provenance", function () {
  this.timeout(180000);
  for (const repair of ["active backfill", "input retention"]) it(`${repair} replaces a corrupt snapshot without changing its hard-link peers`, async () => {
    const {keepSourceInputs} = await import("../tools/osd-source-snapshot.mjs");
    const root = mkdtempSync(join(tmpdir(), "adt-snapshot-links-"));
    try {
      const file = "src/zsnapshot.prog.abap";
      const source = "REPORT zsnapshot. WRITE 'active'.\n";
      const digest = createHash("sha256").update(source).digest("hex");
      const generation = join(root, "build/by-input/fixture");
      const target = join(generation, "source", file);
      const peer = join(root, "other-generation.prog.abap");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, file), source);
      const digests = new Map([[join(root, file), digest]]);
      keepSourceInputs(root, generation, digests);
      linkSync(target, peer);
      writeFileSync(target, "corrupt snapshot\n");
      const peerBytes = readFileSync(peer);
      const shared = join(root, "build/source-by-digest", digest);
      expect(statSync(target).ino).to.equal(statSync(peer).ino);
      expect(statSync(target).ino).to.equal(statSync(shared).ino);
      if (repair === "active backfill") {
        // An incomplete snapshot without shared lookup must backfill this path.
        rmSync(join(generation, "source-shared"));
        const store = new ObjectStore({root, libs: [], roots: [{path: "src", writable: true}]});
        store.served = {running: true, generation: "fixture"};
        expect(store.read("PROG", "ZSNAPSHOT", "main", "active").source).to.equal(source);
      } else {
        keepSourceInputs(root, generation, digests);
      }
      expect(readFileSync(peer).equals(peerBytes), "peer bytes remain unchanged").to.equal(true);
      expect(readFileSync(shared).equals(peerBytes), "shared digest bytes remain unchanged").to.equal(true);
      expect(statSync(target).ino).not.to.equal(statSync(peer).ino);
      expect(createHash("sha256").update(readFileSync(target)).digest("hex")).to.equal(digest);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
  it("normalizes Windows overlay paths in the real snapshot helper", () => {
    const module = readFileSync(join(REPO, "tools/osd-source-snapshot.mjs"), "utf8");
    const code = module.slice(module.indexOf("export function sourceSnapshotPath"), module.indexOf("// gen/"))
      .replaceAll("export function", "function")
      .replace(/function writeSourceSnapshot[\s\S]*?\n}\n/, "");
    const bytes = Buffer.from("REPORT ztest. WRITE 'P1'.\n");
    const written = [];
    const keep = new Function("createHash", "existsSync", "mkdirSync", "readFileSync", "writeSourceSnapshot", "writeFileSync", "linkSync", "copyFileSync",
      "dirname", "join", "relative", "resolve", "sep", code + ";return keepSourceInputs;")(
      createHash, () => true, () => {}, () => bytes, file => written.push(file), () => {}, () => {}, () => {},
      win32.dirname, win32.join, win32.relative, win32.resolve, win32.sep);
    const root = "C:\\repo", target = "C:\\repo\\build\\tmp\\hash";
    keep(root, target, new Map([["C:/repo/build/inactive/active/src/ztest.prog.abap", createHash("sha256").update(bytes).digest("hex")]]));
    expect(written).to.include(win32.join(target, "source", "src/ztest.prog.abap"));
  });
  for (const front of ["node", "abap"]) describe(`${front}: missing generation snapshot`, () => {
    let root, store, server, base, hash;
    const source = value => `CLASS zcl_provenance DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS run RETURNING VALUE(rv) TYPE string. ENDCLASS. CLASS zcl_provenance IMPLEMENTATION. METHOD run. rv = '${value}'. ENDMETHOD. ENDCLASS.\n`;
    before(async () => {
      await import("./start.mjs");
      root = mkdtempSync(join(tmpdir(), "adt-provenance-"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/zcl_provenance.clas.abap"), source("P1"));
      writeFileSync(join(root, "package.json"), "{}");
      symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
      writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: "src", output_folder: "output", libs: [],
        options: {ignoreSyntaxCheck: false, addCommonJS: true, unknownTypes: "compileError"}}));
      hash = (await build({root, generators: false})).hash;
      await import(pathToFileURL(join(root, "output/zcl_provenance.clas.mjs")));
      store = new ObjectStore({root, libs: []});
      store.served = {running: true, generation: hash};
      const app = express();
      app.use(adtRouter({store, watch: false, abap: front === "abap" ? await adtAbap() : undefined}).router);
      server = await new Promise(resolve => {const s = app.listen(0, () => resolve(s));});
      base = `http://localhost:${server.address().port}/sap/bc/adt/oo/classes/zcl_provenance`;
    });
    after(async () => {
      if (server) await new Promise(resolve => server.close(resolve));
      rmSync(root, {recursive: true, force: true});
    });
    const active = async (status = 200) => {
      const response = await fetch(base + "/source/main?version=active");
      expect(response.status).to.equal(status);
      return response.text();
    };
    it("a pre-snapshot generation with matching working bytes still answers active", async () => {
      rmSync(join(root, "build/by-input", hash, "source"), {recursive: true});
      rmSync(join(root, "build/by-input", hash, "source-inputs.json"), {force: true});
      rmSync(join(root, "build/by-input", hash, "source-shared"), {force: true});
      rmSync(join(root, "build/source-by-digest"), {recursive: true, force: true});
      expect(await active()).to.equal(source("P1"));
      expect(await (await fetch(base)).text()).to.include('adtcore:version="active"');
      // A verified backfill remains the active source after a later edit.
      writeFileSync(join(root, "src/zcl_provenance.clas.abap"), source("P2"));
      expect(await active()).to.equal(source("P1"));
      expect(await (await fetch(base)).text()).to.include('adtcore:version="inactive"');
      writeFileSync(join(root, "src/zcl_provenance.clas.abap"), source("P1"));
    });
    it("missing snapshots never adopt edited bytes or label them active", async () => {
      rmSync(join(root, "build/by-input", hash, "source"), {recursive: true, force: true});
      rmSync(join(root, "build/source-by-digest"), {recursive: true, force: true});
      writeFileSync(join(root, "src/zcl_provenance.clas.abap"), source("P2"));
      expect((await abap.Classes.ZCL_PROVENANCE.run()).get()).to.equal("P1");
      expect(await active(404)).to.include("ExceptionResourceNotFound");
      expect(await (await fetch(base)).text()).to.include('adtcore:version="inactive"');
      expect(existsSync(join(root, "build/by-input", hash, "source/src/zcl_provenance.clas.abap"))).to.equal(false);
    });
    it("cleaned build/ keeps P1 execution but reports absent active source", async () => {
      rmSync(join(root, "build"), {recursive: true});
      expect((await abap.Classes.ZCL_PROVENANCE.run()).get()).to.equal("P1");
      expect(await active(404)).to.include("ExceptionResourceNotFound");
      expect(await (await fetch(base)).text()).to.include('adtcore:version="inactive"');
    });
    it("an empty unbuilt working source is also inactive", async () => {
      writeFileSync(join(root, "src/zcl_provenance.clas.abap"), "");
      expect(await active(404)).to.include("ExceptionResourceNotFound");
      expect(await (await fetch(base)).text()).to.include('adtcore:version="inactive"');
    });
  });
});

for (const front of ["node", "abap"]) describe(`ADT active/inactive: ${front} source routes`, function () {
  this.timeout(180000);
  let root, store, server, base, headers, hot, warm, savedClasses;
  before(async () => {
    await import("./start.mjs");
    savedClasses = Object.fromEntries(["CX_ROOT", "IF_OO_ADT_CLASSRUN", "IF_OO_ADT_CLASSRUN_OUT"].map(name => [name, abap.Classes[name]]));
    root = realpathSync(mkdtempSync(join(tmpdir(), "adt-t05-")));
    mkdirSync(join(root, "src"));
    const files = {"zt05.prog.abap": prog("stub"), "zcl_t05.clas.abap": main,
      "zcl_t05.clas.locals_def.abap": def, "zcl_t05.clas.locals_imp.abap": imp("stub"),
      // The compiler emits this import for reports even in a minimal tree.
      "if_oo_adt_classrun.intf.abap": "INTERFACE if_oo_adt_classrun PUBLIC. METHODS main IMPORTING out TYPE REF TO if_oo_adt_classrun_out. ENDINTERFACE.\n",
      "if_oo_adt_classrun_out.intf.abap": "INTERFACE if_oo_adt_classrun_out PUBLIC. METHODS write IMPORTING data TYPE any RETURNING VALUE(output) TYPE REF TO if_oo_adt_classrun_out. ENDINTERFACE.\n",
      "cx_root.clas.abap": "CLASS cx_root DEFINITION PUBLIC. ENDCLASS. CLASS cx_root IMPLEMENTATION. ENDCLASS.\n"};
    for (const [file, source] of Object.entries(files)) writeFileSync(join(root, "src", file), source);
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), '{}');
    writeFileSync(join(root, "abaplint.jsonc"), JSON.stringify({global: {files: "/src/**/*.*"}, syntax: {version: "v702"}, rules: {check_syntax: true}}));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: "src", libs: [], output_folder: "output",
      options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"}, write_source_map: true}));
    await build({root, generators: false});
    store = new ObjectStore({root, libs: [], build: {generators: false}});
    const app = express(); app.use(express.raw({type: "*/*"}));
    app.use(adtRouter({store, watch: false, transpileOnActivate: true, abap: front === "abap" ? await adtAbap() : undefined}).router);
    server = await new Promise(resolve => {const s = app.listen(0, () => resolve(s));});
    base = `http://localhost:${server.address().port}/sap/bc/adt`;
    const hello = await fetch(base + "/core/discovery", {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
    headers = {"x-sap-adt-sessiontype": "stateful", "x-csrf-token": hello.headers.get("x-csrf-token"), cookie: hello.headers.getSetCookie().map(c => c.split(";")[0]).join("; ")};
  });
  after(async () => {
    if (store?.warmState) {store.warmState.next = undefined; store.warmState.on = false;}
    const verifying = warm?.verifying;
    if (verifying && verifying.exitCode === null) {warm.cancelVerify(undefined, "test complete"); await once(verifying, "exit");}
    await store?.warmState?.verifying;
    warm?.drop();
    Object.assign(abap.Classes, savedClasses); clearTimeout(store?.warmState?.timer); clearTimeout(store?.warmState?.reprime);
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(root, {recursive: true, force: true});
  });
  const classrun = async () => {
    const out = await new abap.Classes.ZCL_OSD_CLASSRUN_OUT().constructor_();
    const instance = await new abap.Classes.ZCL_T05().constructor_();
    await instance.if_oo_adt_classrun$main({out});
    return (await out.text()).get();
  };
  const activate = async (object, method = "activate") => {
    const res = await fetch(base + "/activation?method=" + method, {method: "POST", headers: {...headers, "content-type": "application/xml"},
      body: `<adtcore:objectReference xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="/sap/bc/adt${object}"/>`});
    expect(res.status).to.equal(200); return await res.text();
  };
  const save = async (object, sourcePath, source) => {
    const lock = await fetch(base + object + "?_action=LOCK&accessMode=MODIFY", {method: "POST", headers});
    const xml = await lock.text(); const handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(xml)?.[1];
    expect(handle, xml).to.be.a("string");
    try {
      const saved = await fetch(base + sourcePath + "?lockHandle=" + encodeURIComponent(handle), {method: "PUT", headers, body: source});
      expect(saved.status, await saved.text()).to.equal(200);
    } finally {await fetch(base + object + "?_action=UNLOCK&lockHandle=" + encodeURIComponent(handle), {method: "POST", headers});}
  };
  const versions = async (object, path, active, inactive, state) => {
    const tags = {};
    for (const version of ["", "active", "inactive"]) {
      const res = await fetch(base + path + (version ? "?version=" + version : ""), {headers});
      expect(res.status).to.equal(200);
      expect(await res.text()).to.equal(version === "active" ? active : inactive);
      tags[version] = res.headers.get("etag");
    }
    expect(tags.active).to.not.equal(tags.inactive); expect(tags['']).to.equal(tags.inactive);
    const conditional = await fetch(base + path + "?version=active", {headers: {...headers, "if-none-match": tags.inactive}});
    expect(conditional.status).to.equal(200);
    const cached = await fetch(base + path + "?version=active", {headers: {...headers, "if-none-match": tags.active}});
    expect(cached.status).to.equal(304);
    const doc = await fetch(base + object, {headers});
    expect(await doc.text()).to.include(`adtcore:version="${state}"`);
    const feed = await fetch(base + (path.includes("/includes/") ? path.replace(/\/source\/main$/, "") : path) + "/versions", {headers});
    const uri = /src="([^"]+\/00000\/content)"/.exec(await feed.text())?.[1];
    expect(uri).to.be.a("string");
    expect(await (await fetch(new URL(uri, base), {headers})).text()).to.equal(active);
  };
  it("program: stub → save P1 → activate → invalid P2 → failed/unknown activation → P3, cold builds", async () => {
    const object = "/programs/programs/zt05", path = object + "/source/main";
    await save(object, path, prog("P1"));
    await versions(object, path, prog("stub"), prog("P1"), "inactive");
    expect(await activate(object)).to.include('activationExecuted="true"');
    await versions(object, path, prog("P1"), prog("P1"), "active");
    const p2 = "REPORT zt05.\n\nTHIS is invalid.\n";
    await save(object, path, p2);
    await versions(object, path, prog("P1"), p2, "inactive");
    const before = liveHash(root);
    expect(await activate(object)).to.include('activationExecuted="false"');
    await versions(object, path, prog("P1"), p2, "inactive");
    expect(await activate(object, "unknown")).to.equal("");
    await versions(object, path, prog("P1"), p2, "inactive");
    expect(liveHash(root)).to.equal(before);
    // A cold rebuild with the inactive overlay still runs P1.
    await build({root, generators: false, overlay: store.overlay(), force: true});
    await versions(object, path, prog("P1"), p2, "inactive");
    const code = `import {ABAP} from '@abaplint/runtime'; globalThis.abap = new ABAP(); const p = await import(${JSON.stringify(pathToFileURL(join(root, "output", "zt05.prog.mjs")).href)}); if (typeof p.$main === "function") await p.$main(); process.stdout.write(abap.console.get());`;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", code], {cwd: root, encoding: "utf8"})).to.equal("P1");
    await save(object, path, prog("P3"));
    expect(await activate(object)).to.include('activationExecuted="true"');
    await versions(object, path, prog("P3"), prog("P3"), "active");
  });
  it("class include: the same sequence with a real warm swap; failed activation still executes P1", async () => {
    const object = "/oo/classes/zcl_t05", path = object + "/includes/implementations/source/main";
    await import(pathToFileURL(join(root, "output", "zcl_t05.clas.mjs")).href);
    hot = new HotLoader(root);
    warm = new WarmCompiler({root, overlay: activating => store.overlay(activating),
      keyOf: file => store.objectKeyOf(file), inactiveSources: activating => store.inactiveSources(activating)});
    await warm.prime();
    store.warmState = {on: true, compiler: warm};
    store.served = {running: true, generation: hot.generation, epoch: 1,
      hot: async msg => {const r = await hot.swap(msg); store.served.generation = hot.generation; return r;},
      recycle: async () => {throw new Error("this class edit must swap warm");}};
    await save(object, path, imp("P1"));
    await versions(object, path, imp("stub"), imp("P1"), "inactive");
    expect(await activate(object)).to.include('activationExecuted="true"');
    expect(hot.swaps).to.equal(1);
    await versions(object, path, imp("P1"), imp("P1"), "active");
    const p2 = imp("P2").replace("rv = 'P2'.", "THIS is invalid.");
    await save(object, path, p2);
    await versions(object, path, imp("P1"), p2, "inactive");
    const before = hot.generation;
    expect(await activate(object)).to.include('activationExecuted="false"');
    await versions(object, path, imp("P1"), p2, "inactive");
    expect(await activate(object, "unknown")).to.equal("");
    await versions(object, path, imp("P1"), p2, "inactive");
    expect(hot.generation).to.equal(before); expect(hot.swaps).to.equal(1);
    expect(await classrun()).to.equal("P1");
    await save(object, path, imp("P3"));
    expect(await activate(object)).to.include('activationExecuted="true"');
    expect(hot.swaps).to.equal(2);
    await versions(object, path, imp("P3"), imp("P3"), "active");
    expect(await classrun()).to.equal("P3");
    // A warm generation stores changed inputs only. GC must retain the
    // unchanged main's shared bytes even after dropping the cold snapshot.
    const current = join(root, "build", "by-input", hot.generation);
    expect(existsSync(join(current, "source/src/zcl_t05.clas.abap"))).to.equal(false);
    const unused = createHash("sha256").update(imp("stub")).digest("hex");
    expect(gc(root, {keep: 1})).to.not.be.empty;
    expect(store.read("CLAS", "ZCL_T05", "main", "active").source).to.equal(main);
    expect(store.read("CLAS", "ZCL_T05", "implementations", "active").source).to.equal(imp("P3"));
    expect(existsSync(join(root, "build/source-by-digest", unused))).to.equal(false);
  });
});

// All source-bearing types share the generation snapshot selector. Keep the
// compiled tree small: these additional resources need no executable module.
describe("ADT source selector: every source type", function () {
  this.timeout(30000);
  let root, store;
  const fixtures = {
    CLAS: ["zcl_all.clas.abap", "CLASS zcl_all DEFINITION PUBLIC. ENDCLASS. CLASS zcl_all IMPLEMENTATION. ENDCLASS.\n"],
    INTF: ["zif_all.intf.abap", "INTERFACE zif_all PUBLIC. ENDINTERFACE.\n"],
    PROG: ["zall.prog.abap", "REPORT zall. WRITE 'active'.\n"],
    INCL: ["zinc.prog.abap", "FORM run. WRITE 'active'. ENDFORM.\n"],
    DDLS: ["zddl.ddls.asddls", "define view entity ZAll as select from ztable { key id }\n"],
    SRVD: ["zsrv.srvd.srvdsrv", "define service ZAll { expose ZAll; }\n"],
  };
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "adt-all-sources-")); mkdirSync(join(root, "src"));
    for (const [file, source] of Object.values(fixtures)) writeFileSync(join(root, "src", file), source);
    writeFileSync(join(root, "src", "zinc.prog.xml"), '<abapGit><PROGDIR><SUBC>I</SUBC></PROGDIR></abapGit>');
    const {keepSourceInputs, completeSourceSnapshot} = await import("../tools/osd-source-snapshot.mjs");
    const {createHash} = await import("node:crypto");
    const digests = new Map(Object.values(fixtures).map(([file, source]) => [join(root, "src", file), createHash("sha256").update(source).digest("hex")]));
    const generation = join(root, "build", "by-input", "fixture");
    keepSourceInputs(root, generation, digests);
    completeSourceSnapshot(generation);
    symlinkSync(join("by-input", "fixture"), join(root, "build", "live"));
    store = new ObjectStore({root, libs: [], roots: [{path: "src", writable: true}]});
    store.served = {running: false, generation: "a-stopped-runtime"};
  });
  after(() => rmSync(root, {recursive: true, force: true}));
  for (const [type, [file, source]] of Object.entries(fixtures)) it(`${type}: saved/default and active bytes, validators, restart, and equal-source state`, () => {
    const name = file.split('.')[0].toUpperCase();
    expect(store.read(type, name, "main", "active").source).to.equal(source);
    // A checkout/editor may change a file before STORE sees a save. The
    // active source must still come from the generation, never that file.
    writeFileSync(join(root, "src", file), source + "\n");
    store.write(type, name, source + "\n\n");
    for (const reader of [store, new ObjectStore({root, libs: [], roots: [{path: "src", writable: true}]})]) {
      expect(reader.read(type, name).source).to.equal(source + "\n\n");
      expect(reader.read(type, name, "main", "inactive").source).to.equal(source + "\n\n");
      expect(reader.read(type, name, "main", "active").source).to.equal(source);
      expect(reader.stateOf(reader.find(type, name)).version).to.equal("inactive");
    }
    store.write(type, name, source);
    expect(store.stateOf(store.find(type, name)).version).to.equal("active");
    expect(store.read(type, name, "main", "active").etag).not.to.equal(store.read(type, name).etag);
  });
});
