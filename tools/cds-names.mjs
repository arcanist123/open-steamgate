// A namespaced DDIC name in the two places a generator writes it.
//
// /DMO/CURRHLP is written the way abapGit writes it, #dmo#currhlp (a slash
// in a file name would be a directory), and is a word inside a generated
// identifier, ZCL_STG_CDS_DMO_CURRHLP (a slash would not be an ABAP class
// name). Measured before this existed: the first namespaced CDS view in a
// pack made tools/cds2ddic.mjs write gen/cds/dmo/... and fail with ENOENT
// (packs/rap-flight, 2026-11-08). An unnamespaced name passes through.
export const fileOf = (name) => name.toLowerCase().replace(/\//g, "#");
export const wordOf = (name) => name.toUpperCase().replace(/^\/(\w+)\//, "$1_");

// The generated class over a view or table: <prefix><word><suffix>, at most
// 30 characters, which a CDS view entity's 30-character name does not leave
// room for (ZCL_STG_CDS_ + /DMO/I_TRAVEL_STATUS_VH_TEXT would be 39). A name
// that does not fit keeps as much of the word as fits and ends in four hex
// digits of the word's hash, so it is still deterministic and still readable
// (ZCL_STG_CDS_DMO_I_TRAVEL_S_7A1C). Measured before: abaplint refused
// fourteen of the pack's generated classes as "too long".
import {createHash} from "node:crypto";
export function classNameOf(prefix, name, suffix = "") {
  const word = wordOf(name);
  const room = 30 - prefix.length - suffix.length;
  if (word.length <= room) return `${prefix}${word}${suffix}`;
  const hash = createHash("sha256").update(word).digest("hex").slice(0, 4).toUpperCase();
  return `${prefix}${word.slice(0, room - 5).replace(/_+$/, "")}_${hash}${suffix}`;
}
