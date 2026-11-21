#!/usr/bin/env node
// SEGW registration objects -> the service registry.
//
// A SEGW project leaves three registration objects behind, and abapGit
// serializes them: <service>.iwsv.xml (service group -> model, service ->
// _DPC_EXT class), <model>.iwmo.xml (model -> _MPC_EXT class), plus the hub
// side (IWSG/IWOM) this runtime does not need. Reading them is what makes a
// cloned SEGW repository serve itself: no hand-written registration.
//
// The same writer is fed from a tenant dump (H5b): tools/hana-segw-gen.mjs
// joins the Gateway backend registration tables a system dump carries and
// writes the facts -- from-dump.json (the joined services, the skips, the
// XML overrides) and manifest.json (where they came from) -- in
// gen/hana-segw, a folder of their own: this class is generator output a
// build rewrites mid-build, and a hashed input folder must never hold
// that. Whenever the facts are there (dumpFacts reads them from
// gen/hana-segw), this tool merges them under the XML objects: a
// (service, version) the XML objects also name keeps its XML registration,
// reported as an override, the way the later folder wins a file. While the
// mark exists (gen/hana-segw/from-dump.json), the publishers' gen/ copy
// filters drop gen/segw (tools/osd-tmp.mjs's segwPrivateGen) -- during a
// dump-fed phase the class carries the tenant's service and class names.
//
// Output: gen/segw/zcl_stg_segw_registry.clas.abap with one register() that
// calls zcl_oao_registry=>register for every service whose model has an
// MPC class. abapGit names the files "<technical name padded><version>",
// e.g. "zui5_code_search_srv               0001.iwsv.xml"; the names are
// taken from the XML, not from the file name.
import {existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync} from "node:fs";
import {generatorFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {basename, join} from "node:path";

// Deduplicate readers and live service-tree rows for an ADT class.
export function countServiceRegistrations(readers, rows, className) {
  const ids = new Set(readers.flatMap((reader) => reader.services).map((service) =>
    `/sap/opu/odata/sap/${service}`.toUpperCase()));
  for (const row of rows) {
    if ([row.handler, row.mpc].some((candidate) => String(candidate ?? "").toUpperCase() === className)) {
      ids.add(String(row.path).toUpperCase());
    }
  }
  return ids.size;
}

const OUT = "gen/segw";

function tag(xml, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1].trim() : "";
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) {
        continue;
      }
      walk(full, out);
    } else if (/\.(iwsv|iwmo)\.xml$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// the registrations found below the folders, joined service -> model -> MPC
export function segwRegistrations(folders) {
  const models = new Map();
  const services = [];
  for (const file of winningByLayer(folders, (folder) => walk(folder),
    (file) => basename(file).toLowerCase())) {
    const xml = readFileSync(file, "utf8");
    if (/\.iwmo\.xml$/i.test(file)) {
      const head = /<_-IWBEP_-I_MGW_OHD>[\s\S]*?<\/_-IWBEP_-I_MGW_OHD>/.exec(xml)?.[0] ?? xml;
      models.set(tag(head, "TECHNICAL_NAME") + "/" + tag(head, "VERSION"), {
        model: tag(head, "TECHNICAL_NAME"), version: tag(head, "VERSION"), mpc: tag(head, "CLASS_NAME"), file,
      });
    } else {
      const group = /<_-IWBEP_-I_MGW_SRG>[\s\S]*?<\/_-IWBEP_-I_MGW_SRG>/.exec(xml)?.[0] ?? "";
      const head = /<_-IWBEP_-I_MGW_SRH>[\s\S]*?<\/_-IWBEP_-I_MGW_SRH>/.exec(xml)?.[0] ?? xml;
      services.push({
        service: tag(head, "TECHNICAL_NAME"), version: tag(head, "VERSION"),
        external: tag(head, "EXTERNAL_NAME") || tag(head, "TECHNICAL_NAME"),
        dpc: tag(head, "CLASS_NAME"),
        model: tag(group, "MODEL_TECH_NAME"), modelVersion: tag(group, "MODEL_VERSION"),
        description: tag(xml, "DESCRIPTION"), file,
      });
    }
  }
  return services.map((s) => {
    const model = models.get(s.model + "/" + s.modelVersion);
    return {...s, mpc: model?.mpc ?? "", modelFile: model?.file};
  }).sort((a, b) => {
    const layerOf = (file) => folders.findLastIndex((folder) => file.startsWith(folder + "/"));
    return layerOf(a.file) - layerOf(b.file) || a.service.localeCompare(b.service);
  });
}

// A later valid registration replaces an earlier one for the same endpoint.
// Missing classes cannot replace a handler because the runtime cannot register them.
export function registeredServices(entries) {
  const winners = new Map();
  for (const entry of entries) {
    if (entry.mpc && entry.dpc) {
      winners.set(entry.external.toLowerCase(), entry);
    }
  }
  return [...winners.values()];
}

// one registry out of both sources: a (service, version) the XML objects
// also name keeps its XML registration -- the later source wins, the way
// the later folder wins a file -- and the overridden dump registrations are
// returned for the report. The kept dump entries go in front of the XML
// ones, so for a URL endpoint both sources name, registeredServices sees
// the XML registration last and it wins there too; the XML side's own order
// (layer order, then service) is preserved.
export function mergeRegistrations(xmlEntries, dumpEntries) {
  const xml = new Map(xmlEntries.map((e) => [`${e.service}/${e.version}`, e]));
  const entries = [];
  const overrides = [];
  for (const e of dumpEntries) {
    if (xml.has(`${e.service}/${e.version}`)) {
      overrides.push({service: e.service, version: e.version, kept: "xml"});
      continue;
    }
    entries.push({...e, source: "dump"});
  }
  entries.push(...xmlEntries);
  overrides.sort((a, b) => a.service.localeCompare(b.service) || a.version.localeCompare(b.version));
  return {entries, overrides};
}

// the dump facts tools/hana-segw-gen.mjs wrote (its own folder, NOT
// gen/segw -- the class there is generator output a build rewrites
// mid-build, and a hashed input folder must never hold that), or undefined
// when the registry has no dump side. A half-written pair refuses: the
// facts are what marks the dump-fed phase (tools/osd-tmp.mjs
// segwPrivateGen drops gen/segw from every publisher while they exist), and
// a facts file without its manifest would say nothing about where it came
// from.
export function dumpFacts(factsDir = join(OUT, "..", "hana-segw")) {
  const manifestAt = join(factsDir, "manifest.json");
  const factsAt = join(factsDir, "from-dump.json");
  const hasManifest = existsSync(manifestAt);
  const hasFacts = existsSync(factsAt);
  if (hasManifest === false && hasFacts === false) return undefined;
  if (hasManifest === false || hasFacts === false) {
    throw new Error(`segw-registry: ${factsDir} holds only ${hasManifest ? "manifest.json" : "from-dump.json"} -- ${hasManifest ? "from-dump.json" : "manifest.json"} is missing; the pair is written together by tools/hana-segw-gen.mjs, so remove both or regenerate with it`);
  }
  const facts = JSON.parse(readFileSync(factsAt, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestAt, "utf8"));
  return {...facts, manifest, source: manifest.source};
}

export function registryClass(entries) {
  const skipped = entries.filter((e) => !e.mpc || !e.dpc).map((e) =>
    `* ${e.service}: ${!e.mpc ? "no IWMO for model " + e.model : "no DPC class"}, not registered`);
  const lines = registeredServices(entries).map((e) =>
    `    zcl_oao_registry=>register( iv_service = '${e.external}'
                                iv_mpc     = '${e.mpc}'
                                iv_dpc     = '${e.dpc}' ). " ${e.description}`);
  return `CLASS zcl_stg_segw_registry DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/segw-registry.mjs from the IWSV/IWMO objects - do not edit
  PUBLIC SECTION.
    CLASS-METHODS register.
ENDCLASS.

CLASS zcl_stg_segw_registry IMPLEMENTATION.

  METHOD register.
${[...skipped, ...lines].join("\n")}
  ENDMETHOD.

ENDCLASS.
`;
}

if (process.argv[1] && /segw-registry\.mjs$/.test(process.argv[1])) {
  const folders = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const list = process.argv.includes("--list");
  const facts = dumpFacts();
  let entries = segwRegistrations(folders.length > 0 ? folders : generatorFoldersOf(process.env.OSD_ROOT ?? process.cwd()));
  if (facts !== undefined) {
    const merged = mergeRegistrations(entries, facts.services);
    for (const o of merged.overrides) {
      console.log(`segw-registry: ${o.service}/${o.version}: dump registration overridden by the XML objects, the way the later layer wins`);
    }
    entries = merged.entries;
  }
  for (const e of entries) {
    console.log(`segw-registry: ${e.external} -> MPC ${e.mpc || "?"}, DPC ${e.dpc || "?"}${e.description ? " (" + e.description + ")" : ""}${e.source === "dump" ? " [dump]" : ""}`);
  }
  if (!list) {
    mkdirSync(OUT, {recursive: true});
    writeFileSync(join(OUT, "zcl_stg_segw_registry.clas.abap"), registryClass(entries));
  }
}
