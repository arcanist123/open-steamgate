// Two OData v2 `$metadata` documents, parsed and compared, the difference
// put into classes.
//
//   node tools/odata-metadata-diff.mjs <ours.xml> <theirs.xml> [--accept annotations,order]
//
// tools/osd-metadata-diff.mjs, the first comparison, read names with
// regular expressions and compared sorted lists of them: two documents with
// the same entity names and every property typed differently compared
// equal. This one parses (fast-xml-parser) and compares what a client
// reads off the model, in three classes:
//
//   structure    entity types, complex types, their properties (Name, Type,
//                Nullable, MaxLength, Precision, Scale and every other
//                attribute that is not sap:*), keys, navigation properties,
//                associations with their ends and referential constraints,
//                the document versions (edmx:Edmx Version, DataServiceVersion),
//                entity sets, association sets, function imports with their
//                parameters, and the schema namespace itself
//   annotations  every sap:* attribute on any of those elements (label,
//                creatable/updatable/deletable, filterable, sortable,
//                addressable, display-format, ...), and vocabulary
//                <Annotations> blocks, compared per Target
//   order        the same members in another order: types in a schema,
//                properties in a type, sets in the container, parameters
//
// Exit 0 when nothing differs or only classes named in --accept differ, 1
// otherwise, 2 on a usage or parse error. Every difference is printed in
// every case, accepted or not: an accepted class is counted, never hidden.
//
// One normalisation, and it is reported: a reference written as
// `<schema namespace>.<Name>` (EntitySet EntityType=, Relationship=,
// Association End Type=, ReturnType=) is compared by `<Name>` when the
// namespace is that document's own schema namespace. A schema namespace
// that differs is itself a structure difference, listed once -- otherwise
// one differing namespace would repeat on every set and association and
// bury everything else.
import {readFileSync} from "node:fs";
import {XMLParser, XMLValidator} from "fast-xml-parser";
import {runsAs} from "./osd-main.mjs";

export const CLASSES = ["structure", "annotations", "order"];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  attributesGroupName: "@",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // every element is a list, so the order of same-named siblings survives
  // and a single child reads like many
  isArray: (_name, _jpath, _isLeaf, isAttribute) => isAttribute !== true,
});

const local = (name) => String(name).replace(/^[^:]*:/, "");

/** the children of `node` whose local name is `name`, in document order */
function kids(node, name) {
  if (node === undefined || node === null || typeof node !== "object") return [];
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "@" || key === "#text") continue;
    if (local(key) === name) out.push(...(Array.isArray(value) ? value : [value]));
  }
  return out;
}

const attrs = (node) => (node && typeof node === "object" && node["@"]) || {};

// the third normalisation, reported: SAP's boolean annotations whose default
// is "true" -- a system writes them only when false (measured on the SEGW
// sample's $metadata); absent reads as "true" on the elements that carry one
export const SAP_TRUE_BY_DEFAULT = ["sap:creatable", "sap:updatable", "sap:deletable", "sap:sortable", "sap:filterable", "sap:pageable", "sap:unicode"];
const SAP_DEFAULT_CARRIERS = new Set(["Property", "EntitySet", "AssociationSet"]);
let sapDefaults = 0;

/** sap:* attributes apart from the rest: the first are annotations, the
 *  second structure */
function split(node, tag = undefined) {
  const structure = {};
  const annotations = {};
  for (const [key, value] of Object.entries(attrs(node))) {
    if (key.startsWith("xmlns")) continue;
    if (key.startsWith("sap:")) annotations[key] = value;
    else structure[key] = value;
  }
  if (SAP_DEFAULT_CARRIERS.has(tag)) {
    for (const key of SAP_TRUE_BY_DEFAULT) {
      if (annotations[key] !== undefined) continue;
      annotations[key] = "true";
      sapDefaults += 1;
    }
  }
  return {structure, annotations};
}

/** Parse one document into the comparable model. Throws on XML that does
 *  not parse, or on a document that is not an EDMX with DataServices. */
export function model(xml) {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new Error(`not well-formed XML: ${valid.err?.msg ?? "invalid"} (line ${valid.err?.line ?? "?"})`);
  }
  const doc = parser.parse(xml);
  const edmx = kids(doc, "Edmx")[0];
  const services = kids(edmx, "DataServices")[0];
  if (services === undefined) throw new Error("no edmx:Edmx/edmx:DataServices element");
  const schemas = kids(services, "Schema");
  const namespaces = schemas.map((s) => attrs(s).Namespace ?? "");
  const own = new Set(namespaces.filter((n) => n !== ""));
  const ref = (value) => {
    if (typeof value !== "string") return value;
    const dot = value.lastIndexOf(".");
    if (dot < 0) return value;
    const ns = value.slice(0, dot);
    return own.has(ns) ? value.slice(dot + 1) : value;
  };
  const refAttrs = new Set(["EntityType", "Relationship", "Type", "ReturnType", "Association", "BaseType"]);
  const norm = (record) => {
    const out = {};
    for (const [k, v] of Object.entries(record)) out[k] = refAttrs.has(k) ? ref(v) : v;
    return out;
  };
  const element = (node, tag) => {
    const {structure, annotations} = split(node, tag);
    return {structure: norm(structure), annotations};
  };
  // the second normalisation, reported too: CSDL's default for Nullable is
  // true, and a system writes the attribute only when it is false -- an
  // absent Nullable on a Property or Parameter reads as "true"
  let nullableDefaults = 0;
  sapDefaults = 0;
  const members = (node, name, key = "Name") => kids(node, name).map((child) => {
    const one = {name: attrs(child)[key] ?? "", ...element(child, name), node: child};
    if ((name === "Property" || name === "Parameter") && one.structure.Nullable === undefined) {
      one.structure.Nullable = "true";
      nullableDefaults += 1;
    }
    return one;
  });

  const types = [];
  const associations = [];
  const containers = [];
  const vocab = [];
  for (const schema of schemas) {
    for (const kind of ["EntityType", "ComplexType"]) {
      for (const type of members(schema, kind)) {
        types.push({
          kind,
          name: type.name,
          structure: type.structure,
          annotations: type.annotations,
          keys: kids(kids(type.node, "Key")[0], "PropertyRef").map((p) => attrs(p).Name ?? ""),
          properties: members(type.node, "Property"),
          navigation: members(type.node, "NavigationProperty"),
        });
      }
    }
    for (const assoc of members(schema, "Association")) {
      const constraint = kids(assoc.node, "ReferentialConstraint")[0];
      const side = (which) => {
        const s = kids(constraint, which)[0];
        return s === undefined ? undefined
          : {role: attrs(s).Role ?? "", refs: kids(s, "PropertyRef").map((p) => attrs(p).Name ?? "")};
      };
      associations.push({
        name: assoc.name,
        structure: assoc.structure,
        annotations: assoc.annotations,
        ends: members(assoc.node, "End", "Role"),
        constraint: constraint === undefined ? undefined : {principal: side("Principal"), dependent: side("Dependent")},
      });
    }
    for (const container of members(schema, "EntityContainer")) {
      containers.push({
        name: container.name,
        structure: container.structure,
        annotations: container.annotations,
        sets: members(container.node, "EntitySet"),
        associationSets: members(container.node, "AssociationSet").map((set) => ({
          ...set, ends: members(set.node, "End", "Role"),
        })),
        functionImports: members(container.node, "FunctionImport").map((fi) => ({
          ...fi, parameters: members(fi.node, "Parameter"),
        })),
      });
    }
    for (const block of kids(schema, "Annotations")) {
      // canonical: the target and the parsed content, attribute order and
      // whitespace gone; vocabulary blocks are annotations by definition
      vocab.push({target: ref(attrs(block).Target ?? ""), content: JSON.stringify(canonical(block))});
    }
  }
  // the versions a client branches on: edmx:Edmx/@Version and the
  // DataServices' (Max)DataServiceVersion, by local name whatever the prefix
  const versions = {"Edmx Version": attrs(edmx).Version};
  for (const [key, value] of Object.entries(attrs(services))) {
    const name = local(key);
    if (name === "DataServiceVersion" || name === "MaxDataServiceVersion") versions[`DataServices ${name}`] = value;
  }
  return {namespaces, versions, types, associations, containers, vocab, nullableDefaults, sapDefaults};
}

function canonical(node) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(canonical);
  const out = {};
  for (const key of Object.keys(node).sort()) out[key] = canonical(node[key]);
  return out;
}

/** compare two lists of named members: what is only on one side, what
 *  differs in a member, and whether the shared members come in another
 *  order. `inner` compares two members of the same name further. */
function members2(diff, where, what, ours, theirs, inner) {
  const a = new Map(ours.map((m) => [m.name, m]));
  const b = new Map(theirs.map((m) => [m.name, m]));
  for (const m of ours) if (!b.has(m.name)) diff("structure", where, `${what} ${m.name}: only ours`);
  for (const m of theirs) if (!a.has(m.name)) diff("structure", where, `${what} ${m.name}: only theirs`);
  for (const m of ours) {
    const other = b.get(m.name);
    if (other === undefined) continue;
    const at = `${where} ${what} ${m.name}`;
    record(diff, "structure", at, m.structure, other.structure);
    record(diff, "annotations", at, m.annotations, other.annotations);
    inner?.(at, m, other);
  }
  const sharedA = ours.map((m) => m.name).filter((n) => b.has(n));
  const sharedB = theirs.map((m) => m.name).filter((n) => a.has(n));
  if (sharedA.join("\u0000") !== sharedB.join("\u0000")) {
    diff("order", where, `${what} order: ours ${sharedA.join(", ")}; theirs ${sharedB.join(", ")}`);
  }
}

/** attribute by attribute */
function record(diff, cls, at, ours, theirs) {
  const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort();
  for (const key of keys) {
    if (key === "Name") continue;
    const x = ours[key];
    const y = theirs[key];
    if (x === y) continue;
    diff(cls, at, `${key}: ours ${x === undefined ? "(absent)" : JSON.stringify(x)}, theirs ${y === undefined ? "(absent)" : JSON.stringify(y)}`);
  }
}

/** The classed difference of two documents' text. */
export function compare(oursXml, theirsXml) {
  const ours = model(oursXml);
  const theirs = model(theirsXml);
  const differences = [];
  const diff = (cls, where, text) => differences.push({class: cls, where: where.trim(), text});
  for (const key of [...new Set([...Object.keys(ours.versions), ...Object.keys(theirs.versions)])].sort()) {
    const [where, attr] = key.split(" ");
    const x = ours.versions[key];
    const y = theirs.versions[key];
    if (x !== y) diff("structure", where, `${attr}: ours ${x === undefined ? "(absent)" : JSON.stringify(x)}, theirs ${y === undefined ? "(absent)" : JSON.stringify(y)}`);
  }
  if (ours.namespaces.join(",") !== theirs.namespaces.join(",")) {
    diff("structure", "Schema", `Namespace: ours ${ours.namespaces.join(",")}, theirs ${theirs.namespaces.join(",")}`);
  }
  members2(diff, "", "Type", ours.types, theirs.types, (at, a, b) => {
    if (a.kind !== b.kind) diff("structure", at, `kind: ours ${a.kind}, theirs ${b.kind}`);
    if (a.keys.join(",") !== b.keys.join(",")) {
      const sameSet = [...a.keys].sort().join(",") === [...b.keys].sort().join(",");
      diff(sameSet ? "order" : "structure", at, `Key: ours ${a.keys.join(",")}, theirs ${b.keys.join(",")}`);
    }
    members2(diff, at, "Property", a.properties, b.properties);
    members2(diff, at, "NavigationProperty", a.navigation, b.navigation);
  });
  members2(diff, "", "Association", ours.associations, theirs.associations, (at, a, b) => {
    members2(diff, at, "End", a.ends, b.ends);
    const show = (c) => c === undefined ? "(none)"
      : `${c.principal?.role}(${c.principal?.refs.join(",")}) -> ${c.dependent?.role}(${c.dependent?.refs.join(",")})`;
    if (show(a.constraint) !== show(b.constraint)) {
      diff("structure", at, `ReferentialConstraint: ours ${show(a.constraint)}, theirs ${show(b.constraint)}`);
    }
  });
  // one container on each side is the same container whatever its name (the
  // name carries the schema namespace): a differing name is one finding,
  // and the sets inside are still compared rather than hidden behind it
  let theirContainers = theirs.containers;
  if (ours.containers.length === 1 && theirs.containers.length === 1 && ours.containers[0].name !== theirs.containers[0].name) {
    diff("structure", "EntityContainer", `Name: ours ${ours.containers[0].name}, theirs ${theirs.containers[0].name}`);
    theirContainers = [{...theirs.containers[0], name: ours.containers[0].name}];
  }
  members2(diff, "", "EntityContainer", ours.containers, theirContainers, (at, a, b) => {
    members2(diff, at, "EntitySet", a.sets, b.sets);
    members2(diff, at, "AssociationSet", a.associationSets, b.associationSets, (at2, x, y) => {
      members2(diff, at2, "End", x.ends, y.ends);
    });
    members2(diff, at, "FunctionImport", a.functionImports, b.functionImports, (at2, x, y) => {
      members2(diff, at2, "Parameter", x.parameters, y.parameters);
    });
  });
  const blocks = (m) => {
    const out = new Map();
    for (const v of m.vocab) out.set(v.target, [...(out.get(v.target) ?? []), v.content]);
    return out;
  };
  const va = blocks(ours);
  const vb = blocks(theirs);
  for (const target of [...new Set([...va.keys(), ...vb.keys()])].sort()) {
    const x = (va.get(target) ?? []).sort().join("\n");
    const y = (vb.get(target) ?? []).sort().join("\n");
    if (x === y) continue;
    diff("annotations", "Annotations", `Target ${target}: ${!va.has(target) ? "only theirs" : !vb.has(target) ? "only ours" : "content differs"}`);
  }
  const counts = Object.fromEntries(CLASSES.map((c) => [c, differences.filter((d) => d.class === c).length]));
  return {differences, counts, normalised: {nullableDefaults: {ours: ours.nullableDefaults, theirs: theirs.nullableDefaults}, sapDefaults: {ours: ours.sapDefaults, theirs: theirs.sapDefaults}}};
}

/** the verdict: ok when every class that differs is accepted */
export function verdict(result, accept = []) {
  const refused = CLASSES.filter((c) => result.counts[c] > 0 && !accept.includes(c));
  return {ok: refused.length === 0, refused};
}

export function parseAccept(value) {
  if (value === undefined || value === "") return [];
  const list = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const unknown = list.filter((c) => !CLASSES.includes(c));
  if (unknown.length > 0) throw new Error(`--accept: unknown class ${unknown.join(", ")} (known: ${CLASSES.join(", ")})`);
  return list;
}

if (runsAs("odata-metadata-diff.mjs")) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--accept");
  const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--accept");
  let accept;
  try {
    accept = parseAccept(at < 0 ? undefined : argv[at + 1]);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (files.length !== 2) {
    console.error("usage: odata-metadata-diff.mjs <ours.xml> <theirs.xml> [--accept annotations,order]");
    process.exit(2);
  }
  let result;
  try {
    result = compare(readFileSync(files[0], "utf8"), readFileSync(files[1], "utf8"));
  } catch (e) {
    console.error(`odata-metadata-diff: ${e.message}`);
    process.exit(2);
  }
  for (const cls of CLASSES) {
    const list = result.differences.filter((d) => d.class === cls);
    if (list.length === 0) continue;
    console.log(`${cls}${accept.includes(cls) ? " (accepted)" : ""}: ${list.length}`);
    for (const d of list) console.log(`  ${d.where ? d.where + ": " : ""}${d.text}`);
  }
  const nd = result.normalised.nullableDefaults;
  if (nd.ours + nd.theirs > 0) console.log(`normalised: Nullable absent read as "true" (the CSDL default) -- ours ${nd.ours}, theirs ${nd.theirs}`);
  const sd = result.normalised.sapDefaults;
  if (sd.ours + sd.theirs > 0) console.log(`normalised: ${SAP_TRUE_BY_DEFAULT.join("/")} absent read as "true" (SAP's default) -- ours ${sd.ours}, theirs ${sd.theirs}`);
  const v = verdict(result, accept);
  console.log(`odata-metadata-diff: ${CLASSES.map((c) => `${c} ${result.counts[c]}`).join(", ")}; ${v.ok ? "OK" : `differs in ${v.refused.join(", ")}`}`);
  process.exit(v.ok ? 0 : 1);
}
