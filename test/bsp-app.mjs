// The BSP application format, checked against a real one.
//
// `.local/corpus/ui5-code-search` carries ZUI5_CODE_SEA as abapGit's
// LCL_OBJECT_WAPA serialized it. Nineteen of its pages are named after their
// file and ten are `UI5<sha1>` hashes the UI5 uploader made; the nineteen are
// the format and the ten are that tool's doing, so the nineteen are what this
// checks.
import {expect} from "chai";
import {existsSync, readFileSync, readdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MAX_APP_NAME, PAGE_LINE, buildApp, checkAppName, longLine, icfNodeFile, icfNodeXml, icfUrlOf, manifestFor, manifestRebased, pageFile, pageKey, wapaXml} from "../tools/osd-bsp-app.mjs";

const CORPUS = ".local/corpus/ui5-code-search/src";
const APP = "ZUI5_CODE_SEA";

describe("tools/osd-bsp-app: a folder of web files as a BSP application", () => {
  it("names a page's file the way abapGit named a real one", function () {
    if (existsSync(CORPUS) === false) {
      this.skip();
    }
    const xml = readFileSync(join(CORPUS, `${APP.toLowerCase()}.wapa.xml`), "utf8");
    const pages = [...xml.matchAll(/<PAGENAME>([^<]*)<\/PAGENAME>/g)].map((m) => m[1]);
    const onDisk = new Set(readdirSync(CORPUS).filter((f) => f.startsWith(`${APP.toLowerCase()}.wapa.`) && f.endsWith(".xml") === false));
    // the uploader's hashed names are not the format
    const named = pages.filter((p) => /^UI5[0-9A-F]{40}$/.test(p) === false && p !== "UI5RepositoryPathMapping.xml");
    expect(named.length, "pages named after their file").to.be.greaterThan(15);
    const checked = named.filter((p) => onDisk.has(pageFile(APP, p)));
    // every page we can pair must pair by the rule, and most must pair
    expect(checked.length, `paired ${checked.length} of ${named.length}`).to.be.greaterThan(15);
    for (const p of checked) {
      expect(onDisk.has(pageFile(APP, p)), `${p} -> ${pageFile(APP, p)}`).to.equal(true);
    }
  });

  it("the key is the page name in upper case, as the corpus writes it", function () {
    if (existsSync(CORPUS) === false) {
      this.skip();
    }
    const xml = readFileSync(join(CORPUS, `${APP.toLowerCase()}.wapa.xml`), "utf8");
    const items = [...xml.matchAll(/<PAGEKEY>([^<]*)<\/PAGEKEY>[\s\S]*?<PAGENAME>([^<]*)<\/PAGENAME>/g)];
    expect(items.length).to.be.greaterThan(25);
    for (const [, key, name] of items) {
      expect(pageKey(name), name).to.equal(key);
    }
  });

  it("writes one page per file and a descriptor that names them all", () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-bsp-"));
    try {
      const pages = buildApp({from: "packs/travels-a4h/webapp", app: "ZOSD_TEST_APP", out: dir, text: "t", service: "ZX_SRV"});
      expect(pages).to.include.members(["index.html", "manifest.json", "i18n/i18n.properties"]);
      const files = readdirSync(dir);
      for (const p of pages) {
        expect(files, p).to.include(pageFile("ZOSD_TEST_APP", p));
      }
      expect(files).to.include("zosd_test_app.wapa.xml");
      // the one line that changes, and it changes in the written file only
      const manifest = JSON.parse(readFileSync(join(dir, pageFile("ZOSD_TEST_APP", "manifest.json")), "utf8"));
      expect(manifest["sap.app"].dataSources.mainService.uri).to.equal("../../../../opu/odata/sap/ZX_SRV/");
      expect(JSON.parse(readFileSync("packs/travels-a4h/webapp/manifest.json", "utf8"))["sap.app"].dataSources.mainService.uri,
        "the tree is not edited").to.not.equal("../../../../opu/odata/sap/ZX_SRV/");
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("refuses a text page with a line a system would cut (255 per line), not a binary one", () => {
    expect(PAGE_LINE).to.equal(255);
    expect(() => longLine("x.js", Buffer.from(`a\n${"b".repeat(255)}\n`))).to.not.throw();
    expect(() => longLine("List.controller.js", Buffer.from(`a\r\n${"b".repeat(256)}\n`))).to.throw(/List\.controller\.js:2: a line of 256 characters/);
    expect(() => longLine("logo.png", Buffer.from("c".repeat(1000)))).to.not.throw();
    // the generated cockpit of the demo set stays under it, page by page
    for (const f of readdirSync("src/l2demo/cockpit/zosd_fleet2").filter((f) => !/\.trace(?:\.meta)?\.json$/.test(f))) {
      if (f !== "i18n") longLine(f, readFileSync(join("src/l2demo/cockpit/zosd_fleet2", f)));
    }
  });

  it("re-bases a data source onto the OData root of its version (V2 odata, V4 odata4)", () => {
    const manifest = (uri, odataVersion) => JSON.stringify({"sap.app": {dataSources: {main: {uri, type: "OData", settings: {odataVersion}}}}});
    const uri = (text) => JSON.parse(text)["sap.app"].dataSources.main.uri;
    expect(uri(manifestFor(manifest("../../sap/opu/odata/sap/X_SRV/", "2.0"), "X_SRV"))).to.equal("../../../../opu/odata/sap/X_SRV/");
    expect(uri(manifestFor(manifest("../../sap/opu/odata4/sap/X_SRV/", "4.0"), "X_SRV"))).to.equal("../../../../opu/odata4/sap/X_SRV/");
    expect(uri(manifestRebased(manifest("../../sap/opu/odata4/sap/X_SRV/", "4.0")))).to.equal("../../../../opu/odata4/sap/X_SRV/");
    expect(uri(manifestRebased(manifest("/sap/opu/odata/sap/X_SRV/", "2.0")))).to.equal("../../../../opu/odata/sap/X_SRV/");
  });

  it("refuses a name longer than 15, which is the limit the system checks", () => {
    // Measured in A4H's own source, not inferred from a failure:
    // cl_o2_helper=>check_application_name_valid does `IF strlen( l_applname )
    // GT 15` and raises `invalid`, and cl_o2_api_application=>create_new
    // calls it with refuse_long_name defaulting to 'X'. abapGit reports the
    // refusal as "WAPA - error from create_new: 4", which names neither the
    // field nor the limit -- so the tool has to.
    expect(MAX_APP_NAME).to.equal(15);
    expect(() => checkAppName("ZOSD_008_DEMO_APP")).to.throw(/at most 15 characters and this is 17/);
    expect(checkAppName("ZOSD_008_APP")).to.equal("ZOSD_008_APP");
    expect(checkAppName("ZABCDEFGHIJKLMN")).to.equal("ZABCDEFGHIJKLMN");
    // the namespace does not count toward the fifteen: split_applname takes
    // it off before strlen
    expect(checkAppName("/OSD/ZABCDEFGHIJKLMN")).to.equal("/OSD/ZABCDEFGHIJKLMN");
    expect(() => checkAppName("zosd_lower")).to.throw(/upper case/);
    expect(() => buildApp({from: "packs/travels-a4h/webapp", app: "ZOSD_008_DEMO_APP", out: "/tmp/never"}))
      .to.throw(/at most 15/);
  });

  it("writes the ICF node byte for byte as a real deployment's", function () {
    // The corpus carries a node a real deployment made: MindsetAppAnalyzerFree
    // has /sap/bc/ui5_ui5/mindset/analyzer_detail/ whose ICF_DOCU reads
    // "Deployed with SAP Fiori tools" -- the tools created it, abapGit
    // serialized it back. So it is both the shape and the proof that such a
    // node round-trips through abapGit, which is the whole reason this is
    // generated here rather than left to a person and SICF.
    const real = ".local/corpus/MindsetAppAnalyzerFree/src/#mindset#analyzer_ui5/analyzer_detail485dff7044481cbebcb6848d9.sicf.xml";
    expect(icfNodeFile("ANALYZER_DETAIL", "mindset")).to.equal("analyzer_detail485dff7044481cbebcb6848d9.sicf.xml");
    expect(icfUrlOf("ANALYZER_DETAIL", "mindset")).to.equal("/sap/bc/ui5_ui5/mindset/analyzer_detail/");
    if (existsSync(real) === false) {
      this.skip();
    }
    const theirs = readFileSync(real, "utf8");
    const ours = icfNodeXml("ANALYZER_DETAIL", "Deployed with SAP Fiori tools", "mindset");
    // the same fields, in the same order, and **no handler**: ICF inherits
    // one down the tree and the branch carries /UI5/CL_UI5_HTTP_HANDLER
    const fields = (x) => [...x.matchAll(/<(URL|ICF_NAME|ORIG_NAME|ICF_LANGU|ICF_DOCU|ICFHANDLER)>([^<]*)</g)].map((m) => `${m[1]}=${m[2]}`);
    expect(fields(ours)).to.deep.equal(fields(theirs));
    expect(ours).to.not.contain("ICFHANDLER");
  });

  it("a page whose name has no file, or the other way round, cannot happen", () => {
    const xml = wapaXml("ZX", ["a/b.js", "c.html"], "t");
    expect(xml.startsWith("﻿<?xml")).to.equal(true);
    expect(xml).to.contain("<PAGEKEY>A/B.JS</PAGEKEY>");
    expect(xml).to.contain("<PAGENAME>a/b.js</PAGENAME>");
    expect(pageFile("ZX", "a/b.js")).to.equal("zx.wapa.a_-b.js");
  });
});
