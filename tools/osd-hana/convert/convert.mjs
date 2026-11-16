// The extract converter: a sidecar dump (tools/osd-hana sidecar `dump`) into
// an abapGit-layout repository -- one repo in <out>, `.abapgit.xml` + `src/`,
// one object = the files abapGit would write for it.
//
// The report is built from a LEDGER (./ledger.mjs), driven by THE LISTING:
// every in-scope object ends in exactly one state and every part the
// converter knows it cannot write is a line under that object. The walk is
// still objects.jsonl x TADIR x reposrc x DD* for CONTENT, but scope and
// accounting come from the listing rows the extract passed in -- an object
// the listing has and the dump lacks is `skipped: not-in-dump`, never a
// vanishing (critic M1).
//
// This is the converter E2 measured (dump-to-layers.mjs), moved into the repo
// and changed for the extract job; the XML is abapGit's own layout (see
// ./xml.mjs, ./ddic.mjs). Nothing here talks to a database; the dump is read,
// the repository written.
import {createReadStream} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {createInterface} from "node:readline";
import {key, filename, repoDotXml, decodeTextpool, tpoolNode} from "./xml.mjs";
import {tablXml, dtelXml, domaXml, ttypXml, shlpXml, viewXml} from "./ddic.mjs";
import {groupFromMain, mainProgram, groupSuffix} from "./program.mjs";
import {Ledger, unsafeComponent} from "./ledger.mjs";
import {planObjectFiles} from "./write.mjs";

// Objects this converter can write. A type outside this set that is IN SCOPE
// is never dropped silently: it comes back as `unsupported` and the process
// exit code is 3.
export const SUPPORTED_TYPES = new Set(["CLAS", "INTF", "PROG", "FUGR", "BDEF", "DDLS", "DDLX", "SRVD", "TABL", "DTEL", "DOMA", "TTYP", "SHLP", "VIEW"]);
// The DD/table views the converter actually reads -- the report says which
// it looked at (SHOULD-1), and which tables the dump does not carry at all.
export const TABLES_READ = Object.freeze(["TADIR", "TDEVC", "TRDIR", "TFDIR", "TLIBG", "FUPARAREF", "TFTIT", "SEOCLASSDF", "SEOCLASSTX", "REPOTEXT", "DD02L", "DD02T", "DD09L", "DD03L", "DD04L", "DD04T", "DD01L", "DD01T", "DD07L", "DD07T", "DD40L", "DD40T", "DD30L", "DD30T", "DD31S", "DD32S", "DD33S", "DD25L", "DD25T", "DD26S", "DD27S", "DD28S", "DDDDLSRC", "DDLXSRC_SRC", "SRVDSRC_SRC"]);

// Sources kept outside REPOSRC, one active row per object: type -> [table, name column, version column]
const SOURCE_TABLES = {DDLS: ["DDDDLSRC", "DDLNAME", "AS4LOCAL"], DDLX: ["DDLXSRC_SRC", "DDLXNAME", "VERSION"], SRVD: ["SRVDSRC_SRC", "SRVDNAME", "VERSION"]};

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function* jsonl(file) {
  const stream = createReadStream(file, {encoding: "utf8"});
  for await (const line of createInterface({input: stream, crlfDelay: Infinity})) {
    if (line.trim()) yield JSON.parse(line);
  }
}
// A chunked dump is several sidecar runs (one per name chunk, one directory
// each); every table and the sources are read across all of them.
async function rows(roots, name, optional = false) {
  const out = [];
  for (const root of roots) {
    try {
      for await (const r of jsonl(path.join(root, "tables", `${name}.jsonl`))) out.push(r);
    } catch (e) {
      if (!optional || e.code !== "ENOENT") throw e;
    }
  }
  return out;
}

// ---- folder logic ----------------------------------------------------------
// abapGit's folder logic (zcl_abapgit_folder_logic=>package_to_path), the
// rule implemented here:
//   FULL   -- every package is a folder of its own name (leading `$` stripped
//             by abapGit, `/` -> `#`, lower case), NESTED under its parent's
//             folder -- the source recurses into the parent and concatenates
//             for FULL too (critic S1: the converter used to write flat
//             folders, so a pull saw every file of a subpackage as moved).
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

// Returns {paths, collisions}: paths is the package -> folder map, collisions
// the packages that fold to a folder another package already took (abapGit's
// \$ rule strips a leading \$, so \$ZPK and ZPK BOTH fold to zpk/ -- abapGit
// cannot hold both in one repository). SHOULD-3 (critic round 2): the caller
// refuses the affected objects in the ledger; this function never throws, so
// one colliding pair cannot abort the whole run.
export function folderPaths(packages, parents, logic) {
  const paths = new Map();
  const busy = new Set(); // a TDEVC parent cycle must not recurse forever
  const pathOf = (p) => {
    if (paths.has(p)) return paths.get(p);
    const parent = busy.has(p) ? "" : (parents.get(p) ?? "");
    let base;
    if (logic === "PREFIX" && parent !== "" && packages.has(parent) && parent !== p) {
      const suffix = p.slice(parent.length).replace(/^_/, "");
      base = `${pathOf(parent)}${suffix.toLowerCase().replaceAll("/", "#")}/`;
    } else if (logic === "FULL" && parent !== "" && packages.has(parent) && parent !== p) {
      // FULL nests under the parent's folder (S1); the recursion stops at the
      // scope's top packages, as abapGit's does at the repo's top
      base = `${pathOf(parent)}${fullFolderName(p)}/`;
    } else {
      base = `${fullFolderName(p)}/`;
    }
    busy.add(p);
    paths.set(p, base);
    busy.delete(p);
    return base;
  };
  for (const p of packages) pathOf(p);
  const taken = new Map(); // folder -> first package
  const collisions = new Set();
  for (const [p, folder] of [...paths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (taken.has(folder)) {
      collisions.add(p);
      collisions.add(taken.get(folder));
    } else {
      taken.set(folder, p);
    }
  }
  return {paths, collisions};
}

// ---- conversion ------------------------------------------------------------

export async function convert({
  dump,
  out,
  listed,            // the in-scope listing rows: the ledger's spine (M1)
  preSkipped = [],   // listed rows out of scope by rule: ledger-skipped with their reason (M-1, round 2)
  keptPaths = [],    // [{path, why}] -- mirrors protectedPaths for the refusal wording (M-5)
  roots,             // the dump's directories (a chunked dump: one per part); default [dump]
  protectedPaths = new Set(), // repo-relative files this run must NOT overwrite (M-5: the user's, or changed since the last run)
  onLedger = () => {}, // the failure-path seam: extract keeps the ledger even when this throws (S3)
} = {}) {
  const allRoots = roots ?? [dump];
  const manifest = JSON.parse(await fs.readFile(path.join(dump, "manifest.json")));
  const table = (n) => rows(allRoots, n, n !== "TADIR");
  for (const root of allRoots) {
    await fs.access(path.join(root, "reposrc.jsonl"));
    await fs.access(path.join(root, "tables", "TADIR.jsonl"));
  }
  await fs.mkdir(path.join(out, "src"), {recursive: true});

  const sidecarObjects = new Map();
  for (const root of allRoots) {
    for await (const r of jsonl(path.join(root, "objects.jsonl"))) {
      sidecarObjects.set(`${key(r.type)}:${key(r.name)}`, r);
    }
  }
  const tadir = await table("TADIR");
  const objects = new Map(); // TYPE:NAME (uppercased) -> object
  for (const r of tadir) {
    const type = key(r.OBJECT);
    const name = key(r.OBJ_NAME);
    const pkg = key(r.DEVCLASS);
    if (!pkg || !name || !type) continue;
    const id = `${type}:${name}`;
    if (objects.has(id)) continue;
    const sc = sidecarObjects.get(id);
    objects.set(id, {id, type, name, pkg, row: r, sc, parts: new Map(), partNotes: [], files: []});
  }

  // ---- the ledger, from the listing ----------------------------------------
  const ledger = new Ledger(listed);
  for (const r of preSkipped) {
    const cls = r.class;
    ledger.addSkipped(r, `unknown-class: ${cls === undefined || cls === "" ? "the listing carries no classification" : `the classification is "${cls}"`}`
      + " -- only the sidecar's exact customer class is in scope; left out, the sidecar may be newer than this module");
  }
  onLedger(ledger);
  const claims = ledger.markCaseCollisions(); // uppercased id -> surviving entry
  for (const [upperId, e] of claims) {
    if (!objects.has(upperId)) {
      // the listing has it, the dump does not (restart drift, a TADIR gap):
      // skipped, loud -- never a vanishing (critic M1)
      e.status = "skipped";
      e.reason = "not-in-dump: in the listing but not in the dump (no TADIR row)";
    }
  }
  // name safety (attack 2): a package or object name that cannot be a path
  // component is refused per object -- no traversal, no Windows device file,
  // no write crash from a hostile or corrupt dump
  const claimed = new Map(); // uppercased id -> object
  for (const [upperId, e] of claims) {
    const o = objects.get(upperId);
    if (!o || e.status !== undefined) continue;
    const bad = unsafeComponent(fullFolderName(o.pkg)) ?? unsafeComponent(filename(o.name));
    if (bad !== undefined) {
      e.status = "skipped";
      e.reason = `unsafe name: ${bad}`;
      continue;
    }
    claimed.set(upperId, o);
  }

  // ---- folder logic + output root ------------------------------------------
  const parents = new Map();
  for (const r of await table("TDEVC")) parents.set(key(r.DEVCLASS), key(r.PARENTCL));
  const packages = new Set([...claimed.values()].map((o) => o.pkg));
  const logic = decideFolderLogic(packages, parents);
  const {paths: folders, collisions} = folderPaths(packages, parents, logic);
  // deterministic: the first package in sort order keeps the folder, the
  // others' objects are refused per object (never an abort, never mixing)
  const losingPackages = new Set([...collisions].sort().slice(1));
  const winningFolder = (pkg) => {
    for (const [p, folder] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (p !== pkg && folder === folders.get(pkg)) return p;
    }
    return "another package";
  };
  const folderOf = (pkg) => folders.get(pkg) ?? `${fullFolderName(pkg)}/`;
  // the repository's master language follows the dump (N4: a hard-coded E is
  // silently wrong on a non-English system): the dominant TADIR MASTERLANG
  // among the written objects, falling back to E
  const langs = new Map();
  for (const o of claimed.values()) {
    const l = key(o.row.MASTERLANG) || "E";
    langs.set(l, (langs.get(l) ?? 0) + 1);
  }
  const masterLanguage = [...langs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "E";
  // M-5: a .abapgit.xml the user changed (or one the marker does not list)
  // is kept, not overwritten
  const keptDotAbapgit = protectedPaths.has(".abapgit.xml");
  if (!keptDotAbapgit) await fs.writeFile(path.join(out, ".abapgit.xml"), repoDotXml({folderLogic: logic, masterLanguage}));

  // ---- repositories of sources ----------------------------------------------
  const trdir = new Map();
  for (const r of await rows(allRoots, "TRDIR", true)) trdir.set(key(r.NAME), r);
  const tfdir = await table("TFDIR");
  const seoDf = new Map();
  const seoTx = new Map();
  const seoTxLangs = new Map(); // class -> every language SEOCLASSTX carries (SHOULD-1)
  for (const r of await rows(allRoots, "SEOCLASSDF", true)) {
    if (key(r.VERSION || "1") === "1") seoDf.set(key(r.CLSNAME), r);
  }
  for (const r of await rows(allRoots, "SEOCLASSTX", true)) {
    const n = key(r.CLSNAME);
    if (!seoTxLangs.has(n)) seoTxLangs.set(n, new Set());
    seoTxLangs.get(n).add(key(r.LANGU));
    const cur = seoTx.get(n);
    if (cur === undefined || key(r.LANGU) === masterLanguage || (key(cur.LANGU) !== masterLanguage && key(r.LANGU) === "E")) seoTx.set(n, r);
  }
  const repotext = new Map();
  const poolLangs = new Map();
  const errors = [];
  const poolOwner = (n) => objects.has(`PROG:${n}`) || (/^(.{1,30}?)=*CP$/.test(n) && n.length === 32 && objects.has(`CLAS:${n.slice(0, 30).replace(/=+$/, "")}`)) || /^(\/[^/]+\/)?(SAPL|L)/.test(n);
  for (const r of await rows(allRoots, "REPOTEXT", true)) {
    if (key(r.R3STATE || "A") !== "A") continue;
    const n = key(r.PROGNAME);
    if (!poolOwner(n)) continue;
    repotext.set(`${n}:${key(r.LANGUAGE)}`, r);
    if (!poolLangs.has(n)) poolLangs.set(n, []);
    poolLangs.get(n).push(key(r.LANGUAGE));
  }
  // A text pool is written in ONE language (the object's master language);
  // what is left out is a part line, never silence (N5, critic M4's list).
  const tpoolOf = (program, language, {dropEmptyTitle = false} = {}) => {
    const l = language || "E";
    const notes = [];
    const other = (poolLangs.get(key(program)) ?? []).filter((x) => x !== l);
    for (const lang of [...new Set(other)].sort()) {
      notes.push({part: "text pool", disposition: "not extracted", reason: `language ${lang} pool not extracted (only the ${l} pool is written)`});
    }
    const r = repotext.get(`${key(program)}:${l}`);
    if (!r) {
      if (other.length > 0) notes.push({part: "text pool", disposition: "not extracted", reason: `master pool in ${l} missing from the dump; only ${[...new Set(other)].sort().join(",")}`});
      return {node: undefined, notes};
    }
    let e = decodeTextpool(r.DATA);
    if (e === null) {
      notes.push({part: "text pool", disposition: "not extracted", reason: "not fixed records"});
      return {node: undefined, notes};
    }
    if (dropEmptyTitle) e = e.filter((x) => !(x.ID === "R" && x.KEY === "" && x.LENGTH === 0));
    return {node: tpoolNode(e), notes};
  };
  const signatures = new Map();
  const fmTexts = new Map();
  const curLang = new Map(); // NOTE-7: the language the chosen short text carries
  for (const r of (await rows(allRoots, "FUPARAREF", true)).filter((r) => key(r.R3STATE || "A") === "A").sort((a, b) => Number(a.PPOSITION || 0) - Number(b.PPOSITION || 0))) {
    const fm = key(r.FUNCNAME);
    if (!signatures.has(fm)) signatures.set(fm, []);
    signatures.get(fm).push({
      name: key(r.PARAMETER), kind: key(r.PARAMTYPE), structure: String(r.STRUCTURE ?? "").trim(),
      default: String(r.DEFAULTVAL ?? "").trim(), optional: key(r.OPTIONAL) === "X" ? "X" : "",
      reference: key(r.REFERENCE) === "X" ? "X" : "", type: key(r.TYPE) === "X", refClass: key(r.REF_CLASS) === "X" ? "X" : "",
    });
  }
  const tftitLangs = new Map(); // function -> every language TFTIT carries (SHOULD-1)
  for (const r of await rows(allRoots, "TFTIT", true)) {
    const fm = key(r.FUNCNAME);
    if (!tftitLangs.has(fm)) tftitLangs.set(fm, new Set());
    tftitLangs.get(fm).add(key(r.SPRAS));
    const cur = fmTexts.get(fm);
    if (cur === undefined || key(r.SPRAS) === masterLanguage || (curLang.get(fm) !== masterLanguage && key(r.SPRAS) === "E")) {
      fmTexts.set(fm, String(r.STEXT ?? "").trim());
      curLang.set(fm, key(r.SPRAS));
    }
  }

  const fmByInclude = new Map();
  const fmByName = new Map();
  const fmRow = new Map();
  const fmsOfGroup = new Map(); // group -> TFDIR rows (M2's completeness check)
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
    if (!fmsOfGroup.has(group)) fmsOfGroup.set(group, []);
    fmsOfGroup.get(group).push(r);
    if (inc) fmByInclude.set(`${group}:U${inc}`, fm);
  }
  for (const r of await rows(allRoots, "TLIBG", true)) {
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

  const emptySources = {count: 0};
  // One pass over the dump's sources: every program resolves to at most one
  // owner, and the owner takes its ACTIVE version (abapGit serializes the
  // active one); only-inactive sources are taken and the object is flagged
  // via its file states in objects.jsonl.
  for await (const list of repoLists(allRoots)) {
    const p = list[0].program;
    const o = resolve(p);
    if (!o || !claimed.has(o.id)) continue;
    const active = list.find((r) => key(r.state || "A") === "A") ?? list[0];
    // M-4 (critic round 2): a source the dump could not deliver is a PART
    // LINE on its object -- the object is written-partial, never `written`
    // with an include silently missing, and report.errors alone is not an
    // accounting.
    if (active.error) {
      errors.push({program: p, error: String(active.error)});
      o.partNotes.push({part: `include ${p}`, disposition: "not extracted", reason: `the dump could not deliver the source: ${String(active.error)}`});
      continue;
    }
    if (active.empty) {
      emptySources.count++;
      continue;
    }
    if (!active.file || path.isAbsolute(active.file) || active.file.split(/[\\/]/).includes("..")) {
      errors.push({program: p, error: "invalid source path"});
      o.partNotes.push({part: `include ${p}`, disposition: "not extracted", reason: `the dump names an unusable source path (${String(active.file ?? "none")})`});
      continue;
    }
    const partKey = o.type === "CLAS" || o.type === "INTF" || o.type === "BDEF" ? p.slice(30) : p;
    o.parts.set(partKey, path.join(dump, active.file));
  }

  // ---- dictionary objects ----------------------------------------------------
  const dd02tLangs = new Map(); // table -> every language DD02T carries (SHOULD-1)
  {
    const active = (r) => key(r.AS4LOCAL || "A") === "A";
    // NOTE-7 (critic round 2): prefer the repository's master language over
    // a hard-coded E -- on a non-English system the E text under the E key
    // contradicted .abapgit.xml's MASTER_LANGUAGE
    const text = async (t, col) => {
      const m = new Map();
      for (const r of (await table(t)).filter(active)) {
        const n = key(r[col]);
        const cur = m.get(n);
        if (cur === undefined || key(r.DDLANGUAGE) === masterLanguage || (key(cur.DDLANGUAGE) !== masterLanguage && key(r.DDLANGUAGE) === "E")) m.set(n, r);
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
    for (const r of await table("DD02T")) {
      const n = key(r.TABNAME);
      if (!dd02tLangs.has(n)) dd02tLangs.set(n, new Set());
      dd02tLangs.get(n).add(key(r.DDLANGUAGE));
    }
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
      if (!claimed.has(o.id)) continue;
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

  // ---- SHOULD-1 (critic round 2): what `written` covers, said per object ----
  // Fix round 4: the two part kinds. Where the dump CARRIES the table and
  // this converter does not write it (DD05S/DD08L foreign keys when present),
  // the line is "not extracted" -- it lands on `parts` and makes the object
  // written-partial. Where the dump carries none of the aspect's tables
  // (DD12L/DD17S, DD35L/DD36S, DD03T, SEOCOMPOTX), the line is "not checked":
  // it lands on the object's `unchecked` list and never makes written-partial.
  // Translations the converter leaves out (one language is written) are
  // "not extracted" and name the language.
  const dumpHasTable = async (t) => {
    for (const root of allRoots) {
      try {
        await fs.access(path.join(root, "tables", `${t}.jsonl`));
        return true;
      } catch { /* not carried by this root */ }
    }
    return false;
  };
  const coverageAspects = [
    ["foreign keys", ["DD05S", "DD08L"]],
    ["secondary indexes", ["DD12L", "DD17S"]],
    ["search-help assignments", ["DD35L", "DD36S"]],
    ["component texts", ["DD03T"]],
  ];
  const notCarriedTables = [];
  for (const [, tables] of coverageAspects) {
    for (const t of tables) if (!(await dumpHasTable(t)) && !notCarriedTables.includes(t)) notCarriedTables.push(t);
  }
  if (!(await dumpHasTable("SEOCOMPOTX")) && !notCarriedTables.includes("SEOCOMPOTX")) notCarriedTables.push("SEOCOMPOTX");
  for (const o of claimed.values()) {
    if (o.type === "TABL") {
      for (const [aspect, tables] of coverageAspects) {
        const carried = await dumpHasTable(tables[0]) || (tables[1] !== undefined && await dumpHasTable(tables[1]));
        o.partNotes.push(carried
          ? {part: `${aspect} (${tables.join("/")})`, disposition: "not extracted", reason: `${aspect}: the dump carries ${tables.join("/")} but this converter does not write them`}
          : {part: `${aspect} (${tables.join("/")})`, disposition: "not checked", reason: `the dump carries none of ${tables.join("/")}, so it cannot be told whether this table has ${aspect}`});
      }
      const langs = [...(dd02tLangs.get(o.name) ?? [])].filter((l) => l !== "E").sort();
      if (langs.length > 0) o.partNotes.push({part: "table texts", disposition: "not extracted", reason: `table texts in language${langs.length === 1 ? "" : "s"} ${langs.join(", ")} are not extracted (only the E text is written)`});
    } else if (o.type === "CLAS" || o.type === "INTF") {
      o.partNotes.push({part: "component texts (SEOCOMPOTX)", disposition: "not checked", reason: "the dump carries no SEOCOMPOTX, so it cannot be told whether this object's components (methods, attributes) carry component texts"});
      const langs = [...(seoTxLangs.get(o.name) ?? [])].filter((l) => l !== "E").sort();
      if (langs.length > 0) o.partNotes.push({part: "class texts", disposition: "not extracted", reason: `class texts in language${langs.length === 1 ? "" : "s"} ${langs.join(", ")} are not extracted (only the E text is written)`});
    } else if (o.type === "FUGR") {
      const langs = new Set();
      for (const fm of fmsOfGroup.get(o.name) ?? []) for (const l of tftitLangs.get(key(fm.FUNCNAME)) ?? []) if (l !== "E") langs.add(l);
      if (langs.size > 0) o.partNotes.push({part: "function texts", disposition: "not extracted", reason: `function short texts in language${langs.size === 1 ? "" : "s"} ${[...langs].sort().join(", ")} are not extracted (only the E text is written)`});
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
      if (!owner || !claimed.has(owner.id)) continue;
      owner.text = r.SOURCE ?? "";
      owner.sourceRow = r;
      owner.parts.set("SRC", "");
    }
  }

  // ---- read the source contents, then plan every file before writing any ---
  const stateOf = (o) => {
    const s = o.sc?.state ?? undefined;
    const fileStates = new Set((o.sc?.files ?? []).map((f) => f.state).filter(Boolean));
    if (fileStates.has("I")) return fileStates.has("A") ? "both" : "I";
    return s ?? "A";
  };
  for (const o of claimed.values()) {
    o.partNotes = o.partNotes ?? [];
    const realRoots = [];
    for (const root of allRoots) {
      try {
        realRoots.push(await fs.realpath(root));
      } catch { /* the root vanished mid-run: the read below fails loudly */ }
    }
    for (const [k, file] of o.parts) {
      if (file === "") continue; // a marker (SRC of DDLS/DDLX/SRVD), not a file
      let content;
      try {
        // NOTE-5 (critic round 2): a symlink inside a dump directory is not
        // followed out of it -- a planted dump must not make the converter
        // copy an arbitrary readable file into the repository as "source"
        const real = await fs.realpath(file);
        if (!realRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
          throw new Error("the file resolves outside the dump directory");
        }
        content = await fs.readFile(real, "utf8");
      } catch (e) {
        errors.push({program: k, object: o.name, error: e.message});
        o.partNotes.push({part: `source ${k}`, disposition: "not extracted", reason: `not readable inside the dump directory: ${e.message}`});
        continue;
      }
      o.parts.set(k, content);
    }
  }
  // The group's short text (TLIBT) is not in the dump; abapGit suppresses the
  // empty AREAT, and so do we (fugrXml).
  const areatOf = (o) => o.sc?.areat ?? o.row.AREAT ?? "";
  const ctx = {
    folderOf, trdir, tpoolOf, seoDf, seoTx, fmByInclude, fmRow, fmTexts, signatures, fmsOfGroup, areatOf, errors,
    sourceNameColumn: {DDLS: "DDLNAME", DDLX: "DDLXNAME", SRVD: "SRVDNAME"},
  };
  const plans = new Map(); // uppercased id -> {files, parts} | {skip, parts}
  const ddicTypes = ["TABL", "DTEL", "DOMA", "TTYP", "SHLP", "VIEW"];
  for (const [upperId, o] of [...claimed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const e = o.entry = claims.get(upperId);
    // SHOULD-3: this package lost the folder to another -- per-object
    // refusal in the ledger, the run continues.
    if (losingPackages.has(o.pkg)) {
      e.status = "skipped";
      e.reason = `folder collision: ${o.pkg} and ${winningFolder(o.pkg)} both fold to the folder src/${folderOf(o.pkg)} -- abapGit cannot hold both in one repository; this object is not written`;
      continue;
    }
    // A type this converter cannot write is NEVER dropped silently.
    if (!SUPPORTED_TYPES.has(o.type)) {
      e.status = "unsupported";
      continue;
    }
    // what the sidecar already refused has its own reason
    if (o.sc?.status === "skipped") {
      e.status = "skipped";
      e.reason = o.sc.reason ?? "skipped by the sidecar";
      continue;
    }
    if (o.parts.size + (o.ddic !== undefined ? 1 : 0) + (o.text !== undefined ? 1 : 0) === 0) {
      e.status = "skipped";
      e.reason = ddicTypes.includes(o.type) ? "no dictionary rows in the dump" : "no source in the dump";
      continue;
    }
    const plan = planObjectFiles(o, ctx);
    if (plan.skip) {
      e.status = "skipped";
      e.reason = plan.skip;
      e.parts = plan.parts;
      continue;
    }
    plans.set(upperId, plan);
  }

  // Cross-object collisions (attack 2): two objects planning the SAME repo
  // path refuse each other -- both listed, never last-writer-wins. And the
  // containment backstop: every planned path stays inside <out>/src.
  const srcRoot = path.resolve(out, "src");
  const ownerOf = new Map(); // rel path -> uppercased id
  const colliding = new Set();
  for (const [upperId, plan] of plans) {
    for (const f of plan.files) {
      const abs = path.resolve(out, f.rel);
      if (abs !== srcRoot && !abs.startsWith(`${srcRoot}${path.sep}`)) {
        throw new Error(`internal: planned path escapes the repository: ${f.rel}`);
      }
      if (ownerOf.has(f.rel)) {
        colliding.add(upperId);
        colliding.add(ownerOf.get(f.rel));
      } else {
        ownerOf.set(f.rel, upperId);
      }
    }
  }
  for (const upperId of colliding) {
    const plan = plans.get(upperId);
    plans.delete(upperId);
    const other = plan.files.map((f) => ownerOf.get(f.rel)).find((x) => x !== undefined && x !== upperId);
    const e = claimed.get(upperId).entry;
    e.status = "skipped";
    e.reason = `output path collision with ${other !== undefined ? claimed.get(other).id : "another object"} -- refused, not overwritten`;
    e.parts = plan.parts;
  }

  // ---- write -----------------------------------------------------------------
  for (const [upperId, plan] of plans) {
    const o = claimed.get(upperId);
    // M-5: a plan that would overwrite a kept file refuses its object -- the
    // user's bytes win, the ledger says why nothing was written.
    const blocked = plan.files.find((f) => protectedPaths.has(f.rel));
    if (blocked) {
      const e = o.entry;
      e.status = "skipped";
      e.reason = `not overwritten: ${blocked.rel} is kept (${protectedKeptReason(blocked.rel, keptPaths)}), this object is not written`;
      e.parts = plan.parts;
      continue;
    }
    for (const f of plan.files) {
      const p = path.join(out, f.rel);
      await fs.mkdir(path.dirname(p), {recursive: true});
      await fs.writeFile(p, f.content);
      o.files.push({path: f.rel, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content)});
    }
    const e = o.entry;
    e.files = o.files;
    e.state = stateOf(o);
    e.generated = key(o.row.GENFLAG) === "X";
    // Fix round 4: the two part kinds are split at the entry. `parts` carries
    // what the dump SHOWS exists and this tool did not write ("not
    // extracted") -- the only kind that makes the object written-partial.
    // `unchecked` carries what the dump cannot even tell ("not checked") --
    // the object stays `written` and carries the list; a blind spot is not a
    // loss, and a signal that is always on is no signal.
    e.parts = plan.parts.filter((p) => p.disposition === "not extracted");
    e.unchecked = plan.parts.filter((p) => p.disposition === "not checked");
    e.status = e.parts.length > 0 ? "written-partial" : "written";
  }

  return {
    folderLogic: logic,
    folders: [...folders.entries()].map(([p, f]) => ({package: p, folder: `src/${f}`})),
    keptDotAbapgit,
    ddicTables: {looked: TABLES_READ, notCarried: notCarriedTables},
    entries: ledger.entries,
    unaccounted: ledger.unaccounted(),
    errors,
    emptySources: emptySources.count,
    manifestProvenance: manifest.provenance,
    masterLanguage,
  };
}

// reposrc.jsonl, grouped per program, active version first. One pass keeps
// the whole dump from being held in memory: rows carry only their file path.
async function* repoLists(roots) {
  const groups = new Map();
  for (const root of roots) {
    for await (const r of jsonl(path.join(root, "reposrc.jsonl"))) {
      const p = key(r.program);
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(r);
    }
  }
  for (const list of groups.values()) yield list;
}

const protectedKeptReason = (rel, kept) => {
  const k = kept.find((x) => x.path === rel);
  return k ? k.why : "it is not ours";
};

// abapGit's FULL folder name (zcl_abapgit_folder_logic): lower case, a
// namespace "/" becomes "#", a leading "$" (local packages) is stripped.
export const fullFolderName = (pkg) => pkg.replace(/^\$/, "").toLowerCase().replaceAll("/", "#");
