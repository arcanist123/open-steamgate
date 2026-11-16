// Planning one object's files (paths + contents) and the part lines for what
// the converter knows it cannot write. Everything is PLANNED before anything
// is written, so an output-path collision can refuse every involved object
// instead of letting the second write win (attack 2), and the ledger entry's
// files/parts are known before the status is chosen.
//
// A plan is `{files: [{rel, content}], parts: [...]}` -- rel is repo-relative
// ("src/<folder>/<stem>.<suffix>") -- or `{skip: reason, parts}` when nothing
// can be written for the object.
import {filename, key, lf, leaf, node, abapgitXmlDoc} from "./xml.mjs";
import {assembleClass, clasXml, intfXml, progXml, includeXml, fugrXml, includePrefix, mainProgram} from "./program.mjs";

// Every program-shaped object: the dump carries no screen/CUA/variant tables
// (verified against the real dump's manifest and table list), so these three
// parts can never be checked -- "not checked", never silently complete
// (critic M4). The converter reports what it FOUND about this in the report.
export function screenParts() {
  const reason = (what, tables) => `the dump carries no ${tables}, so it cannot be told whether this object has ${what}`;
  return [
    {part: "dynpros", disposition: "not checked", reason: reason("dynpros", "screen tables (RPY_DYNPRO/D021T...)")},
    {part: "GUI status", disposition: "not checked", reason: reason("a GUI status", "GUI-status (CUA) tables")},
    {part: "variants", disposition: "not checked", reason: reason("variants", "variant (VARIS) tables")},
  ];
}

const comment = (content) => !content.split("\n").some((line) => line.trim() && !/^\s*\*"\*/.test(line));

// ctx carries the dump-derived lookups (trdir, tpoolOf, seoDf, seoTx,
// fmByInclude, fmRow, fmTexts, signatures, fmsOfGroup, areatOf, errors) and
// folderOf. o.parts holds the INCLUDE CONTENT (already read; unreadable parts
// became part notes in o.partNotes).
export function planObjectFiles(o, ctx) {
  const folder = ctx.folderOf(o.pkg);
  const stem = filename(o.name);
  const files = [];
  const parts = [...(o.partNotes ?? [])];
  const put = (suffix, content) => files.push({rel: `src/${folder}${stem}.${suffix}`, content});

  if (o.type === "CLAS") {
    if (!o.parts.has("CS") && !o.parts.has("CU")) return {skip: "class without CU or CS include", parts};
    const cls = new Map(o.parts);
    put("clas.abap", assembleClass(o.name, cls));
    const code = (s) => cls.has(s) && !comment(cls.get(s));
    if (code("CL") && code("CCIMP")) {
      ctx.errors.push({object: o.name, error: "local classes in both CL and CCIMP includes"});
      // M-4 (critic round 2): the dropped copy is a line, not silence
      parts.push({part: "local classes (CCIMP)", disposition: "not written", reason: "local types exist in both the CL and the CCIMP include -- the CCIMP copy is dropped (abapGit stores one locals block)"});
      cls.delete("CCIMP");
    } else if (code("CL")) cls.set("CCIMP", cls.get("CL"));
    for (const [s, ext] of [["CCDEF", "locals_def"], ["CCIMP", "locals_imp"], ["CCMAC", "macros"], ["CCAU", "testclasses"]]) {
      const content = cls.get(s);
      if (content && !comment(content)) put(`clas.${ext}.abap`, content);
    }
    const t = ctx.tpoolOf(o.name.padEnd(30, "=") + "CP", o.row.MASTERLANG);
    parts.push(...t.notes);
    put("clas.xml", clasXml(o, ctx.seoDf.get(o.name), ctx.seoTx.get(o.name), t.node));
  } else if (o.type === "INTF") {
    if (!o.parts.has("IU")) return {skip: "interface without IU include", parts};
    put("intf.abap", o.parts.get("IU"));
    put("intf.xml", intfXml(o, ctx.seoDf.get(o.name), ctx.seoTx.get(o.name)));
  } else if (o.type === "BDEF") {
    if (!o.parts.has("BD")) return {skip: "behaviour definition without BD include", parts};
    put("bdef.asbdef", lf(o.parts.get("BD")));
    put("bdef.xml", abapgitXmlDoc("LCL_OBJECT_BDEF", [node("BDEF", [leaf("NAME", o.name), leaf("LANGU", o.row.MASTERLANG || "E")])]));
  } else if (o.ddic !== undefined) {
    put(`${o.type.toLowerCase()}.xml`, o.ddic);
  } else if (o.text !== undefined) {
    const ext = {DDLS: "ddls.asddls", DDLX: "ddlx.asddlxs", SRVD: "srvd.srvdsrv"}[o.type];
    put(ext, lf(o.text));
    const tag = {DDLS: "DDLS", DDLX: "DDLX", SRVD: "SRVD"}[o.type];
    const children = [leaf(ctx.sourceNameColumn[o.type], o.name), leaf("LANGU", o.row.MASTERLANG || "E")];
    if (o.type === "DDLS" && key(o.sourceRow.SOURCE_TYPE ?? "") !== "") children.push(leaf("SOURCE_TYPE", key(o.sourceRow.SOURCE_TYPE)));
    put(`${o.type.toLowerCase()}.xml`, abapgitXmlDoc(`LCL_OBJECT_${o.type}`, [node(tag, children)]));
  } else if (o.type === "PROG") {
    const source = o.parts.get(o.name);
    if (source === undefined) return {skip: "program without source", parts};
    put("prog.abap", source);
    const t = ctx.tpoolOf(o.name, o.row.MASTERLANG, {dropEmptyTitle: true});
    parts.push(...t.notes);
    put("prog.xml", progXml(o.name, ctx.trdir.get(o.name), t.node));
    parts.push(...screenParts());
  } else if (o.type === "FUGR") {
    const prefix = includePrefix(o.name);
    const includes = [];
    const functions = [];
    const mainPool = ctx.tpoolOf(mainProgram(o.name), o.row?.MASTERLANG, {dropEmptyTitle: true});
    for (const [prog, source] of [...o.parts].sort(([a], [b]) => a.localeCompare(b))) {
      const suffix = prog.startsWith(prefix) ? prog.slice(prefix.length) : "";
      // abapGit does not store what the function library generates: UXX (the
      // module list), $NN (a module's interface comment), Vnn (a remote
      // module's RFC stub) -- each marked as generated in its source
      if (suffix === "UXX" || /^\$[0-9]{2,3}$/.test(suffix) || (!ctx.fmByInclude.get(`${o.name}:${suffix}`) && /GENERATED BY THE FUNCTION LIBRARY/i.test(String(source).slice(0, 400)))) continue;
      // abapGit also skips the LSVIM* generated maintenance-view includes;
      // it is a real divergence from a byte-copy of the dump, so it is a
      // part line rather than silence (critic N6)
      if (/^LSVIM/i.test(suffix)) {
        parts.push({part: `include ${prog}`, disposition: "not written", reason: "generated maintenance-view include (abapGit does not store it)"});
        continue;
      }
      const fm = ctx.fmByInclude.get(`${o.name}:${suffix}`);
      // abapGit stores each include's and the main program's attributes
      // beside it (PROGDIR, plain <abapGit version="v1.0.0">); a module's
      // file has none
      if (!fm) {
        put(`fugr.${filename(prog)}.abap`, source);
        const t = prog === mainProgram(o.name) ? mainPool : {node: undefined, notes: []};
        parts.push(...t.notes);
        put(`fugr.${filename(prog)}.xml`, includeXml(prog, ctx.trdir.get(prog), t.node));
        includes.push(prog);
      } else {
        const r = ctx.fmRow.get(fm);
        functions.push({name: fm, remote: key(r.FMODE) === "R" ? "R" : "", update: key(r.UTASK), text: ctx.fmTexts.get(fm), params: ctx.signatures.get(fm)});
        put(`fugr.${filename(fm)}.abap`, source);
        // the dump carries no function-documentation table (RSFDO), so this
        // cannot be checked either -- listed, not claimed (critic M4/N-notes)
        parts.push({part: `documentation of ${fm}`, disposition: "not checked", reason: "the dump carries no function-documentation table (RSFDO), so it cannot be told whether this function has documentation"});
      }
    }
    // critic M2: every TFDIR function of an in-scope group whose include has
    // no source in the dump is a part line -- abapGit builds FUNCTIONS from
    // TFDIR and would carry all of them; here the group's XML honestly lists
    // what the dump gave, and the ledger says what it did not.
    for (const r of ctx.fmsOfGroup.get(o.name) ?? []) {
      const inc = key(r.INCLUDE);
      const fm = key(r.FUNCNAME);
      // TFDIR.INCLUDE carries the bare suffix ("01"); the include's PROGRAM
      // is the U-include the function library generates (LZOSG_X4U01) -- the
      // same name fmByInclude is keyed by. Measured on the real bed: the
      // number alone is never a parts key, and comparing against it mourned
      // every function whose include the dump DID carry.
      const incProgram = `${includePrefix(o.name)}U${inc}`;
      if (fm !== "" && inc !== "" && !o.parts.has(incProgram)) {
        parts.push({part: `function ${fm}`, disposition: "not written", reason: `include ${incProgram} has no source in the dump`});
      }
    }
    if (files.length === 0) return {skip: "nothing could be written for this function group", parts};
    parts.push(...screenParts());
    put("fugr.xml", fugrXml({areat: ctx.areatOf(o), includes, functions}));
  } else {
    return {skip: `no writer for type ${o.type}`, parts};
  }
  return {files, parts};
}
