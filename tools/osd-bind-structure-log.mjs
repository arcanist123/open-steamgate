// bind_structure, made loud (H5x-4 B3).
//
// `/iwbep/if_mgw_odata_entity_typ~bind_structure` in the model API
// (open-abap-odata, zcl_oao_entity_typ) describes the structure by name
// and RETURNS SILENTLY when the type is not found; the complex type's
// version stores the name and looks nothing up. On a system the Gateway
// derives display formats, lengths and conversions from that structure, so
// a type that is not found here is a wrong $metadata with no error at all.
//
// The library is a lib of this build, cloned from upstream, so the
// observation sits beside it rather than in it: each bind_structure of the
// two model classes is wrapped, the original runs unchanged (found or not,
// it does exactly what it did), and the name is resolved once more with the
// same CL_ABAP_TYPEDESCR=>DESCRIBE_BY_NAME the entity type calls. "Not
// found" is the entity type's own condition: the type is unknown, or it is
// not a structure. The log keeps every distinct name, so a host can say
// "bind_structure: N of M not found: <names>" after a $metadata
// (tools/hana-serve.mjs does).
//
// The fix that belongs upstream -- the model API raising or recording the
// miss itself -- is open-abap-odata's to take; this module goes when it has.

/** the two methods, by class, as the transpiler names them */
export const BIND_METHODS = [
  ["ZCL_OAO_ENTITY_TYP", "$iwbep$if_mgw_odata_entity_typ$bind_structure"],
  ["ZCL_OAO_CMPLX_TYPE", "$iwbep$if_mgw_odata_cmplx_type$bind_structure"],
];

const text = (value) => String(value?.get?.() ?? value ?? "").trim().toUpperCase();

/** Is `name` a structure the runtime can describe? The same call the model
 *  API makes; a classic exception (TYPE_NOT_FOUND) is "no". */
export async function describesStructure(abap, name) {
  const descr = abap.Classes?.CL_ABAP_TYPEDESCR;
  if (descr === undefined) return {found: false, why: "no CL_ABAP_TYPEDESCR in this runtime"};
  let ref;
  try {
    ref = await descr.describe_by_name({p_name: new abap.types.String().set(name)});
  } catch (e) {
    if (e?.classic !== undefined) return {found: false, why: String(e.classic).toLowerCase()};
    return {found: false, why: e?.message ?? String(e)};
  }
  const object = ref?.get?.() ?? ref;
  if (object === undefined || object === null) return {found: false, why: "not bound"};
  const kind = text(object.kind);
  if (kind !== "S") return {found: false, why: `kind ${kind || "?"}, not a structure`};
  return {found: true};
}

/** Wrap the bind_structure methods of `abap`'s model classes; idempotent.
 *  Returns the log: `entries` (distinct names with their verdict),
 *  `summary()` and `line()`. */
export function installBindStructureLog(abap, {methods = BIND_METHODS} = {}) {
  if (abap.__bindStructureLog !== undefined) return abap.__bindStructureLog;
  const entries = new Map();
  let calls = 0;
  const installed = [];
  for (const [className, method] of methods) {
    const cls = abap.Classes?.[className];
    const original = cls?.prototype?.[method];
    if (typeof original !== "function") continue;
    cls.prototype[method] = async function (INPUT) {
      const answer = await original.call(this, INPUT);
      calls += 1;
      // looked up as given, the way the model API looks it up; logged upper
      const given = String(INPUT?.iv_structure_name?.get?.() ?? INPUT?.iv_structure_name ?? "").trim();
      const name = given.toUpperCase();
      if (!entries.has(name)) {
        entries.set(name, {name, owner: className, ...(await describesStructure(abap, given))});
      }
      return answer;
    };
    installed.push(className);
  }
  const log = {
    installed,
    get calls() { return calls; },
    entries: () => [...entries.values()],
    summary() {
      const all = [...entries.values()];
      const missing = all.filter((e) => e.found !== true);
      return {total: all.length, notFound: missing.length, missing};
    },
    line() {
      const s = log.summary();
      return `bind_structure: ${s.notFound} of ${s.total} not found` +
        (s.notFound > 0 ? `: ${s.missing.map((e) => `${e.name} (${e.why})`).join(", ")}` : "");
    },
  };
  Object.defineProperty(abap, "__bindStructureLog", {value: log, configurable: true});
  return log;
}
