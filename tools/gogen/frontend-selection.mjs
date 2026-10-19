// Shared cold/replay selection preparation. Only current registry answers count.
import {abaplint} from "./frontend-base.mjs";
import {syntaxDiagnostics} from "./frontend-diagnostics.ts";
import {indexFrozenSelection, selectionHas} from "./frontend-queries.mjs";
import {expandProgramSelection, withRole} from "./frontend-provenance.mjs";

/** @param {import("./frontend-session-types.ts").Registry} reg @param {Pick<import("./frontend-session-types.ts").CompileOptions, "objects" | "tolerant" | "strictRoots">} options @param {import("./frontend-diagnostics.ts").DiagnosticsSession | null} [session] @param {() => void} [prepare] */
export function prepareSelection(reg, {objects, tolerant = false, strictRoots}, session, prepare) {
  const objName = (/** @type {string} */ fn) => fn.split("/").pop().split(".")[0].toLowerCase().replaceAll("#", "/");
  let wanted = objects.map(o => o.toLowerCase().replaceAll("#", "/"));
  // abaplint's RAISE syntax checker only accepts ObjectReferenceType, not
  // its generic REF TO object sibling. The dynamic raise path below checks
  // the actual registered object; retain every other syntax diagnostic.
  const diagnostics = syntaxDiagnostics(reg, (fn) => selectionHas(wanted, objName(fn)), objName, session)
    .filter((d) => !d.message.endsWith("RAISE EXCEPTION, must be object reference, got GenericObjectReferenceType"));
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
