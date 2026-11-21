// gofmt over a directory, reusing the formatted copy of a large generated file
// whose emission is the one formatted last time (osgo.mjs: on a save the core
// and app packages of the layered build, 20 MB of Go, are unchanged).
//
// cacheDir/<key>.go is the formatted copy, cacheDir/<key>.sha256 the hash of
// the unformatted emission it came from; the hash is written last, so an
// interrupted copy is never taken for a formatted one.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";

/**
 * Format `dir` (non-recursive, as `gofmt -w dir` does) and each of `files`,
 * taking a cached formatted copy for a file whose content is unchanged.
 * @param {{dir: string, files: {key: string, file: string}[], cacheDir: string}} o
 *   files: generated files outside `dir`, each with a stable cache key
 * @returns {{reused: string[]}} the keys whose copy was reused
 * @throws the gofmt error (its stderr in `.stderr`)
 */
export function gofmtCached({dir, files, cacheDir}) {
  const entries = files.map(({key, file}) => {
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    const go = join(cacheDir, `${key}.go`), sum = join(cacheDir, `${key}.sha256`);
    const reused = existsSync(go) && existsSync(sum) && readFileSync(sum, "utf8") === hash;
    if (reused) copyFileSync(go, file);
    return {key, file, hash, go, sum, reused};
  });
  execFileSync("gofmt", ["-w", dir, ...entries.filter((e) => !e.reused).map((e) => e.file)], {stdio: ["ignore", "pipe", "pipe"]});
  mkdirSync(cacheDir, {recursive: true});
  for (const e of entries.filter((x) => !x.reused)) {
    rmSync(e.sum, {force: true});
    copyFileSync(e.file, e.go);
    writeFileSync(e.sum, e.hash);
  }
  return {reused: entries.filter((e) => e.reused).map((e) => e.key)};
}
