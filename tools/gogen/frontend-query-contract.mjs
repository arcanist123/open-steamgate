// @ts-check
// The selected-contributions answer is rebuilt from current parsed methods.
// It guards provider identities and the complete supplied-parameter set, rather
// than unrelated bytes in every implementation body.
import {createHash} from "node:crypto";
/** @param {{kind: string, policy?: string}} query @returns {boolean} */
export const projectedQuery = (query) => query.kind === "supplied" && query.policy === "selected-contributions"
  || query.kind === "caught" && query.policy === "selected-subclass-presence";
const arrayHashes = new WeakMap();
// @ts-expect-error -- abapiti form pending
const primitive = (value) => value === null || ["undefined", "string", "number", "boolean"].includes(typeof value);
// @ts-expect-error -- abapiti form pending
function setHash(values) {
  if (!Array.isArray(values)) return values;
  if (arrayHashes.has(values)) return arrayHashes.get(values);
  // Only frozen scalar arrays may be memoized. Mutable caller data and unknown
  // shapes keep their normal validation path; they never borrow an old hash.
  if (!values.every(primitive)) return values;
  const hash = createHash("sha256").update(JSON.stringify([...values].sort())).digest("hex");
  if (Object.isFrozen(values)) arrayHashes.set(values, hash);
  return hash;
}
// @ts-expect-error -- abapiti form pending
export function projectionAnswer(answer) {
  const value = {...answer, result: setHash(answer.result)};
  if (Object.hasOwn(answer, "providers")) value.providers = setHash(answer.providers);
  if (Array.isArray(answer.parameters)) value.parameters = [...answer.parameters].sort();
  return value;
}
