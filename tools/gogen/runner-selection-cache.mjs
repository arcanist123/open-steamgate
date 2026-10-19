// Optional host adapter; the compiler controller itself performs no host I/O.
import {createHash, randomUUID} from "node:crypto";
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {deriveProgramWanted} from "./frontend.mjs";
import {withRole} from "./frontend-provenance.mjs";
import {selectionScope} from "./runner-selection-scope.mjs";
import {discoveryEvidence} from "./runner-selection-evidence.mjs";
const digest = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
function closedSelection(saved, options, reg) {
  const roots = options.objects;
  const strings = value => Array.isArray(value) && value.every(n => typeof n === "string");
  const same = (left, right) => left.length === right.length && left.every((n, i) => n === right[i]);
  if (!Array.isArray(saved.rounds) || !saved.rounds.length || !strings(saved.selection)) return undefined;
  const session = {}; // One current issue list for this immutable loaded scope.
  let expected = roots, selected;
  for (const [round, row] of saved.rounds.entries()) {
    if (![row.inputs, row.wanted, row.missing, row.supers, row.added].every(strings)
        || !same(row.inputs, expected)) return undefined;
    const wanted = deriveProgramWanted(reg, {...options, objects: expected, tolerant: round ? true : options.tolerant}, session);
    if (!same(row.wanted, wanted)) return undefined;
    selected ??= new Set(wanted);
    // Replay the controller from the request, never from persisted wanted.
    const added = [...row.missing, ...row.supers].filter(n => !selected.has(n) && reg.getObject("CLAS", n));
    if (!same(row.added, added)) return undefined;
    added.forEach(n => selected.add(n));
    expected = [...selected];
  }
  if (saved.rounds.at(-1).added.length || !same(saved.rounds.at(-1).inputs, saved.selection)) return undefined;
  return expected;
}
export function runnerSelectionCache(cacheDir, identity, files, policy) {
  const file = join(cacheDir, "runner-selection.json");
  let previous;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.checksum === digest(saved.contents)) previous = saved.contents;
  } catch { /* Discovery from original roots. */ }
  const scope = selectionScope(previous?.key?.identity === identity ? previous.scope : undefined);
  const current = () => files.map(({layer, name, hash, path}) => ({layer, name, hash,
    evidence: discoveryEvidence(name, readFileSync(path, "utf8"))}));
  let inputs, request, replayed;
  const key = options => ({identity, policy, roots: options.objects, tolerant: options.tolerant ?? false,
    includeTests: options.includeTests instanceof Set ? [...options.includeTests] : options.includeTests ?? false});
  return {
    read(options) {
      try {
        if (!scope.available || options.registry || options.session || digest(previous?.key) !== digest(key(options))) return;
        if (!Array.isArray(previous?.inputs) || previous.inputs.length !== files.length
            || !previous.inputs.every(row => row && typeof row.hash === "string" && typeof row.evidence === "string")) return;
        const exact = previous.inputs.every((old, i) => old.layer === files[i].layer && old.name === files[i].name && old.hash === files[i].hash);
        if (exact) inputs = previous.inputs;
        if (!exact) {
          inputs = files.map((row, i) => row.layer === previous.inputs[i].layer && row.name === previous.inputs[i].name && row.hash === previous.inputs[i].hash ? previous.inputs[i] : {
            layer: row.layer, name: row.name, hash: row.hash, evidence: discoveryEvidence(row.name, readFileSync(row.path, "utf8"))});
          if (!inputs.every((row, i) => row.layer === previous.inputs[i].layer && row.name === previous.inputs[i].name
              && row.evidence === previous.inputs[i].evidence
              && (row.hash === previous.inputs[i].hash || row.evidence.startsWith("local-v1:")))) return;
        }
        if (!Array.isArray(previous.rounds) || !previous.rounds.length) return;
        if (!Array.isArray(previous.selection) || !previous.selection.every(n => typeof n === "string")) return;
        request = options;
        return {selection: previous.selection, get closed() { return replayed; }, evidence: exact ? "exact-inputs" : "local-string-initializers", rounds: previous.rounds};
      } catch { return; } // Incomplete evidence always restarts discovery.
    },
    check(reg, seeded) {
      const evidence = scope.check(reg, seeded);
      if (!seeded || evidence === false) return evidence;
      try {
        replayed ??= withRole("scheduling", () => closedSelection(previous, request, reg));
        return replayed ? evidence : false;
      } catch { return false; }
    },
    write(options, selection, rounds) {
      if (options.registry || options.session) return;
      const temp = `${file}.${randomUUID()}.pending`;
      try {
        const loaded = scope.snapshot();
        if (!loaded) return;
        const contents = {key: key(options), inputs: inputs ?? current(), selection, rounds, scope: loaded};
        mkdirSync(cacheDir, {recursive: true});
        writeFileSync(temp, JSON.stringify({contents, checksum: digest(contents)})); renameSync(temp, file);
      } catch { /* Unavailable metadata is a miss. */ }
      finally { try { rmSync(temp, {force: true}); } catch { /* Unavailable cache. */ } }
    },
  };
}
