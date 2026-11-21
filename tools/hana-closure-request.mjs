// The closure request (H5c): the TADIR kinds a name is asked under and the
// request file the dumper's reader reads. Carved out of tools/hana-closure.mjs
// (milestone 3, the search helps): the loop module was at its size ceiling,
// and the request is the part with its own contract.
import {readFileSync} from "node:fs";
import {join} from "node:path";

// the ten TADIR kinds, in the order the request file lists them: VIEW since
// milestone 3 -- a search help's selection method can be a view (a help
// view), and the dumper's dictionary closure follows VIEW (DD25L/DD26S/DD27S)
// like the other dictionary kinds
export const TADIR = ["TABL", "DTEL", "DOMA", "TTYP", "SHLP", "VIEW", "CLAS", "INTF", "FUGR", "PROG"];

/** the TADIR kinds a classified name is requested under. A `ddic` name has
 *  no kind of its own -- the transpiler's wording says only that the type
 *  is unknown -- so it is asked under every dictionary kind the dumper
 *  resolves by name: TABL, DTEL and TTYP, plus SHLP when the finding's
 *  message says search help -- the message only, never the raw line (the
 *  raw ends in the file name, and a file called *searchhelpexits* must not
 *  classify). The dumper resolves what exists and reports
 *  the rest in its manifest's `closure.missing`, which the loop reads into
 *  the gaps. Pure. */
export function tadirKinds(kind, finding) {
  if (kind === "ddic") {
    // H5x-2: the structural ask carries no DOMA precision (the UnknownType's
    // error text says `lookup` for every kind-less miss), so the kind-less
    // triple grew DOMA -- the dumper answers what exists, per kind
    const kinds = ["TABL", "DTEL", "TTYP", "DOMA"];
    if (/search[ -]?help/i.test(String(finding ?? ""))) kinds.push("SHLP");
    return kinds;
  }
  // shlp and view (milestone 3): a search help a service hands to the
  // /IWBEP/ API by name, and what an arrived help selects from
  const of = {tabl: "TABL", dtel: "DTEL", doma: "DOMA", ttyp: "TTYP", shlp: "SHLP", view: "VIEW", clas: "CLAS", intf: "INTF", fugr: "FUGR"};
  return [of[kind] ?? "PROG"];
}

/** the request file's content, schema 1 -- exactly the keys the dumper's
 *  reader reads (`schema`, `iteration`, `requested`, `seen`; the rest is
 *  provenance for the walk): the fresh names per kind, every name an
 *  earlier iteration asked under the kinds it was requested under (so the
 *  dumper skips it), and the current gaps. `deferred` -- the stubbed
 *  methods' code names, only with --stub-unresolved -- and `excluded` --
 *  the definition-level exclusions' objects, never under deferred -- are
 *  OPTIONAL keys: the dumper's reader takes requested/seen and ignores
 *  unknown keys, so the file stays schema 1 with them beside. Pure. */
export function requestFor({iteration, generation, fresh, asked, gaps, deferred, excluded}) {
  const perKind = () => {
    const kinds = {};
    for (const kind of TADIR) kinds[kind] = [];
    return kinds;
  };
  const requested = perKind();
  for (const n of fresh ?? []) {
    for (const kind of tadirKinds(n.kind, n.message ?? n.finding)) {
      if (requested[kind].includes(n.name) === false) requested[kind].push(n.name);
    }
  }
  const seen = perKind();
  for (const [name, a] of Object.entries(asked ?? {})) {
    const kinds = a.kinds ?? [String(a.kind ?? "").toUpperCase()].filter((k) => k !== "");
    for (const kind of kinds) {
      if (seen[kind] !== undefined && seen[kind].includes(name) === false) seen[kind].push(name);
    }
  }
  const result = {
    schema: 1,
    iteration,
    generation: generation ?? "",
    source: "transpile validate() findings",
    requested,
    seen,
    gaps: (gaps ?? []).map((g) => ({name: g.name, kind: g.kind, first_finding: g.first_finding, iterations_requested: g.iterations_requested})),
  };
  if (deferred !== undefined) {
    const list = perKind();
    for (const n of deferred) {
      for (const kind of tadirKinds(n.kind, n.message ?? n.finding)) {
        if (list[kind].includes(n.name) === false) list[kind].push(n.name);
      }
    }
    result.deferred = list;
  }
  if (excluded !== undefined && excluded.length > 0) {
    const list = perKind();
    for (const n of excluded) {
      for (const kind of tadirKinds(n.kind, n.message ?? n.finding)) {
        if (list[kind].includes(n.name) === false) list[kind].push(n.name);
      }
    }
    result.excluded = list;
  }
  return result;
}

/** the dump's answer to the request (moved out of tools/hana-closure.mjs,
 *  milestone 4: the loop module was at its size ceiling): what the dump's
 *  own manifest says the dictionary answered, read on every continuation.
 *  Every name in closure.missing (the requested names the dictionary does
 *  not have) joins state.missing with the kind it is missing under; a name
 *  a later round reports resolved leaves it. The answer is PER KIND -- a
 *  kind-less name is asked under TABL, DTEL and TTYP, and a name that
 *  resolved under one of them is one the dictionary HAS: `missing` under
 *  the other two is not "does not exist". The resolved names accumulate per
 *  kind in state.resolved (round 7: the per-name DDIC fill and the
 *  iteration line read them across all dumps). The kinds the dumper's
 *  closure does not follow (`closure.unhandled`) make a gap with the reason
 *  unless a kind's missing already said does-not-exist or a round resolved
 *  it. A dump without a manifest answers nothing. Mutates state. */
export function readDumpAnswer(state, dump) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dump, "manifest.json"), "utf8"));
  } catch {
    return;
  }
  const resolved = new Set();
  state.resolved ??= {};
  for (const [kind, list] of Object.entries(manifest.closure?.resolved ?? {})) {
    state.resolved[kind] = [...new Set([...(state.resolved[kind] ?? []),
      ...list.map((n) => String(n).trim().toUpperCase())])];
    for (const name of state.resolved[kind]) resolved.add(name);
  }
  for (const name of resolved) delete state.missing[name];
  for (const [kind, list] of Object.entries(manifest.closure?.missing ?? {})) {
    for (const name of list) {
      const upper = String(name).trim().toUpperCase();
      if (state.asked[upper] !== undefined && resolved.has(upper) === false) {
        state.missing[upper] = {kind, iteration: state.asked[upper].iteration};
      }
    }
  }
  for (const [kind, list] of Object.entries(manifest.closure?.unhandled ?? {})) {
    for (const name of list) {
      const upper = String(name).trim().toUpperCase();
      if (state.asked[upper] !== undefined && resolved.has(upper) === false && state.missing[upper] === undefined) {
        state.missing[upper] = {kind, iteration: state.asked[upper].iteration, reason: "unhandled by the dumper's closure"};
      }
    }
  }
}
