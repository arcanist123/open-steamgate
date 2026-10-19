// A filesystem scan is only a preflight. Authority comes from the normalized
// inputs actually loaded by the compiler, including inventory, roles and CDS.
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {discoveryEvidence, matchingDiscoveryEvidence} from "./runner-selection-evidence.mjs";
import {equivalentMethodDiscovery} from "./runner-method-discovery.mjs";
import {builtinDiscoveryIntegers} from "./runner-discovery-types.mjs";
const require = createRequire(import.meta.url);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function selectionScope(previous) {
  const valid = previous && typeof previous.config === "string" && typeof previous.cds === "string"
    && Array.isArray(previous.files) && previous.files.every(row => row && typeof row.owner === "string"
      && typeof row.dependency === "boolean" && typeof row.name === "string" && typeof row.hash === "string" && typeof row.evidence === "string");
  const memo = new WeakMap();
  let initial, current, registry, complete = true, certification;
  const shape = scope => [scope.config, scope.cds, scope.files.map(({owner, dependency, name, hash}) => [owner, dependency, name, hash])];
  return {
    available: !!valid,
    check(reg, seeded, rounds, includeTests) {
      registry = reg;
      const {inputSnapshot, rawHashOf, cdsInputDigest} = require("./frontend-inventory.mjs");
      const input = inputSnapshot(reg, true), files = [];
      for (const [owner, row] of input.objects) for (const source of row.sources) {
        let value = memo.get(source.file);
        if (!value || value.raw !== source.raw) {
          value = {raw: source.raw, hash: rawHashOf(source)}; memo.set(source.file, value);
        }
        files.push({owner, obj: row.obj, dependency: row.dependency, name: source.name, hash: value.hash, value});
      }
      current = {config: input.config, cds: cdsInputDigest(reg), files};
      const signature = digest(shape(current));
      if (initial && initial !== signature) { complete = false; return !seeded; }
      initial ??= signature;
      if (!seeded) return true;
      if (!valid || previous.config !== current.config || previous.cds !== current.cds || previous.files.length !== files.length) return false;
      const general = [];
      let exact = true, editedEvidence = "local-string-initializers";
      for (let i = 0; i < files.length; i++) {
        const row = files[i], old = previous.files[i];
        if (row.owner !== old.owner || row.dependency !== old.dependency || row.name !== old.name) return false;
        if (row.hash === old.hash) { row.value.evidence ??= old.evidence; continue; }
        exact = false;
        row.value.evidence ??= discoveryEvidence(row.name, row.value.raw, !row.name.toLowerCase().endsWith(".clas.abap") || builtinDiscoveryIntegers(reg, row.obj));
        const match = matchingDiscoveryEvidence(old.evidence, row.value.evidence);
        if (!match) return false;
        if (match === "discovery-references") editedEvidence = match;
        if (match === "method-discovery-candidate") general.push(row.name);
      }
      if (general.length && !equivalentMethodDiscovery(reg, previous, current, rounds, includeTests, general)) return false;
      if (general.length) editedEvidence = "method-discovery-references";
      certification = exact ? "exact-inputs" : editedEvidence;
      return certification;
    },
    snapshot() {
      if (!complete || !current) return;
      return {config: current.config, cds: current.cds, files: current.files.map(({owner, obj, dependency, name, hash, value}, i) => {
        const old = valid && previous.files[i];
        if (old && old.name === name && old.hash === hash) value.evidence ??= old.evidence;
        value.evidence ??= discoveryEvidence(name, value.raw, !name.toLowerCase().endsWith(".clas.abap") || builtinDiscoveryIntegers(registry, obj));
        return {owner, dependency, name, hash, evidence: value.evidence};
      })};
    },
  };
}
