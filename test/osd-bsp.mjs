// BSP applications served by this system's own ABAP.
import {expect} from "chai";
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {W3MI_NAME_WIDTH, applications, generate, mimeOf, registryClass, w3miFile, w3miName} from "../tools/osd-bsp-registry.mjs";
import {generatorFoldersOf} from "../tools/osd-packs.mjs";

describe("tools/osd-bsp-registry: a BSP application is an object, not a folder", () => {
  it("a user WAPA overrides a pack application of the same name", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-bsp-order-"));
    try {
      for (const dir of ["src", "packs/demo/src", "packs/demo/webapp", "user"]) mkdirSync(join(root, dir), {recursive: true});
      writeFileSync(join(root, "packs/demo/osd-pack.json"), JSON.stringify({name: "demo"}));
      writeFileSync(join(root, "packs/demo/webapp/index.html"), "pack page");
      writeFileSync(join(root, "user/zdemo.wapa.xml"), "<APPLNAME>ZDEMO</APPLNAME><TEXT>user</TEXT><PAGENAME>index.html</PAGENAME>");
      writeFileSync(join(root, "user/zdemo.wapa.index.html"), "user page");
      const folders = generatorFoldersOf(root, {OSD_LAYERS: "user"}).map((folder) => join(root, folder));
      const apps = generate(folders, join(root, "out"), root);
      expect(apps.find((app) => app.app === "ZDEMO").pages[0].content.toString()).to.equal("user page");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
  it("refuses two WAPA names in the same folder that declare one application", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-bsp-collision-"));
    try {
      mkdirSync(join(root, "src"), {recursive: true});
      for (const name of ["one", "two"]) {
        writeFileSync(join(root, "src", `${name}.wapa.xml`), "<APPLNAME>ZSHARED</APPLNAME>");
      }
      expect(() => generate([join(root, "src")], join(root, "out"), root))
        .to.throw(/BSP application ZSHARED is declared twice in one layer/);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
  it("reads the pages the descriptor names, from the files abapGit would write", () => {
    const apps = applications(["src"]);
    expect(apps.length, "the tree carries at least one BSP application").to.be.greaterThan(0);
    const app = apps.find((a) => a.app === "ZOSD_008_APP");
    expect(app, "the demo app is in the tree").to.not.equal(undefined);
    expect(app.pages.map((p) => p.page)).to.include.members(
      ["index.html", "manifest.json", "Component.js", "i18n/i18n.properties"]);
    // the descriptor is the object: a page it names with no file is an error
    // and not a smaller application
    expect(app.missing, `missing: ${app.missing.join(", ")}`).to.deep.equal([]);
  });

  it("a page is typed by its name, because the object carries no MIME", () => {
    expect(mimeOf("index.html")).to.contain("text/html");
    expect(mimeOf("i18n/i18n.properties")).to.contain("text/plain");
    expect(mimeOf("osg.svg")).to.equal("image/svg+xml");
    expect(mimeOf("x.png")).to.equal("image/png");
    // unknown is bytes, not a guess
    expect(mimeOf("x.zzz")).to.equal("application/octet-stream");
  });

  it("the generated class is a list, and the bytes are not in it", () => {
    const abap = registryClass(applications(["src"]));
    expect(abap).to.contain("CLASS zcl_stg_bsp_registry DEFINITION");
    expect(abap).to.contain("ls_page-app   = `ZOSD_008_APP`.");
    expect(abap).to.contain("ls_page-objid = `ZOSD_008_APP/INDEX.HTML`.");
    // **The defect this replaced**: 33 pages as chunked base64, 141 KB of
    // assets in a generated ABAP source, a transpile on every image. The
    // bytes live in Web Repository objects beside the class now, which is
    // the mechanism this tree already carries 33 media objects on.
    expect(abap, "no base64 payload").to.not.contain("ls_page-b64");
    expect(abap, "no raw page content either").to.not.contain("<!DOCTYPE html>");
    expect(abap.length, "a list, not a payload").to.be.lessThan(30000);
  });

  it("a page's Web Repository name fits the column it is stored in", () => {
    // WWWPARAMS-OBJID is CHAR 40 in the DDIC -- read, not remembered. The
    // first version of this said 60 and three of the 33 pages were longer
    // than the column, which is the same defect as a versioned file name
    // written narrower than its fixed width.
    for (const app of applications(["src"])) {
      for (const page of app.pages) {
        expect(w3miName(app.app, page.page).length, `${app.app}/${page.page}`)
          .to.be.at.most(W3MI_NAME_WIDTH);
      }
    }
  });

  it("a page too long for the column gets a digest, and long siblings no longer collide", () => {
    // the shape of an application downloaded from a system (names
    // synthetic): 22 pages share their first 40 characters, which the old
    // cut-to-the-column refused as one collision after another
    const root = mkdtempSync(join(tmpdir(), "osd-bsp-long-"));
    const pages = Array.from({length: 22}, (_, i) => `controller/activity/eventconfiguration${i}.controller.js`)
      .concat(["view/fragment/detectionsection/one.fragment.xml", "view/fragment/detectionsection/two.fragment.xml", "index.html"]);
    try {
      mkdirSync(join(root, "packs/demo/webapp"), {recursive: true});
      writeFileSync(join(root, "packs/demo/osd-pack.json"), JSON.stringify({name: "demo"}));
      for (const page of pages) {
        mkdirSync(join(root, "packs/demo/webapp", page, ".."), {recursive: true});
        writeFileSync(join(root, "packs/demo/webapp", page), page);
      }
      const apps = generate([], join(root, "out"), root);
      const demo = apps.find((app) => app.app === "ZDEMO");
      expect(demo.pages).to.have.length(pages.length);
      const names = demo.pages.map((p) => w3miName(demo.app, p.page));
      expect(new Set(names).size, "one object per page").to.equal(pages.length);
      for (const name of names) {
        expect(name.length).to.be.at.most(W3MI_NAME_WIDTH);
      }
      // a name that fits is the name it always was
      expect(w3miName("ZDEMO", "index.html")).to.equal("ZDEMO/INDEX.HTML");
      expect(w3miName("ZDEMO", pages[0])).to.match(/^ZDEMO\/H[0-9A-F]{33}$/);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the names do not depend on the order files were written or listed", () => {
    // a generator that follows readdir order has bitten this repository
    // before: the same input, written in two orders, must give one registry
    const pages = Array.from({length: 12}, (_, i) => `controller/activity/eventconfiguration${i}.controller.js`).concat(["a.js", "z/b.js"]);
    const build = (order) => {
      const root = mkdtempSync(join(tmpdir(), "osd-bsp-order-"));
      try {
        mkdirSync(join(root, "packs/demo/webapp"), {recursive: true});
        writeFileSync(join(root, "packs/demo/osd-pack.json"), JSON.stringify({name: "demo"}));
        for (const page of order) {
          mkdirSync(join(root, "packs/demo/webapp", page, ".."), {recursive: true});
          writeFileSync(join(root, "packs/demo/webapp", page), page);
        }
        generate([], join(root, "out"), root);
        return {registry: readFileSync(join(root, "out", "zcl_stg_bsp_registry.clas.abap"), "utf8"),
          objects: readdirSync(join(root, "out")).sort()};
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    };
    const forward = build(pages);
    expect(build([...pages].reverse())).to.deep.equal(forward);
    expect(build(pages), "and twice is the same").to.deep.equal(forward);
  });

  it("the file name carries no dot, because abaplint reads the type out of it", () => {
    // `ztravels_a4h_-manifest.json.w3mi.xml` parses as an object of type
    // `json.w3mi` and comes back "Unknown object type" -- 33 of these failed
    // the lint before the dot was escaped at all.
    expect(w3miFile("ZOSD_008_APP", "i18n/i18n.properties"))
      .to.equal("zosd_008_app_-i18n_-i18n_properties");
    expect(w3miFile("Z", "manifest.json")).to.not.contain(".json.");
  });

  it("and no percent either, because these names are fetched over HTTP", () => {
    // **The first escape was abapGit's, `%2e`, and it does not survive a
    // URL.** abapGit's files are read from disk; ours are fetched, because
    // the browser preview reads a page's bytes out of `media/` over the
    // network. `...%2e...` decodes back to a dot and finds nothing, and the
    // literal name needs `%252e` -- measured on the published deployment,
    // where `%252e` answered 200 and `%2e` answered 404 for the same file.
    for (const page of ["index.html", "i18n/i18n.properties", "annotations/annotations.xml"]) {
      const file = w3miFile("ZAPP", page);
      expect(file, page).to.match(/^[a-z0-9_-]+$/);
      expect(encodeURIComponent(file), "survives a URL unchanged").to.equal(file);
    }
  });

  it("writes one object per page and sweeps what it did not write", () => {
    const out = mkdtempSync(join(tmpdir(), "osd-bsp-"));
    // a stale object from an earlier run: it is in an input folder, so it
    // would be transpiled and would fill a wwwparams row for a page no
    // application has
    const stale = join(out, "zgone_-old%2ehtml.w3mi.xml");
    writeFileSync(stale, "<abapGit/>");
    const apps = generate(["src"], out);
    const written = readdirSync(out);
    expect(written).to.not.include("zgone_-old%2ehtml.w3mi.xml");
    const pages = apps.reduce((n, a) => n + a.pages.length, 0);
    expect(written.filter((f) => f.endsWith(".w3mi.xml")).length,
      "one object per page").to.equal(pages);
    // and the object carries no filesize of its own: the transpiler writes
    // one from the data file's real length, and two rows of the same key
    // kill the seed with `UNIQUE constraint failed: wwwparams`
    const one = readFileSync(join(out, written.find((f) => f.endsWith(".w3mi.xml"))), "utf8");
    expect(one).to.contain("<NAME>");
    expect(one, "the size comes from the bytes, not from us").to.not.contain("filesize");
  });
});
