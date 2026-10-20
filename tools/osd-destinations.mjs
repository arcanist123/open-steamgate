// One registry for "which other system is that", and one for "who answers
// this path with it".
//
// **Why this exists, and it is a mess of mine from yesterday.** Within a day
// this tree grew two files for one idea:
//
//   .local/rfc-destinations.json       name -> {kind: local|live|replay|…}
//   .local/gateway-destinations.json   SERVICE NAME -> {url, user, password}
//
// fable-osd found the seam by needing a third use: a preflight is keyed by
// **system**, not by service, and bending the second file into that shape
// would have made a third. The right split is the one SM59 already has, and
// it is not "one file with a kind" -- that was my first answer and it is
// wrong, because RFC's `kind` already means *how to satisfy this call*
// (local, replay, live, record, fallback) and would have collided with a
// transport discriminator.
//
// So two things, named apart:
//
//   a **destination** is a system            A4H = {type: http|rfc, …}
//   a **binding** says who uses it here      ZOSD_006_DEMO_SRV -> A4H
//
// A preflight names a destination. A proxy names a binding. An RFC call
// names a destination. Nothing has to be re-keyed to be reused, which was
// the whole complaint.
//
// **Nothing on disk has to change to keep working.** Without the unified
// file this reads the two legacy ones and says so, once, because a tool that
// silently reads something other than what it documents is how the next
// session loses an evening.
import {existsSync, readFileSync} from "node:fs";

export const FILE = ".local/destinations.json";
export const LEGACY_RFC = ".local/rfc-destinations.json";
export const LEGACY_HTTP = ".local/gateway-destinations.json";

/** The file in use: OSD_DESTINATIONS names another one. A compiled binary
 *  runs in its own home under the user's data folder, not in the folder it
 *  was unpacked to, so a stand handed to somebody says where its file is
 *  rather than asking them to copy it into a hidden directory. Read per
 *  call, because a test sets it after this module is loaded. */
export const destinationsFile = (env = process.env) => env.OSD_DESTINATIONS || FILE;

const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`${file}: ${error?.message ?? error} -- treated as absent`);
    return undefined;
  }
};

/** A destination is a system. `type` is the transport and nothing else:
 *  `rfc` keeps its own `mode` (the old `kind`), `http` carries a url and a
 *  logon. A destination with a url and no type is http, which is inference
 *  and is only applied to the legacy file where the shape is unambiguous. */
export function destinations({file = destinationsFile(), rfcFile = LEGACY_RFC, httpFile = LEGACY_HTTP, say = console.error} = {}) {
  if (file === process.env.OSD_DESTINATIONS && !existsSync(file)) {
    // a file somebody named and is not there is not "no destinations": the
    // legacy files would answer in its place and nobody would know
    say(`osd-destinations: ${file} (OSD_DESTINATIONS) does not exist; reading the defaults instead`);
  }
  const unified = existsSync(file) ? read(file) : undefined;
  if (unified !== undefined) {
    // **`?? unified` was a defect and the first file anybody writes trips
    // it.** A unified file with `services` and no `destinations` yet fell
    // through to the bare map and produced a phantom destination literally
    // named `services`, after which every binding reported "bound to A4H,
    // which is not a destination". Found by an adversarial review,
    // 2026-09-20. The shape is decided by whether the file HAS the key, not
    // by whether that key is empty.
    const bare = unified.destinations === undefined && unified.services === undefined;
    const out = {};
    for (const [name, d] of Object.entries(bare ? unified : unified.destinations ?? {})) {
      // inference only where the shape is unambiguous -- a legacy bare map.
      // The comment above used to promise that and the code did it in both
      // branches, which is a rule and its violation in one file.
      out[name] = bare ? {...d, type: d.type ?? (d.url === undefined ? "rfc" : "http")} : {...d, type: d.type ?? "http"};
    }
    return out;
  }
  const out = {};
  const legacyRfc = existsSync(rfcFile) ? read(rfcFile) : undefined;
  for (const [name, d] of Object.entries(legacyRfc ?? {})) {
    // the old `kind` is the RFC mode, not the transport
    const {kind, ...rest} = d;
    out[name] = {type: "rfc", mode: kind, ...rest};
  }
  const legacyHttp = existsSync(httpFile) ? read(httpFile) : undefined;
  for (const [service, d] of Object.entries(legacyHttp ?? {})) {
    // its key was a SERVICE name, which is the defect; the system it names
    // has no name of its own, so it gets one derived from the service and a
    // binding is synthesised below
    out[`${service}@legacy`] = {type: "http", ...d};
  }
  if (legacyRfc !== undefined || legacyHttp !== undefined) {
    say(`osd-destinations: ${FILE} is absent; read ${[legacyRfc && rfcFile, legacyHttp && httpFile].filter(Boolean).join(" and ")} instead`);
  }
  return out;
}

/** A binding says which of this system's paths another system answers.
 *  Today there is one kind of binding: an OData service by name. */
export function bindings({file = destinationsFile(), httpFile = LEGACY_HTTP, say = console.error} = {}) {
  const unified = existsSync(file) ? read(file) : undefined;
  if (unified !== undefined) {
    if (unified.services === undefined && unified.destinations === undefined) {
      // a bare map is the legacy destination shape and carries no bindings.
      // Returning {} silently made "no service is answered remotely" and "I
      // read a file that cannot say" look the same.
      say(`${file} is a bare destination map with no "services": nothing is bound, so no path is answered remotely`);
      return {};
    }
    return {...(unified.services ?? {})};
  }
  const legacyHttp = existsSync(httpFile) ? read(httpFile) : undefined;
  if (legacyHttp === undefined) {
    return {};
  }
  void say;
  // the legacy file's key IS the service, so every entry is its own binding
  return Object.fromEntries(Object.keys(legacyHttp).map((service) => [service, `${service}@legacy`]));
}

/** Every OData service another system answers, as {service, destination}.
 *  A binding naming a destination that is not there is an error and not a
 *  silent omission -- the whole point of naming them apart is that the two
 *  halves can now disagree, so somebody has to check. */
export function remoteServices(options = {}) {
  const all = destinations(options);
  const bound = bindings(options);
  const out = [];
  for (const [service, name] of Object.entries(bound)) {
    const destination = all[name];
    if (destination === undefined) {
      (options.say ?? console.error)(`osd-destinations: service ${service} is bound to ${name}, which is not a destination`);
      continue;
    }
    if (destination.type !== "http") {
      (options.say ?? console.error)(`osd-destinations: service ${service} is bound to ${name}, which is a ${destination.type} destination and cannot answer HTTP`);
      continue;
    }
    out.push({service, name, destination});
  }
  return out;
}

/** One system by name, for a caller that has one -- a preflight, a capture,
 *  anything that asks a system a question rather than serving a path. */
export function destinationOf(name, options = {}) {
  const all = destinations(options);
  const d = all[name];
  if (d === undefined) {
    throw new Error(`no destination ${name}: ${Object.keys(all).join(", ") || "none are defined"}`);
  }
  return d;
}
