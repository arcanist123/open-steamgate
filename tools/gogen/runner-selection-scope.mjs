// A filesystem scan is only a preflight. Authority comes from the normalized
// inputs actually loaded by the compiler, including inventory, roles and CDS.
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {discoveryEvidence} from "./runner-selection-evidence.mjs";
const require = createRequire(import.meta.url);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function selectionScope(previous) {
  const valid = previous && typeof previous.config === "string" && typeof previous.cds === "string"
    && Array.isArray(previous.files) && previous.files.every(row => row && typeof row.owner === "string"
      && typeof row.dependency === "boolean" && typeof row.name === "string" && typeof row.hash === "string" && typeof row.evidence === "string");
  const memo = new WeakMap();
  let initial, current, complete = true, certification;
  const shape = scope => [scope.config, scope.cds, scope.files.map(({owner, dependency, name, hash}) => [owner, dependency, name, hash])];
  return {
    available: !!valid,
    check(reg, seeded) {
      const {inputSnapshot, rawHashOf, cdsInputDigest} = require("./frontend-inventory.mjs");
      const input = inputSnapshot(reg, true), files = [];
      for (const [owner, row] of input.objects) for (const source of row.sources) {
        let value = memo.get(source.file);
        if (!value || value.raw !== source.raw) {
          value = {raw: source.raw, hash: rawHashOf(source)}; memo.set(source.file, value);
        }
        files.push({owner, dependency: row.dependency, name: source.name, hash: value.hash, value});
      }
      current = {config: input.config, cds: cdsInputDigest(reg), files};
      const signature = digest(shape(current));
      if (initial && initial !== signature) { complete = false; return !seeded; }
      initial ??= signature;
      if (!seeded) return true;
      if (!valid || previous.config !== current.config || previous.cds !== current.cds || previous.files.length !== files.length) return false;
      let exact = true;
      for (let i = 0; i < files.length; i++) {
        const row = files[i], old = previous.files[i];
        if (row.owner !== old.owner || row.dependency !== old.dependency || row.name !== old.name) return false;
        if (row.hash === old.hash) { row.value.evidence ??= old.evidence; continue; }
        exact = false;
        row.value.evidence ??= discoveryEvidence(row.name, row.value.raw);
        if (!row.value.evidence.startsWith("local-v1:") || row.value.evidence !== old.evidence) return false;
      }
      certification = exact ? "exact-inputs" : "local-string-initializers";
      return certification;
    },
    snapshot() {
      if (!complete || !current) return;
      return {config: current.config, cds: current.cds, files: current.files.map(({owner, dependency, name, hash, value}, i) => {
        const old = valid && previous.files[i];
        if (old && old.name === name && old.hash === hash) value.evidence ??= old.evidence;
        value.evidence ??= discoveryEvidence(name, value.raw);
        return {owner, dependency, name, hash, evidence: value.evidence};
      })};
    },
  };
}
