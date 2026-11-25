import {readFileSync} from "node:fs";
import {join} from "node:path";

// These approvals apply to the reviewed commits, not to every later commit
// in the same forks. A changed lock ref needs its own license review.
const approved = new Map([
  ["oisee/open-abap-odata", "bd9f1fb175e7b26678e48eb2e311a278a13ef91b"],
  // f1fbd36 = 238c5bfe (reviewed) + the converter's native mode (open-steamgate's
  // own MIT code, oisee/open-abap-gui#1); LICENSE and package.json unchanged.
  // 9b3b985 = f1fbd36 + the converter's chained-WRITE comma fix
  // (open-abap/open-abap-gui#182); LICENSE and package.json unchanged.
  // b65c443 = 9b3b985 + the converter's field-symbol check skipping backquoted
  // literals (ABAPiti 041); LICENSE and package.json unchanged.
  // 8b239c2 = b65c443 + upstream's #231 + the fork's syntax errors of
  // abaplint 2.120.118 fixed as upstream fixed them (#230 and later); LICENSE
  // and package.json unchanged.
  ["oisee/open-abap-gui", "8b239c239cbb9f9e41be3f57346cbeecb093257a"],
]);

export function approvedLicenseAssumption(source) {
  return approved.has(source.repo) && approved.get(source.repo) === source.ref
    && source.licenseAssumption?.license === "MIT";
}

/** Every library sources.json marks with a placeholder licence must be
 *  pinned in libs.lock.json at the commit that was reviewed. Repo tooling
 *  and CI only (tools/osd-libs.mjs, test/bootstrap.mjs, the image build):
 *  a shipped tree carries neither this file nor sources.json, so nothing on
 *  the runtime path imports it. */
export function checkLockLicences(root = ".") {
  const sources = JSON.parse(readFileSync(join(root, "docker", "image", "sources.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "libs.lock.json"), "utf8"));
  for (const source of sources.libraries.filter((entry) => entry.licenseAssumption)) {
    const pin = lock.libraries.find((entry) => entry.folder === source.folder);
    if (!pin || !approvedLicenseAssumption({...pin, ...source})) {
      throw new Error(`libs.lock.json: ${source.folder} needs licence approval for its pinned ref`);
    }
  }
}
