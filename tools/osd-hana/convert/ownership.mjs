// Which object does a REPOSRC program belong to? ONE resolver for two
// callers that must never disagree (fix round 5):
//
//   the converter -- a source is written only for the object it resolves to;
//   the extract verb's source-level scope audit -- a source the dump fetched
//   that resolves to NO in-scope owner is foreign code sitting in
//   <out>/.osd-hana/dump/src, and the run refuses it (SHOULD-1).
//
// The resolution rules are the converter's measured ones: a flat program or
// interface by exact name; a class's/interface's 30-character '='-padded
// includes by suffix; a function group's main program and includes via
// TFDIR/TLIBG (mainProgram, groupSuffix). `objects` maps "TYPE:NAME" (the
// dump's TADIR ids) to {id, type, ...}; the caller decides what "in scope"
// means by comparing the owner's id.
import {key} from "./xml.mjs";
import {groupFromMain, groupSuffix, mainProgram} from "./program.mjs";

// TFDIR/TLIBG -> the program/group -> owning-object maps the resolver needs.
// Only the group wiring is built here; the per-function maps (fmByInclude,
// fmRow, ...) stay the converter's business.
export function programOwnerMaps({objects, tfdir, tlibg}) {
  const groupByProgram = new Map();
  const groupByName = new Map();
  for (const r of tfdir) {
    const prog = key(r.PNAME_MAIN || r.PNAME);
    const fm = key(r.FUNCNAME);
    const group = groupFromMain(prog);
    if (!group || !fm) continue;
    const owner = objects.get(`FUGR:${group}`);
    if (!owner) continue; // a group outside TADIR has no package; it is not in scope
    groupByName.set(group, owner);
    groupByProgram.set(prog, owner);
  }
  for (const r of tlibg) {
    const group = key(r.AREA);
    const owner = objects.get(`FUGR:${group}`);
    if (owner) {
      groupByName.set(group, owner);
      groupByProgram.set(mainProgram(group), owner);
    }
  }
  return {groupByProgram, groupByName};
}

// The owner of `program`, or null when nothing claims it. Never throws.
export function resolveProgramOwner(program, {objects, groupByProgram, groupByName}) {
  const p = key(program);
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
  return o || null;
}
