// The extract converter: a sidecar dump (tools/osd-hana sidecar `dump`) into
// an abapGit-layout repository -- one repo in <out>, `.abapgit.xml` + `src/`,
// one object = the files abapGit would write for it.
//
// This is the converter E2 measured (dump-to-layers.mjs), moved into the repo
// and changed for the extract job:
//   - the output is ONE abapGit repository (folder logic PREFIX or FULL),
//     not a stack of layers; the cross-reference walk (WBCROSSGT/CROSS,
//     layer order, cycles) belonged to the layers and is gone;
//   - the XML is written in abapGit's own layout: one element per line,
//     its indentation and field order (see ./xml.mjs, ./ddic.mjs);
//   - the source of truth for WHAT was dumped is the sidecar's objects.jsonl
//     (per-object status, class, state, skip reason), joined with TADIR for
//     the row fields (MASTERLANG, GENFLAG).
// Nothing here talks to a database; the dump is read, the repository written.
import {createReadStream} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {createInterface} from "node:readline";
import {filename, key, lf, node, leaf, abapgitXmlDoc, decodeTextpool, tpoolNode, repoDotXml} from "./xml.mjs";
import {tablXml, dtelXml, domaXml, ttypXml, shlpXml, viewXml} from "./ddic.mjs";
import {assembleClass, clasXml, intfXml, progXml, includeXml, fugrXml, groupFromMain, includePrefix, mainProgram, groupSuffix} from "./program.mjs";

// Objects this converter can write. A type outside this set that is IN SCOPE
// is never dropped silently: it comes back as `unsupported` and the process
// exit code is 3.
export const SUPPORTED_TYPES = new Set(["CLAS", "INTF", "PROG", "FUGR", "BDEF", "DDLS", "DDLX", "SRVD", "TABL", "DTEL", "DOMA", "TTYP", "SHLP", "VIEW"]);
// Sources kept outside REPOSRC, one active row per object: type -> [table, name column, version column]
const SOURCE_TABLES = {DDLS: ["DDDDLSRC", "DDLNAME", "AS4LOCAL"], DDLX: ["DDLXSRC_SRC", "DDLXNAME", "VERSION"], SRVD: ["SRVDSRC_SRC", "SRVDNAME", "VERSION"]};

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function* jsonl(file) {
  const stream = createReadStream(file, {encoding: "utf8"});
  for await (const line of createInterface({input: stream, crlfDelay: Infinity})) {
    if (line.trim()) yield JSON.parse(line);
  }
}
async function rows(dump, name, optional = false) {
  const out = [];
  try {
    for await (const r of jsonl(path.join(dump, "tables", `${name}.jsonl`))) out.push(r);
  } catch (e) {
    if (!optional || e.code !== "ENOENT") throw e;
  }
  return out;
}

// ---- folder logic ----------------------------------------------------------

// abapGit's folder logic (zcl_abapgit_folder_logic):
//   FULL   -- every package is a folder of its own name (leading `$` stripped
//             by abapGit, `/` -> `#`, lower case), nested under its parent's
//             folder.
//   PREFIX -- a package's folder is the suffix behind its parent's name; it
//             exists only where the names allow it: the packages must form a
//             single hierarchy whose every child is `<parent>_<suffix>`.
//             With several unrelated packages (the usual extract of "my own
//             work", which lives in separate attempts) PREFIX cannot name the
//             folders and FULL is used; the report says which was taken.
export function decideFolderLogic(packages, parents) {
  const tops = [...packages].filter((p) => !(parents.get(p) ?? "").trim());
  if (tops.length !== 1) return "FULL";
  const top = tops[0];
  for (const p of packages) {
    if (p === top) continue;
    const parent = parents.get(p) ?? "";
    if (parent === "" || !packages.has(parent) || parent === p) return "FULL";
    if (!p.startsWith(`${parent}_`) || p.length === parent.length + 1) return "FULL";
  }
  return "PREFIX";
}

const fullFolderName = (pkg) => pkg.replace(/^\$/, "").toLowerCase().replaceAll("/", "#");

export function folderPaths(packages, parents, logic) {
  const paths = new Map();
  for (const p of [...packages].sort()) {
    const parent = parents.get(p) ?? "";
    if (logic === "PREFIX" && packages.has(parent) && parent !== p) {
      const suffix = p.slice(parent.length).replace(/^_/, "");
      paths.set(p, `${paths.get(parent)}${suffix.toLowerCase().replaceAll("/", "#")}/`);
    } else {
      paths.set(p, `${fullFolderName(p)}/`);
    }
  }
  if (new Set(paths.values()).size !== paths.size) {
    throw new Error(`Folder name collision under ${logic} logic: ${[...paths.entries()].map(([k, v]) => `${k} -> ${v}`).join(", ")}`);
  }
  return paths;
}

// ---- conversion ------------------------------------------------------------

export async function convert({
  dump,
  out,
  inScope = () => true, // (object row) => boolean: the extract's scope, not a second classification
  report = () => {},   // per-object outcome hook
} = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(dump, "manifest.json")));
  const table = (n) => rows(dump, n, n !== "TADIR");
  await fs.access(path.join(dump, "reposrc.jsonl"));
  await fs.access(path.join(dump, "tables", "TADIR.jsonl"));
  await fs.mkdir(path.join(out, "src"), {recursive: true});

  const sidecarObjects = new Map();
  for await (const r of jsonl(path.join(dump, "objects.jsonl"))) {
    sidecarObjects.set(`${key(r.type)}:${key(r.name)}`, r);
  }
  const tadir = await table("TADIR");
  const objects = new Map(); // TYPE:NAME -> object
  for (const r of tadir) {
    const type = key(r.OBJECT);
    const name = key(r.OBJ_NAME);
    const pkg = key(r.DEVCLASS);
    if (!pkg || !name || !type) continue;
    const id = `${type}:${name}`;
    if (objects.has(id)) continue;
    const sc = sidecarObjects.get(id);
    objects.set(id, {id, type, name, pkg, row: r, sc, parts: new Map(), files: []});
  }

  // ---- folder logic + output root ---------------------------------------
  const parents = new Map();
  for (const r of await table("TDEVC")) parents.set(key(r.DEVCLASS), key(r.PARENTCL));
  const packages = new Set([...objects.values()].filter(inScope).map((o) => o.pkg));
  const logic = decideFolderLogic(packages, parents);
  const folders = folderPaths(packages, parents, logic);
  const folderOf = (pkg) => folders.get(pkg) ?? `${fullFolderName(pkg)}/`;
  await fs.writeFile(path.join(out, ".abapgit.xml"), repoDotXml({folderLogic: logic}));

  // ---- repositories of sources -------------------------------------------
  const trdir = new Map();
  for (const r of await rows(dump, "TRDIR", true)) trdir.set(key(r.NAME), r);
  const tfdir = await table("TFDIR");
  const seoDf = new Map();
  const seoTx = new Map();
  for (const r of await rows(dump, "SEOCLASSDF", true)) {
    if (key(r.VERSION || "1") === "1") seoDf.set(key(r.CLSNAME), r);
  }
  for (const r of await rows(dump, "SEOCLASSTX", true)) {
    const n = key(r.CLSNAME);
    if (!seoTx.has(n) || key(r.LANGU) === "E") seoTx.set(n, r);
  }
  const repotext = new Map();
  const poolLangs = new Map();
  const tpoolErrors = [];
  const poolOwner = (n) => objects.has(`PROG:${n}`) || (/^(.{1,30}?)=*CP$/.test(n) && n.length === 32 && objects.has(`CLAS:${n.slice(0, 30).replace(/=+$/, "")}`)) || /^(\/[^/]+\/)?(SAPL|L)/.test(n);
  for (const r of await rows(dump, "REPOTEXT", true)) {
    if (key(r.R3STATE || "A") !== "A") continue;
    const n = key(r.PROGNAME);
    if (!poolOwner(n)) continue;
    repotext.set(`${n}:${key(r.LANGUAGE)}`, r);
    if (!poolLangs.has(n)) poolLangs.set(n, []);
    poolLangs.get(n).push(key(r.LANGUAGE));
  }
  const tpoolOf = (program, language, {dropEmptyTitle = false} = {}) => {
    const l = language || "E";
    const r = repotext.get(`${program}:${l}`);
    if (!r) {
      const other = poolLangs.get(program);
      if (other) tpoolErrors.push({program, language: l, reason: `pool only in ${other.sort().join(",")}`});
      return undefined;
    }
    let e = decodeTextpool(r.DATA);
    if (e === null) {
      tpoolErrors.push({program, language: l, reason: "not fixed records"});
      return undefined;
    }
    if (dropEmptyTitle) e = e.filter((x) => !(x.ID === "R" && x.KEY === "" && x.LENGTH === 0));
    return tpoolNode(e);
  };
  const signatures = new Map();
  const fmTexts = new Map();
  for (const r of (await rows(dump, "FUPARAREF", true)).filter((r) => key(r.R3STATE || "A") === "A").sort((a, b) => Number(a.PPOSITION || 0) - Number(b.PPOSITION || 0))) {
    const fm = key(r.FUNCNAME);
    if (!signatures.has(fm)) signatures.set(fm, []);
    signatures.get(fm).push({
      name: key(r.PARAMETER), kind: key(r.PARAMTYPE), structure: String(r.STRUCTURE ?? "").trim(),
      default: String(r.DEFAULTVAL ?? "").trim(), optional: key(r.OPTIONAL) === "X" ? "X" : "",
      reference: key(r.REFERENCE) === "X" ? "X" : "", type: key(r.TYPE) === "X", refClass: key(r.REF_CLASS) === "X" ? "X" : "",
    });
  }
  for (const r of await rows(dump, "TFTIT", true)) {
    const fm = key(r.FUNCNAME);
    if (!fmTexts.has(fm) || key(r.SPRAS) === "E") fmTexts.set(fm, String(r.STEXT ?? "").trim());
  }

  const fmByInclude = new Map();
  const fmByName = new Map();
  const fmRow = new Map();
  const groupByProgram = new Map();
  const groupByName = new Map();
  for (const r of tfdir) {
    const prog = key(r.PNAME_MAIN || r.PNAME);
    const inc = key(r.INCLUDE);
    const fm = key(r.FUNCNAME);
    const group = groupFromMain(prog);
    if (!group || !fm) continue;
    const owner = objects.get(`FUGR:${group}`);
    if (!owner) continue; // a group outside TADIR has no package; it is not in scope
    groupByName.set(group, owner);
    groupByProgram.set(prog, owner);
    fmByName.set(fm, owner);
    fmRow.set(fm, r);
    if (inc) fmByInclude.set(`${group}:U${inc}`, fm);
  }
  for (const r of await rows(dump, "TLIBG", true)) {
    const group = key(r.AREA);
    const owner = objects.get(`FUGR:${group}`);
    if (owner) {
      groupByName.set(group, owner);
      groupByProgram.set(mainProgram(group), owner);
    }
  }

  const sourceOwner = new Map();
  function resolve(program) {
    const p = key(program);
    if (sourceOwner.has(p)) return sourceOwner.get(p);
    let o = objects.get(`PROG:${p}`) || objects.get(`INTF:${p}`);
    if (!o && p.length > 30 && p[30] !== "") {
      const base = p.slice(0, 30).replace(/=+$/, "");
      const suffix = p.slice(30);
      o = objects.get(`CLAS:${base}`) || objects.get(`INTF:${base}`);
      if (o && o.type === "INTF" && !/^(?:IU|IP|IT)$/.test(suffix)) o = undefined;
      if (o && o.type === "CLAS" && !/^(CU|CO|CI|CP|CT|CS|CL|CCDEF|CCIMP|CCMAC|CCAU|CM[0-9A-Z]{3})$/.test(suffix)) o = undefined;
      if (!o && /^BDI?$/.test(suffix)) o = objects.get(`BDEF:${base}`);
    }
    if (!o) o = groupByProgram.get(p);
    const m = /^(\/[^/]+\/)?L(.+)$/.exec(p);
    if (!o && m) {
      for (const n of [3, 4]) {
        const suffix = m[2].slice(-n);
        const g = (m[1] || "") + m[2].slice(0, -n);
        if (m[2].length > n && groupSuffix.test(suffix) && groupByName.has(g)) {
          o = groupByName.get(g);
          break;
        }
      }
    }
    sourceOwner.set(p, o || null);
    return o;
  }

  const errors = [];
  const emptySources = {count: 0};
  // One pass over the dump's sources: every program resolves to at most one
  // owner, and the owner takes its ACTIVE version (abapGit serializes the
  // active one); only-inactive sources are taken and the object is flagged
  // via its file states in objects.jsonl.
  for await (const list of repoLists(dump)) {
    const p = list[0].program;
    const o = resolve(p);
    if (!o || !inScope(o)) continue;
    const active = list.find((r) => key(r.state || "A") === "A") ?? list[0];
    if (active.error) {
      errors.push({program: p, error: String(active.error)});
      continue;
    }
    if (active.empty) {
      emptySources.count++;
      continue;
    }
    if (!active.file || path.isAbsolute(active.file) || active.file.split(/[\\/]/).includes("..")) {
      errors.push({program: p, error: "invalid source path"});
      continue;
    }
    const partKey = o.type === "CLAS" || o.type === "INTF" || o.type === "BDEF" ? p.slice(30) : p;
    o.parts.set(partKey, path.join(dump, active.file));
  }

  // ---- dictionary objects --------------------------------------------------
  {
    const active = (r) => key(r.AS4LOCAL || "A") === "A";
    const text = async (t, col) => {
      const m = new Map();
      for (const r of (await table(t)).filter(active)) {
        const n = key(r[col]);
        if (!m.has(n) || key(r.DDLANGUAGE) === "E") m.set(n, r);
      }
      return m;
    };
    const by = async (t, col) => {
      const m = new Map();
      for (const r of (await table(t)).filter(active)) {
        const n = key(r[col]);
        if (!m.has(n)) m.set(n, []);
        m.get(n).push(r);
      }
      return m;
    };
    const dd02l = await by("DD02L", "TABNAME");
    const dd02t = await text("DD02T", "TABNAME");
    const dd09l = await by("DD09L", "TABNAME");
    const dd03l = await by("DD03L", "TABNAME");
    const dd04l = await by("DD04L", "ROLLNAME");
    const dd04t = await text("DD04T", "ROLLNAME");
    const dd01l = await by("DD01L", "DOMNAME");
    const dd01t = await text("DD01T", "DOMNAME");
    const dd07l = await by("DD07L", "DOMNAME");
    const dd07t = new Map();
    for (const r of (await table("DD07T")).filter(active)) {
      const k2 = `${key(r.DOMNAME)}:${key(r.VALPOS)}`;
      if (!dd07t.has(k2) || key(r.DDLANGUAGE) === "E") dd07t.set(k2, r);
    }
    const dd40l = await by("DD40L", "TYPENAME");
    const dd40t = await text("DD40T", "TYPENAME");
    const dd30l = await by("DD30L", "SHLPNAME");
    const dd30t = await text("DD30T", "SHLPNAME");
    const dd31s = await by("DD31S", "SHLPNAME");
    const dd32s = await by("DD32S", "SHLPNAME");
    const dd33s = await by("DD33S", "SHLPNAME");
    const dd25l = await by("DD25L", "VIEWNAME");
    const dd25t = await text("DD25T", "VIEWNAME");
    const dd26s = await by("DD26S", "VIEWNAME");
    const dd27s = await by("DD27S", "VIEWNAME");
    const dd28s = await by("DD28S", "CONDNAME");
    const lang = (r) => (r ? {DDLANGUAGE: "E", ...r, DDLANGUAGE: key(r.DDLANGUAGE) || "E"} : {DDLANGUAGE: "E"});
    for (const o of objects.values()) {
      if (!inScope(o)) continue;
      if (o.type === "TABL" && dd02l.has(o.name)) {
        o.ddic = tablXml({...dd02l.get(o.name)[0], ...lang(dd02t.get(o.name)), TABNAME: o.name}, dd09l.get(o.name)?.[0], dd03l.get(o.name) || []);
      } else if (o.type === "DTEL" && dd04l.has(o.name)) {
        o.ddic = dtelXml({...dd04l.get(o.name)[0], ...lang(dd04t.get(o.name)), ROLLNAME: o.name});
      } else if (o.type === "DOMA" && dd01l.has(o.name)) {
        o.ddic = domaXml({...dd01l.get(o.name)[0], ...lang(dd01t.get(o.name)), DOMNAME: o.name}, (dd07l.get(o.name) || []).map((v) => {
          const t = dd07t.get(`${o.name}:${key(v.VALPOS)}`);
          return {...v, DDLANGUAGE: "E", ...(t ? {DDTEXT: t.DDTEXT, DDLANGUAGE: key(t.DDLANGUAGE) || "E"} : {})};
        }));
      } else if (o.type === "TTYP" && dd40l.has(o.name)) {
        o.ddic = ttypXml({...dd40l.get(o.name)[0], ...lang(dd40t.get(o.name)), TYPENAME: o.name});
      } else if (o.type === "SHLP" && dd30l.has(o.name)) {
        o.ddic = shlpXml({...dd30l.get(o.name)[0], ...lang(dd30t.get(o.name)), SHLPNAME: o.name}, dd31s.get(o.name) || [], dd32s.get(o.name) || [], dd33s.get(o.name) || []);
      } else if (o.type === "VIEW" && dd25l.has(o.name)) {
        const fields = (dd27s.get(o.name) || []).map((r) => {
          const b = (dd03l.get(key(r.TABNAME)) || []).find((x) => key(x.FIELDNAME) === key(r.FIELDNAME)) || {};
          const e = dd04l.get(key(r.ROLLNAME))?.[0] || {};
          const d = dd01l.get(key(e.DOMNAME))?.[0] || {};
          return {...r, CHECKTABLE: b.CHECKTABLE, SHLPORIGIN: b.SHLPORIGIN, LOGFLAG: e.LOGFLAG, VALEXI: d.VALEXI};
        });
        o.ddic = viewXml({...dd25l.get(o.name)[0], ...lang(dd25t.get(o.name)), VIEWNAME: o.name}, dd09l.get(o.name)?.[0], dd26s.get(o.name) || [], fields, dd28s.get(o.name) || []);
      }
    }
  }

  // CDS and friends: source rows outside REPOSRC
  for (const [type, [name, column, version]] of Object.entries(SOURCE_TABLES)) {
    let tableRows;
    try {
      tableRows = await table(name);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      continue;
    }
    for (const r of tableRows) {
      if (key(r[version]) !== "A") continue;
      const owner = objects.get(`${type}:${key(r[column])}`);
      if (!owner || !inScope(owner)) continue;
      owner.text = r.SOURCE ?? "";
      owner.sourceRow = r;
      owner.parts.set("SRC", "");
    }
  }

  // ---- write ---------------------------------------------------------------
  const outcomes = new Map(); // id -> {object, status}
  const outcome = (o, status, reason) => {
    outcomes.set(o.id, {type: o.type, name: o.name, package: o.pkg, status, reason, state: stateOf(o), generated: key(o.row.GENFLAG) === "X", files: o.files, sc: o.sc});
    report(o, status, reason);
  };
  const stateOf = (o) => {
    const s = o.sc?.state ?? undefined;
    const fileStates = new Set((o.sc?.files ?? []).map((f) => f.state).filter(Boolean));
    if (fileStates.has("I")) return fileStates.has("A") ? "both" : "I";
    return s ?? "A";
  };

  async function writeObject(o) {
    const folder = path.join(out, "src", folderOf(o.pkg));
    await fs.mkdir(folder, {recursive: true});
    const stem = filename(o.name);
    const put = async (suffix, content) => {
      const p = path.join(folder, `${stem}.${suffix}`);
      await fs.writeFile(p, content);
      o.files.push({path: path.relative(out, p).split(path.sep).join("/"), sha256: sha256(content), bytes: Buffer.byteLength(content)});
    };
    const parts = new Map();
    for (const [k, file] of o.parts) {
      if (file === "") continue; // a marker (SRC of DDLS/DDLX/SRVD), not a file
      const content = await fs.readFile(file, "utf8").catch((e) => {
        errors.push({program: k, object: o.name, error: e.message});
        return null;
      });
      if (content !== null) parts.set(k, content);
    }
    let wrote = false;
    if (o.type === "CLAS") {
      if (!parts.has("CS") && !parts.has("CU")) {
        outcome(o, "skipped", "class without CU or CS include");
        return;
      }
      await put("clas.abap", assembleClass(o.name, parts));
      const code = (s) => parts.has(s) && !comment(parts.get(s));
      if (code("CL") && code("CCIMP")) {
        errors.push({object: o.name, error: "local classes in both CL and CCIMP includes"});
        parts.delete("CCIMP");
      } else if (code("CL")) parts.set("CCIMP", parts.get("CL"));
      for (const [s, ext] of [["CCDEF", "locals_def"], ["CCIMP", "locals_imp"], ["CCMAC", "macros"], ["CCAU", "testclasses"]]) {
        const content = parts.get(s);
        if (content && !comment(content)) await put(`clas.${ext}.abap`, content);
      }
      await put("clas.xml", clasXml(o, seoDf.get(o.name), seoTx.get(o.name), tpoolOf(o.name.padEnd(30, "=") + "CP", o.row.MASTERLANG)));
      wrote = true;
    } else if (o.type === "INTF") {
      if (!parts.has("IU")) {
        outcome(o, "skipped", "interface without IU include");
        return;
      }
      await put("intf.abap", parts.get("IU"));
      await put("intf.xml", intfXml(o, seoDf.get(o.name), seoTx.get(o.name)));
      wrote = true;
    } else if (o.type === "BDEF") {
      if (!parts.has("BD")) {
        outcome(o, "skipped", "behaviour definition without BD include");
        return;
      }
      await put("bdef.asbdef", lf(parts.get("BD")));
      await put("bdef.xml", abapgitXmlDoc("LCL_OBJECT_BDEF", [node("BDEF", [leaf("NAME", o.name), leaf("LANGU", o.row.MASTERLANG || "E")])]));
      wrote = true;
    } else if (o.ddic !== undefined) {
      await put(`${o.type.toLowerCase()}.xml`, o.ddic);
      wrote = true;
    } else if (o.text !== undefined) {
      const ext = {DDLS: "ddls.asddls", DDLX: "ddlx.asddlxs", SRVD: "srvd.srvdsrv"}[o.type];
      await put(ext, lf(o.text));
      const tag = {DDLS: "DDLS", DDLX: "DDLX", SRVD: "SRVD"}[o.type];
      const children = [leaf(SOURCE_TABLES[o.type][1], o.name), leaf("LANGU", o.row.MASTERLANG || "E")];
      if (o.type === "DDLS" && key(o.sourceRow.SOURCE_TYPE ?? "") !== "") children.push(leaf("SOURCE_TYPE", key(o.sourceRow.SOURCE_TYPE)));
      await put(`${o.type.toLowerCase()}.xml`, abapgitXmlDoc(`LCL_OBJECT_${o.type}`, [node(tag, children)]));
      wrote = true;
    } else if (o.type === "PROG") {
      const source = parts.get(o.name);
      if (source === undefined) {
        outcome(o, "skipped", "program without source");
        return;
      }
      await put("prog.abap", source);
      await put("prog.xml", progXml(o.name, trdir.get(o.name), tpoolOf(o.name, o.row.MASTERLANG, {dropEmptyTitle: true})));
      wrote = true;
    } else if (o.type === "FUGR") {
      const {includes, functions, wrote: groupWrote} = await writeFunctionGroup(o, parts, folder, stem);
      if (groupWrote) {
        await put("fugr.xml", fugrXml({areat: areatOf(o), includes, functions}));
        wrote = true;
      }
    }
    if (wrote) outcome(o, "written");
    else outcome(o, "skipped", "nothing could be written for this object");
  }

  // The group's short text (TLIBT) is not in the dump; abapGit suppresses the
  // empty AREAT, and so do we (fugrXml).
  const areatOf = (o) => o.sc?.areat ?? o.row.AREAT ?? "";
  const comment = (content) => !content.split("\n").some((line2) => line2.trim() && !/^\s*\*"\*/.test(line2));

  async function writeFunctionGroup(o, parts, folder, stem) {
    const includes = [];
    const functions = [];
    const prefix = includePrefix(o.name);
    let wrote = false;
    for (const [prog, source] of [...parts].sort(([a], [b]) => a.localeCompare(b))) {
      const suffix = prog.startsWith(prefix) ? prog.slice(prefix.length) : "";
      // abapGit does not store what the function library generates: UXX
      // (the module list), $NN (a module's interface comment), Vnn (a remote
      // module's RFC stub) -- each marked as generated in its source
      if (suffix === "UXX" || /^\$[0-9]{2,3}$/.test(suffix) || (!fmByInclude.get(`${o.name}:${suffix}`) && /GENERATED BY THE FUNCTION LIBRARY/i.test(String(source).slice(0, 400)))) continue;
      const fm = fmByInclude.get(`${o.name}:${suffix}`);
      const file = path.join(folder, `${stem}.fugr.${filename(fm || prog)}.abap`);
      await fs.writeFile(file, source);
      o.files.push({path: path.relative(out, file).split(path.sep).join("/"), sha256: sha256(source), bytes: Buffer.byteLength(source)});
      wrote = true;
      // abapGit stores each include's and the main program's attributes
      // beside it (PROGDIR, plain <abapGit version="v1.0.0">); a module's
      // file has none
      if (!fm) {
        const x = includeXml(prog, trdir.get(prog), prog === mainProgram(o.name) ? tpoolOf(prog, o.row?.MASTERLANG, {dropEmptyTitle: true}) : undefined);
        const xp = path.join(folder, `${stem}.fugr.${filename(prog)}.xml`);
        await fs.writeFile(xp, x);
        o.files.push({path: path.relative(out, xp).split(path.sep).join("/"), sha256: sha256(x), bytes: Buffer.byteLength(x)});
        includes.push(prog);
      } else {
        const r = fmRow.get(fm);
        functions.push({name: fm, remote: key(r.FMODE) === "R" ? "R" : "", update: key(r.UTASK), text: fmTexts.get(fm), params: signatures.get(fm)});
      }
    }
    return {includes, functions, wrote};
  }

  const todo = [...objects.values()].filter((o) => inScope(o)).sort((a, b) => a.id.localeCompare(b.id));
  for (const o of todo) {
    // A type this converter cannot write is NEVER dropped silently.
    if (!SUPPORTED_TYPES.has(o.type)) {
      outcome(o, "unsupported");
      continue;
    }
    // what the sidecar already refused has its own reason
    if (o.sc?.status === "skipped") {
      outcome(o, "skipped", o.sc.reason ?? "skipped by the sidecar");
      continue;
    }
    if (o.parts.size + (o.ddic !== undefined ? 1 : 0) + (o.text !== undefined ? 1 : 0) === 0) {
      const ddicTypes = ["TABL", "DTEL", "DOMA", "TTYP", "SHLP", "VIEW"];
      outcome(o, "skipped", ddicTypes.includes(o.type) ? "no dictionary rows in the dump" : "no source in the dump");
      continue;
    }
    await writeObject(o);
  }

  return {
    folderLogic: logic,
    folders: [...folders.entries()].map(([p, f]) => ({package: p, folder: `src/${f}`})),
    outcomes: [...outcomes.values()].map(({sc, ...rest}) => rest),
    errors,
    tpoolErrors,
    emptySources: emptySources.count,
    manifestProvenance: manifest.provenance,
  };
}

// reposrc.jsonl, grouped per program, active version first. One pass keeps
// the whole dump from being held in memory: rows carry only their file path.
async function* repoLists(dump) {
  const groups = new Map();
  for await (const r of jsonl(path.join(dump, "reposrc.jsonl"))) {
    const p = key(r.program);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(r);
  }
  for (const list of groups.values()) yield list;
}
