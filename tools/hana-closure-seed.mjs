// The closure's SEED (milestone 4): the dump the walk started from -- a
// package (or several) plus the Gateway registration tables -- decides which
// services the closure is FOR. Registration and the seed guard follow the
// seed, not a registration dump fixed in a recipe: the bed recipe ran
// tools/hana-segw-gen.mjs on a fixed dump before the closure, registered the
// sample whose sources that dump carried, skipped the service being closed,
// and the seed guard then demanded the sample's classes.
//
// Read off the seed dump only (manifest.json, tables/*.jsonl, the dumper's
// layout; `/` in a table name is `#`):
// - the seed's classes: TADIR rows of kind CLAS in the dump's packages
//   (manifest.packages; every TADIR row when the manifest names none), else
//   SEOCLASS;
// - the seed's services: every registration row (SRH) whose DPC class --
//   or whose model's MPC class (SRH -> SRG -> OHD) -- is a seed class. A
//   hand-written DPC (no SEGW project, no _DPC suffix) is a service the same
//   way; a service whose DPC_EXT inherits another service's _EXT is still
//   its own row;
// - the seed's namespaces: of its packages and its TADIR objects -- the
//   tenant's own, never a framework namespace of ours
//   (tools/hana-closure-framework.mjs).
// registerSeed() hands exactly those services to hana-segw-gen (--service
// per row, --seed marks the facts), after every merge -- a service whose
// classes arrive later is registered when they do, and the guard
// (tools/hana-closure-stubs.mjs serviceGuard) protects the seed's services'
// classes from the first iteration, registered yet or not.
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {run as segwGen} from "./hana-segw-gen.mjs";
import {namespaceOf} from "./hana-closure-intake.mjs";

const str = (v) => String(v ?? "").trim();
const up = (v) => str(v).toUpperCase();

function rows(dump, table) {
  try {
    return readFileSync(join(dump, "tables", `${table.replaceAll("/", "#")}.jsonl`), "utf8").split("\n")
      .filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function manifestOf(dump) {
  try {
    return JSON.parse(readFileSync(join(dump, "manifest.json"), "utf8"));
  } catch {
    return {};
  }
}

/** the seed's packages, classes and objects. */
export function seedObjects(dump) {
  const packages = (manifestOf(dump).packages ?? []).map(up);
  const tadir = rows(dump, "TADIR").filter((r) => packages.length === 0 || packages.includes(up(r.DEVCLASS)));
  const objects = tadir.map((r) => ({kind: up(r.OBJECT), name: up(r.OBJ_NAME)}));
  const classes = new Set(objects.filter((o) => o.kind === "CLAS").map((o) => o.name));
  if (classes.size === 0) for (const r of rows(dump, "SEOCLASS")) if (up(r.CLSNAME) !== "") classes.add(up(r.CLSNAME));
  return {packages, objects, classes};
}

/** the services the seed is for: [{service, version, dpc, mpc}], sorted. */
export function seedServices(dump) {
  const {classes} = seedObjects(dump);
  if (classes.size === 0) return [];
  const key = (a, b) => `${up(a)}/${up(b)}`;
  const srg = new Map(rows(dump, "/IWBEP/I_MGW_SRG").map((r) => [key(r.GROUP_TECH_NAME, r.GROUP_VERSION), r]));
  const ohd = new Map(rows(dump, "/IWBEP/I_MGW_OHD").map((r) => [key(r.TECHNICAL_NAME, r.VERSION), r]));
  const out = [];
  for (const r of rows(dump, "/IWBEP/I_MGW_SRH")) {
    if (str(r.TECHNICAL_NAME) === "" || str(r.VERSION) === "") continue;
    const group = srg.get(key(r.TECHNICAL_NAME, r.VERSION));
    const model = group === undefined ? undefined : ohd.get(key(group.MODEL_TECH_NAME, group.MODEL_VERSION));
    const dpc = up(r.CLASS_NAME);
    const mpc = up(model?.CLASS_NAME);
    if (classes.has(dpc) === false && (mpc === "" || classes.has(mpc) === false)) continue;
    out.push({service: str(r.TECHNICAL_NAME), version: str(r.VERSION), dpc, mpc});
  }
  return out.sort((a, b) => (a.service + a.version < b.service + b.version ? -1 : 1));
}

/** the namespaces the seed holds objects in or is packaged in. */
export function seedNamespaces(dump) {
  const {packages, objects} = seedObjects(dump);
  const out = new Set();
  for (const name of [...packages, ...objects.map((o) => o.name)]) {
    const ns = namespaceOf(name);
    if (ns !== undefined) out.add(ns);
  }
  return out;
}

/** registers exactly the seed's services through hana-segw-gen (--seed,
 *  one --service per row). No service in the seed: nothing is written (a
 *  registration the tree already has stays), and the line says so once.
 *  Returns the services. */
export async function registerSeed({root, dump, say, quiet = false}) {
  const services = seedServices(dump);
  if (services.length === 0) {
    if (quiet === false) say(`seed: no registration row of ${dump} names a seed class -- the registration is left as it is`);
    return services;
  }
  const args = ["--from-dump", dump, "--seed", ...services.flatMap((s) => ["--service", `${s.service}:${s.version}`])];
  const lines = [];
  await segwGen(args, {root, log: (line) => lines.push(String(line))});
  say(`seed: ${services.length} service(s) of the seed registered or guarded (${lines.filter((l) => /: skipped, /.test(l)).length} waiting for their classes)`);
  return services;
}
