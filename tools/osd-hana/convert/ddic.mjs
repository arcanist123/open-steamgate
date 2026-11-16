// The dictionary in abapGit's shape, from the dump's DD* rows. The element
// ORDER is the DDIC structure order -- what abapGit writes, because it
// serializes the DDIC structures themselves (CALL TRANSFORMATION id). Where
// the order is decided on evidence, the evidence is abapGit's own tracked
// `.tabl.xml` files (39 files, 491 DD03P items) and this repository's
// abapGit-shaped `src/**/*.xml`; every deviation from those is listed in
// REPORT.md.
//
// abapGit's clearing rules are applied (zcl_abapgit_object_tabl
// clear_dd03p_fields): no AS4* stamps of user/date/time, no positions, no
// TABNAME/DDLANGUAGE copies, data-element fields without the type they take
// from the element, no nested (DEPTH <> 00) or included (ADMINFIELD <> 0)
// fields, ROWORCOLST = 'C' cleared (a field that does not exist on all
// releases; abapGit clears it on serialize to avoid spurious diffs).
import {xmlEscape, key, initial, elems, node, leaf, abapgitXmlDoc} from "./xml.mjs";

export const DD02V = ["TABNAME","DDLANGUAGE","TABCLASS","SQLTAB","DATMIN","DATMAX","DATAVG","CLIDEP","BUFFERED","COMPRFLAG","LANGDEP","DDTEXT","ACTFLAG","APPLCLASS","AUTHCLASS","MASTERLANG","MAINFLAG","CONTFLAG","RESERVETAB","GLOBALFLAG","PROZPUFF","VIEWREF","MULTIPLEX","SHLPEXI","VIEWGRANT","EXCLASS"];
export const DD09L = ["TABNAME","AS4LOCAL","TABKAT","TABART","PUFFERUNG","SCHFELDANZ","PROTOKOLL","BUFALLOW","ROWORCOLST"];
// DD03P order: FIELDNAME KEYFLAG [MANDATORY] ROLLNAME [CHECKTABLE] ADMINFIELD
// INTTYPE INTLEN [REFTABLE PRECFIELD REFFIELD CONROUT] [NOTNULL] [DOMNAME]
// DATATYPE LENG DECIMALS MASK [VALEXI] SHLPORIGIN ... COMPTYPE. The order of
// FIELDNAME..COMPTYPE is as abapGit's own files write it (NOTNULL after
// INTLEN, MASK after LENG, COMPTYPE last); MASK itself is never written by us
// -- the dump's DD03L rows do not carry the column (listed in REPORT.md).
export const DD03P = ["FIELDNAME","KEYFLAG","MANDATORY","ROLLNAME","CHECKTABLE","ADMINFIELD","INTTYPE","INTLEN","REFTABLE","PRECFIELD","REFFIELD","CONROUT","NOTNULL","DOMNAME","DATATYPE","LENG","DECIMALS","VALEXI","SHLPORIGIN","TABLETYPE","DEPTH","COMPTYPE","REFTYPE","LANGUFLAG","DBPOSITION","ANONYMOUS","OUTPUTSTYLE"];
const BY_ELEMENT = ["DOMNAME","INTTYPE","INTLEN","DATATYPE","LENG","DECIMALS"];
export const DD04V = ["ROLLNAME","DDLANGUAGE","DOMNAME","ROUTPUTLEN","MEMORYID","LOGFLAG","HEADLEN","SCRLEN1","SCRLEN2","SCRLEN3","DDTEXT","REPTEXT","SCRTEXT_S","SCRTEXT_M","SCRTEXT_L","DTELMASTER","RESERVEDTE","DATATYPE","LENG","OUTPUTLEN","DECIMALS","LOWERCASE","SIGNFLAG","CONVEXIT","VALEXI","ENTITYTAB","REFKIND","REFTYPE","PROXYTYPE","LTRFLDDIS","BIDICTRLC","NOHISTORY"];
export const DD01V = ["DOMNAME","DDLANGUAGE","DATATYPE","LENG","OUTPUTLEN","DECIMALS","LOWERCASE","SIGNFLAG","LANGFLAG","VALEXI","ENTITYTAB","CONVEXIT","DDTEXT","DOMMASTER"];
export const DD07V = ["DOMNAME","VALPOS","DDLANGUAGE","DOMVALUE_L","DOMVALUE_H","DDTEXT"];
export const DD40V = ["TYPENAME","DDLANGUAGE","ROWTYPE","ROWKIND","DATATYPE","LENG","DECIMALS","ACCESSMODE","KEYDEF","KEYKIND","KEYFDCOUNT","GENERIC","TYPELEN","DDTEXT"];

function container(tag, order, row) {
  const children = order
    .filter((k) => !initial(k, row[k]))
    .map((k) => leaf(k, String(row[k]).trim()));
  return node(tag, children);
}

function ddicXml(type, values) {
  return abapgitXmlDoc(`LCL_OBJECT_${type}`, values);
}

export function tablXml(head, settings, fields) {
  const values = [container("DD02V", DD02V, head)];
  if (settings) {
    const s = {...settings};
    // abapGit zif_abapgit_object~serialize: ROWORCOLST = 'C' is cleared "to
    // avoid diff errors. This field doesn't exist in all releases."
    if (key(s.ROWORCOLST) === "C") delete s.ROWORCOLST;
    values.push(container("DD09L", DD09L, s));
  }
  const rows = fields
    .filter((f) => /^0*$/.test(String(f.DEPTH ?? "").trim()) && String(f.ADMINFIELD ?? "0").trim() === "0")
    .sort((a, b) => Number(a.POSITION || 0) - Number(b.POSITION || 0))
    .map((f) => {
      const r = {...f, ADMINFIELD: String(f.ADMINFIELD ?? "").trim() || "0"};
      if (String(f.ROLLNAME ?? "").trim() && key(f.COMPTYPE) === "E") {
        for (const k of BY_ELEMENT) delete r[k];
      }
      return container("DD03P", DD03P, r);
    });
  if (rows.length) values.push(node("DD03P_TABLE", rows));
  return ddicXml("TABL", values);
}

export function dtelXml(row) {
  return ddicXml("DTEL", [container("DD04V", DD04V, row)]);
}

export function domaXml(head, values7) {
  const values = [container("DD01V", DD01V, head)];
  const items = [...values7]
    .sort((a, b) => Number(a.VALPOS || 0) - Number(b.VALPOS || 0))
    .map((v) => container("DD07V", DD07V, v));
  if (items.length) values.push(node("DD07V_TAB", items));
  return ddicXml("DOMA", values);
}

export function ttypXml(row) {
  return ddicXml("TTYP", [container("DD40V", DD40V, row)]);
}

// abapGit's .shlp.xml (zcl_abapgit_object_shlp): DD30V, then DD31V_TABLE
// (included helps of a collective help), DD32P_TABLE (parameters) and
// DD33V_TABLE (parameter assignments), each without AS4* stamps.
export const DD30V = ["SHLPNAME","DDLANGUAGE","DDTEXT","ISSIMPLE","ELEMEXI","NOFIELDS","ATTACHEXI","SELMETHOD","SELMTYPE","TEXTTAB","SELMEXIT","HOTKEY","DIALOGTYPE","AUTOSUGGEST","FUZZY_SEARCH","FUZZY_SIMILARITY"];
export const DD31V = ["SHLPNAME","SUBSHLP","SHPOSITION","VIASHLP","HIDEFLAG"];
// DD32P: abapGit clears DATATYPE/LENG/DECIMALS (they come from the data
// element) and writes SCRLEN3, which the DD32P view joins from DD04L -- the
// dump's DD32S rows do not carry it, so it is left out (a known diff, listed
// in REPORT.md).
export const DD32P = ["SHLPNAME","FIELDNAME","FLPOSITION","ROLLNAME","SHLPINPUT","SHLPOUTPUT","SHLPSELPOS","SHLPSELDIS","SHLPLISPOS","SHLPUPPER","DEFAULTVAL","DEFAULTTYP","SQLTAB","INDEXNAME","ROLLCHANGE"];
export const DD33V = ["SHLPNAME","FIELDNAME","SUBSHLP","SUBFIELD","DEFAULTVAL","DEFAULTTYP","VALUEDIREC"];

export function shlpXml(head, includes, params, assigns) {
  // FUZZY_SIMILARITY is a decimal: zero is initial, and dumps before vsp's
  // decimal fix hold {} for it, which says nothing
  const h = {...head};
  const fz = h.FUZZY_SIMILARITY;
  if (typeof fz === "object" || /^0*(\.0*)?$/.test(String(fz ?? "").trim())) delete h.FUZZY_SIMILARITY;
  const values = [container("DD30V", DD30V, h)];
  const table = (tag, item, order, list, sort) => {
    if (!list.length) return undefined;
    return node(tag, [...list].sort(sort).map((r) => container(item, order, r)));
  };
  values.push(table("DD31V_TABLE", "DD31V", DD31V, includes, (a, b) => Number(a.SHPOSITION || 0) - Number(b.SHPOSITION || 0)));
  values.push(table("DD32P_TABLE", "DD32P", DD32P, params, (a, b) => Number(a.FLPOSITION || 0) - Number(b.FLPOSITION || 0)));
  values.push(table("DD33V_TABLE", "DD33V", DD33V, assigns, (a, b) => `${key(a.FIELDNAME)}:${key(a.SUBSHLP)}`.localeCompare(`${key(b.FIELDNAME)}:${key(b.SUBSHLP)}`)));
  return ddicXml("SHLP", values.filter((v) => v !== undefined));
}

// abapGit's .view.xml (zcl_abapgit_object_view): DD25V without the AS4*
// stamps and ACTFLAG; DD09L when the view has technical settings;
// DD26V_TABLE (base tables and the foreign keys that join them); DD27P_TABLE
// (fields: abapGit clears VIEWNAME, OBJPOS, DDLANGUAGE, ROLLNAME, the texts
// and what the data element gives, and keeps ROLLNAMEVI only when ROLLCHANGE
// is set; CHECKTABLE and SHLPORIGIN come from the base field, LOGFLAG from
// the data element, VALEXI from its domain -- the caller joins them in);
// DD28J_TABLE (a database view's joins: DD28S stores each as a JL row and the
// JR row after it); DD28V_TABLE (the other DD28S rows, positions kept; a JL
// or JR row without its partner stays here rather than be lost).
export const DD25V = ["VIEWNAME","AS4LOCAL","AS4VERS","DDLANGUAGE","AGGTYPE","APPLCLASS","AUTHCLASS","READONLY","ROOTTAB","DDTEXT","VIEWCLASS","MASTERLANG","CUSTOMAUTH","VIEWGRANT","GLOBALFLAG","MANKEY","DBREFNAME","ALLDATAINCL","WITH_PARAMETERS","EXVIEW_INCLUDED","EXPR_IS_USED","KEYMAX_FEATURE","KEYLEN_FEATURE","TABLEN_FEATURE","NONTRP_INCLUDED","VIEWREF","VIEWREF_ERR","VIEWREF_POS_CHG","TBFUNC_INCLUDED","SESSION_VAR_EX","COMPRFLAG","USED_SESSION_VARS","SHLPEXI","HDB_ONLY_ENTITY_INCLUDED","ABAP_LANGUAGE_VERSION"];
export const DD26V = ["VIEWNAME","TABNAME","TABPOS","FORTABNAME","FORFIELD","FORDIR"];
export const DD27P = ["VIEWFIELD","TABNAME","FIELDNAME","KEYFLAG","MCFIELDID","EFORM","ROLLNAMEVI","ROLLCHANGE","ENQMODE","RDONLY","CHECKTABLE","SHLPORIGIN","SHLPNAME","SHLPFIELD","REFTABLE","REFFIELD","LOGFLAG","VALEXI","PROXYTYPE","LTRFLDDIS","BIDICTRLC","OUTPUTSTYLE","NOHISTORY","AMPMFORMAT","DBVIEWFIELD","EXVDATATYPE","EXVFLENGTH","EXVDECIMALS","SQL_PASSVALUE"];
export const DD28J = ["VIEWNAME","LTAB","LFIELD","OPERATOR","RTAB","RFIELD","SOURCE","FRKTAB","FRKFIELD","FRKDIR","VOPERATOR","JOPERATOR","JCONSTANT","AND_OR","JSOURCE"];
export const DD28V = ["CONDNAME","POSITION","TABNAME","FIELDNAME","NEGATION","OPERATOR","CONSTANTS","CONTLINE","AND_OR","OFFSET","FLENGTH","MCOFIELD","JOPERATOR","JSOURCE"];

export function viewXml(head, settings, tables, fields, conditions) {
  const pos = (col) => (a, b) => Number(a[col] || 0) - Number(b[col] || 0);
  const table = (tag, item, order, list) => {
    if (!list.length) return undefined;
    return node(tag, list.map((r) => container(item, order, r)));
  };
  const f = [...fields].sort(pos("OBJPOS")).map((r) => {
    const x = {...r};
    if (key(x.ROLLCHANGE) === "X") x.ROLLNAMEVI = x.ROLLNAMEVI ?? x.ROLLNAME;
    else delete x.ROLLNAMEVI;
    return x;
  });
  const joins = [];
  const conds = [];
  const rows = [...conditions].sort(pos("POSITION"));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const n = key(r.NEGATION);
    if (n === "JL" && key(rows[i + 1]?.NEGATION) === "JR") {
      const j = rows[++i];
      joins.push({VIEWNAME: head.VIEWNAME, LTAB: r.TABNAME, LFIELD: r.FIELDNAME, OPERATOR: r.OPERATOR, RTAB: j.TABNAME, RFIELD: j.FIELDNAME, SOURCE: "S"});
    } else {
      conds.push(r);
    }
  }
  const values = [container("DD25V", DD25V, head)];
  if (settings) {
    const s = {...settings};
    if (key(s.ROWORCOLST) === "C") delete s.ROWORCOLST;
    values.push(container("DD09L", DD09L, s));
  }
  values.push(table("DD26V_TABLE", "DD26V", DD26V, [...tables].sort(pos("TABPOS"))));
  values.push(table("DD27P_TABLE", "DD27P", DD27P, f));
  values.push(table("DD28J_TABLE", "DD28J", DD28J, joins));
  values.push(table("DD28V_TABLE", "DD28V", DD28V, conds));
  return ddicXml("VIEW", values.filter((v) => v !== undefined));
}
