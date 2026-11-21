// Preloaded in generator children (node --import, or `osd gen` in a hosted
// binary). One JSON line per source read, before a generator can transform
// or copy the bytes into gen/. Every node:fs road to a file's bytes is
// recorded: read, open, stream, copy, link and rename record the source's
// bytes; a read that cannot be tied to a file (an fd this process cannot
// resolve) is an {"incomplete": true} line. The handshake line, written only
// once the hooks are proven visible to ESM importers, tells the parent this
// child was recorded at all (tools/osd-build-generators.mjs recordedRun):
// a Bun binary ignores syncBuiltinESMExports, so its children never write it.
// Names count as well as bytes: a listing, stat or existence test on a path
// whose real ancestry is private or unknown is a "meta" entry (registries in
// gen/ are made from listings). A path is skipped as tooling or output only
// when its real path is too, so a link in gen/ to a private tree is recorded.
// Child processes: tools/osd-generator-children.mjs.
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {dirname, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {installChildHooks} from "./osd-generator-children.mjs";
import {markerMemo, metaEntry, privacyOf, readEntry, realOf, sha256} from "./osd-read-record.mjs";

const log = process.env.OSD_GENERATOR_READS;
if (log) {
  // the root of the build, kept for children that are told another OSD_ROOT
  const root = resolve(process.env.OSD_READ_ROOT ?? process.env.OSD_ROOT ?? process.cwd());
  process.env.OSD_READ_ROOT = root;
  const both = paths => [...new Set(paths.flatMap(path => [resolve(path), realOf(path)]))];
  const roots = both([root]);
  const external = both(JSON.parse(process.env.OSD_READ_EXTERNAL ?? "[]"));
  const ignored = both(JSON.parse(process.env.OSD_READ_EXCLUDE_PREFIXES ?? "[]"));
  const promises = fs.promises;
  const o = {...fs};
  const op = {...promises};
  let busy = false;
  const write = line => o.appendFileSync(log, `${JSON.stringify(line)}\n`);
  const under = (base, path) => { const rel = relative(base, path); return rel !== ".." && !rel.startsWith(`..${sep}`); };
  const TOOLING = /^(gen|build|output|tools|scripts|test|node_modules|\.git|\.local\/ci-artifact)(\/|$)/;
  const skipped = (path, projected) => !(roots.some(base => under(base, path)) || external.some(base => under(base, path)))
    || ignored.some(base => under(base, path))
    || !projected && roots.some(base => under(base, path) && TOOLING.test(relative(base, path).split(sep).join("/")));
  // skipped only if the path as written AND its real path are; a real path
  // out of every scope is still recorded when its ancestry is not public
  const watched = (path, projected) => {
    if (!skipped(path, projected)) return true;
    const real = realOf(path);
    return (real !== path && !skipped(real, projected)) || privacyOf(real) !== false;
  };
  const pathOf = file => typeof file === "string" ? file : file instanceof URL ? fileURLToPath(file)
    : file instanceof Uint8Array ? Buffer.from(file).toString() : undefined;
  // the bytes as the generator got them; for a directory (cp), every file under it
  const each = (path, seen = new Set()) => {
    const fd = o.openSync(path, "r");
    try {
      if (!fs.fstatSync(fd).isDirectory()) return [[path, o.readFileSync(fd)]];
    } finally { o.closeSync(fd); }
    const real = fs.realpathSync(path);
    if (seen.has(real)) return [];
    seen.add(real);
    const dir = fs.opendirSync(path);
    const files = [];
    try { for (let entry; (entry = dir.readSync()) !== null;) files.push(...each(join(path, entry.name), seen)); } finally { dir.closeSync(); }
    return files;
  };
  const logged = new Set();
  // node's own sync readers call the public openSync/readSync: the outer call records
  const quiet = call => { if (busy) return call(); busy = true; try { return call(); } finally { busy = false; } };
  const record = (file, bytes, {projected = false, missingOk = false} = {}) => {
    if (busy) return;
    const given = pathOf(file);
    busy = true;
    try {
      if (given === undefined) return write({incomplete: true, path: String(file)});
      const path = resolve(given);
      if (!watched(path, projected)) return;
      if (missingOk) try { fs.accessSync(path); } catch { return; }
      for (const [one, data] of bytes === undefined ? each(path) : [[path, bytes]]) {
        const key = `${one}\0${sha256(data)}`;
        if (!watched(one, projected) || logged.has(key)) continue;
        logged.add(key);
        write(readEntry(root, one, data, markerMemo));
      }
    } catch { write({incomplete: true, path: String(pathOf(file) ?? file)}); } finally { busy = false; }
  };
  // a name seen: written only when the real ancestry is private or unknown
  const meta = (file, seen) => {
    if (busy) return;
    const given = pathOf(file);
    if (given === undefined) return;
    busy = true;
    try {
      const path = resolve(given);
      if (!watched(path, false) || privacyOf(realOf(path)) === false) return;
      const entry = metaEntry(root, path, typeof seen === "string" ? seen : JSON.stringify(seen ?? path), markerMemo);
      const key = `meta\0${path}\0${entry.sha256}`;
      if (logged.has(key)) return;
      logged.add(key);
      write(entry);
    } catch { write({incomplete: true, path: `meta: ${given}`}); } finally { busy = false; }
  };
  // a listing's names belong to the directory: judged as a name inside it
  const listed = (file, list) => { const given = pathOf(file); if (given !== undefined) meta(join(resolve(given), "*"), names(list)); };
  // A file this process wrote holds what it read, which is recorded: a later
  // read of it (a cache it renames into place, say) is derived, not a source.
  // Only when the bytes are all this process's: a truncating write or a file
  // it created. An append (or r+) keeps what was there, which stays a source.
  // Links are not writes: reading through one reads its target.
  const absent = file => { const given = pathOf(file); return given !== undefined && !o.existsSync(given); };
  const truncates = flags => typeof flags === "string" ? flags.includes("w") : typeof flags === "number" && (flags & fs.constants.O_TRUNC) !== 0;
  const flagOf = (options, key, fallback) => (options !== null && typeof options === "object" && options[key] !== undefined ? options[key] : fallback);
  const wrote = (file, whole = true) => {
    if (busy || !whole) return;
    const given = pathOf(file);
    if (given === undefined) return;
    busy = true;
    try { if (watched(resolve(given), false)) write({wrote: realOf(given)}); } catch { /* nothing read, nothing claimed */ } finally { busy = false; }
  };
  const writable = flags => typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & 3) !== 0;
  const names = list => Array.isArray(list) ? list.map(entry => typeof entry === "object" && !Buffer.isBuffer(entry) ? entry.name : String(entry)) : list;
  const metaHooks = (target, original, list, after) => {
    for (const name of list) if (typeof original[name] === "function") target[name] = after(name);
  };
  // An fd read is attributed to the file the fd names now; one this process
  // cannot name (no /proc) is incomplete. Pipes and sockets are not files.
  const fdSeen = new Map();
  const fdRead = fd => {
    if (busy) return;
    if (typeof fd === "object" && fd !== null && typeof fd.fd === "number") fd = fd.fd;
    let path;
    try { path = quiet(() => fs.readlinkSync(`/proc/self/fd/${fd}`)); } catch { return void write({incomplete: true, path: `fd:${fd}`}); }
    if (!path.startsWith("/") || fdSeen.get(fd) === path) return;
    fdSeen.set(fd, path);
    record(path, undefined, {missingOk: true});
  };
  const readable = flags => flags === undefined || flags === null
    || (typeof flags === "string" ? /[r+]/.test(flags) : (flags & 3) !== fs.constants.O_WRONLY);
  const asBytes = (value, options) => Buffer.isBuffer(value) ? value
    : Buffer.from(value, typeof options === "string" ? options : options?.encoding ?? "utf8");
  const callback = args => args.findLastIndex(arg => typeof arg === "function");
  // wrap an fs callback API: `after(args, result)` runs on success
  const viaCallback = (name, after) => {
    fs[name] = (...args) => {
      const at = callback(args);
      const created = absent(args[0]);
      if (at >= 0) {
        const done = args[at];
        args[at] = (error, ...rest) => { if (!error) after(args, rest[0], created); done(error, ...rest); };
      }
      return o[name](...args);
    };
  };
  const viaPromise = (name, after) => {
    promises[name] = async (...args) => { const created = absent(args[0]); const value = await op[name](...args); after(args, value, created); return value; };
  };

  fs.readFileSync = (file, ...args) => {
    if (busy) return o.readFileSync(file, ...args);
    const value = quiet(() => o.readFileSync(file, ...args));
    if (typeof file === "number") { fdRead(file); return value; }
    // the file the view (tools/osd-generator-view.mjs) actually read
    const viewed = globalThis[Symbol.for("osd.generator.readPath")]?.(file) ?? file;
    const given = pathOf(file);
    const actual = pathOf(viewed);
    record(viewed, asBytes(value, args[0]), {projected: given !== undefined && actual !== undefined && resolve(actual) !== resolve(given)});
    return value;
  };
  const opened = (args, fd, created) => {
    if (readable(args[1])) record(args[0]);
    if (writable(args[1])) wrote(args[0], created || truncates(args[1]));
    fdSeen.delete(typeof fd === "number" ? fd : fd?.fd);
  };
  fs.openSync = (...args) => { const created = absent(args[0]); const fd = o.openSync(...args); opened(args, fd, created); return fd; };
  for (const name of ["readSync", "readvSync"]) fs[name] = (fd, ...args) => { fdRead(fd); return o[name](fd, ...args); };
  for (const name of ["read", "readv"]) fs[name] = (fd, ...args) => { fdRead(fd); return o[name](fd, ...args); };
  fs.copyFileSync = (src, dest, ...args) => { const value = quiet(() => o.copyFileSync(src, dest, ...args)); record(src); wrote(dest); return value; };
  fs.cpSync = (src, ...args) => { const value = quiet(() => o.cpSync(src, ...args)); record(src); return value; };
  fs.linkSync = (src, ...args) => { const value = o.linkSync(src, ...args); record(src); return value; };
  fs.symlinkSync = (target, path, ...args) => {
    const value = o.symlinkSync(target, path, ...args);
    record(resolve(dirname(resolve(pathOf(path) ?? ".")), pathOf(target) ?? ""));
    return value;
  };
  fs.renameSync = (src, dest, ...args) => { record(src, undefined, {missingOk: true}); const value = o.renameSync(src, dest, ...args); wrote(dest); return value; };
  for (const [name, flag] of [["writeFileSync", "w"], ["appendFileSync", "a"]]) fs[name] = (file, ...args) => {
    const created = typeof file !== "number" && absent(file);
    const value = o[name](file, ...args);
    if (typeof file !== "number") wrote(file, created || truncates(flagOf(args[1], "flag", flag)));
    return value;
  };
  fs.createWriteStream = (file, options) => {
    const created = absent(file);
    const stream = o.createWriteStream(file, options);
    if (options?.fd === undefined || options.fd === null) wrote(file, created || truncates(flagOf(options, "flags", "w")));
    return stream;
  };
  fs.createReadStream = (file, options) => {
    if (options?.fd !== undefined && options.fd !== null) fdRead(options.fd);
    else record(file, undefined, {missingOk: true});
    return o.createReadStream(file, options);
  };
  if (o.openAsBlob) fs.openAsBlob = (file, ...args) => { record(file, undefined, {missingOk: true}); return o.openAsBlob(file, ...args); };
  fs.readFile = (file, ...args) => {
    if (typeof file === "number") fdRead(file);
    const at = callback(args);
    if (at >= 0 && typeof file !== "number") {
      const done = args[at];
      const options = at > 0 ? args[0] : undefined;
      args[at] = (error, value) => { if (!error) record(file, asBytes(value, options)); done(error, value); };
    }
    return o.readFile(file, ...args);
  };
  viaCallback("open", opened);
  const written = flag => (args, value, created) => { if (typeof args[0] !== "number") wrote(args[0], created || truncates(flagOf(args[2], "flag", flag))); };
  viaCallback("writeFile", written("w"));
  viaCallback("appendFile", written("a"));
  viaCallback("copyFile", args => record(args[0]));
  viaCallback("cp", args => record(args[0]));
  viaCallback("link", args => record(args[0]));
  fs.rename = (src, ...args) => { record(src, undefined, {missingOk: true}); return o.rename(src, ...args); };

  promises.readFile = async (file, options) => {
    if (typeof file === "object" && file !== null && typeof file.fd === "number") fdRead(file);
    const value = await op.readFile(file, options);
    if (!(typeof file === "object" && file !== null && typeof file.fd === "number")) record(file, asBytes(value, options));
    return value;
  };
  viaPromise("open", opened);
  const named = flag => (args, value, created) => { if (typeof args[0] === "string" || args[0] instanceof URL || args[0] instanceof Uint8Array) wrote(args[0], created || truncates(flagOf(args[2], "flag", flag))); };
  viaPromise("writeFile", named("w"));
  viaPromise("appendFile", named("a"));
  viaPromise("copyFile", args => record(args[0]));
  viaPromise("cp", args => record(args[0]));
  viaPromise("link", args => record(args[0]));
  promises.symlink = async (target, path, ...args) => {
    await op.symlink(target, path, ...args);
    record(resolve(dirname(resolve(pathOf(path) ?? ".")), pathOf(target) ?? ""));
  };
  promises.rename = async (src, ...args) => { record(src, undefined, {missingOk: true}); return op.rename(src, ...args); };
  // names: listings by their names, the rest by the path asked about
  const SYNC = ["statSync", "lstatSync", "existsSync", "realpathSync", "readlinkSync", "accessSync"];
  metaHooks(fs, o, SYNC, name => {
    const hook = (file, ...args) => { meta(file); return o[name](file, ...args); };
    if (o[name].native) hook.native = (file, ...args) => { meta(file); return o[name].native(file, ...args); };
    return hook;
  });
  fs.readdirSync = (file, ...args) => { const list = o.readdirSync(file, ...args); listed(file, list); return list; };
  fs.opendirSync = (file, ...args) => { listed(file, String(pathOf(file))); return o.opendirSync(file, ...args); };
  fs.opendir = (file, ...args) => { listed(file, String(pathOf(file))); return o.opendir(file, ...args); };
  metaHooks(fs, o, ["stat", "lstat", "exists", "realpath", "readlink", "access"], name => {
    const hook = (file, ...args) => { meta(file); return o[name](file, ...args); };
    if (o[name].native) hook.native = (file, ...args) => { meta(file); return o[name].native(file, ...args); };
    return hook;
  });
  viaCallback("readdir", (args, list) => listed(args[0], list));
  metaHooks(promises, op, ["stat", "lstat", "realpath", "readlink", "access"],
    name => async (file, ...args) => { meta(file); return op[name](file, ...args); });
  promises.opendir = async (file, ...args) => { listed(file, String(pathOf(file))); return op.opendir(file, ...args); };
  viaPromise("readdir", (args, list) => listed(args[0], list));
  // the file itself, never a bundle that carries it (a preload of the whole program)
  const recorderUrl = /^file:.*\/osd-generator-reads\.mjs$/.test(import.meta.url) && quiet(() => fs.existsSync(fileURLToPath(import.meta.url))) ? import.meta.url : undefined;
  const modules = [[fs, o, "node:fs"], [promises, op, "node:fs/promises"], ...installChildHooks({write, recorder: recorderUrl, meta, listed})];
  syncBuiltinESMExports();

  // Proven, not assumed: a named import of each module must now see the hooks.
  let visible = true;
  for (const [module, original, specifier] of modules) {
    const named = await import(specifier);
    visible &&= Object.keys(module).every(name => module[name] === original[name] || named[name] === module[name]);
  }
  if (visible && process.env.OSD_GENERATOR_READS_TOKEN) write({recorder: process.env.OSD_GENERATOR_READS_TOKEN});
  if (!visible) write({incomplete: true, path: "recorder: node:fs hooks are not visible to imports"});
}
