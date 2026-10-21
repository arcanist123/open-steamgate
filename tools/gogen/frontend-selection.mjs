// @ts-check
// Shared cold/replay selection preparation. Only current registry answers count.
import {abaplint} from "./frontend-base.mjs";
import {syntaxDiagnostics} from "./frontend-diagnostics.ts";
import {indexFrozenSelection, selectionHas} from "./frontend-queries.mjs";
import {expandProgramSelection, withRole, enumerateObjects} from "./frontend-provenance.mjs";

/** @param {string} fn @returns {string} */
// @ts-expect-error -- abapiti form pending
const objectName = fn => fn.split("/").pop().split(".")[0].toLowerCase().replaceAll("#", "/");
/** @param {import("./frontend-session-types.ts").Registry} reg @param {string[]} objects @param {import("./frontend-diagnostics.ts").DiagnosticsSession | null} [session] */
export function selectionDiagnostics(reg, objects, session) {
  const wanted = objects.map(o => o.toLowerCase().replaceAll("#", "/"));
  // Dynamic RAISE validates its actual object at lowering; retain every other
  // parser/syntax refusal, including those in a changed owner's attached files.
  return syntaxDiagnostics(reg, fn => selectionHas(wanted, objectName(fn)), objectName, session)
    .filter(d => !d.message.endsWith("RAISE EXCEPTION, must be object reference, got GenericObjectReferenceType"));
}
/** @param {import("./frontend-session-types.ts").Registry} reg @param {Pick<import("./frontend-session-types.ts").CompileOptions, "objects" | "tolerant" | "strictRoots">} options @param {import("./frontend-diagnostics.ts").DiagnosticsSession | null} [session] @param {() => void} [prepare] @param {import("./frontend-session-types.ts").PreparedSelection} [prepared] @returns {import("./frontend-session-types.ts").PreparedSelection} */
export function prepareSelection(reg, {objects, tolerant = false, strictRoots}, session, prepare, prepared) {
  if (prepared) { prepare?.(); return prepared; }
  let wanted = objects.map(o => o.toLowerCase().replaceAll("#", "/"));
  const diagnostics = selectionDiagnostics(reg, wanted, session);
  prepare?.();
  if (diagnostics.length && (!tolerant || diagnostics.some(d => strictRoots?.has(d.object.toUpperCase())))) throw new Error(diagnostics.map((d) => d.message).join("\n"));
  const broken = new Set(diagnostics.map((d) => d.object.toLowerCase()));
  if (broken.size > 0) wanted = wanted.filter((w) => !broken.has(w));

  // A literal CALL FUNCTION is a dependency on its function group. The
  // registry already knows each module's group; include it before signatures
  // are built, including calls made by a module in another group.
  withRole("scheduling", () => expandProgramSelection(reg, wanted, /** @type {import("./frontend-session-types.ts").SelectionCore} */ ({VirtualPosition: abaplint.VirtualPosition, MacroContent: abaplint.MacroContent,
    Objects: {FunctionGroup: abaplint.Objects.FunctionGroup}, Visibility: {Public: abaplint.Visibility.Public},
    Statements: {CallFunction: abaplint.Statements.CallFunction}, Expressions: {FunctionName: abaplint.Expressions.FunctionName},
    Tokens: {StringToken: abaplint.Tokens.StringToken, Identifier: abaplint.Tokens.Identifier}}))); Object.freeze(wanted); indexFrozenSelection(wanted);

  return {wanted, diagnostics, broken};
}

// The host captures this current-registry frame while validating the ledger;
// probes reuse it only after the loaded source/config guards also agree.
/**
 * @param {import("./frontend-session-types.ts").Registry} reg
 * @param {import("./frontend-session-types.ts").CompileOptions} options
 * @param {import("./frontend-diagnostics.ts").DiagnosticsSession | undefined} session
 * @param {{selection?: import("./frontend-session-types.ts").PreparedSelection} | undefined} capture
 * @param {(reg: import("./frontend-session-types.ts").Registry, obj: import("@abaplint/core").Objects.Class, tests: boolean) => import("./frontend-types.ts").LocalClass[]} getLocals
 * @param {Set<string>} localOwners
 * @returns {string[]}
 */
export function deriveSelectionWanted(reg, options, session, capture, getLocals, localOwners) {
  const selection = prepareSelection(reg, options, session), {wanted} = selection;
  if (capture) capture.selection = selection;
  const result = new Set(wanted.map(n => n.toUpperCase())), includeTests = options.includeTests ?? false;
  // @ts-expect-error -- abapiti form pending
  for (const obj of enumerateObjects(reg, "local-dispatch", [], "scheduling", o => o instanceof abaplint.Objects.Class && selectionHas(wanted, o.getName().toLowerCase()) && (includeTests || localOwners.has(o.getName().toUpperCase())))) {
    // @ts-expect-error -- abapiti form pending
    for (const local of getLocals(reg, obj, includeTests === true || (includeTests instanceof Set && includeTests.has(obj.getName().toUpperCase())))) result.add(local.name);
  }
  for (const group of enumerateObjects(reg, "selected-groups", wanted, "scheduling", o => o instanceof abaplint.Objects.FunctionGroup && selectionHas(wanted, o.getName().toLowerCase()))) result.add(`FUGR:${group.getName().toUpperCase()}`);
  return [...result];
}
