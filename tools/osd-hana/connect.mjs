// Connection input for `osd hana doctor` (tools/osd-hana/): flags, an env
// file, the environment, stdin or a hidden prompt. There is NO --password
// flag, by rule: a password on argv is visible to every user of the machine
// (the same rule the sidecar keeps; contract W0 "Credentials").
//
//   --host --port --database --user     the connection
//   --env-file <file>                   keys HANA_HOST, HANA_PORT, HANA_DATABASE,
//                                       HANA_USER, HANA_PASSWORD, HANA_SCHEMA
//   the password, in order:            --password-stdin (first line of stdin)
//                                       > HANA_PASSWORD from --env-file
//                                       > $OSD_HANA_PASSWORD
//                                       > a hidden prompt, only on a TTY
//                                       > refused, naming the four ways
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";

export const ENV_FILE_KEYS = ["HANA_HOST", "HANA_PORT", "HANA_DATABASE", "HANA_USER", "HANA_PASSWORD", "HANA_SCHEMA"];

export class UsageError extends Error {}

/** `--double-dash` flags only: a bare `-host` is a usage error here, so a
 *  typo cannot silently become a positional word. Returns {flags, rest} where
 *  flags maps the long name to the last value given; boolean flags map to
 *  `true`; repeated value flags keep the last one -- unless the name is listed
 *  in `repeatable`, in which case the values collect in an array (W3's
 *  extract: --package, --name). */
export function parseFlags(argv, {valueFlags, booleanFlags, repeatable = []}) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const equals = name.indexOf("=");
    const key = equals === -1 ? name : name.slice(0, equals);
    if (booleanFlags?.includes(key)) {
      if (equals !== -1) throw new UsageError(`osd hana: --${key} takes no value`);
      flags[key] = true;
      continue;
    }
    let value;
    if (equals !== -1) {
      value = name.slice(equals + 1);
    } else if (valueFlags?.includes(key)) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`osd hana: --${key} needs a value`);
    } else {
      throw new UsageError(`osd hana: unknown or misshaped flag --${key}`);
    }
    if (repeatable.includes(key)) (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return {flags, rest};
}

/** A `.env`-shaped file, only the six keys above, `#` comments. Unknown keys
 *  are named and refused: a typo'd key must not silently drop the setting it
 *  was meant to carry. */
export function readEnvFile(path) {
  if (!existsSync(path)) throw new UsageError(`osd hana: --env-file: no such file: ${path}`);
  const out = {};
  for (const [index, rawLine] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) throw new UsageError(`osd hana: ${path}:${index + 1}: expected KEY=VALUE`);
    const key = line.slice(0, eq).trim();
    if (!ENV_FILE_KEYS.includes(key)) {
      throw new UsageError(`osd hana: ${path}:${index + 1}: unknown key ${key} -- one of ${ENV_FILE_KEYS.join(", ")}`);
    }
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// A visible line prompt on a terminal: the question is written to stderr and
// the typed answer ECHOES -- this is for login NAMES and yes/no questions,
// never for a password (the hidden prompt below is for those). Not a terminal
// (stdin or stderr) is a refusal, never a silent read.
export async function promptVisible(question, {input = process.stdin, output = process.stderr} = {}) {
  if (input?.isTTY !== true || output?.isTTY !== true) {
    throw new UsageError("osd hana: this question needs a terminal -- stdin and stderr are not both terminals here, so there is nobody to answer it");
  }
  const {createInterface} = await import("node:readline");
  const rl = createInterface({input, output});
  return new Promise((resolvePromise) => rl.question(question, (answer) => {
    rl.close();
    resolvePromise(answer);
  }));
}

// A hidden prompt on a TTY: raw mode, every character swallowed, nothing
// echoed. Not a TTY (a test, a pipe) is a refusal, never a read: hanging on
// stdin that will never speak is worse than a clear error.
export async function promptHidden(question, {input = process.stdin, output = process.stderr, isTTY = input.isTTY} = {}) {
  if (!isTTY) throw new UsageError("osd hana: a password is missing and stdin is not a terminal -- use --password-stdin, HANA_PASSWORD in --env-file, or OSD_HANA_PASSWORD");
  return new Promise((resolvePromise, reject) => {
    output.write(question);
    const chars = [];
    let rawWasSet = false;
    try {
      if (typeof input.setRawMode === "function") {
        input.setRawMode(true);
        rawWasSet = true;
      }
    } catch { /* not rawable here; the echo risk is on the host terminal */ }
    input.resume();
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolvePromise(chars.join(""));
          return;
        }
        if (ch === "\u0003") { // Ctrl-C
          cleanup();
          reject(new UsageError("osd hana: cancelled"));
          return;
        }
        chars.push(ch);
      }
    };
    const cleanup = () => {
      input.removeListener("data", onData);
      if (rawWasSet && typeof input.setRawMode === "function") input.setRawMode(false);
      input.pause();
    };
    input.on("data", onData);
  });
}

/** Everything the doctor needs to open a connection. Precedence: the CLI flag
 *  wins over the env file, the env file over the process environment. The
 *  password has one more rank between them: --password-stdin first, then the
 *  env file's HANA_PASSWORD, then $OSD_HANA_PASSWORD, then a TTY prompt. The
 *  password never travels as a flag. */
export async function collectConnection({
  flags,
  env = process.env,
  stdin,
  isTTY,
  prompt = promptHidden,
} = {}) {
  const file = flags["env-file"] !== undefined ? readEnvFile(resolve(flags["env-file"])) : {};
  const pick = (key, envKeys) => flags[key] ?? file[envKeys[0]] ?? envKeys.map((k) => env[k]).find((v) => v !== undefined);
  const host = pick("host", ["HANA_HOST"]);
  const portRaw = pick("port", ["HANA_PORT"]);
  const database = pick("database", ["HANA_DATABASE"]);
  const user = pick("user", ["HANA_USER"]);
  const schema = pick("schema", ["HANA_SCHEMA"]);
  const missing = [];
  if (host === undefined) missing.push("--host");
  if (portRaw === undefined) missing.push("--port");
  if (user === undefined) missing.push("--user");
  if (missing.length > 0) {
    throw new UsageError(`osd hana: the connection is incomplete -- give ${missing.join(", ")} (flags, --env-file, or HANA_* in the environment)`);
  }
  // An empty string is present-but-empty: `HANA_HOST=` in an env file used to
  // pass the completeness check and fail later as an obscure driver error
  // (critic round-2 NOTE-3). Refused the way the password channel already
  // refuses "".
  const empty = [];
  if (host === "") empty.push("the host (--host / HANA_HOST)");
  if (user === "") empty.push("the user (--user / HANA_USER)");
  if (empty.length > 0) {
    throw new UsageError(`osd hana: ${empty.join(" and ")} is/are set to the empty string -- an empty value is refused here, exactly like an empty password. Give a real value or remove the setting.`);
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new UsageError(`osd hana: --port: not a port number: ${portRaw}`);

  let password;
  if (flags["password-stdin"] === true) {
    password = await readStdinLine(stdin);
    if (password === "") throw new UsageError("osd hana: --password-stdin got an empty first line");
  } else if (typeof file.HANA_PASSWORD === "string" && file.HANA_PASSWORD !== "") {
    // HANA_PASSWORD in the env file is a real password channel, not a parsed
    // but dropped key: it ranks above the process environment and below
    // --password-stdin.
    password = file.HANA_PASSWORD;
  } else if (typeof env.OSD_HANA_PASSWORD === "string" && env.OSD_HANA_PASSWORD !== "") {
    password = env.OSD_HANA_PASSWORD;
  } else {
    password = await prompt("HANA password: ", {isTTY});
  }
  return {host, port, database, user, schema, password};
}

function readStdinLine(stdin) {
  // Collected by hand rather than through readline: the first line only, and
  // an already-ended stdin is an empty answer, never a hang.
  return new Promise((resolvePromise) => {
    let buffer = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (typeof stdin.pause === "function") stdin.pause();
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        cleanup();
        resolvePromise(buffer.slice(0, nl).replace(/\r$/, ""));
      }
    };
    const onEnd = () => {
      cleanup();
      resolvePromise(buffer.replace(/\r$/, ""));
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    if (typeof stdin.resume === "function") stdin.resume();
  });
}
