// Where the dedicated reader's credentials live: a small interface -- get /
// set / delete -- so the extension can inject VS Code SecretStorage later
// without this module knowing. The CLI default is a file backend under the
// user's config directory.
//
// The file backend's one job is the modes: the directory 0700, the secret file
// 0600, both enforced with fchmod even when they already existed -- a store
// that was once created loose must not stay loose just because nothing
// re-created it. (Windows has no executable bit; the mode call is skipped
// there, and the file inherits the profile's ACLs -- noted in the README.)
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";

export function fileSecretStore(dir, {platform = process.platform} = {}) {
  const enforceModes = () => {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    if (platform !== "win32") {
      chmodSync(dir, 0o700); // even when the directory already existed
    }
  };
  const path = join(dir, "reader-secret.json");
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
      // Replace, never update in place: a pre-existing loose file (written
      // before this rule, or by hand) is removed first, so the fresh write
      // gets 0600 from its mode argument and the fchmod below re-asserts it.
      rmSync(path, {force: true});
      writeFileSync(path, `${JSON.stringify(secrets, null, 1)}\n`, {mode: 0o600});
      if (platform !== "win32") chmodSync(path, 0o600);
    },
    delete(name = "OSD_READER") {
      if (!existsSync(path)) return;
      const secrets = JSON.parse(readFileSync(path, "utf8"));
      delete secrets[name];
      if (Object.keys(secrets).length === 0) {
        rmSync(path, {force: true});
      } else {
        writeFileSync(path, `${JSON.stringify(secrets, null, 1)}\n`, {mode: 0o600});
        if (platform !== "win32") chmodSync(path, 0o600);
      }
    },
  };
}

/** The default store's directory: under the user's config directory
 *  (XDG_CONFIG_HOME, or the platform's own place), so it sits beside the other
 *  state of this tool and not beside code. */
export function defaultSecretStoreDir({platform = process.platform, env = process.env, home = homedir()} = {}) {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "open-steamgate", "osd-hana");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "open-steamgate", "osd-hana");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "open-steamgate", "osd-hana");
}

export function defaultSecretStore(deps = {}) {
  return fileSecretStore(defaultSecretStoreDir(deps), deps);
}
