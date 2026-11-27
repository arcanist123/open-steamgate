// The provenance of a public artefact, tied to the bytes it ships.
//
// Every publishing edge copies the WORKING TREE (packs, fetched sources,
// build/live, gen/, output/), while the live generation's manifest says what
// the tree was when it was built. A private pack fetched after a public build
// is in the tree and not in the manifest. So an artefact is stamped, and
// verified, only when
//   - the live record is complete and public (assertPublicSystem),
//   - every CURRENT input is recorded public (generationSystem over
//     inputsOf(root), refetched identities and OSD_PACKS folders included),
//   - and the tree hashes to the live generation: hashOf(root) === live,
//     which names private and unknown inputs, so nothing changed since.
// Kept out of osd-system.mjs and osd-provenance.mjs on purpose: the OCI
// publisher's import closure must not reach osd-build, and the Dockerfile
// verifies with osd-provenance.mjs alone.
import {assertPublicSystem, generationSystem, unknownPrivacy} from "./osd-system.mjs";
import {hashOf, inputsOf} from "./osd-build.mjs";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {sha256, verifyReadRecord} from "./osd-read-record.mjs";
import {resolve} from "node:path";
import {liveGenerationRecord, verifyPublicArtefact, writeArtefactProvenance} from "./osd-provenance.mjs";

const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };

/** The checked provenance of the tree at `root`, or a refusal. */
export function publicProvenance(root) {
  assertPublicSystem(root);
  const record = liveGenerationRecord(root);
  const inputs = inputsOf(root);
  const named = new Map();
  const tree = hashOf(root, inputs, {digests: named});
  named.set(inputs.config, sha256(readFileSync(inputs.config)));
  const reads = verifyReadRecord(root, join(root, "build/live"), named);
  const current = generationSystem(root, inputs, reads.reads, reads);
  const secret = current.provenance.find(input => input.private === true);
  if (secret) fail("PRIVATE_LAYER", `private input ${secret.path} is in the tree, so it cannot be published to a public destination`);
  const unknown = current.provenance.find(input => input.private !== false);
  if (unknown) fail("PRIVATE_LAYER", unknownPrivacy(unknown.path));
  if (current.systemDigest !== record.systemDigest)
    fail("BAD_PROVENANCE", "the installed system is not the one the live generation was built from; rebuild with node tools/osd-build.mjs");
  if (tree !== record.generation)
    fail("BAD_PROVENANCE", `the working tree (${tree}) is not the live generation (${record.generation}); rebuild with node tools/osd-build.mjs`);
  return {...record, systemPrivate: false, inputs: current.provenance};
}

export const assertPublicTree = root => { publicProvenance(root); };

/** Stamp an artefact copied from the tree at `root`. */
export function writePublicArtefact(path, root) {
  return writeArtefactProvenance(path, publicProvenance(root));
}

/** An artefact made from this tree: its bytes, a public record, and the
 *  record is the generation the tree is now. */
export function verifyTreeArtefact(path, root) {
  const current = publicProvenance(root);
  const record = verifyPublicArtefact(path);
  if (record.generation !== current.generation || record.systemDigest !== current.systemDigest)
    fail("BAD_PROVENANCE", `${path} was made from generation ${record.generation}, the tree is ${current.generation}; rebuild it`);
  return record;
}

/** Re-stamp an artefact that was changed in place (screenshots added to a
 *  preview): only when the tree is still the generation it was verified as. */
export function restampTreeArtefact(path, root, before) {
  const current = publicProvenance(root);
  if (current.generation !== before.generation || current.systemDigest !== before.systemDigest)
    fail("BAD_PROVENANCE", `the live generation changed from ${before.generation} to ${current.generation} while ${path} was being extended`);
  return writeArtefactProvenance(path, current);
}

// node tools/osd-public-tree.mjs write|verify <artefact>, from the tree's root:
// stamp an artefact made from this tree, or verify one against it.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [operation, path] = process.argv.slice(2);
  try {
    if (operation === "write" && path) writePublicArtefact(path, process.cwd());
    else if (operation === "verify" && path) verifyTreeArtefact(path, process.cwd());
    else fail("BAD_PROVENANCE", "usage: osd-public-tree.mjs write|verify <artifact>");
  } catch (error) {
    console.error(`${error.code ?? "BAD_PROVENANCE"}: ${error.message}`);
    process.exitCode = 2;
  }
}
