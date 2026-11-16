// Where the dedicated reader's credentials live: a small interface -- get /
// set / delete -- so the extension can inject VS Code SecretStorage later
// without this module knowing. The CLI default is a file backend under the
// user's config directory.
//
// The file backend's one job is the modes and the writes: the directory
// 0700, the secret file 0600, both enforced with fchmod even when they
// already existed -- a store that was once created loose must not stay loose
// just because nothing re-created it. Writes are ATOMIC (write a temp file
// with 'wx' in the same directory, then rename over): a crash mid-write can
// lose the new entry, never every stored reader; a symlinked store directory
// or secret file is refused, never chmodded or written through (the target
// would be changed, not the link). (Windows has no executable bit; the mode
// call is skipped there, and the file inherits the profile's ACLs -- noted in
// the README.)
import {chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {isAbsolute, join} from "node:path";
import {randomBytes} from "node:crypto";

export function fileSecretStore(dir, {platform = process.platform} = {}) {
  const refuseSymlink = (path, what) => {
    if (!existsSync(path)) return;
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`osd-hana: refusing the secret store ${what} ${path}: it is a symbolic link. ` +
        `Remove the link and let the store create a real ${what} -- writing or chmodding through a link ` +
        `changes the link's target, not the store.`);
    }
  };
  const enforceModes = () => {
    refuseSymlink(dir, "directory");
    mkdirSync(dir, {recursive: true, mode: 0o700});
    if (platform !== "win32") {
      chmodSync(dir, 0o700); // even when the directory already existed
    }
  };
  const path = join(dir, "reader-secret.json");
  // Replace, never update in place: a pre-existing loose file (written
  // before this rule, or by hand) is replaced atomically, so the fresh write
  // gets 0600 from its mode argument and the fchmod below re-asserts it.
  // 'wx' refuses to clobber anything that appeared at the temp name; rename
  // over the old file is atomic on the same filesystem -- a reader of the
  // store never sees a half-written document.
  const writeAtomic = (text) => {
    refuseSymlink(path, "file");
    rmSync(path, {force: true});
    const tmp = join(dir, `.reader-secret-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, text, {mode: 0o600, flag: "wx"});
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, {force: true});
    }
    if (platform !== "win32") chmodSync(path, 0o600);
  };
  return {
    kind: "file",
    path,
    /** The path the secret for `name` lives at, for messages ("the doctor
     *  says where"). */
    location(name = "OSD_READER") {
      return path;
    },
    get(name = "OSD_READER") {
      if (!existsSync(path)) return undefined;
      let raw;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        throw new Error(`osd-hana: the reader secret file ${path} is not valid JSON -- remove it and run --create-reader again`);
      }
      return raw[name];
    },
    set(value, name = "OSD_READER") {
      enforceModes();
      const secrets = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      secrets[name] = value;
      writeAtomic(`${JSON.stringify(secrets, null, 1)}\n`);
    },
    delete(name = "OSD_READER") {
      if (!existsSync(path)) return;
      const secrets = JSON.parse(readFileSync(path, "utf8"));
      delete secrets[name];
      if (Object.keys(secrets).length === 0) {
        rmSync(path, {force: true});
      } else {
        writeAtomic(`${JSON.stringify(secrets, null, 1)}\n`);
      }
    },
  };
}

/** The default store's directory: under the user's config directory
 *  (XDG_CONFIG_HOME, or the platform's own place), so it sits beside the other
 *  state of this tool and not beside code. A RELATIVE XDG_CONFIG_HOME is
 *  ignored, as the XDG spec says -- otherwise an env file could park the
 *  secret store under whatever directory the tool happens to run in. */
export function defaultSecretStoreDir({platform = process.platform, env = process.env, home = homedir()} = {}) {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "open-steamgate", "osd-hana");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "open-steamgate", "osd-hana");
  }
  const xdg = env.XDG_CONFIG_HOME;
  return join((typeof xdg === "string" && xdg !== "" && isAbsolute(xdg)) ? xdg : join(home, ".config"),
    "open-steamgate", "osd-hana");
}

export function defaultSecretStore(deps = {}) {
  return fileSecretStore(defaultSecretStoreDir(deps), deps);
}
