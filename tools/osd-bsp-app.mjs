// A folder of web files as a BSP application, in abapGit's shape.
//
//   node tools/osd-bsp-app.mjs <folder> --name ZOSD_008_DEMO_APP --out <dir>
//        [--text "…"] [--service ZOSD_006_DEMO_SRV] [--only a,b,c]
//
// Why. The last thing in the README's loop that had never travelled is the
// **page**: the service reaches a system, and the Fiori app that talks to it
// still only runs here. A UI5 app on a system is a BSP application (WAPA) --
// one object with one page per file -- and abapGit can carry one.
//
// The shape is measured, not guessed: `.local/corpus/ui5-code-search`
// carries a real `ZUI5_CODE_SEA` serialized by abapGit's LCL_OBJECT_WAPA,
// and this writes the same thing:
//
//   <app>.wapa.xml                      ATTRIBUTES + one PAGES/item per file
//   <app>.wapa.<page>                   the file, `/` written `_-`, lower case
//
// What is deliberately NOT imitated: `/UI5/UI5_REPOSITORY_LOAD` replaces
// some page names with a `UI5<sha1>` hash and adds a
// `UI5RepositoryPathMapping.xml` page to map them back. Ten of the corpus
// app's pages are hashed that way. That is the uploader's doing, not
// abapGit's and not the format's -- a plain page name is what the other
// nineteen have -- so the pages here are named after the files.
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {runsAs} from "./osd-main.mjs";

const BOM = "﻿";

/** abapGit writes a page's path with `/` as `_-`, lower case, after the
 *  `<app>.wapa.` prefix. `controller/App.controller..js` is filed as
 *  `zui5_code_sea.wapa.controller_-app.controller..js`. */
export const pageFile = (app, page) => `${app.toLowerCase()}.wapa.${page.replace(/^\./, "").replaceAll("/", "_-").toLowerCase()}`;

/** and the key is the page name in upper case, which is what the PAGEKEY
 *  column of O2PAGDIR holds */
export const pageKey = (page) => page.toUpperCase();

const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function wapaXml(app, pages, text) {
  const items = [...pages].sort((a, b) => (pageKey(a) < pageKey(b) ? -1 : 1)).map((page) => `    <item>
     <ATTRIBUTES>
      <APPLNAME>${app}</APPLNAME>
      <PAGEKEY>${escape(pageKey(page))}</PAGEKEY>
      <PAGENAME>${escape(page)}</PAGENAME>
      <PAGETYPE>X</PAGETYPE>
      <LAYOUTLANGU>E</LAYOUTLANGU>
      <VERSION>A</VERSION>
      <LANGU>E</LANGU>
     </ATTRIBUTES>
    </item>
`).join("");
  return `${BOM}<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_WAPA" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <ATTRIBUTES>
    <APPLNAME>${app}</APPLNAME>
    <APPLCLAS>/UI5/CL_UI5_BSP_APPLICATION</APPLCLAS>
    <APPLEXT>${app}</APPLEXT>
    <SECURITY>X</SECURITY>
    <ORIGLANG>E</ORIGLANG>
    <MODIFLANG>T</MODIFLANG>
    <TEXT>${escape(text)}</TEXT>
   </ATTRIBUTES>
   <PAGES>
${items}   </PAGES>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

/** The one line that has to change, because the same file is served from two
 *  places. A manifest under `/app/<name>/` reaches its service with
 *  `../../sap/opu/odata/...`; served from `/sap/bc/ui5_ui5/<ns>/<app>/` that
 *  same string lands in `/sap/bc/ui5_ui5/sap/opu/odata/` and the application
 *  reads nothing.
 *
 *  **"It cannot reach the service with `../`" is what this comment used to
 *  say, and it was the assumption the defect grew out of.** It can: the
 *  branch is four segments deep, so `../../../../opu/odata/sap/<srv>/` gets
 *  there. The first fix made the URL absolute instead, which is right on a
 *  system and wrong wherever this system is not at the origin root -- on
 *  GitHub Pages the tile opened onto an empty application. Recounted
 *  independently by fable-osd before it went out. */
// How far up from `/sap/bc/ui5_ui5/<ns>/<app>/` the OData branch sits: four
// segments, back to `/sap/`. Counted once, here, rather than written as a
// run of `../` somebody has to trust.
const UP_TO_SAP = "../".repeat(4);
// A V4 data source (settings.odataVersion "4.0") is served at /sap/opu/odata4/
// (docs/odata-v4.md), the same service under a second root.
const bspServiceUri = (service, v4 = false) => `${UP_TO_SAP}opu/${v4 ? "odata4" : "odata"}/sap/${service}/`;
const isV4 = (ds) => String(ds?.settings?.odataVersion ?? "") === "4.0";

/** A pack names its services in its own manifest, one URI per OData source. */
export function manifestRebased(text) {
  const m = JSON.parse(text);
  for (const ds of Object.values(m["sap.app"]?.dataSources ?? {})) {
    if (ds?.type !== "OData" || typeof ds.uri !== "string") continue;
    const service = /(?:^|\/)opu\/odata4?\/sap\/([^/?#]+)(?=\/|[?#]|$)/i.exec(ds.uri)?.[1];
    if (service === undefined || service === "." || service === "..") continue;
    ds.uri = bspServiceUri(service, isV4(ds));
  }
  return JSON.stringify(m, undefined, 2) + "\n";
}

export function manifestFor(text, service) {
  const m = JSON.parse(text);
  for (const ds of Object.values(m["sap.app"]?.dataSources ?? {})) {
    if (ds.type === "OData") {
      // **Relative to the application, not absolute from the origin.**
      //
      // The folder's own manifest says `../../sap/opu/odata/...`, which is
      // right for `/app/<name>/` and wrong once the same file is served
      // from `/sap/bc/ui5_ui5/<ns>/<app>/`. The first fix for that made it
      // absolute, `/sap/opu/odata/sap/<srv>/`, which is right on a system
      // and wrong on GitHub Pages: the deployment lives under
      // /open-steamgate/main/, the service worker's scope is that
      // directory, and a request to the origin root never reaches it. The
      // tile then opened onto an empty application with
      // `[ODataMetadata] initial loading of metadata failed`.
      //
      // `../../../../opu/odata/sap/<srv>/` from the application's own
      // location is `/sap/opu/odata/sap/<srv>/` on a system and
      // `/open-steamgate/main/sap/opu/odata/sap/<srv>/` on Pages -- the one
      // spelling that is right in both, and the same correction the
      // launchpad's component URLs needed an hour earlier.
      ds.uri = bspServiceUri(service, isV4(ds));
    }
  }
  return JSON.stringify(m, undefined, 2) + "\n";
}

// The door. A BSP application is objects; what makes it answer on a URL is
// an **ICF node**, and abapGit's WAPA handler does not create one -- it has
// nothing to do with the UI5 repository at all (`ui5_rep_dt`, `ui5_ui5`,
// `cl_ui5` appear zero times in its source). `/UI5/UI5_REPOSITORY_LOAD` does
// create it, because `/ui5/cl_ui5_rep_dt=>create_repository` does, under the
// fixed parent `C_UI5_ICF_NODE_GUID = '3I2I44WJCWUB7IJYCK1741MH3'`.
//
// So the node travels as an ordinary SICF object beside the WAPA, and one zip
// carries both. The shape is copied from a real one in the corpus --
// `/sap/bc/ui5_ui5/mindset/analyzer_detail/` in MindsetAppAnalyzerFree, whose
// ICF_DOCU says "Deployed with SAP Fiori tools", i.e. a node the Fiori tools
// made and abapGit serialized back:
//
//   <URL>, <ICFSERVICE> with ICF_NAME and ORIG_NAME, <ICFDOCU>. **No
//   handler.** ICF inherits a handler down the tree, and the branch carries
//   /UI5/CL_UI5_HTTP_HANDLER, so the application's own node is only a name.
//
// abapGit creates it active: zcl_abapgit_object_sicf=>insert_sicf finds the
// parent with `cl_icf_tree=>service_from_url( iv_url )` -- from the <URL> in
// this file, not from its name -- and calls insert_node with
// `icfactive = abap_true`.
export const icfUrlOf = (app, namespace = "sap") => `/sap/bc/ui5_ui5/${namespace}/${app.toLowerCase()}/`;

/** `<node name padded to 15><first 25 hex of sha1(URL)>.sicf.xml`. Measured
 *  on 35 real SICF files in the corpus: 33 match exactly and the two that do
 *  not differ only in the case of the node inside its URL. On import the
 *  suffix does not matter -- abapGit takes the parent from <URL> -- so it is
 *  here to make the file the same one a system would write back. */
export function icfNodeFile(app, namespace = "sap") {
  const url = icfUrlOf(app, namespace);
  return app.toLowerCase().padEnd(15, " ") + createHash("sha1").update(url).digest("hex").slice(0, 25) + ".sicf.xml";
}

export function icfNodeXml(app, text, namespace = "sap") {
  return `${BOM}<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_SICF" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <URL>${icfUrlOf(app, namespace)}</URL>
   <ICFSERVICE>
    <ICF_NAME>${app.toUpperCase()}</ICF_NAME>
    <ORIG_NAME>${app.toLowerCase()}</ORIG_NAME>
   </ICFSERVICE>
   <ICFDOCU>
    <ICF_NAME>${app.toUpperCase()}</ICF_NAME>
    <ICF_LANGU>E</ICF_LANGU>
    <ICF_DOCU>${escape(text)}</ICF_DOCU>
   </ICFDOCU>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

function filesUnder(root, at = root) {
  const out = [];
  for (const name of readdirSync(at)) {
    const full = join(at, name);
    if (statSync(full).isDirectory()) {
      out.push(...filesUnder(root, full));
    } else {
      out.push(relative(root, full).replaceAll("\\", "/"));
    }
  }
  return out;
}

// A BSP application name is **at most 15 characters** after its namespace,
// and the check is not advisory: `cl_o2_helper=>check_application_name_valid`
// does `IF strlen( l_applname ) GT 15` and raises `invalid`, and
// `cl_o2_api_application=>create_new` calls it with `refuse_long_name`
// defaulting to `'X'`. abapGit turns the refusal into its own
// `undefined_name`, and what a person sees is
//
//   WAPA - error from create_new: 4
//
// which names neither the field nor the limit. Read off A4H's own source
// 2026-09-19, after ZOSD_008_DEMO_APP (17) was refused. The same method also
// requires APPLEXT to equal APPLNAME, so nothing here lets them differ.
export const MAX_APP_NAME = 15;

export function checkAppName(app) {
  const bare = app.replace(/^\/[^/]+\//, "");
  if (bare.length > MAX_APP_NAME) {
    throw new Error(`${app}: a BSP application name is at most ${MAX_APP_NAME} characters and this is ${bare.length}. `
      + "cl_o2_helper=>check_application_name_valid refuses a longer one, and abapGit reports it as "
      + '"WAPA - error from create_new: 4", which says neither.');
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(bare) === false) {
    throw new Error(`${app}: a BSP application name is upper case letters, digits and underscore (RS_CHARACTER_CHECK)`);
  }
  return app;
}

/** A system stores a text page of a BSP application in lines of 255
 *  characters and cuts what is longer, silently: measured on a sandbox, where a
 *  controller with one 1790-character line arrived 1511 bytes short and the
 *  application did not start. Refused here, by file and line. */
export const PAGE_LINE = 255;
const TEXT_PAGE = /\.(js|mjs|ts|json|xml|svg|html?|properties|css|csv|txt|md|ya?ml)$/i;
export function longLine(page, body) {
  if (!TEXT_PAGE.test(page)) return;
  const lines = body.toString("utf8").split(/\r?\n/);
  const at = lines.findIndex((l) => l.length > PAGE_LINE);
  if (at >= 0) throw new Error(`${page}:${at + 1}: a line of ${lines[at].length} characters; a system keeps ${PAGE_LINE} per line of a BSP page and cuts the rest`);
}

export function buildApp({from, app, out, text = app, service, only, icf, namespace = "sap"}) {
  checkAppName(app);
  mkdirSync(out, {recursive: true});
  const keep = only === undefined ? undefined : new Set(only);
  const pages = filesUnder(from).filter((p) => keep === undefined || keep.has(p)).sort();
  if (pages.length === 0) {
    throw new Error(`${from}: no files to carry`);
  }
  for (const page of pages) {
    const body = page.endsWith("manifest.json")
      ? Buffer.from(service === undefined
        ? manifestRebased(readFileSync(join(from, page), "utf8"))
        : manifestFor(readFileSync(join(from, page), "utf8"), service))
      : readFileSync(join(from, page));
    longLine(page, body);
    writeFileSync(join(out, pageFile(app, page)), body);
  }
  writeFileSync(join(out, `${app.toLowerCase()}.wapa.xml`), wapaXml(app, pages, text));
  if (icf !== false) {
    writeFileSync(join(out, icfNodeFile(app, namespace)), icfNodeXml(app, text, namespace));
  }
  return pages;
}

if (runsAs("osd-bsp-app.mjs")) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
  const from = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const app = flag("name");
  const out = flag("out");
  if (from === undefined || app === undefined || out === undefined || existsSync(from) === false) {
    console.error("usage: osd-bsp-app.mjs <folder> --name ZOSD_008_DEMO_APP --out <dir> [--text …] [--service …] [--only a,b]");
    process.exit(2);
  }
  const only = flag("only") === undefined ? undefined : flag("only").split(",");
  const pages = buildApp({from, app, out, text: flag("text", app), service: flag("service"), only, icf: argv.includes("--no-icf") === false});
  console.log(`${app}: ${pages.length} pages -> ${out}`);
  if (argv.includes("--no-icf") === false) {
    console.log(`  + ICF node ${icfUrlOf(app)} (${icfNodeFile(app)})`);
  }
  for (const p of pages) console.log(`  ${p}`);
}
