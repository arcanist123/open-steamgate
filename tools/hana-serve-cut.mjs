// --cut-members-typed-by: a kept class keeps its place in the build without
// the library some of its members are typed by (docs/hana-serve-icf.md,
// "Members typed by a library the route does not run").
//
// The serve scope (tools/hana-serve-scope.mjs) keeps every object a kept
// object names. A class that serves a route can also carry members for a
// feature the route never runs -- attributes typed by another package's
// classes, methods that call into it -- and then that whole package and its
// closure come along, and the part that does not load is where the build
// breaks. Naming the package (`--cut-members-typed-by <PACKAGE>`, repeatable)
// stops the walk at the edge: a name a kept object outside the package gives
// to an object inside it is not followed, and when nothing else keeps the
// object (a root, or another kept object of that package), the members that
// name it are cut. Not an application's rule: the package is named on the
// command line, never guessed.
//
// What a cut does to the kept class, through abaplint's parser:
//   - an attribute `DATA x TYPE REF TO <gone>` (or CLASS-DATA) becomes
//     `TYPE REF TO object`: CLEAR, IS BOUND and IS INITIAL still compile and
//     still mean what they meant;
//   - a method whose body names a gone object, or calls through such an
//     attribute (`x->`), gets the stub body of the closure's lazy activation:
//     RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = '<the
//     gone names>'. Loud: calling it raises with the names, and hana-serve's
//     stub hook records the raise (tools/hana-host-guard.mjs);
//   - anything else in the definition part that names a gone object (a
//     parameter, a type, INHERITING FROM, INTERFACES) is refused by name:
//     the cut does not guess what a signature without its type would mean.
//
// The rewritten files go into one more island folder, OVERLAY below, which
// sorts after every closure layer, so the later layer wins the name the way
// it does everywhere in the build (abap_transpile.json, `gen/hana-src/*`)
// and `node tools/osd-inputs.mjs` lists the override. The closure's own
// layers stay exactly as the walk wrote them; `--clear` removes the overlay
// with the record.
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import * as abaplint from "@abaplint/core";
import {applyStubs, methodBlocks} from "./hana-closure-stubs.mjs";

export const OVERLAY_NAME = "999-serve-scope";
export const OVERLAY = join("gen", "hana-src", OVERLAY_NAME);

/** folder name -> package, from the island's manifest.json (the closure
 *  writes it: layers[].name and .package, folders are "<order>-<name>") */
export function islandPackages(root) {
  const file = join(root, "gen", "hana-src", "manifest.json");
  if (existsSync(file) === false) throw new Error(`hana-serve-scope: --cut-members-typed-by needs ${file}, the closure's record of which folder holds which package`);
  const out = new Map();
  for (const layer of JSON.parse(readFileSync(file, "utf8")).layers ?? []) {
    if (layer?.name === undefined || layer?.package === undefined) continue;
    out.set(`${String(layer.order).padStart(3, "0")}-${layer.name}`, String(layer.package).toUpperCase());
  }
  return out;
}

/** an island object's package: the folder of its first file */
export function packageOfObject(root) {
  const packages = islandPackages(root);
  return (one) => {
    const folder = String(one.files?.[0] ?? "").split("/")[2];
    return packages.get(folder);
  };
}

const bare = (token) => String(token).toUpperCase().replace(/\($/, "");

/** the cut of one class file. `gone` are the object names that stay out.
 *  Pure: {source, attributes: [{name, type}], stubbed: [{method, missing}]};
 *  throws, naming the statement, when the definition part names a gone
 *  object any other way than as an attribute's reference type. */
export function cutMembers(source, filename, gone) {
  const goneSet = new Set(gone.map((n) => String(n).toUpperCase()));
  const reg = new abaplint.Registry().addFile(new abaplint.MemoryFile(filename, source)).parse();
  const blocks = methodBlocks(source, filename);
  const inBody = (row) => blocks.some((b) => row > b.headerEnd.row && row < b.endStart.row);
  const lines = source.split("\n");
  const attributes = [];
  const edits = [];
  const statements = (reg.getFirstObject()?.getABAPFiles() ?? []).flatMap((f) => f.getStatements());
  // the definition part first: attributes are retyped, anything else refused
  for (const st of statements) {
    const tokens = st.getTokens();
    if (inBody(tokens[0]?.getStart().getRow() ?? 0)) continue;
    const named = tokens.filter((t) => goneSet.has(bare(t.getStr())));
    if (named.length === 0) continue;
    const kind = st.get().constructor.name;
    const up = tokens.map((t) => t.getStr().toUpperCase());
    const at = up.indexOf("TYPE");
    const isRef = at > 0 && up[at + 1] === "REF" && up[at + 2] === "TO" && tokens.length >= at + 4 && goneSet.has(bare(up[at + 3]));
    if ((kind === "Data" || kind === "ClassData") && isRef && named.length === 1) {
      const t = tokens[at + 3];
      edits.push({row: t.getStart().getRow(), col: t.getStart().getCol(), length: t.getStr().length, text: "object"});
      // DATA x ... / CLASS-DATA x ... (CLASS, -, DATA are three tokens)
      attributes.push({name: up[up.indexOf("DATA") + 1], type: bare(up[at + 3])});
      continue;
    }
    throw new Error(`hana-serve-scope: ${filename}:${tokens[0].getStart().getRow()}: ${kind} names ${named.map((t) => bare(t.getStr())).join(", ")}, `
      + "which --cut-members-typed-by leaves out, in a way it does not cut (only an attribute TYPE REF TO the object is retyped)");
  }
  const cutAttributes = new Set(attributes.map((a) => a.name));
  const typeOf = new Map(attributes.map((a) => [a.name, a.type]));
  // then the bodies: a method that names a gone object, or calls through a
  // retyped attribute, is stubbed
  const stubs = [];
  for (const block of blocks) {
    const missing = [];
    const add = (name) => { if (missing.includes(name) === false) missing.push(name); };
    for (const st of statements) {
      const row = st.getStart().getRow();
      if (row <= block.headerEnd.row || row >= block.endStart.row) continue;
      const tokens = st.getTokens();
      for (let i = 0; i < tokens.length; i++) {
        const name = bare(tokens[i].getStr());
        if (goneSet.has(name)) add(name);
        else if (cutAttributes.has(name) && tokens[i + 1]?.getStr() === "->") add(typeOf.get(name));
      }
    }
    if (missing.length > 0) stubs.push({...block, missing, reason: ""});
  }
  // the attribute edits are on definition rows, which a body stub never
  // touches: apply them first, column offsets unchanged by the stubs
  const retyped = lines.slice();
  for (const e of [...edits].sort((a, b) => b.row - a.row || b.col - a.col)) {
    const line = retyped[e.row - 1];
    retyped[e.row - 1] = line.slice(0, e.col - 1) + e.text + line.slice(e.col - 1 + e.length);
  }
  const out = applyStubs(retyped.join("\n"), stubs);
  return {source: out, attributes, stubbed: stubs.map((s) => ({method: s.method, missing: s.missing}))};
}

/** write the overlay for the scope's member cuts; returns the record. `read`
 *  reads a root-relative file. An object's XML goes along unchanged. */
export function writeOverlay(root, memberCuts, read) {
  clearOverlay(root);
  if (memberCuts.length === 0) return [];
  const src = join(root, OVERLAY, "src");
  mkdirSync(src, {recursive: true});
  writeFileSync(join(root, OVERLAY, ".abapgit.xml"), [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<asx:abap xmlns:asx=\"http://www.sap.com/abapxml\" version=\"1.0\">",
    " <asx:values>",
    "  <DATA><MASTER_LANGUAGE>E</MASTER_LANGUAGE><STARTING_FOLDER>/src/</STARTING_FOLDER><FOLDER_LOGIC>PREFIX</FOLDER_LOGIC></DATA>",
    " </asx:values>",
    "</asx:abap>", ""].join("\n"));
  const record = [];
  for (const one of memberCuts) {
    if (one.object.startsWith("CLAS ") === false) {
      throw new Error(`hana-serve-scope: ${one.object} names ${one.gone.join(", ")}, which --cut-members-typed-by leaves out; only a class's members are cut`);
    }
    const entry = {object: one.object, gone: one.gone, attributes: [], stubbed: [], files: []};
    for (const file of one.files) {
      const target = join(src, basename(file));
      if (file.endsWith(".abap")) {
        const done = cutMembers(read(file), basename(file), one.gone);
        writeFileSync(target, done.source);
        entry.attributes.push(...done.attributes);
        entry.stubbed.push(...done.stubbed);
      } else {
        copyFileSync(join(root, file), target);
      }
      entry.files.push(`${OVERLAY.split("\\").join("/")}/src/${basename(file)}`);
    }
    record.push(entry);
  }
  return record;
}

export function clearOverlay(root) {
  rmSync(join(root, OVERLAY), {recursive: true, force: true});
}
