// R10 (docs/rap-runtime.md, "Path elements"): CDS path elements, `_A._B.X as
// Y [: localized]`, for tools/cds2ddic.mjs and tools/rap/bdef-gen.mjs.
//
//   resolvePaths(views, byName)   walks each path over the parsed views and
//                                 types it from the element it ends in
//   pathClass(view)               the ABAP class that fills them after a read
//
// parseDDLS (cds2ddic.mjs) records a path element as a calculated element
// with `path: {source, hops, element, localized}`; tools/cds-tree.mjs calls
// resolvePaths as the last pass of resolveTree. The class it writes uses
// ZCL_STG_CDS_PATH (src/sadl) for a draft row's first hop. Depends on
// tools/cds-names.mjs only.
import {classNameOf} from "./cds-names.mjs";

/** the calculated element parseDDLS records for `_A._B[1: L = $session.
 *  system_language].Element as Alias [: localized]` (TEXT: its token text) */
export function pathElement(srcName, alias, annos, text, sqlView) {
  // a hop may carry a filter, `_Text[1: Language = $session.system_language]`
  const element = srcName.slice(srcName.lastIndexOf(".") + 1);
  const hops = [...srcName.slice(0, srcName.lastIndexOf(".")).matchAll(/_?\w+(\[[^\]]*\])?/g)].map((m) => m[0]);
  const name = (alias ?? element).toUpperCase();
  const label = annos.map((a) => /@EndUserText\.label:\s*'([^']*)'/.exec(a)?.[1]).find(Boolean);
  return {name, element: alias ?? element, base: "", key: false, virtual: true,
    calculatedBy: classNameOf("ZCL_STG_CDS_", sqlView, "_P"), label: label ?? name, annotations: annos,
    path: {source: srcName, hops, element: element.toUpperCase(), localized: /:\s*localized\b/i.test(text)}};
}

/** R10 (docs/rap-runtime.md, "Path elements"): each path element of a view,
 *  `_A._B.Element [: localized]`, walked over the associations it names: per
 *  hop the target view, the pairs (source element = target element) and the
 *  language element of the target when the element is localized (its
 *  @Semantics.language key) or the hop is filtered by
 *  `[1: X = $session.system_language]`, compared with the logon language.
 *  A hop a projection does not expose is its base's association, its pair
 *  sources renamed through the projection. The element it ends in gives the
 *  type. A path that does not resolve is taken out of the view's fields
 *  (droppedPaths, with why) -- not served, as before R10 -- and counted with
 *  the exposed associations, where an element without a column always went */
export function resolvePaths(views, byName) {
  const language = (v) => (v.fields ?? []).find((f) => (f.annotations ?? []).some((a) => /@Semantics\.language:\s*true/i.test(a)))?.name;
  for (const view of views) {
    for (const f of [...(view.fields ?? [])]) {
      if (!f.path) continue;
      let current = view;
      const steps = [];
      let why;
      for (const raw of f.path.hops) {
        const hop = raw.replace(/\[.*$/, "");
        const filter = /\[\s*(?:\d+\s*:)?\s*(\w+)\s*=\s*\$session\.system_language\s*\]/i.exec(raw)?.[1];
        if (raw.includes("[") && !filter) { why = `${raw}: a filter other than [1: x = $session.system_language]`; break; }
        let a = (current.associations ?? []).find((x) => String(x.alias).toUpperCase() === hop.toUpperCase());
        let rename = (n) => n;
        // a hop the view does not expose is the association of the view it
        // reads (its projection base, or the CDS view it selects from)
        const base = byName.get(String(current.projectionOf ?? current.source ?? "").toUpperCase());
        if (!a && base) {
          const own = current;
          a = (base.associations ?? []).find((x) => String(x.alias).toUpperCase() === hop.toUpperCase());
          rename = (n) => own.fields.find((x) => !x.virtual && (own.projectionOf ? x.fromElement : String(x.base ?? "").toUpperCase()) === String(n).toUpperCase())?.name;
        }
        const target = a && byName.get(String(a.target ?? "").toUpperCase());
        if (!a) { why = `${hop} is no association of ${current.name}`; break; }
        if (!target || target.skip) { why = `${hop} ends in ${a.target}, which is not a generated CDS view`; break; }
        const pairs = (a.pairs ?? []).map((p) => ({source: rename(String(p.source).toUpperCase()), target: String(p.target).toUpperCase()}));
        if (!pairs.length || pairs.some((p) => !p.source)) { why = `${hop} of ${current.name} has no key pairs here`; break; }
        const lang = filter ? filter.toUpperCase() : f.path.localized ? language(target) : undefined;
        // a hop to many is one row only through the language (a text
        // association); any other would read an arbitrary one of its rows
        if (!lang && a.max !== undefined && a.max !== "1" && a.max !== "0") { why = `${hop} of ${current.name} is to-many [${a.min ?? "0"}..${a.max}] without a language condition`; break; }
        steps.push({assoc: hop, target: target.name.toUpperCase(), sqlView: target.sqlView.toUpperCase(), pairs, language: lang});
        current = target;
      }
      const end = why ? undefined : (current.fields ?? []).find((x) => x.name === f.path.element && !x.virtual);
      if (!why && !end) why = `${f.path.element} is no column element of ${current.name}`;
      if (!why && !end.typeABAP) why = `${current.name}.${end.name} has no ABAP type here`;
      if (why) {
        view.fields.splice(view.fields.indexOf(f), 1);
        view.droppedPaths = [...(view.droppedPaths ?? []), {name: f.name, why}];
        view.exposedAssociations = [...(view.exposedAssociations ?? []), f.path.source];
        continue;
      }
      Object.assign(f, {abapType: end.typeABAP, edm: end.edm, maxlength: end.maxlength, precision: end.precision, scale: end.scale});
      f.path.steps = steps;
    }
  }
  return views;
}

// R10 (docs/rap-runtime.md, "Path elements"): the class that fills a view's
// path elements after the read, one SELECT SINGLE per hop over the target's
// SQL view, keyed by the pairs of the association (and the logon language
// for a localized element). A row of a draft (ISACTIVEENTITY there and
// initial) reads its first hop from the target's draft table when the target
// is an entity of a draft-enabled business object (ZCL_STG_CDS_PATH): the
// text a draft has is the draft's text.
export function pathClass(e) {
  const cls = classNameOf("zcl_stg_cds_", e.sqlView, "_p").toLowerCase();
  const paths = e.fields.filter((f) => f.path);
  const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;
  const methods = paths.map((f, i) => {
    const steps = f.path.steps;
    let body = "";
    steps.forEach((st, k) => {
      const from = k === 0 ? "cs_row" : `ls_h${k}`;
      body += `* ${k === 0 ? e.name : steps[k - 1].target}\\${st.assoc} -> ${st.target}\n`;
      body += `    lv_table = ${lit(st.sqlView)}.\n`;
      if (k === 0) body += `    IF zcl_stg_cds_path=>is_draft( cs_row ) = abap_true.\n      lv_table = zcl_stg_cds_path=>draft_table( iv_entity = ${lit(st.target)} iv_default = lv_table ).\n    ENDIF.\n`;
      const conds = st.pairs.map((p, j) => {
        body += `    ASSIGN COMPONENT ${lit(p.source)} OF STRUCTURE ${from} TO <lv_k${j}>.\n    IF sy-subrc <> 0.\n      RETURN.\n    ENDIF.\n`;
        return `${p.target.toLowerCase()} = <lv_k${j}>`;
      });
      if (st.language) conds.push(`${st.language.toLowerCase()} = sy-langu`);
      body += `    SELECT SINGLE * FROM (lv_table) INTO CORRESPONDING FIELDS OF ls_h${k + 1}\n      WHERE ${conds.join("\n        AND ")}.\n    IF sy-subrc <> 0.\n      RETURN.\n    ENDIF.\n`;
    });
    const n = steps.length;
    const decl = steps.map((st, k) => `    DATA ls_h${k + 1} TYPE ${st.sqlView.toLowerCase()}.\n`).join("");
    const keys = Math.max(...steps.map((st) => st.pairs.length));
    return {name: `p${i}`, field: f.name, code: `  METHOD p${i}.
* ${f.name} = ${f.path.hops.join(".")}.${f.path.element}${f.path.localized ? " (localized)" : ""}
    DATA lv_table TYPE string.
${decl}${Array.from({length: keys}, (_, j) => `    FIELD-SYMBOLS <lv_k${j}> TYPE any.\n`).join("")}    FIELD-SYMBOLS <lv_out> TYPE any.

    ASSIGN COMPONENT ${lit(f.name)} OF STRUCTURE cs_row TO <lv_out>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    CLEAR <lv_out>.
${body}    <lv_out> = ls_h${n}-${f.path.element.toLowerCase()}.
  ENDMETHOD.
`};
  });
  return `CLASS ${cls} DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/cds2ddic.mjs from ${e.name} - do not edit
* (docs/rap-runtime.md, "Path elements"): the elements of ${e.name} read
* through associations, filled after the read
  PUBLIC SECTION.
    INTERFACES if_sadl_exit_calc_element_read.
  PRIVATE SECTION.
${methods.map((m) => `    METHODS ${m.name}\n      CHANGING\n        cs_row TYPE any.\n`).join("")}ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD if_sadl_exit_calc_element_read~get_calculation_info.
    DATA ls_element TYPE if_sadl_exit=>ty_s_element_info.
${[...new Set(paths.flatMap((f) => f.path.steps[0].pairs.map((p) => p.source)))].map((n) => `    ls_element-name = ${lit(n)}.\n    APPEND ls_element TO ct_requested_orig_elements.\n`).join("")}  ENDMETHOD.

  METHOD if_sadl_exit_calc_element_read~calculate.
    DATA ls_element TYPE if_sadl_exit=>ty_s_element_info.
    FIELD-SYMBOLS <ls_row> TYPE any.

    LOOP AT ct_calculated_data ASSIGNING <ls_row>.
      LOOP AT it_requested_calc_elements INTO ls_element.
        CASE ls_element-name.
${methods.map((m) => `          WHEN ${lit(m.field)}.\n            ${m.name}( CHANGING cs_row = <ls_row> ).\n`).join("")}        ENDCASE.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

${methods.map((m) => m.code).join("\n")}
ENDCLASS.
`;
}

