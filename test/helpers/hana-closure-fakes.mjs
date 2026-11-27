// The fake-dumper loop of milestone 4's closure tests (test/hana-closure-m4.mjs):
// a scratch tree, a fake dumper that answers from a staged TENANT folder, a
// fake converter that lays what the dumper staged, and a fake host whose
// hana-src-gen is the REAL tool -- the bounded layer names and the intake
// refusals are hana-src-gen's, so the loop must run it (test/hana-closure.mjs
// emulates it instead, which is right for its scenarios and blind to these).
// No HANA, no network: synthetic names ZOSD_H5X_* / ZCL_OSD_H5X_* and the
// synthetic namespace /ZOSDH5X/.
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));

const IF_MESSAGE = `INTERFACE if_message PUBLIC.
  METHODS get_text RETURNING VALUE(result) TYPE string.
  METHODS get_longtext RETURNING VALUE(result) TYPE string.
ENDINTERFACE.
`;
const CX_ROOT = `CLASS cx_root DEFINITION ABSTRACT PUBLIC.
  PUBLIC SECTION.
    DATA previous TYPE REF TO cx_root READ-ONLY.
    DATA textid TYPE c LENGTH 32 READ-ONLY.
    METHODS constructor IMPORTING textid LIKE textid OPTIONAL previous TYPE REF TO cx_root OPTIONAL.
    INTERFACES if_message.
    ALIASES get_text FOR if_message~get_text.
ENDCLASS.
CLASS cx_root IMPLEMENTATION.
  METHOD constructor.
    me->previous = previous.
    me->textid = textid.
  ENDMETHOD.
  METHOD if_message~get_text.
    result = ''.
  ENDMETHOD.
  METHOD if_message~get_longtext.
    result = ''.
  ENDMETHOD.
ENDCLASS.
`;
const CX_NO_CHECK = `CLASS cx_no_check DEFINITION PUBLIC INHERITING FROM cx_root.
  PUBLIC SECTION.
    METHODS constructor IMPORTING textid LIKE textid OPTIONAL previous TYPE REF TO cx_root OPTIONAL.
ENDCLASS.
CLASS cx_no_check IMPLEMENTATION.
  METHOD constructor.
    super->constructor( textid = textid previous = previous ).
  ENDMETHOD.
ENDCLASS.
`;

const ABAPGIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
 <asx:values>
  <DATA><MASTER_LANGUAGE>E</MASTER_LANGUAGE><STARTING_FOLDER>/src/</STARTING_FOLDER><FOLDER_LOGIC>PREFIX</FOLDER_LOGIC></DATA>
 </asx:values>
</asx:abap>
`;

/** a scratch tree: inputs gen/hana-ddic, gen/hana-src/*, src; `lib` --
 *  {file: content} of a library folder (fwlib/src) the build loads;
 *  `src` -- extra {file: content} in src/; `seed` -- {file: content} the
 *  seed dump carries; `seedTables` -- {TABLE: rows} of the seed dump;
 *  `seedManifest` -- extra keys of its manifest; `tenant` -- {file:
 *  content} the fake dumper can bring. Returns {root, env, seedDump}. */
export function scratchClosure({lib, src = {}, seed = {}, seedTables = {}, seedManifest = {}, tenant = {}, env = {}} = {}) {
  const root = mkdtempSync(join(tmpdir(), "hana-closure-m4-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({name: "hana-closure-m4-scratch", private: true}) + "\n");
  writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
    input_folder: ["gen/hana-ddic", "gen/hana-src/*", "src"],
    output_folder: "output",
    libs: lib === undefined ? [] : [{folder: "/fwlib"}],
    write_source_map: false,
    options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
  }, null, 2) + "\n");
  const put = (dir, files) => {
    mkdirSync(dir, {recursive: true});
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  };
  put(join(root, "src"), {"if_message.intf.abap": IF_MESSAGE, "cx_root.clas.abap": CX_ROOT, "cx_no_check.clas.abap": CX_NO_CHECK, ...src});
  mkdirSync(join(root, "src", "hana"), {recursive: true});
  copyFileSync(join(REPO, "src", "hana", "zcx_osd_not_activated.clas.abap"), join(root, "src", "hana", "zcx_osd_not_activated.clas.abap"));
  if (lib !== undefined) put(join(root, "fwlib", "src"), lib);
  put(join(root, "tenant"), tenant);
  // the seed dump: the dumper's layout, plus the converter output the fake
  // converter lays (conv/), one layer
  const seedDump = join(root, "dump-001");
  put(join(seedDump, "tables"), Object.fromEntries(Object.entries(seedTables)
    .map(([t, rows]) => [`${t.replaceAll("/", "#")}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"])));
  writeFileSync(join(seedDump, "manifest.json"), JSON.stringify({...seedManifest}) + "\n");
  stageLayers(join(seedDump, "conv"), [{name: "h5x-seed", files: seed}]);
  writeFileSync(join(root, "fake-host.mjs"), FAKE_HOST);
  writeFileSync(join(root, "fake-converter.mjs"), FAKE_CONVERTER);
  writeFileSync(join(root, "fake-dumper.mjs"), FAKE_DUMPER);
  chmodSync(join(root, "fake-dumper.mjs"), 0o755);
  writeFileSync(join(root, "dump.env"), "HANA_HOST=h5x.example\nHANA_PORT=30215\nHANA_USER=h5x_user\nHANA_SCHEMA=h5x_schema\nHANA_PASSWORD=h5x_secret\n");
  return {root, seedDump, env: {
    ...process.env,
    OSD_SELF: JSON.stringify([process.execPath, join(root, "fake-host.mjs")]),
    OSD_HANA_CONVERTER: join(root, "fake-converter.mjs"),
    OSD_HANA_DUMPER: join(root, "fake-dumper.mjs"),
    OSD_HANA_DUMP_ENV: join(root, "dump.env"),
    H5X_REPO: REPO,
    H5X_TENANT: join(root, "tenant"),
    H5X_RECORD: join(root, "dumper-log.jsonl"),
    ...env,
  }};
}

/** a converter output: plan.json + layers/<name>/{.abapgit.xml, src/};
 *  `cycle` -- the layer names that form one package cycle. */
export function stageLayers(dir, layers, cycle = []) {
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, "plan.json"), JSON.stringify({
    schema: 1, system: "h5x", dump: {manifest_sha256: "h5x_sha"},
    layers: layers.map((l, i) => ({name: l.name, package: `$${l.name.toUpperCase()}`, folder: `layers/${l.name}`, order: i,
      objects: {CLAS: Object.keys(l.files).length}})),
    cycles: cycle.length > 0 ? [cycle] : [], no_source: {},
  }, null, 2) + "\n");
  for (const l of layers) {
    mkdirSync(join(dir, "layers", l.name, "src"), {recursive: true});
    writeFileSync(join(dir, "layers", l.name, ".abapgit.xml"), ABAPGIT_XML);
    for (const [name, content] of Object.entries(l.files)) writeFileSync(join(dir, "layers", l.name, "src", name), content);
  }
}

/** the dumper's recorded requests, one per round */
export const dumperRequests = (root) => {
  try {
    return readFileSync(join(root, "dumper-log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).request);
  } catch {
    return [];
  }
};
export const outFile = (root, name) => join(root, "gen", "hana-closure", name);
export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// the fake dumper: the real CLI's required flags, the schema-1 request, and
// an answer from the tenant folder -- a requested CLAS/INTF whose abapGit
// file the tenant has resolves (its files staged for the converter), every
// other requested name is missing. H5X_INJECT names tenant files staged into
// every dump whatever was asked (a dump that brings more than it was asked);
// H5X_CYCLE=<n> lays the answer as n layers of one package cycle, long names.
const FAKE_DUMPER = `#!/usr/bin/env node
import {appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
const {stageLayers} = await import(join(process.env.H5X_REPO, "test", "helpers", "hana-closure-fakes.mjs"));
const args = process.argv.slice(2);
const at = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] !== "hana" || args[1] !== "dump") process.exit(3);
for (const flag of ["--host", "--user", "--schema", "--provenance", "--out"]) if (!at(flag)) process.exit(3);
const out = resolve(at("--out"));
if (existsSync(out) && readdirSync(out).length > 0) process.exit(3);
const request = JSON.parse(readFileSync(at("--ddic-closure"), "utf8"));
if (request.schema !== 1) process.exit(3);
appendFileSync(process.env.H5X_RECORD, JSON.stringify({request}) + "\\n");
const tenant = process.env.H5X_TENANT;
const have = new Set(readdirSync(tenant));
const base = (name) => name.replace(/^\\/([^/]+)\\//, "#$1#").toLowerCase();
const resolved = {};
const missing = {};
const files = {};
for (const [kind, list] of Object.entries(request.requested)) {
  for (const name of list) {
    const suffix = kind === "CLAS" ? ".clas.abap" : kind === "INTF" ? ".intf.abap" : undefined;
    const hit = suffix !== undefined && (have.has(base(name) + ".clas.abap") || have.has(base(name) + ".intf.abap"));
    if (hit) {
      (resolved[kind] ??= []).push(name);
      for (const f of have) if (f.startsWith(base(name) + ".")) files[f] = readFileSync(join(tenant, f), "utf8");
    } else (missing[kind] ??= []).push(name);
  }
}
for (const f of (process.env.H5X_INJECT ?? "").split(",").filter(Boolean)) files[f] = readFileSync(join(tenant, f), "utf8");
mkdirSync(join(out, "tables"), {recursive: true});
writeFileSync(join(out, "manifest.json"), JSON.stringify({closure: {rounds: 1, resolved, missing}}) + "\\n");
const n = Number(process.env.H5X_CYCLE ?? "0");
if (n > 0) {
  const names = Array.from({length: n}, (_, i) => "osg-zosd-h5x-basis-package-with-a-long-name-" + String(i).padStart(2, "0"));
  const layers = names.map((name, i) => ({name, files: i === 0 ? files : {}}));
  stageLayers(join(out, "conv"), layers, names);
} else {
  stageLayers(join(out, "conv"), [{name: "h5x-answer", files}]);
}
process.exit(0);
`;

// the fake converter: lays what the dump staged under conv/
const FAKE_CONVERTER = `#!/usr/bin/env node
import {cpSync, rmSync} from "node:fs";
import {join} from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
rmSync(out, {recursive: true, force: true});
cpSync(join(args[0], "conv"), out, {recursive: true});
process.exit(0);
`;

// the fake host behind OSD_SELF: hana-src-gen is the REAL tool; the DDIC
// merge has nothing to write (no DD* rows); the build and the load check
// agree (the positive control is the test's own business)
const FAKE_HOST = `#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {join} from "node:path";
const args = process.argv.slice(2);
const tool = args[1];
const rest = args.slice(2);
if (tool === "hana-src-gen.mjs") {
  const child = spawnSync(process.execPath, [join(process.env.H5X_REPO, "tools", "hana-src-gen.mjs"), ...rest], {stdio: "inherit"});
  process.exit(child.status ?? 2);
}
if (tool === "osd-generation-check.mjs") {
  console.log(JSON.stringify({ok: true, loads: true}));
  process.exit(0);
}
process.exit(0);
`;
