// R5 (docs/rap-runtime.md, "R5"): the CDS side of a RAP business object as
// a tree, and of a projection over it, for tools/cds2ddic.mjs.
//
//   composition [0..*] of ZI_CHILD as _Child           a part of this entity
//   association to parent ZI_ROOT as _Root on ...       the child's way up
//   define view entity ZC_X as projection on ZI_X {     a projection: read as
//     key a as A, _Child : redirected to composition    the base view's table,
//     child ZC_CHILD }                                  one hop, redirected
//
// A composition has no ON condition: its pairs are the reverse of the
// child's to-parent association (resolveCompositions, once every view is
// parsed). A projection's association is its base's, re-pointed where it is
// redirected, its pairs renamed through the projections at both ends
// (resolveProjections). parseDDLS stays the one reader of a view; this
// module only knows the shapes above.

/** abaplint's token text spells a namespace `/ DMO / I_X`: one name again */
export function namespaced(text) {
  return String(text).replace(/\/\s*(\w+)\s*\/\s*/g, "/$1/");
}

/** the base of a projection view, parsed (or a skip naming why not) */
export function projectionBase(tree, reg, name, depth, parseDDLS) {
  const names = (tree.getChildren?.() ?? []).filter((c) => c.get?.().constructor?.name === "CDSName");
  const base = (names[1]?.concatTokens?.() ?? "").replace(/\s+/g, "").toUpperCase();
  const object = depth < 8 ? reg.getObject("DDLS", base) : undefined;
  if (object === undefined) return {name, skip: `a projection on ${base}, which is not a CDS view of this system`};
  const parsed = parseDDLS(object, reg, depth + 1);
  if (parsed === undefined || parsed.skip) return {name, skip: `a projection on ${base}, which is not generated (${parsed?.skip ?? "no parse tree"})`};
  return parsed;
}

/** `_X : redirected to [parent|composition child] ZC_Y` -> ZC_Y */
export function redirectOf(text) {
  return /:\s*redirected\s+to\s+(?:parent\s+|composition\s+child\s+)?([\w/]+)/i.exec(namespaced(text))?.[1]?.toUpperCase();
}

/** the compositions a view declares, from the token text of each */
export function compositionsOf(texts, exposed) {
  return texts.map((text) => {
    const toks = namespaced(text).replace(/\s+/g, " ");
    const m = /\[\s*(\d+)\s*\.\s*\.\s*(\d+|\*)\s*\]/.exec(toks);
    const rel = /\bof\s+([\w/]+)(?:\s+as\s+([\w/]+))?/i.exec(toks.replace(/\bof\s+\[[^\]]*\]/i, "of"));
    const target = rel?.[1]?.toUpperCase();
    const alias = rel?.[2] ?? target;
    return {alias, target, min: m?.[1] ?? "0", max: m?.[2] ?? "*", pairs: [], exposed: exposed.includes(alias), composition: "CHILD"};
  });
}

/** a projection's associations: its base's, by the elements it exposes */
export function projectedAssociations(base, exposed, redirects, own) {
  const out = [];
  for (const alias of exposed) {
    if (own.some((a) => a.alias === alias)) continue;
    const a = base.associations.find((x) => x.alias === alias);
    if (a === undefined) continue;
    out.push({...a, target: redirects.get(alias) ?? a.target, pairs: [], exposed: true,
      projectedFrom: {view: base.name, target: a.target}});
  }
  return out;
}

/** the pairs of each composition: the reverse of the child's way up. A
 *  composition whose child declares no association to parent back to this
 *  view keeps none, and nothing navigates or cascades over it */
export function resolveCompositions(views, byName) {
  for (const view of views) {
    for (const a of view.associations ?? []) {
      if (a.composition !== "CHILD" || (a.pairs ?? []).length > 0 || a.projectedFrom) continue;
      const child = byName.get(String(a.target ?? "").toUpperCase());
      const up = (child?.associations ?? []).find((x) => x.composition === "PARENT" && String(x.target).toUpperCase() === view.name.toUpperCase());
      if (up !== undefined) a.pairs = up.pairs.map((p) => ({source: p.target, target: p.source}));
    }
  }
  return views;
}

/** the pairs of each projected association, renamed through both ends: a
 *  pair names base elements, each projection says which of its elements a
 *  base element became. One that is not exposed leaves the association
 *  unresolved (unresolvedAssociations), not half-renamed */
export function resolveProjections(views, byName) {
  const nameIn = (view, element) => (view === undefined ? undefined : view.projectionOf === undefined ? element
    : view.fields.find((f) => f.fromElement === String(element).toUpperCase())?.name);
  for (const view of views) {
    for (const a of view.associations ?? []) {
      if (!a.projectedFrom) continue;
      const own = (byName.get(a.projectedFrom.view.toUpperCase())?.associations ?? []).find((x) => x.alias === a.alias);
      const target = byName.get(String(a.target).toUpperCase());
      const pairs = (own?.pairs ?? []).map((p) => ({source: nameIn(view, p.source), target: nameIn(target, p.target)}));
      if (pairs.length === 0 || pairs.some((p) => p.source === undefined || p.target === undefined)) {
        view.unresolvedAssociations = [...(view.unresolvedAssociations ?? []), a.alias];
        a.pairs = [];
      } else a.pairs = pairs;
    }
  }
  return views;
}

/** both passes, in their order: the compositions, then the projections of
 *  them; R10: then the path elements, which walk both */
import {resolvePaths} from "./cds-path.mjs";
export function resolveTree(views, byName) {
  resolveCompositions(views, byName);
  resolveProjections(views, byName);
  return resolvePaths(views, byName);
}
