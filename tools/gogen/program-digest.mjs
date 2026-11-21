// What an osgo generation names: the program itself, by content, and the
// database statements it boots from -- never the text it was emitted into.
//
// The generation used to be the sha256 of the unlayered emission (osgo.mjs
// emitted the whole single-package text a second time just to hash it, 3.6 s
// of every build, layered or not). The emitter reads the program through a
// known set of fields; digesting those, canonically, names the same thing
// (same program -> same generation) without emitting anything, and does not
// depend on how the classes were packaged (docs/osgo-fast-rebuild.md, "The
// incremental front end"). The canonical walk is by value: two builds of the
// same program share no IR objects (one lowered everything, one took most of
// it from a cache), so identity and sharing carry no meaning here.
//
// The same parts answer a second question (osgo.mjs): whether a generated
// Go package's emission can be left as it is. A package's text is a pure
// function of the tier assignment, the IRs of the classes it holds, and the
// program-level facts every package embeds (the table registry, RTTI names,
// the dynamic-call adapters, ownership); `parts` splits the digest so those
// can be compared per package.
//
// The emitter's reads (emit-go.mjs, checked by test): classes, structs,
// consts, interfaceMethods, interfaceAttrs, events, tables, dynStatics,
// dynamicDispatch, ddicOutputLen, ddicNames, exceptionSupers, rtti,
// amcChannels, ownershipSafety (through analyzeOwnership), and the component
// interfaces of every interface used as a reference type.
import {createHash} from "node:crypto";

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** the canonical text of a lowered value: by value, sorted object keys,
 *  collections in their iteration order (which the program's construction
 *  fixes); a depth guard only -- lowered values are acyclic */
function canon(value, depth = 0) {
  if (value === null || ["undefined", "string", "number", "boolean"].includes(typeof value)) return [typeof value, String(value)];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (depth > 1000) return ["deep", ""];
  if (Array.isArray(value)) return ["a", value.map((v) => canon(v, depth + 1))];
  if (value instanceof Map) return ["m", [...value].map(([k, v]) => [canon(k, depth + 1), canon(v, depth + 1)])];
  if (value instanceof Set) return ["s", [...value].map((v) => canon(v, depth + 1))];
  return ["o", Object.keys(value).sort().map((k) => [k, canon(value[k], depth + 1)])];
}

const digests = new WeakMap();
/** the digest of one value, memoised per object (a class IR is asked once) */
export function valueDigest(value) {
  const key = typeof value === "object" && value !== null ? value : undefined;
  if (key !== undefined && digests.has(key)) return digests.get(key);
  const d = sha(JSON.stringify(canon(value)));
  if (key !== undefined) digests.set(key, d);
  return d;
}

/**
 * The digest parts of a program: one digest per class (in program order) and
 * one for every program-level fact the emitter reads.
 * @param {import("./frontend-types.ts").FrontendProgram} program the front end's program
 * @param {{componentInterfaces: (reg: object, name: string) => string[]}} io
 *   componentInterfaces as emit-go.mjs spells it (the one registry read)
 */
export function programParts(program, {componentInterfaces}) {
  const sorted = (entries) => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const globals = {
    tables: (program.tables ?? []).map(valueDigest),
    ddicNames: program.ddicNames ?? [],
    ddicOutputLen: sorted([...(program.ddicOutputLen ?? [])]),
    rtti: program.rtti ? {structs: [...program.rtti.structs].map(([k, v]) => [k, valueDigest(v)]),
      known: [...program.rtti.known].sort(), classSupers: [...program.rtti.classSupers]} : null,
    dynStatics: [...(program.dynStatics ?? [])].sort(),
    dynamicDispatch: (program.dynamicDispatch ?? []).map(valueDigest),
    exceptionSupers: sorted(Object.entries(program.exceptionSupers ?? {})),
    ownershipSafety: [...(program.ownershipSafety ?? [])].map(([k, v]) => [k, [...v.names].sort(), v.dynamic]),
    missing: [...(program.missing ?? [])].sort(),
    amcChannels: (program.amcChannels ?? []).map(valueDigest),
    structs: [...program.structs].map(([k, v]) => [k, valueDigest(v)]),
    consts: [...program.consts].map(([k, v]) => [k, valueDigest(v)]),
    interfaceMethods: [...(program.interfaceMethods ?? [])].map(([k, sigs]) => [k, sigs.map(valueDigest)]),
    interfaceAttrs: [...(program.interfaceAttrs ?? [])].map(([k, v]) => [k, valueDigest(v)]),
    events: [...(program.events ?? [])].map(([k, v]) => [k, valueDigest(v)]),
    interfaces: [...(program.interfaces ?? [])].sort().map((i) => [i, componentInterfaces(program.reg, i)]),
  };
  return {classes: program.classes.map((c) => [c.name, valueDigest(c)]), globals: valueDigest(globals)};
}

/** the content digest of a whole program */
export function programDigest(program, io) {
  return valueDigest({schema: "osgo-program-digest/1", ...(programParts(program, io))});
}
