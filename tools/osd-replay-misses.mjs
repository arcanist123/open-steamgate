// The misses of a replay, for the person who has to fill them.
//
// tools/osd-http-replay.mjs keeps every request no fixture answered, with
// the nearest recording at the same path and how it differs. This serves
// them (`/sap/bc/osd/replay/misses`, mounted by tools/osd-remote-service.mjs)
// and makes one a fixture (`promote`, the CLI tools/osd-replay-promote.mjs
// and `osd replay-promote`). The page only reads: writing a fixture is a
// person's decision, because a recording carries a system's data and where
// it lands decides whether it is published.
import {spawnSync} from "node:child_process";
import {existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {basename, dirname, join, relative, resolve} from "node:path";
import {ODATA_ROOT, pathKey, replayer, replayKey, splitUrl} from "./osd-http-replay.mjs";

/** the URL a miss was asked at, from the root, as a page sent it */
const missUrl = ({service, path, query}) => `${ODATA_ROOT}${service}${path === "" ? "" : `/${path}`}${query === "" ? "" : `?${query}`}`;

/** the command that turns a miss into a fixture from its nearest
 *  recording, for the host this runs on: `osd replay-promote` from a binary
 *  (OSD_SELF, tools/osd-host.mjs), the tool from a checkout. Every word that
 *  is not plainly safe is quoted: for a POSIX shell, and on Windows for
 *  PowerShell, the default there, whose single quotes expand nothing --
 *  cmd.exe expands %VAR% even inside double quotes, so it gets no command. */
export function promoteCommand(miss, {env = process.env, platform = process.platform} = {}) {
  // a backslash is a path separator on Windows and an escape in a POSIX shell
  const plain = platform === "win32" ? "_-./:=@\\" : "_-./:=@";
  const safe = (w) => w !== "" && [...w].every((c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || plain.includes(c));
  const quote = (w) => (safe(w) ? w : platform === "win32" ? `'${w.replaceAll("'", "''")}'` : `'${w.replaceAll("'", "'\\''")}'`);
  const self = env.OSD_SELF === undefined || env.OSD_SELF === "" ? undefined : JSON.parse(env.OSD_SELF);
  const words = [...(self === undefined ? ["node", "tools/osd-replay-promote.mjs"] : [...self, "replay-promote"]),
    "--destination", String(miss.destination), "--url", missUrl(miss.request), "--out", ".local/replay/promoted"].map(quote);
  // PowerShell runs a quoted program only through the call operator
  return platform === "win32" && words[0].startsWith("'") ? `& ${words.join(" ")}` : words.join(" ");
}

const escapeHtml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** `/sap/bc/osd/replay/misses`: every miss of every replaying destination of
 *  this run, newest last -- JSON, or a table with `?format=html` or a
 *  browser's Accept. Each carries the nearest recording, the batch parts it
 *  was asked in and the command that promotes it. Read only: writing a
 *  fixture is the CLI's, run by a person, because a recording carries a
 *  system's data and where it lands is a decision. */
export function missesHandler(replayers) {
  return (req, res) => {
    const misses = [...replayers].flatMap((r) => r.misses()).map((m) => ({...m, promote: promoteCommand(m)}));
    const html = req.query?.format === "html" || (req.query?.format === undefined && String(req.headers.accept ?? "").includes("text/html"));
    if (!html) {
      res.json({misses});
      return;
    }
    const rows = misses.map((m) => `<tr><td>${escapeHtml(m.destination)}</td><td>${m.count}</td><td><code>${escapeHtml(m.key)}</code>` +
      `${m.parts.map((p) => `<br>batch part ${p.part}: <code>${escapeHtml(p.line)}</code>`).join("")}</td>` +
      `<td>${m.closest === undefined ? "nothing at this path" : `<code>${escapeHtml(m.closest.file ?? m.closest.key)}</code><br>` +
        m.closest.differences.map((d) => `${escapeHtml(d.option)}: asked <code>${escapeHtml(d.asked ?? "(none)")}</code>, recorded <code>${escapeHtml(d.recorded ?? "(none)")}</code>`).join("<br>")}</td>` +
      `<td><code>${escapeHtml(m.promote)}</code></td></tr>`).join("\n");
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Replay misses</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top;text-align:left}code{font-size:12px;word-break:break-all}</style>
<h1>Replay misses (${misses.length})</h1>
<table><tr><th>destination</th><th>count</th><th>request</th><th>closest recording</th><th>promote</th></tr>
${rows}</table>`);
  };
}

/** `path` with every existing part resolved to where it physically is: a
 *  symlinked `.local/` must be judged where the file would land. A part
 *  that exists only as a dangling link (lstat sees it, stat does not) is
 *  refused: where it would land is not knowable before writing. */
function physical(path) {
  const rest = [];
  let at = resolve(path);
  const present = (p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  while (!present(at)) {
    const up = dirname(at);
    if (up === at) {
      break;
    }
    rest.unshift(basename(at));
    at = up;
  }
  let real;
  try {
    real = realpathSync(at);
  } catch (error) {
    throw new Error(`${at} is a link that leads nowhere (${error.code}); a promoted fixture is not written through it`);
  }
  return join(real, ...rest);
}

/** Whether git could publish `file`: it is in a repository's work tree and
 *  either tracked already or not ignored. Fails closed -- a repository git
 *  will not answer about (another owner, a broken config) counts as one
 *  that would publish it. Outside any repository nothing is published. */
function publishable(file) {
  let root;
  for (let at = dirname(file); root === undefined; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) {
      root = at;
    } else if (dirname(at) === at) {
      return false;
    }
  }
  const rel = relative(root, file);
  const git = (...args) => spawnSync("git", ["-C", root, ...args, "--", rel], {stdio: "ignore"}).status;
  // each answers 0 or 1; anything else (an error, a signal, no git) is git
  // unable to say, which counts as publishing
  const tracked = git("ls-files", "--error-unmatch");
  if (tracked !== 1) {
    return true;
  }
  return git("check-ignore", "-q") !== 0;
}

/** A miss made a fixture: the request's own key, the response of `from`
 *  (a fixture file) or, without one, of the nearest recording at the same
 *  path. Written into `out` only when git would not publish it there, and
 *  never over a file. Returns {file, from}. */
export function promote({fixtures, url, from, out, say = console.error, mkdir = mkdirSync}) {
  const request = splitUrl(url);
  if (request === undefined) {
    throw new Error(`not an OData URL: ${url}`);
  }
  let source;
  if (from !== undefined) {
    source = JSON.parse(readFileSync(from, "utf8"));
  } else {
    const replay = replayer(fixtures, {say: () => {}});
    const nearest = replay.nearest({method: "GET", ...request});
    if (nearest === undefined) {
      throw new Error(`nothing is recorded at ${pathKey({method: "GET", ...request})}; name a fixture with --from`);
    }
    source = fixtures.get(nearest.key);
    from = nearest.file ?? nearest.key;
    say(`osd-http-replay: promoting from ${from}: ${nearest.differences.map((d) => `${d.option} asked ${d.asked ?? "(none)"}, recorded ${d.recorded ?? "(none)"}`).join("; ") || "same query"}`);
  }
  const key = {method: "GET", service: request.service, path: request.path, query: request.query};
  const name = `promoted-${createHash("sha256").update(replayKey(key)).digest("hex").slice(0, 12)}.json`;
  const folder = resolve(out);
  const file = physical(join(folder, name));
  if (publishable(file)) {
    throw new Error(`${file} could be published: it is in a git work tree and tracked or not ignored there; a promoted fixture carries a system's data -- write it under .local/ or a private pack's ignored folder`);
  }
  mkdir(dirname(file), {recursive: true});
  try {
    // "wx": created here or not at all -- an existing file, or a link put
    // there since the check, is never written through or over
    writeFileSync(file, `${JSON.stringify({key, response: source.response, promotedFrom: relative(folder, resolve(String(from)))}, null, 2)}\n`, {flag: "wx"});
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`${file} exists; a promoted fixture is never overwritten`);
    }
    throw error;
  }
  // judged again where it actually landed: a folder swapped for a link
  // between the check and the write (Node has no openat to pin it) moves the
  // file, and a moved file is taken back rather than left publishable.
  // What this guards is a mistake, not a process racing us on purpose --
  // one that can write into the folder can publish anything anyway.
  const landed = realpathSync(file);
  if (landed !== file || publishable(landed)) {
    rmSync(landed, {force: true});
    throw new Error(`${file} landed at ${landed}, which git could publish; removed`);
  }
  return {file, from};
}
