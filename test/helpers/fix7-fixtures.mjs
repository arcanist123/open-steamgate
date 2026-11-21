import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {prepareCiTranspiler} from "../../tools/osd-ci-transpiler.mjs";

export function syntheticReads(root, hash, reads = []) {
  writeFileSync(join(root, "build/by-input", hash, "reads.json"), JSON.stringify({schema: 1, root, reads, uncovered: []}));
}

export function syntheticCiTranspiler(root) {
  const dir = join(root, ".local/ci-artifact/transpiler");
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, "fixture.txt"), "synthetic compiler\n");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "fixture.txt"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const ref = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  writeFileSync(join(root, "libs.lock.json"), JSON.stringify({transpiler: {ref}, libraries: []}));
  prepareCiTranspiler(root);
}
