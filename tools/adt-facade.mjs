import {prepareActivation, publishActivation, beginActivation, activationIssues} from "./osd-publish-activation.mjs";
import {unitResultDocument, unitResultOptions} from "./adt-unit-result.mjs";
import {validateCreation, validationDocument} from "./adt-create-validation.mjs";
import {requestElements, elementsNamed, attributeValue, namespaces, objectXMLRoots, invalidObjectXML} from "./adt-request-xml.mjs";
import {requestXMLProfile, readRequestXML, RequestXMLError, XML_ERROR_TYPE, XML_ERROR_MESSAGE} from "./adt-request-xml.mjs";
import {segwRegistrationsOf} from "./osd-store-destination.mjs";
import {xrefFact} from "./adt-xref-facts.mjs";
// Consume the serving credential before any runtime, job or build starts.
const boundaryToken = process.env.OSD_ADT_TOKEN;
delete process.env.OSD_ADT_TOKEN;

import {renderCell, cellType} from "./adt-datapreview-cells.mjs";
// The ADT façade of OSD: `/sap/bc/adt/**` answered by a local system that
// has no system behind it. A client that speaks ADT to a real ABAP server
// should not be able to tell, within the surface we advertise.
//
// Two rules, and everything here follows from them.
//
// 1. Discovery is the gatekeeper. A collection appears in the discovery
//    document only because a handler for it was mounted; the list is built
//    from the mounted routes rather than written by hand, so the document
//    cannot promise what we do not serve. A client that sweeps discovery to
//    learn what exists then gets one honest answer.
// 2. The client is the test. vsp's ADT client is strict on purpose and
//    learned the quirks over a thousand commits against real systems. Where
//    this file guesses a shape it says so, and the guess is settled by
//    pointing that client at it rather than by argument.
//
// The façade never touches the file system or the database: sources come
// from the object store, table contents from its data layer. The store never
// parses HTTP. That seam is the contract between this session and the one
// that owns the store.
// The HTTP boundary holds the per-start credential and launches Git children.
import {execFileSync} from "./osd-child-process.mjs";
import express from "express";
import {readFileSync, appendFileSync} from "node:fs";
import {dirname, join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes, createHash, timingSafeEqual} from "node:crypto";
import {Sessions, refuseToken} from "./adt-session.mjs";
import {virtualFoldersDocument} from "./adt-vfs.mjs";
import {answered, refuse} from "./adt-refusal.mjs";
export {answered, refuse} from "./adt-refusal.mjs";
import {abapFront} from "./adt-abap-front.mjs";
import {RemoteSessions} from "./adt-remote-sessions.mjs";
import {sessionRoutes} from "./adt-session-routes.mjs";
import {AbapSessions} from "./adt-abap-sessions.mjs";
import {abapSession, statelessLock, newLockHandle} from "./adt-enq.mjs";
import {createDumpRecorder} from "./osd-dumps.mjs";
import {SOURCE_PROPERTY_MIME, sourcePropertiesDocument} from "./adt-source-properties.mjs";
import {ObjectStore, TYPES, INCLUDES as CLASS_INCLUDES, NotFound, ReadOnly, NotSupported, Conflict, InvalidName} from "./osd-store.mjs";
import {cdsEntityOf} from "./adt-cds.mjs";
import {hashOf, liveHash} from "./osd-build.mjs";
import {classIncludeTemplates, missingTestInclude, emptyFeedDocument, uriOf, ADT_TYPE, dataElementDocument, tableFieldsOf, tableDocument, tableSourceDocument, TREE_FOLDER, TREE_CATEGORY, TREE_TYPE_LABEL, TREE_CATEGORY_LABEL, classDocument, activationSuccessDocument, namedItemsDocument, objectStructureDocument, structureOf, objectReferencesDocument, searchObjects, packageDocument, packageOf, nodeStructureDocument, nodePathDocument, nodesOf, classIncludeDocument, lockResultDocument, exceptionDocument, lockedByOtherDocument, activationFailureDocument, inactiveObjectsDocument, objectReferencesIn, objectFromUri, checkReportDocument, checkObjectsIn, transportCheckDocument, transportCheckRequest} from "./adt-documents.mjs";
import {checkRunReport} from "./adt-checkrun.mjs";
import {identity as osdIdentity} from "./osd-identity.mjs";
import {gitObjectRevision, gitObjectState} from "./osd-git-history.mjs";
import {objectVersions, versionSource, versionsFeedDocument} from "./adt-versions.mjs";
import {segwRegistrations, countServiceRegistrations} from "./segw-registry.mjs";
import {generatorFoldersOf} from "./osd-packs.mjs";
import {withoutHostPaths} from "./osd-build-issues.mjs";
import {entitySetMapFor} from "./segw-entityset-map.mjs";
import {testClassesIn} from "./osd-unit-run.mjs";
import {serviceTree} from "./osd-status.mjs";
import {transactions} from "./osd-tran-registry.mjs";
import {entityTag, normalizedTag, sendEntity} from "./adt-entity.mjs";

export const BASE = "/sap/bc/adt";

export {countServiceRegistrations} from "./segw-registry.mjs";

const xmlEscape = (s) => String(s)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

// ------------------------------------------------------------- discovery

// An ADT discovery document is an Atom service document: workspaces of
// collections, each collection a resource with the content types it takes.
//
// The shape follows the sanitized sample vsp supplied from its own client
// (`docs/fixtures/adt-discovery.sample.xml` in that repository). Worth
// knowing, because it decides what breaks: vsp does not parse this XML. It
// scans the body for `href="/sap/bc/adt/<collection>"` and reads the token
// off the response header. So the bar for vsp is low, and the reason to emit
// a structurally real document anyway is the stricter clients behind it,
// adt-fs and eventually Eclipse.
// An empty compatibility graph: well formed, and claiming nothing. See the
// route for why it is empty rather than populated.
// What this system can do, said in the vocabulary a client checks against.
//
// This was an empty element under the wrong name, and an empty graph does not
// mean "no opinion" — it means "supports nothing". The client acted on it
// exactly as told: it deleted the content handler for object references and
// reported "Outdated content handler ... was deleted", it concluded
// "Activation is not supported on this project", and it stopped filling in
// package contents. Three unrelated-looking failures, one document, and none
// of them a request that any resource here answered wrongly — the client had
// decided before asking.
//
// The element is compatibility:graph, not adtcomp:graph. The prefix is
// arbitrary but the local name is not, and ours was a different element
// entirely.
//
// The nodes are feature flags and the edges are what makes them mean
// something.
//
// Declaring the flags alone was not enough, and the reason is the second
// measurement: an obligatory edge says a feature is incomplete without its
// partner. OO/classes obligatorily requires classModelXmlSchemaConform,
// PROGRAMS/programs requires programsXmlSchemaConform, CORE/checkruns
// requires checkrunsVendorContentType, ACTIVATION/activate requires
// CORE/xmlFormat. A client reading a feature whose obligations are missing
// treats it as unusable — which is what "Outdated content handler ... was
// deleted" and "Activation is not supported on this project" were both
// saying.
//
// So the set below is the obligatory closure of what this façade serves,
// computed from the system's own edges rather than assembled by hand: start
// from the features there are resources for, and add whatever they are
// declared to require, transitively. Nineteen nodes became thirty-two.
//
// The names ending XmlSchemaConform are promises about the shape of the
// documents here, not about which resources exist, and they are made
// knowingly: a client that finds them false will say so, and there is a real
// system beside this one to compare against when it does.
const COMPATIBILITY = {
  // The one node without which none of the others count for anything.
  //
  // Read off the client's own code rather than guessed: GraphAnalyzer's
  // isNodeAvailable looks up COM.SAP.ADT.COMPATIBILITY/compatibilityAvailable
  // *before* the node it was asked about, and returns false for everything if
  // that node is missing from this system's graph. So a graph that carefully
  // lists activation, checkruns and search, and omits this one line, says "I
  // support nothing" just as loudly as the empty graph did -- and the client
  // says so without sending a request, which is why the resources were all
  // there and none of them were ever called.
  "COM.SAP.ADT.COMPATIBILITY": ["compatibilityAvailable"],
  "COM.SAP.ADT.ABAPUNIT": ["abapunit", "uriBasedAbapUnit", "xmlVersion2"],
  // The one promise in this map with nothing behind it yet, made on purpose.
  //
  // Without this namespace the client says "Navigation to ABAP in Eclipse
  // might not work correctly in this system" and offers SAP GUI for Java,
  // which is the one GUI not installed on the machine that asks. With it the
  // client reaches for SAP GUI for Windows instead, which is installed, and
  // that GUI then opens DIAG to the dispatcher port of whatever instance the
  // project names — where, today, nothing is listening.
  //
  // So this does not make F8 work, and is not meant to. It converts a dialog
  // that ends the story into a real client knocking on a real port, which is
  // a thing that can be recorded and answered. That recording is the first
  // step of the DIAG side quest (docs/backlog/diag-rfc.md, track C); until C.4 stands
  // up a listener, the honest reading of this entry is "we intend to".
  //
  // reentranceTickets is included because there is a resource behind it —
  // /sap/bc/adt/core/http/reentranceticket — and because matching the three
  // a real system declares is a better bet than guessing which one the client
  // keys on.
  "COM.SAP.ADT.SAPGUI": ["navigationEvents", "reentranceTickets", "sapguiForWindows"],
  "COM.SAP.ADT.ACTIVATION": ["activate", "check"],
  "COM.SAP.ADT.CORE": ["checkruns", "checkrunsVendorContentType", "xmlFormat", "xmlNameSpace"],
  "COM.SAP.ADT.DDIC": ["ddic"],
  // The DDL editor asks for DDLSOURCES/ddlSources before it opens anything
  // (cds.ddl.ui!DdlSourceEditor#getFeatureNamespaceForInitialCheck), and a
  // double click on a CDS view sent no request at all while it was absent.
  // ddlParserV1 is deliberately not promised: it would make the client
  // fetch the system's own DDL grammar, which is not served here; without
  // the promise the client parses with its built-in version.
  "COM.SAP.ADT.DDIC.DDLSOURCES": ["ddlSources"],
  "COM.SAP.ADT.DDIC.VIEWS": ["views"],
  "COM.SAP.ADT.FUNCTIONS": ["fmodulesSignatureEditable", "functionGroupIncludes",
    "functionGroupIncludesXmlSchemaConform", "functionGroups", "functionModules",
    "functionModulesXmlSchemaConform", "functions"],
  "COM.SAP.ADT.OO": ["classModelXmlSchemaConform", "classes", "interfaces",
    "interfacesModelXmlSchemaConform", "startUriAdaptationToMainResource"],
  "COM.SAP.ADT.PROGRAMS": ["includes", "includesXmlSchemaConform", "programs", "programsXmlSchemaConform"],
  // treePath is deliberately absent. repository/nodepath now resolves an
  // object's package chain for test-result navigation, but advertising the
  // feature also makes clients use it while expanding packages; that wider
  // contract is not implemented and would bypass the working nodestructure
  // fallback. The other three stay advertised because their full resources
  // are present: nodestructure, informationsystem/search and typestructure.
  "COM.SAP.ADT.PROJECTEXPLORER": ["fullRepositoryTree", "repositoryQueryService", "typeMetaData"],
  "COM.SAP.ADT.RIS": ["ris", "search"],
  // The outline of a class or interface is gated here, not at the resource.
  // The client's outline provider asks the graph for this node before it
  // does anything else (abapsource.ui!AdtOutlineTreeContentProvider
  // #isObjectStructureResourceAvailable@34-58) and, told no, cancels its job
  // without a request, an error or a refresh — "Loading outline structure
  // ..." forever, nothing in the log. The objectstructure resource behind
  // it had been answering the whole time. Declared without the obligatory
  // edge the system carries (outline -> outlineBlockInformation), because
  // block information is not served here and a promise of it would be false.
  "COM.SAP.ADT.SOURCESERVICES": ["outline"],
};

// [source namespace, source, target namespace, target, obligatory]
const COMPATIBILITY_EDGES = [
  ["COM.SAP.ADT.ABAPUNIT", "abapunit", "COM.SAP.ADT.ABAPUNIT", "uriBasedAbapUnit", true],
  ["COM.SAP.ADT.ABAPUNIT", "abapunit", "COM.SAP.ADT.ABAPUNIT", "xmlVersion2", true],
  ["COM.SAP.ADT.ACTIVATION", "activate", "COM.SAP.ADT.CORE", "xmlFormat", true],
  ["COM.SAP.ADT.CORE", "checkruns", "COM.SAP.ADT.CORE", "checkrunsVendorContentType", true],
  ["COM.SAP.ADT.CORE", "xmlFormat", "COM.SAP.ADT.CORE", "xmlNameSpace", true],
  ["COM.SAP.ADT.FUNCTIONS", "functionGroupIncludes", "COM.SAP.ADT.FUNCTIONS", "functionGroupIncludesXmlSchemaConform", true],
  ["COM.SAP.ADT.FUNCTIONS", "functionModules", "COM.SAP.ADT.FUNCTIONS", "fmodulesSignatureEditable", true],
  ["COM.SAP.ADT.FUNCTIONS", "functionModules", "COM.SAP.ADT.FUNCTIONS", "functionModulesXmlSchemaConform", true],
  ["COM.SAP.ADT.FUNCTIONS", "functions", "COM.SAP.ADT.FUNCTIONS", "fmodulesSignatureEditable", true],
  ["COM.SAP.ADT.FUNCTIONS", "functions", "COM.SAP.ADT.FUNCTIONS", "functionGroupIncludes", true],
  ["COM.SAP.ADT.FUNCTIONS", "functions", "COM.SAP.ADT.FUNCTIONS", "functionGroups", false],
  ["COM.SAP.ADT.FUNCTIONS", "functions", "COM.SAP.ADT.FUNCTIONS", "functionModules", true],
  ["COM.SAP.ADT.OO", "classes", "COM.SAP.ADT.OO", "classModelXmlSchemaConform", true],
  ["COM.SAP.ADT.OO", "classes", "COM.SAP.ADT.OO", "startUriAdaptationToMainResource", true],
  ["COM.SAP.ADT.OO", "interfaces", "COM.SAP.ADT.OO", "interfacesModelXmlSchemaConform", true],
  ["COM.SAP.ADT.OO", "interfaces", "COM.SAP.ADT.OO", "startUriAdaptationToMainResource", true],
  ["COM.SAP.ADT.PROGRAMS", "includes", "COM.SAP.ADT.PROGRAMS", "includesXmlSchemaConform", true],
  ["COM.SAP.ADT.PROGRAMS", "programs", "COM.SAP.ADT.PROGRAMS", "programsXmlSchemaConform", true],
  ["COM.SAP.ADT.RIS", "ris", "COM.SAP.ADT.RIS", "search", true],
];

export function compatibilityGraphDocument(features = COMPATIBILITY, edges = COMPATIBILITY_EDGES) {
  const nodes = Object.entries(features).flatMap(([nameSpace, names]) =>
    names.map((name) => `<node nameSpace="${nameSpace}" name="${name}"/>`)).join("");
  const wires = edges.map(([sourceSpace, source, targetSpace, target, obligatory]) =>
    `<edge isObligatory="${obligatory}">` +
    `<sourceNode nameSpace="${sourceSpace}" name="${source}"/>` +
    `<targetNode nameSpace="${targetSpace}" name="${target}"/>` +
    "</edge>").join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<compatibility:graph xmlns:compatibility="http://www.sap.com/adt/compatibility"><nodes>${nodes}</nodes><edges>${wires}</edges></compatibility:graph>
`;
}

// core: the core/discovery form, every collection in a workspace of its own
// (abap-adt-api's adtCoreDiscovery, DebugService.create's first call, reads
// app:collection as one element per workspace). Mirrors
// ZCL_OSD_ADT_DISCOVERY=>document( iv_core ).
export function discoveryDocument(resources, {core = false} = {}) {
  const workspaces = new Map();
  for (const resource of resources) {
    if (workspaces.has(resource.workspace) === false) {
      workspaces.set(resource.workspace, []);
    }
    workspaces.get(resource.workspace).push(resource);
  }

  const collection = (r) => `    <app:collection href="${xmlEscape(r.href)}">
      <atom:title>${xmlEscape(r.title)}</atom:title>
${(r.accept ?? []).map((a) => `      <app:accept>${xmlEscape(a)}</app:accept>`).join("\n")}${(r.accept ?? []).length === 0 ? "" : "\n"}${r.category === undefined ? "" : `      <atom:category term="${xmlEscape(r.category[0])}" scheme="${xmlEscape(r.category[1])}"/>\n`}${(r.templates ?? []).length === 0 ? `      <adtcomp:templateLinks/>\n` : `      <adtcomp:templateLinks>\n${r.templates.map(([rel, template, type]) => `        <adtcomp:templateLink rel="${xmlEscape(rel)}" template="${xmlEscape(template)}"${type === undefined ? "" : ` type="${xmlEscape(type)}"`}/>`).join("\n")}\n      </adtcomp:templateLinks>\n`}    </app:collection>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<app:service xmlns:app="http://www.w3.org/2007/app"
             xmlns:atom="http://www.w3.org/2005/Atom"
             xmlns:adtcomp="http://www.sap.com/adt/compatibility">
${[...workspaces].map(([title, list]) => (core ? list.map((r) => [r]) : [list]).map((group) => `  <app:workspace>
    <atom:title>${xmlEscape(title)}</atom:title>
${group.map(collection).join("\n")}
  </app:workspace>`).join("\n")).join("\n")}
</app:service>
`;
}

// ------------------------------------------------------- data preview XML

// The answer to freestyle SQL is column-oriented: per column its metadata,
// then every value of that column. SHAPE NOT YET CONFIRMED against a real
// system; this is the structure as we understand it and the first thing to
// check when the round trip runs.
export function tableDataDocument(answer, options = {}) {
  const rows = answer.rows ?? [];
  const columns = answer.columns ?? (rows.length === 0 ? [] : Object.keys(rows[0]));
  const render = renderCell;
  const type = (name) => cellType(rows, name);

  // The dictionary's own metadata when the table is known (a4h-adt.jsonl:642:
  // type letter, colType, length, description per column), the guess from
  // the first row for freestyle SQL, whose columns are whatever was selected.
  const known = new Map((options.fields ?? []).map((f) => [f.name.toUpperCase(), f]));
  const metadata = (name) => {
    const f = known.get(name.toUpperCase());
    return f === undefined
      ? `dataPreview:type="${type(name)}" dataPreview:description="${xmlEscape(name.toUpperCase())}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"`
      // camelCaseName is what makes a CDS preview a CDS preview: the element
      // is named in the source in mixed case and the client shows that, while
      // the column it selects is the upper-case one. A table has no such name
      // and the attribute is left off rather than filled with the column.
      : `${f.camelCaseName === undefined ? "" : `dataPreview:camelCaseName="${xmlEscape(f.camelCaseName)}" `}dataPreview:type="${xmlEscape(f.letter)}" dataPreview:description="${xmlEscape(f.description || f.name)}" dataPreview:keyAttribute="${f.key === true}" dataPreview:colType="${xmlEscape(f.dataType)}" dataPreview:isKeyFigure="false" dataPreview:length="${f.length}" dataPreview:caseSensitive="false"`;
  };
  const body = columns.map((name) => `  <dataPreview:columns>
    <dataPreview:metadata dataPreview:name="${xmlEscape(name.toUpperCase())}" ${metadata(name)}/>
    <dataPreview:dataSet>
${rows.map((r) => `      <dataPreview:data>${xmlEscape(render(r[name]))}</dataPreview:data>`).join("\n")}
    </dataPreview:dataSet>
  </dataPreview:columns>`).join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">
  <dataPreview:totalRows>${rows.length}</dataPreview:totalRows>${options.name === undefined ? "" : `
  <dataPreview:name>${xmlEscape(options.name)}</dataPreview:name>`}
${options.cdsEntityName === undefined ? "" : `
  <dataPreview:cdsEntityName>${xmlEscape(options.cdsEntityName)}</dataPreview:cdsEntityName>`}${options.cdsCamelCaseName === undefined ? "" : `
  <dataPreview:cdsCamelCaseName>${xmlEscape(options.cdsCamelCaseName)}</dataPreview:cdsCamelCaseName>`}
  <dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>${options.maxRowsLink !== true ? "" : `
  <atom:link rel="http://www.sap.com/adt/categories/datapreview/cds/metadata/maxrows" title="Max Rows Increase" xmlns:atom="http://www.w3.org/2005/Atom"/>`}
  <dataPreview:executedQueryString>${xmlEscape(answer.sql ?? "")}</dataPreview:executedQueryString>
  <dataPreview:queryExecutionTime>${options.ms ?? 0}</dataPreview:queryExecutionTime>
${body}
</dataPreview:tableData>
`;
}

// ---------------------------------------------------------------- routing

// which object types answer a source read, and under which ADT collection.
// The store already knows the mapping, because it is the same fact: an
// object type, a file extension and a resource path. INCL and PROG share a
// file on disk and differ by resource, which is why both are here.
const SOURCE_TYPES = Object.entries(TYPES)
  .filter(([, meta]) => meta.source === true && meta.adt !== undefined)
  .map(([type, meta]) => ({type, adt: meta.adt}));

// the content type a collection takes, where a client cares. Taken from the
// sample vsp supplied; a collection absent from here advertises none.
const ACCEPT = {
  "programs/programs": ["application/vnd.sap.adt.programs.programs.v2+xml"],
  "programs/includes": ["application/vnd.sap.adt.programs.includes.v2+xml"],
  "oo/classes": ["application/vnd.sap.adt.oo.classes.v4+xml"],
  "oo/interfaces": ["application/vnd.sap.adt.oo.interfaces.v2+xml"],
  "functions/groups": ["application/vnd.sap.adt.functions.groups.v3+xml"],
  // Both, newest first, the way A4H advertises them: a client picks the
  // highest it knows and a façade that offers only v1 tells a modern one
  // that there is nothing here it can open.
  "packages": ["application/vnd.sap.adt.packages.v2+xml", "application/vnd.sap.adt.packages.v1+xml"],
  "cts/transportchecks": ["application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData"],
  "ddic/dataelements": ["application/vnd.sap.adt.dataelements.v2+xml"],
  "ddic/tables": ["application/vnd.sap.adt.tables.v2+xml"],
  // the run configurations the system says it takes (a4h-adt.jsonl discovery),
  // which is also what tells the client to talk to this resource the typed way
  "abapunit/testruns": ["application/vnd.sap.adt.abapunit.testruns.config.v1+xml",
    "application/vnd.sap.adt.abapunit.testruns.config.v2+xml",
    "application/vnd.sap.adt.abapunit.testruns.config.v3+xml",
    "application/vnd.sap.adt.abapunit.testruns.config.v4+xml", "application/xml"],
};

// which workspace a collection is filed under in the discovery document
// The category every collection carries, and which a client needs before it
// will parse the collection at all.
//
// Read off A4H's own discovery document rather than invented: a cloud project
// reported "Error parsing collection" for every collection this façade
// advertised, and the message named what was wrong — categories=[]. The terms
// and schemes below are the system's, including the two that misspell
// "repository" as "respository", because a client matching on the string
// would not forgive the correction.
const CATEGORY = {
  "packages/settings": ["settings", "http://www.sap.com/wbobj/packages"],
  "packages/validation": ["devck/validation", "http://www.sap.com/wbobj/packages"],
  "oo/validation/objectname": ["validation", "http://www.sap.com/adt/categories/oo"],
  "programs/programs": ["programs", "http://www.sap.com/adt/categories/programs"],
  "programs/includes": ["includes", "http://www.sap.com/adt/categories/programs"],
  "oo/classes": ["classes", "http://www.sap.com/adt/categories/oo"],
  "oo/interfaces": ["interfaces", "http://www.sap.com/adt/categories/oo"],
  // F9, "Run as ABAP Application (Console)". Read off a real system's own
  // discovery (.local/adt-corpus/latest/bodies/00009-response.xml), not
  // guessed: term "classrun", same scheme as the rest of COM.SAP.ADT.OO, no
  // app:accept at all, and no compatibility-graph node gates it -- unlike
  // checkruns/activation/abapunit, discovery alone is what a client checks
  // before it shows F9.
  "oo/classrun": ["classrun", "http://www.sap.com/adt/categories/oo"],
  "functions/groups": ["groups", "http://www.sap.com/adt/categories/functions"],
  "packages": ["devck", "http://www.sap.com/wbobj/packages"],
  "ddic/tables": ["tabldt", "http://www.sap.com/wbobj/dictionary"],
  // What opens a data element is this line. The client's navigation looks
  // the object's category up in discovery (BlueObjectTypeUtil
  // #getBlueObjectTypeInfo@78-155) before it sends anything, and with no
  // collection under this scheme and term it offered to install software
  // instead — "/sap/bc/adt/ddic/dataelements/icfname is not installed".
  "ddic/dataelements": ["dtelde", "http://www.sap.com/wbobj/dictionary"],
  // F8 on a table: the system's own term and scheme (a4h-adt.jsonl discovery)
  "datapreview/ddic": ["DatapreviewDdic", "http://www.sap.com/adt/categories/datapreview"],
  // F8 on a CDS view, the same scheme with the system's CDS term
  "datapreview/cds": ["DatapreviewCds", "http://www.sap.com/adt/categories/datapreview"],
  "abapunit/testruns": ["unittestruns", "http://www.sap.com/adt/categories/abapunit"],
  "activation": ["activationruns", "http://www.sap.com/adt/categories/activation"],
  "checkruns": ["checkruns", "http://www.sap.com/adt/categories/check"],
  "repository/nodestructure": ["nodestructure", "http://www.sap.com/adt/categories/respository"],
  "repository/informationsystem/search": ["search", "http://www.sap.com/adt/categories/respository"],
  "repository/informationsystem/virtualfolders": ["virtualfolders", "http://www.sap.com/adt/categories/repository"],
  "cts/transportchecks": ["transportchecks", "http://www.sap.com/adt/categories/cts"],
  "checkruns/reporters": ["reporters", "http://www.sap.com/adt/categories/check"],
  "activation/inactiveobjects": ["inactiveobjects", "http://www.sap.com/adt/categories/activation"],
  "datapreview/freestyle": ["DatapreviewFreeStyle", "http://www.sap.com/adt/categories/datapreview"],
  "ddic/ddl/sources": ["ddlsources", "http://www.sap.com/adt/categories/ddic/ddlsources"],
  "ddic/srvd/sources": ["srvdsrv", "http://www.sap.com/wbobj/raps"],
  // These three were advertised with no category at all, and a collection
  // without one is not a collection the client can read: its discovery
  // handler calls category.getScheme() without checking, so one such entry
  // throws NullPointerException and the *whole* discovery document fails to
  // deserialize — which is why the tree sat on "Loading repository tree ..."
  // under every package while three unrelated-looking errors sat in the log.
  // Terms and schemes are the system's own, "respository" included: that
  // misspelling is in SAP's scheme and fixing it would be inventing a scheme
  // nobody looks for.
  "abapunit/metadata": ["metadata", "http://www.sap.com/adt/categories/abapunit"],
  "repository/informationsystem/objecttypes": ["objecttypes", "http://www.sap.com/adt/categories/respository"],
  "repository/informationsystem/releasestates": ["releasestates", "http://www.sap.com/adt/categories/respository"],
};

// How a client builds a URL it was never told in full.
//
// Some resources are not just a path: a client reads the template and fills
// it in. Without one it cannot form the request at all, and it does not fail
// at the server — it fails before the network, which is why the search dialog
// reported "Outdated content handler" while nothing whatsoever arrived here.
// The same search against A4H went out and came back fine, and the difference
// was this element.
//
// Templates copied from the system rather than reduced to what this façade
// honours. A client fills in what it wants and an unknown parameter is
// ignored here, so offering fewer would only teach it to ask for less.
const SEARCH_TEMPLATE =
  "/sap/bc/adt/repository/informationsystem/search{?operation,query,useSearchProvider,noDescription,maxResults}" +
  "{&objectType*}{&group*}{&packageName*}{&sourcetype*}{&state*}{&lifecycle*}{&rollout*}{&category*}{&appl*}" +
  "{&userName*}{&releaseState*}{&language*}{&system*}{&version*}{&docu*}{&fav*}{&created*}{&month*}{&date*}{&comp*}";

const TEMPLATE_LINKS = {
  "packages": [
    ["http://www.sap.com/wbobj/packages/devck/properties", "/sap/bc/adt/packages/{object_name}{?corrNr,lockHandle,version,accessMode,_action}"],
    ...["applicationcomponents", "softwarecomponents", "transportlayers", "translationrelevances", "abaplanguageversions"].map((name) =>
      [name, `/sap/bc/adt/packages/valuehelps/${name}`, "application/vnd.sap.adt.nameditems.v1+xml"]),
  ],
  // the system's own template for a data element (a4h-adt.jsonl:121):
  // the lock handle and transport it carries are for the editor's save
  "ddic/dataelements": [
    ["http://www.sap.com/wbobj/dictionary/dtelde/properties",
      "/sap/bc/adt/ddic/dataelements/{object_name}{?corrNr,lockHandle,version,accessMode,_action}"],
  ],
  "repository/informationsystem/search": [
    ["http://www.sap.com/adt/relations/informationsystem/search/quicksearch", SEARCH_TEMPLATE],
    ["http://www.sap.com/adt/relations/informationsystem/search/whitelisting", SEARCH_TEMPLATE],
  ],
  "datapreview/freestyle": [
    ["http://www.sap.com/adt/categories/datapreview/freestyle", "/sap/bc/adt/datapreview/freestyle{?rowNumber}"],
    ["http://www.sap.com/adt/categories/datapreview/freestyle/check", "/sap/bc/adt/datapreview/freestyle{?action,uniqueURI}"],
  ],
  // The data page uses colcount for both TABL and CDS previews. The
  // launchfreestyle relation is the capability switch for its SQL Pane;
  // execution itself goes through the freestyle collection below.
  "datapreview/ddic": [
    ["http://www.sap.com/adt/categories/datapreview/ddic/metadata", "/sap/bc/adt/datapreview/ddic/{object_name}/metadata"],
    ["http://www.sap.com/adt/categories/datapreview/ddic", "/sap/bc/adt/datapreview/ddic{?rowNumber,ddicEntityName}"],
    ["http://www.sap.com/adt/categories/datapreview/ddic/colcount", "/sap/bc/adt/datapreview/ddic{?rowNumber,ddicEntityName,colNumber}"],
    ["http://www.sap.com/adt/categories/datapreview/ddic/launchfreestyle", "/sap/bc/adt/datapreview/freestyle"],
  ],
  // CDSDataPreviewPage.fetchCount reads associationrefresh's URI template
  // even for a plain CDS count, before sending the count SELECT. Without
  // this exact A4H relation it dereferences null inside Eclipse. For the
  // plain count it fills ddlSourceName and leaves action empty, which is
  // answered by the existing CDS POST route.
  "datapreview/cds": [
    ["http://www.sap.com/adt/categories/datapreview/cds/metadata", "/sap/bc/adt/datapreview/cds/{object_name}/metadata"],
    ["http://www.sap.com/adt/categories/datapreview/cds", "/sap/bc/adt/datapreview/cds{?rowNumber,ddlSourceName}"],
    ["http://www.sap.com/adt/categories/datapreview/cds/associationrefresh", "/sap/bc/adt/datapreview/cds{?action,rowNumber,targetType,ddlSourceName}"],
    ["http://www.sap.com/adt/categories/datapreview/cds/launchfreestyle", "/sap/bc/adt/datapreview/cds"],
  ],
  "checkruns": [
    ["http://www.sap.com/adt/categories/check/relations/reporters", "/sap/bc/adt/checkruns{?reporters}"],
  ],
  "activation/inactiveobjects": [
    ["http://www.sap.com/adt/relations/activation/inactiveobjects", "/sap/bc/adt/activation/inactiveobjects{?USERNAME}"],
    ["http://www.sap.com/adt/relations/activation/inactiveobjects/update", "/sap/bc/adt/activation/inactiveobjects{?action}"],
  ],
  "ddic/ddl/sources": [
    ["http://www.sap.com/adt/categories/ddic/ddlsources/properties",
      "/sap/bc/adt/ddic/ddl/sources/{object_name}{?corrNr,lockHandle,version,accessMode,_action}"],
    ["http://www.sap.com/adt/categories/ddic/ddlsources/source",
      "/sap/bc/adt/ddic/ddl/sources/{object_name}/source/main{?corrNr,lockHandle,version}"],
  ],
  "ddic/srvd/sources": [
    ["http://www.sap.com/wbobj/raps/srvdsrv/properties",
      "/sap/bc/adt/ddic/srvd/sources/{object_name}{?corrNr,lockHandle,version,accessMode,_action}"],
    ["http://www.sap.com/wbobj/raps/srvdsrv/source",
      "/sap/bc/adt/ddic/srvd/sources/{object_name}/source/main{?corrNr,lockHandle,version}"],
  ],
  // the system's own template (a4h-corpus discovery): {classname} in the
  // path, {?profilerId} a query parameter this façade accepts and ignores
  // (no profiling here), type="text/plain" because the answer always is
  "oo/classrun": [
    ["http://www.sap.com/adt/relations/oo/classrun", "/sap/bc/adt/oo/classrun/{classname}{?profilerId}", "text/plain"],
  ],
};

const WORKSPACE = (adt) => {
  if (adt.startsWith("ddic/") || adt.startsWith("datapreview/")) {
    return "Data Dictionary";
  }
  if (adt.startsWith("repository/") || adt.startsWith("packages")) {
    return "Repository";
  }
  return adt === "activation" || adt === "checkruns" || adt.startsWith("abapunit") || adt.startsWith("cts/") ? "Development Loop" : "Source Library";
};

const TITLE = {
  "packages/settings": "Package Settings",
  "packages/validation": "Package Name Validation",
  "oo/validation/objectname": "Validation of Object Name",
  "programs/programs": "Programs",
  "programs/includes": "Includes",
  "oo/classes": "Classes",
  "oo/interfaces": "Interfaces",
  "oo/classrun": "Run a class",
  "ddic/ddl/sources": "CDS DDL Sources",
  "ddic/dataelements": "Data Element",
  "ddic/tables": "Database Table",
  "datapreview/ddic": "Modelled Data Preview for DDIC",
  "datapreview/cds": "Data Preview for CDS",
  "ddic/srvd/sources": "Service Definitions",
  "datapreview/freestyle": "Data Preview (freestyle SQL)",
  "repository/informationsystem/search": "Object Search",
  "repository/nodestructure": "Repository Node Structure",
  "packages": "Packages",
  "activation": "Activation",
  "checkruns": "Check Runs (syntax)",
  "abapunit/testruns": "ABAP Unit Test Runs",
  "cts/transportchecks": "Transport Checks",
};

// The body of a request, whatever the host application did with it.
//
// A client may send a wildcard content type — `application/*` is one a real
// system accepts on a check run — and a body parser that cannot resolve that
// to a media type quietly leaves the body unparsed. The façade then sees no
// body and answers "you sent me nothing", which is a lie about the request
// and a hard one to diagnose from the other end. So it reads the stream
// itself when the body did not arrive as bytes.
function rawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === "string") {
    return Promise.resolve(Buffer.from(req.body, "utf8"));
  }
  if (req.readableEnded === true || req.readable === false) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Env keys a caller of `core/http/unit/object/run` may set for that run's
// OWN database (tools/osd-unit.mjs `unitChildEnv`, "run tests on a
// different database" -- docs/vscode-extension.md, "Databases"). An
// allowlist, not "anything the body sends": this reaches a spawned child's
// environment, and the route otherwise takes no body at all, so naming the
// keys explicitly excludes nothing a legitimate caller needs.
export const UNIT_RUN_DB_ENV_KEYS = new Set([
  "STG_DB", "STG_DB_FRESH", "STG_DB_TRACE",
  "HANA_HOST", "HANA_PORT", "HANA_USER", "HANA_PASSWORD", "HANA_SCHEMA",
  "HXE_HOST", "HXE_PORT", "HXE_USER", "HXE_PASSWORD", "OSD_HANA_PASSWORD_FILE",
  "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE",
]);

/** `{dbEnv}` out of a JSON request body, filtered to the allowlist above.
 *  `undefined` for no body, an unparsable body, or a body with no `dbEnv`
 *  of its own -- every existing caller sends no body at all and this must
 *  leave that alone. */
export async function unitRunOptions(req) {
  const body = await rawBody(req);
  if (body.length === 0) {
    return {dbEnv: undefined, inspectPort: undefined, waitForDebugger: false};
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return {dbEnv: undefined, inspectPort: undefined, waitForDebugger: false};
  }
  const dbEnv = parsed?.dbEnv;
  const out = {};
  if (dbEnv !== null && typeof dbEnv === "object") {
    for (const [key, value] of Object.entries(dbEnv)) {
      if (UNIT_RUN_DB_ENV_KEYS.has(key) && typeof value === "string") {
        out[key] = value;
      }
    }
  }
  let inspectPort;
  if (parsed?.inspectPort !== undefined) {
    inspectPort = typeof parsed.inspectPort === "number" ? parsed.inspectPort
      : typeof parsed.inspectPort === "string" && /^\d+$/.test(parsed.inspectPort) ? Number(parsed.inspectPort) : NaN;
    if (!Number.isInteger(inspectPort) || inspectPort < 1 || inspectPort > 65535) {
      const error = new Error("inspector port must be an integer between 1 and 65535");
      error.code = "INVALID_REQUEST";
      throw error;
    }
  }
  if (parsed?.waitForDebugger !== undefined && typeof parsed.waitForDebugger !== "boolean") {
    const error = new Error("waitForDebugger must be boolean");
    error.code = "INVALID_REQUEST";
    throw error;
  }
  if (parsed?.waitForDebugger === true && inspectPort === undefined) {
    const error = new Error("waitForDebugger needs an inspector port");
    error.code = "INVALID_REQUEST";
    throw error;
  }
  return {dbEnv: Object.keys(out).length === 0 ? undefined : out, inspectPort,
    waitForDebugger: parsed?.waitForDebugger === true};
}

/** Backwards-compatible db-only view used by other façade routes/tests. */
export async function unitRunDbEnv(req) {
  return (await unitRunOptions(req)).dbEnv;
}

const STARTED = new Date().toISOString();

export function buildAnswer({store, data, sourceCommit, identity}) {
  return {raw: JSON.stringify({
    build: facadeBuildStamp(),
    generation: liveHash(store.root),
    // The commit, and it is the **only** number the two deployment targets
    // can share (docs/backlog/pages-preview.md, "Deploying: the i7 follows Pages"). The
    // generation above is the transpiler's, the preview's `stamp` is
    // webpack's, and those two cannot agree even when built from one
    // source -- a check on them produces a false alarm, which is worse
    // than no check. `unknown` when there is no git, rather than a field
    // that looks measured and is not.
    commit: sourceCommit(),
    // Are we serving what we are running? Three names, and they are
    // synchronized when all three agree. source is what a build of the
    // tree would produce now (105 ms to compute); live is the build on
    // disk; serving is the code the runtime child actually runs. source
    // ahead of live means unbuilt saves; live ahead of serving means a
    // build that went live without a recycle — a pinned runtime, or one
    // that failed to come up and was rolled back.
    system: (() => {
      if (store.root === undefined) {
        return undefined;
      }
      const source = hashOf(store.root);
      const live = liveHash(store.root);
      // null, not undefined: JSON drops an undefined field, and "no
      // runtime is serving yet" is an answer, not an absence
      const serving = store.served?.running === true ? store.served.generation : null;
      // and the rows: which file the serving runtime holds, and where the
      // preview reads — "serving" means through the runtime's door, which
      // is the only answer in which a preview and the application agree
      const database = {
        serving: store.served?.running === true ? (store.served.database ?? "memory") : null,
        preview: data.source ?? "in-process",
      };
      return {source, live, serving, database, synchronized: source === live && (serving === null || serving === live) && database.preview === "serving"};
    })(),
    started: STARTED,
    identity,
  })};
}
export function changedAnswer(store) {
  const objects = store.changedObjects();
  const w = store.warm?.();
  return {raw: JSON.stringify({
    objects,
    reason: objects === undefined ? (w?.on !== true ? "OSD_WARM is not 1" : w?.reason) : undefined,
  })};
}
export function servicesAnswer(store) {
  try {
    const classUri = (name) => (name !== undefined && name !== "" && store.exists("CLAS", name) ? uriOf("CLAS", name) : undefined);
    const classSource = (name) => {
      if (name === undefined || name === "") return undefined;
      try {
        return store.read("CLAS", name).file;
      } catch {
        return undefined;
      }
    };
    const rows = serviceTree(store.root).map((one) => ({
      kind: one.kind,
      name: one.name,
      path: one.path,
      text: one.text,
      pack: one.pack,
      handler: one.kind === "APP" ? undefined : one.handler,
      handlerUri: one.kind === "APP" ? undefined : classUri(one.handler),
      handlerSource: one.kind === "APP" ? undefined : classSource(one.handler),
      app: one.kind === "APP" ? one.handler : undefined,
      mpc: one.mpc,
      mpcUri: classUri(one.mpc),
      mpcSource: classSource(one.mpc),
      helpers: (one.kind === "ODATA" ? [
        one.mpc?.replace(/_MPC_EXT$/i, "_MPC_ANN"),
        "ZCL_STG_SEGW_REGISTRY", "ZCL_STG_SHLP_REGISTRY", "ZCL_STG_FM_REGISTRY",
      ] : one.kind === "APP" ? ["ZCL_STG_BSP_REGISTRY"] : []).filter((name) => name && store.exists("CLAS", name)).map((name) => ({
        name,
        role: name.endsWith("_MPC_ANN") ? "annotations" : "registry",
        uri: classUri(name),
        source: classSource(name),
      })),
      source: one.source,
    }));
    const counts = {};
    for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    return {raw: JSON.stringify({services: rows, counts})};
  } catch (e) {
    return {refuse: {status: 500, type: "ExceptionInternalError", message: String(e?.message ?? e)}};
  }
}
export function transactionsAnswer(store) {
  try {
    const folders = generatorFoldersOf(store.root).map((folder) => join(store.root, folder));
    const rows = transactions(folders).map((one) => ({
      ...one,
      file: undefined,
      source: relative(store.root, one.file),
      ...store.locationOf(relative(store.root, one.file)),
      programSource: store.find(one.className ? "CLAS" : "PROG", one.className || one.program)?.file,
    }));
    return {raw: JSON.stringify({transactions: rows})};
  } catch (e) {
    return {refuse: {status: 500, type: "ExceptionInternalError", message: String(e?.message ?? e)}};
  }
}

function sendIntrospection(res, answer) {
  if (answer.refuse) {
    const {status, type, message} = answer.refuse;
    refuse(res, status, type, message);
  } else res.type("application/json; charset=utf-8").send(answer.raw);
}

export function adtRouter(options = {}) {
  const store = options.store ?? new ObjectStore({root: options.root});
  if (options.watch !== false && typeof store.watch === "function") {
    // the disk is the other editor: see ObjectStore#watch. A host may hand
    // in a stand-in store that does not watch, and that is not an error
    store.watch();
  }
  // who this system says it is (see "What an ABAP Cloud Project needs",
  // below, for why the id matters); said here because the ABAP sessions
  // name their cookie after it
  const whoami = osdIdentity().adt;
  const identity = {
    systemID: options.systemID ?? whoami.systemID,
    userName: options.userName ?? whoami.userName,
    userFullName: options.userFullName ?? whoami.userFullName,
    client: options.client ?? whoami.client,
    language: options.language ?? whoami.language,
    ...options.identity,
  };
  // With the ABAP front every request resolves its session in ABAP
  // (ZCL_OSD_ADT_SESSION through AbapSessions, slice 3 option B), and Node's
  // Sessions is not in this façade at all: one session store, the tables.
  // Without it (OSD_ADT=js, the child-mode parent, which runs no ABAP, and
  // the suites that mount the Node façade alone) Node's Sessions is the
  // store and its middleware the gate, as before.
  if (options.abap !== undefined && options.sessions !== undefined && options.sessions instanceof AbapSessions === false) {
    throw new Error("the ABAP front resolves its sessions in ABAP: pass AbapSessions, or no sessions");
  }
  const sessions = options.sessions ?? (options.abap === undefined ? new Sessions()
    : options.abap.remote !== undefined ? new RemoteSessions(options.abap.remote, {identity: {systemID: identity.systemID, client: identity.client}})
    : new AbapSessions({identity: {systemID: identity.systemID, client: identity.client}}));

  const data = options.data ?? store.data();
  const router = express.Router();
  const resources = [];

  const advertise = (adt) => resources.push({
    workspace: WORKSPACE(adt),
    title: TITLE[adt] ?? adt,
    href: `${BASE}/${adt}`,
    accept: ACCEPT[adt] ?? [],
    category: CATEGORY[adt],
    templates: TEMPLATE_LINKS[adt],
  });

  // What a client asked for and did not get, in two kinds. "resource" is a
  // path nothing is mounted on, which is the next wave's work. "object" is a
  // mounted resource answering that the thing is not in this tree, which is
  // usually a client assuming a system convention we do not have — $TMP was
  // one of those and it never appeared here, because the route existed.
  // Recording only the first kind makes an empty list look like a clean bill
  // of health while a client is failing on every node it opens.
  const missed = new Map();
  const record = (req, kind, detail, path = req?.path) => {
    if (req === undefined) {
      return;
    }
    const key = `${kind} ${req.method} ${path}`;
    const seen = missed.get(key);
    missed.set(key, {
      kind,
      method: req.method,
      path,
      query: Object.keys(req.query ?? {}).length === 0 ? undefined : {...req.query},
      detail: seen?.detail ?? detail,
      accept: seen?.accept ?? req.headers.accept,
      count: (seen?.count ?? 0) + 1,
      first: seen?.first ?? new Date().toISOString(),
    });
    if (options.logMisses !== false && seen === undefined) {
      console.log(`ADT miss (${kind}): ${req.method} ${path}${detail === undefined ? "" : "  " + detail}`);
    }
  };
  // every answer() inside this router records the object misses it turns
  // into 404s, without each call site having to remember to
  const answer = (res, body) => answered(res, body, record);

  // scoped to the façade's own prefix: this router is mounted on the same
  // app as the OData front, and a CSRF gate over somebody else's POST is a
  // 403 they never asked for
  // the Node session middleware is the gate only when no ABAP front is; with
  // one, the front resolves the session and runs the gate in ABAP
  // every pass-through layer is mounted through here and returned, so the
  // coverage gate (test/adt-abap-coverage.mjs) can tell it from an endpoint
  // by reference, with its path, and not by what its source looks like
  const middleware = [];
  const pass = (id, path, fn) => {
    middleware.push({id, path, fn});
    router.use(path, fn);
  };
  // Before sessions, captures and the ABAP front. Basic/anonymous local logon
  // stays unchanged; presenting a Bearer credential always requires validation.
  const localToken = options.localToken ?? boundaryToken;
  pass("local-logon", [BASE, "/sap/public/bc/icf/logoff"], (req, res, next) => {
    const header = String(req.headers.authorization ?? "");
    if (!/^Bearer(?:\s|$)/i.test(header)) return next();
    const supplied = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header)?.[1];
    const peer = req.socket.remoteAddress;
    const loopback = peer === "::1" || /^127\./.test(peer ?? "") || /^::ffff:127\./i.test(peer ?? "");
    const digest = (value) => createHash("sha256").update(value).digest();
    if (!localToken || !supplied || !loopback || !timingSafeEqual(digest(supplied), digest(localToken))) {
      return res.status(401).set("WWW-Authenticate", 'Bearer realm="OSD local"').send("Unauthorized");
    }
    // Existing Node and ABAP session parsers read the user from Basic. Replace
    // the verified credential with that identity; no token reaches ABAP/captures.
    req.headers.authorization = `Basic ${Buffer.from(`${identity.userName}:`).toString("base64")}`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "authorization") req.rawHeaders[i + 1] = req.headers.authorization;
    }
    next();
  });
  // Validate the entire XML request before any Node route reads the store.
  // ABAP validates original bytes before resolving its session. HOST
  // requests then parse the same bytes for their Node consumers.
  const admitXML = async (req, res, next) => {
    const profile = requestXMLProfile(req.method, req.originalUrl ?? req.url);
    if (profile === undefined) return next();
    const path = (req.originalUrl ?? req.url).split("?")[0].toLowerCase();
    if (path === `${BASE}/activation` && req.query.method !== "activate") return next();
    try {
      const body = await rawBody(req);
      if (body.length === 0 && (profile.length === 0 || profile[0] === "asx" || profile[0] === "vfs")) return next();
      req.requestXML = readRequestXML(body, profile);
      req.body = body; // Retain original bytes when admission consumed the stream.
      next();
    } catch (error) {
      if (error instanceof RequestXMLError) refuse(res, 400, XML_ERROR_TYPE, XML_ERROR_MESSAGE);
      else next(error);
    }
  };

  if (options.abap === undefined) {
    pass("request-xml", BASE, admitXML);
    pass("sessions", BASE, sessions.middleware());
  }
  // every answer names the generation of the system it describes
  pass("generation", BASE, (req, res, next) => {
    const generation = liveHash(store.root);
    if (generation !== undefined) {
      res.set("X-OSD-Generation", generation);
    }
    next();
  });

  // STG_ADT_DUMP=<file.jsonl> records every exchange under the façade in
  // the shape of the A4H oracle captures: method, url, request headers and
  // body, response status, headers and body, both bodies base64. It exists
  // because the thing a client actually sent is the one thing a replay of
  // "what it must have sent" cannot show, and the proxy the client goes
  // through is on another machine. Off unless asked; a capture carries
  // logons and goes under .local/, never into the tree.
  const dump = options.dump ?? process.env.STG_ADT_DUMP;
  if (dump !== undefined && dump !== "") {
    let seq = 0;
    pass("dump", BASE, (req, res, next) => {
      const startedAt = new Date();
      const chunks = [];
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = (chunk, ...rest) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...rest); };
      res.end = (chunk, ...rest) => {
        if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk));
        rawBody(req).then((body) => {
          const line = {
            at: startedAt.toISOString(), seq: ++seq, ms: Date.now() - startedAt.getTime(),
            method: req.method, url: req.originalUrl,
            request: {headers: req.headers, body: {bytes: body.length, base64: body.toString("base64")}},
            response: {status: res.statusCode, headers: res.getHeaders(), body: {bytes: Buffer.concat(chunks).length, base64: Buffer.concat(chunks).toString("base64")}},
          };
          appendFileSync(dump, JSON.stringify(line) + "\n");
        }).catch(() => {});
        return end(chunk, ...rest);
      };
      next();
    });
  }

  // ADR 0007: every request enters ZCL_OSD_ADT_HANDLER (adt-abap-front.mjs),
  // which resolves the session, gates and answers or hands over; locks go
  // to ENQ (adt-enq.mjs)
  const inlineDumps = options.abap !== undefined && options.abap.remote === undefined
    ? createDumpRecorder({connection: () => globalThis.abap.context.databaseConnections.DEFAULT,
      generation: () => liveHash(store.root)}) : undefined;
  if (options.abap !== undefined) pass("abap-front", [BASE, "/sap/public/bc/icf/logoff"], abapFront({...options.abap, served: options.abapServed, refuse, store, facadeOptions: options,
    miss: (req, kind, detail) => record(req, kind, detail, (req.originalUrl ?? req.url).split("?")[0]),
    generation: () => liveHash(store.root),
    sessions, ...abapSession(sessions, async (kind, name, req, json) => {
      if (kind === "IDENTITY") return identity;
      if (kind === "DUMP") return inlineDumps?.system(json);
      if (kind === "SEGW_REGISTRATIONS") return segwRegistrationsOf(store);
      if (kind === "BUILD") return buildAnswer({store, data, sourceCommit, identity});
      if (kind === "CHANGED") return changedAnswer(store);
      if (kind === "SERVICES") return servicesAnswer(store);
      if (kind === "TRANSACTIONS") return transactionsAnswer(store);
      if (kind === "XREF_WARM") return xrefFact(store, kind, {...JSON.parse(json || "{}"), limit: options.xrefLimit ?? 5000});
      return undefined;
    })}));

  if (options.abap !== undefined) pass("request-xml", BASE, admitXML);

  // ---- What an ABAP Cloud Project needs that an ordinary one does not.
  //
  // Measured 2026-09-14 against A4H behind a TLS terminator: an ABAP Cloud
  // Project asks for exactly four things beyond the classic surface, and with
  // them a plain on-premise system opens as a cloud one — tree, sources, and
  // ABAP Unit runs. Everything else the wizard needs, including the released-
  // objects tree, comes from resources this façade already serves.
  //
  // The fourth is /sap/public/bc/icf/virtualhost, which is not here because
  // the right answer to it is 404 and that is what an unmounted path already
  // gives. A4H answers the same, and the wizard carries on regardless.
  //
  // The system id is the one id of this system, as sy-sysid and the status
  // service have it; the client (001) is not sy-mandt (123). A project
  // refuses a logon to a system reporting another id than the one it was
  // created against, so rename before projects exist: tools/osd-identity.mjs.
  // The logon, and the whole of what the wizard calls a challenge.
  //
  // It turns out to be neither OAuth nor PKCE. Eclipse opens a listener on a
  // loopback port, sends a browser here, and expects to be sent back to that
  // listener with a ticket in the query string; the ticket exists only to let
  // the client pick up a session cookie. A real system authenticates first.
  // This one has nobody to authenticate, so it issues the ticket directly —
  // which is the honest behaviour for a façade with no user store, and is why
  // it must not be exposed to a network that matters.
  //
  // The redirect target is restricted to loopback, which is where Eclipse's
  // listener always is. Without that this is an open redirect: anything could
  // hand out a link to this endpoint and have a trusted-looking host bounce a
  // browser wherever it liked, carrying a freshly minted credential.
  //
  // This is the one resource here that redirects, and adt-session's rule that
  // nothing does is not being broken: that rule is about requests for data,
  // where a client reads a redirect as having been logged out. A logon that
  // redirects is the logon working.
  //
  // For now it admits everyone. A façade over a local SQLite file has no user
  // store and inventing one would be pretending; when there is a reason to
  // ask for credentials, this is where the 401 goes, and A4H shows the shape
  // — a plain Basic challenge, then the same 307.
  router.get(`${BASE}/core/http/reentranceticket`, (req, res) => {
    const target = req.query["redirect-url"];
    if (typeof target !== "string" || target === "") {
      res.status(400).type("text/plain").send("redirect-url is required");
      return;
    }
    // A3b: check the literal authority before WHATWG can expand IPv4 aliases.
    const authority = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(target);
    if (!authority || !/^(?:\[[^\]]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/.test(authority[2])) {
      res.status(400).type("text/plain").send("redirect-url is not a URL");
      return;
    }
    const host = authority[2].replace(/:[0-9]+$/, "").toLowerCase();
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      res.status(400).type("text/plain").send("redirect-url must point at loopback");
      return;
    }
    const suffix = authority[3];
    const path = suffix.split(/[?#]/)[0];
    const pathGrammar = /^(?:\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9a-f]{2})*)*$/i;
    const tailGrammar = /^(?:\?(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9a-f]{2})*)?(?:#(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9a-f]{2})*)?$/i;
    if (!pathGrammar.test(path) || !tailGrammar.test(suffix.slice(path.length))
      || path.split("/").some((part) => [".", ".."].includes(part.replace(/%2e/ig, ".")))) {
      res.status(400).type("text/plain").send("redirect-url is not a URL");
      return;
    }
    let url;
    try {
      url = new URL(target);
    } catch {
      res.status(400).type("text/plain").send("redirect-url is not a URL");
      return;
    }
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
      res.status(400).type("text/plain").send("redirect-url must point at loopback");
      return;
    }

    const ticket = randomBytes(24).toString("base64url");
    url.searchParams.set("_", String(req.query._ ?? Date.now()));
    url.searchParams.set("reentrance-ticket", ticket);

    // The session cookie is not set here on purpose. The session middleware
    // above already issued one naming a real session, and writing the ticket
    // over it would leave the client holding a value that identifies nothing
    // — which is how every later write earned a CSRF refusal the first time
    // this ran against Eclipse.
    //
    // The ticket's whole life is this redirect. What the client uses
    // afterwards is the cookie: every request Eclipse made after logging on
    // carried one, and no Authorization header at all.
    res.cookie("sap-usercontext", `sap-client=${identity.client}`, {path: "/"});
    res.redirect(307, url.toString());
  });

  if (options.abap === undefined) sessionRoutes(router, sessions, answer);

  // ---- Virtual folders: how a cloud project builds its tree.
  //
  // Measured on a working session: the tree came from 19 POSTs to
  // virtualfolders/contents and not one call to nodestructure. The two are
  // not interchangeable — a cloud client asked this façade for a tree, got
  // nodestructure back, and reported "No content-handler found for
  // content-type …nodestructure.v1+xml and data-type RepositoryObjectTreeContent".
  // It was not outdated and no plug-in was missing: it had asked for one
  // thing and been handed another.
  //
  // The model is a filter, not a hierarchy. The client sends preselections
  // (this package, that type) and an order of facets still to expand. A
  // non-empty facetorder asks for the folders of its first facet; an empty
  // one asks for the objects themselves. So one resource serves every level
  // of the tree, and the tree's shape is the client's choice rather than
  // ours.
  const FACETS = ["package", "group", "type", "api", "fav"];

  advertise("repository/informationsystem/virtualfolders");
  router.get(`${BASE}/repository/informationsystem/virtualfolders/facets`, (req, res) => {
    res.type("application/vnd.sap.adt.facets.v1+xml; charset=utf-8").send(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<vf:facets xmlns:vf="http://www.sap.com/adt/ris/facets">' +
      FACETS.map((facet) =>
        `<vf:facet key="${facet}" displayName="${facet[0].toUpperCase() + facet.slice(1)}"` +
        ` description="${facet}" isHierarchical="false"` +
        ' isForFiltering="true" isForStructuring="true"/>').join("") +
      "</vf:facets>",
    );
  });

  // One resource for every level of the tree. The shape of the answer is
  // read off the request: a non-empty facetorder asks for the drawers of its
  // first facet, an empty one asks for the objects. The forms below are the
  // system's, by capture line: package drawers a4h-adt.jsonl:44 and :232,
  // several selected packages :231, group and type drawers :90 and :91,
  // objects :92, the direct-only spelling :233 and :239.
  router.post(`${BASE}/repository/informationsystem/virtualfolders/contents`, (req, res) => answer(res, async () => {
    res.type("application/vnd.sap.adt.repository.virtualfolders.result.v1+xml; charset=utf-8")
      .send(virtualFoldersDocument(store, await rawBody(req)));
  }));

  // ---- The rest of what a client asks for before it will work.
  //
  // Found by a sweep rather than one failure at a time: every path the real
  // system answered was replayed against this façade, and these are the ones
  // that came back 404 while being asked for on every project open. Fixing
  // them one dialog at a time was costing a round trip with a person for
  // each, which is a slow way to find out what a client wants.

  // What kinds of object a client may filter a search by. Ours, not a
  // system's list of 304 — a filter for a type this façade cannot hold finds
  // nothing, and the client shows it as an option anyway.
  advertise("repository/informationsystem/objecttypes");
  router.get(`${BASE}/repository/informationsystem/objecttypes`, (req, res) => {
    res.type("application/vnd.sap.adt.nameditems.v1+xml; charset=utf-8").send(
      namedItemsDocument(Object.keys(TYPES).filter(code => !["SICF", "SAPC", "SAMC"].includes(code)).map((code) => ({
        // The item name is the workbench kind. The qualified ADT type and
        // its consumers live in data; Eclipse parses this field without a
        // null check while pre-loading and while constructing search filters.
        name: code,
        description: (LABELS[code] ?? [code])[1] ?? code,
        data: `type:${ADT_TYPE[code] ?? code};usedBy:quick_search,virtual_folders`,
      }))),
    );
  });

  // Release states, which a cloud client uses to split released APIs from the
  // rest. Nothing here is released in that sense and the empty list says so.
  advertise("repository/informationsystem/releasestates");
  router.get(`${BASE}/repository/informationsystem/releasestates`, (req, res) => {
    res.type("application/vnd.sap.adt.nameditems.v1+xml; charset=utf-8").send(namedItemsDocument([]));
  });

  // Property value helps behind the search dialog's filters.
  router.get(`${BASE}/repository/informationsystem/objectproperties/values`, (req, res) => {
    res.type("application/vnd.sap.adt.nameditems.v1+xml; charset=utf-8").send(namedItemsDocument([]));
  });

  // Whether to report package check errors. False, because there are none.
  router.get(`${BASE}/packages/settings`, (req, res) => {
    res.type("application/vnd.sap.adt.packages.settings+xml; charset=utf-8").send(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<pkcs:settings pkcs:showPackageCheckErrors="false" xmlns:pkcs="http://www.sap.com/adt/packages/settings"/>',
    );
  });

  // The feed list, and the feeds themselves elsewhere. A client activates
  // "registered feed queries" on every project open and logs an error when it
  // cannot read this.
  router.get(`${BASE}/feeds`, (req, res) => {
    emptyFeed(res, "ABAP System Monitoring", `${BASE}/feeds`);
  });
  router.get(`${BASE}/feeds/variants`, (req, res) => {
    emptyFeed(res, "Feed Variants", `${BASE}/feeds/variants`);
  });

  // Who exists. One user: the one this façade answers as, because there is no
  // user store behind it and pretending otherwise would put names in a
  // dropdown that mean nothing here.
  router.get(`${BASE}/system/users`, (req, res) => {
    res.type("application/atom+xml;type=feed").send(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">' +
      `<atom:title>Users</atom:title><atom:updated>${new Date().toISOString()}</atom:updated>` +
      `<atom:entry><atom:id>${identity.userName}</atom:id>` +
      `<atom:title>${identity.userFullName}</atom:title></atom:entry>` +
      "</atom:feed>",
    );
  });

  // Which object types can carry unit tests. Packages and classes here, which
  // is what this façade can actually run.
  advertise("abapunit/metadata");
  router.get(`${BASE}/abapunit/metadata`, (req, res) => {
    const feature = (kind, own) =>
      `<aunit:supportedTypeFeatures globalWorkbenchType="${kind}" ownTests="${own}"` +
      ' assignedTests="true" coverage="false"/>';
    res.type("application/vnd.sap.adt.abapunit.metadata.result.v1+xml; charset=utf-8").send(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<aunit:metadata xmlns:aunit="http://www.sap.com/adt/aunit">' +
      feature("DEVC/K", "true") + feature("CLAS/OC", "true") + feature("PROG/P", "true") +
      "</aunit:metadata>",
    );
  });

  // Which build is answering.
  //
  // "Are we sure the server was restarted" is a question that should cost one
  // request, not a chain of inference. It was asked after a deploy that had
  // in fact landed, and the only way to answer was to probe three unrelated
  // resources and reason about what their shapes implied. The bridge grew the
  // same stamp for the same reason.
  //
  // The digest is over the façade's own sources, so it changes when the
  // answers change and not when the process merely restarts.
  /** the commit this tree is at, asked once: a release is built from a
   *  checkout, so the answer does not change while the process lives */
  let commitCache;
  const sourceCommit = () => {
    if (commitCache !== undefined) return commitCache;
    commitCache = process.env.GITHUB_SHA ?? "";
    // A **release** is not a checkout, so git cannot answer there and the
    // field read `unknown` on the one target the commit rule exists to
    // check. `scripts/make-release.mjs` writes it into `release.json` beside
    // the binary; that file is read first because where it exists it is the
    // only correct answer -- a release carried to another machine has no
    // repository at all.
    if (commitCache === "") {
      for (const dir of [store.root ?? process.cwd(), process.cwd()]) {
        try {
          commitCache = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")).commit ?? "";
        } catch {
          commitCache = "";
        }
        if (commitCache !== "") break;
      }
    }
    if (commitCache === "") {
      try {
        commitCache = execFileSync("git", ["rev-parse", "HEAD"],
          {cwd: store.root ?? process.cwd(), encoding: "utf8"}).trim();
      } catch {
        commitCache = "unknown";
      }
    }
    return commitCache;
  };

  router.get(`${BASE}/core/http/build`, (req, res) => sendIntrospection(res, buildAnswer({store, data, sourceCommit, identity})));

  // What "Rebuild (warm)" (editors/vscode, docs/vscode-extension.md "Warm")
  // activates in one call: every CLAS/INTF whose file no longer hashes to
  // what the warm registry was primed or last built from
  // (ObjectStore#changedObjects, off the warm compiler's own digests --
  // tools/osd-warm.mjs). `objects: undefined` (not an empty array) when the
  // registry is not primed, which is the caller's cue to fall back to a
  // cold rebuild rather than trust a list this could not check; `reason`
  // carries store.warm()'s own reason in that case. OSG-specific, so not
  // advertised, like the other core/http/* doors around it.
  router.get(`${BASE}/core/http/changed`, (req, res) => sendIntrospection(res, changedAnswer(store)));

  // The host checkout is the Workbench's history layer. This endpoint is
  // intentionally read-only and resolves type/name through ObjectStore
  // before Git sees a path. It is OSG-specific, so it is not advertised as
  // an ADT capability that a standard client might mistake for SAP ADT.
  router.get(`${BASE}/core/http/git/object`, (req, res) => {
    const type = String(req.query.type ?? "").split("/")[0].toUpperCase();
    const name = String(req.query.name ?? "").toUpperCase();
    try {
      const entry = store.read(type, name);
      res.type("application/json; charset=utf-8").send(JSON.stringify(
        gitObjectState(store.root, entry.file),
      ));
    } catch (error) {
      if (error instanceof NotFound) {
        refuse(res, 404, "ExceptionResourceNotFound", error.message);
      } else {
        refuse(res, 500, "ExceptionGitHistory", error.message ?? String(error));
      }
    }
  });

  router.get(`${BASE}/core/http/git/object/revision`, (req, res) => {
    const type = String(req.query.type ?? "").split("/")[0].toUpperCase();
    const name = String(req.query.name ?? "").toUpperCase();
    try {
      const entry = store.read(type, name);
      const source = gitObjectRevision(store.root, entry.file,
        String(req.query.revision ?? ""));
      res.status(200).type("text/plain; charset=utf-8").send(source);
    } catch (error) {
      if (error instanceof NotFound) {
        refuse(res, 404, "ExceptionResourceNotFound", error.message);
      } else {
        refuse(res, 400, "ExceptionGitRevision", error.message ?? String(error));
      }
    }
  });

  // Object-scoped ABAP Unit for the Fiori Workbench. This is deliberately a
  // thin JSON view over the same UnitRun used by the ADT endpoint below: the
  // UI gets discovery without executing anything, and a run still happens
  // in the isolated child database rather than in the serving process.
  const selectedUnitPlan = (plan, testClass, method) => {
    const selectedClass = testClass === undefined ? undefined
      : plan.classes.find((item) => item.name === testClass);
    if (testClass !== undefined && selectedClass === undefined) {
      const error = new Error(`test class ${testClass} does not belong to ${plan.object.name}`);
      error.code = "NOT_FOUND";
      throw error;
    }
    if (method !== undefined && selectedClass?.testMethods.some((item) => item.name === method) !== true) {
      const error = new Error(`test method ${testClass}=>${method} does not belong to ${plan.object.name}`);
      error.code = "NOT_FOUND";
      throw error;
    }
    return {plan, testClass, method};
  };

  router.get(`${BASE}/core/http/unit/object`, async (req, res) => {
    const type = String(req.query.type ?? "").split("/")[0].toUpperCase();
    const name = String(req.query.name ?? "").toUpperCase();
    if (!["CLAS", "PROG"].includes(type)) {
      refuse(res, 400, "ExceptionInvalidRequest", `${type || "object"} cannot carry ABAP Unit tests here`);
      return;
    }
    try {
      // lazy: osd-unit.mjs needs node:child_process, which the browser preview bundle must not pull in
      const {unitPlan} = await import("./osd-unit.mjs");
      const plan = await unitPlan(store, type, name, {risk: true});
      res.type("application/json; charset=utf-8").send(JSON.stringify({
        object: {type: plan.object.type, name: plan.object.name},
        writes: plan.writes,
        writesTotal: plan.writesTotal,
        dynamicCalls: plan.dynamicCalls,
        dynamicCallsTotal: plan.dynamicCallsTotal,
        ...(plan.riskError === undefined ? {} : {riskError: plan.riskError}),
        classes: plan.classes.map((testClass) => ({
          name: testClass.name,
          riskLevel: testClass.riskLevel,
          riskLevelDeclared: testClass.riskLevelDeclared,
          durationCategory: testClass.durationCategory,
          durationDeclared: testClass.durationDeclared,
          schedule: testClass.schedule,
          include: testClass.include,
          line: testClass.line,
          column: testClass.column,
          methods: testClass.testMethods.map((method) => ({
            name: method.name, line: method.line, column: method.column,
          })),
        })),
      }));
    } catch (error) {
      refuse(res, error instanceof NotFound ? 404 : 500,
        error instanceof NotFound ? "ExceptionResourceNotFound" : "ExceptionTestDiscoveryFailed",
        error.message ?? String(error));
    }
  });

  router.post(`${BASE}/core/http/unit/object/run`, async (req, res) => {
    const type = String(req.query.type ?? "").split("/")[0].toUpperCase();
    const name = String(req.query.name ?? "").toUpperCase();
    const testClass = String(req.query.testClass ?? "").toUpperCase() || undefined;
    const method = String(req.query.method ?? "").toUpperCase() || undefined;
    if (!["CLAS", "PROG"].includes(type)) {
      refuse(res, 400, "ExceptionInvalidRequest", `${type || "object"} cannot carry ABAP Unit tests here`);
      return;
    }
    const cancellation = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) cancellation.abort();
    });
    try {
      const {dbEnv, inspectPort, waitForDebugger} = await unitRunOptions(req);
      const runner = await store.unit();
      // with the risk: the child guards a class scheduled as HARMLESS
      const plan = await runner.withRisk(runner.classes(type, name));
      const run = await runner.runDetached(type, name, {...selectedUnitPlan(plan, testClass, method), dbEnv, inspectPort,
        waitForDebugger, signal: cancellation.signal});
      res.type("application/json; charset=utf-8").send(JSON.stringify(run));
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const missing = error instanceof NotFound || error?.code === "NOT_FOUND";
      const invalid = error?.code === "INVALID_REQUEST";
      refuse(res, invalid ? 400 : missing ? 404 : 500,
        invalid ? "ExceptionInvalidRequest" : missing ? "ExceptionResourceNotFound" : "ExceptionTestRunFailed",
        error.message ?? String(error));
    }
  });

  // Everything this system serves, as the tree an editor shows (the VS Code
  // extension's grouped tree): OData services, UI5 apps, ICF nodes and push
  // channels, one row each, with the class that answers and where the row is
  // declared, so a node is a pointer to its source and one action. One
  // inventory, the one the status tables and the webgui menu read
  // (tools/osd-status.mjs serviceTree); an OData service's entity sets are
  // not listed here but asked for when a node opens (segw/entitysets).
  router.get(`${BASE}/core/http/services`, (req, res) => sendIntrospection(res, servicesAnswer(store)));

  // The same transaction registry the WebGUI reads, including entries that
  // cannot be entered in this runtime (reports and dynpros still belong in
  // the developer's inventory). Source paths stay relative to the tree.
  router.get(`${BASE}/core/http/transactions`, (req, res) => sendIntrospection(res, transactionsAnswer(store)));

  // Q2b "Runner" (docs/vscode-extension.md): which service and entity set a
  // SEGW _DPC_EXT class's own `<set>_get_entityset` / `<set>_get_entity`
  // methods answer for, so a CodeLens can call one without the extension
  // guessing at file names. Read fresh off the tree every call, the way the
  // registry itself is built (tools/segw-registry.mjs, tools/osd-status.mjs
  // servicesOf): a class not registered as a service's DPC, or whose model
  // has no MPC, is 404 rather than a guess.
  router.get(`${BASE}/core/http/segw/entitysets`, (req, res) => answer(res, async () => {
    const name = String(req.query.class ?? "").toUpperCase();
    if (name === "") {
      refuse(res, 400, "ExceptionInvalidRequest", "class is required");
      return;
    }
    const registrations = await segwRegistrationsOf(store);
    const readSource = (className) => {
      try {
        return store.read("CLAS", className).source;
      } catch {
        return undefined;
      }
    };
    const map = entitySetMapFor(name, registrations, readSource);
    if (map === undefined) {
      refuse(res, 404, "ExceptionResourceNotFound", `${name} is not a registered service's _DPC_EXT with a known MPC`);
      return;
    }
    res.type("application/json; charset=utf-8").send(JSON.stringify(map));
  }));

  // Q3 "Readers" (docs/vscode-extension.md): who references a CLAS or INTF,
  // for a CodeLens above its `CLASS ... DEFINITION` / `INTERFACE` line. The
  // parse already knows this direction and seeds it at every host start
  // (tools/osd-xref-seed.mjs): a WBCROSSGT/WBCROSSGTX row is `{OTYPE: 'TY',
  // NAME: the referenced object, INCLUDE: the referencer}` -- INCLUDE
  // already carries the referencer's own object name, never a per-include
  // suffix (tools/osd-xref.mjs CrossReference#build, the WBCROSSGT branch),
  // so there is no include-to-object mapping to do here. The rows are read
  // the same way the client's own data preview reads any table
  // (`data.query`, tools/osd-data.mjs) -- this is a where-used view over the
  // same seeded tables, not a second index.
  //
  // A reader is a test if it carries its own ABAP Unit tests
  // (tools/osd-unit-run.mjs testClassesIn, the build's own list of
  // `*.clas.testclasses.abap` objects) or a service if it is registered as a
  // service's own `_DPC_EXT` (tools/segw-registry.mjs segwRegistrations,
  // read fresh off the tree the way the entitysets route above does) --
  // both are classifications of the reader, not of the class being read, so
  // a reader can be neither, either or both. The services count also includes
  // registrations directly handled by the class being read (DPC, MPC or
  // another service handler); those are not where-used readers.
  router.get(`${BASE}/core/http/xref/readers`, async (req, res) => {
    const type = String(req.query.type ?? "").toUpperCase();
    const name = String(req.query.name ?? "").toUpperCase();
    if (!["CLAS", "INTF"].includes(type)) {
      refuse(res, 400, "ExceptionInvalidRequest", "type must be CLAS or INTF");
      return;
    }
    if (name === "") {
      refuse(res, 400, "ExceptionInvalidRequest", "name is required");
      return;
    }
    if (!store.exists(type, name)) {
      refuse(res, 404, "ExceptionResourceNotFound", `${type} ${name} does not exist`);
      return;
    }
    try {
      // the warm registry's reverse index when it is primed -- as fresh as the
      // last build, where the seeded rows are as fresh as the last start of
      // the serving process, and a warm swap does not reseed them -- and the
      // seeded rows otherwise; `source` says which one answered
      let includes = xrefFact(store, "XREF_WARM", {operation: "READERS", type, name}).objects?.map(o => o.name);
      const source = includes === undefined ? "xref" : "warm";
      if (includes === undefined) {
        const escaped = name.replace(/'/g, "''");
        const result = await data.query(
          `SELECT include FROM wbcrossgt WHERE otype = 'TY' AND name = '${escaped}' AND include <> '${escaped}' ` +
          `UNION SELECT include FROM wbcrossgtx WHERE otype = 'TY' AND name = '${escaped}' AND include <> '${escaped}'`,
          {max: 5000});
        includes = result.rows.map((r) => String(r.include).toUpperCase());
      }
      const typeOf = new Map(Object.entries(xrefFact(store, "OBJECT_TYPES")));
      const registrations = xrefFact(store, "SEGW_REGISTRATIONS", {registered:true});
      const testClasses = new Set(xrefFact(store, "TESTCLASSES"));
      const readers = [...new Set(includes)]
        .filter((include) => include !== name)
        .sort()
        .map((include) => ({
          type: typeOf.get(include) ?? "UNKNOWN",
          name: include,
          include,
          isTest: testClasses.has(include),
          services: registrations.filter((r) => r.dpc === include).map((r) => r.external),
        }));
      const serviceCount = countServiceRegistrations(readers, type === "CLAS" ? xrefFact(store, "SERVICE_ROWS") : [], name);
      res.type("application/json; charset=utf-8").send(JSON.stringify({
        name,
        source,
        readers,
        counts: {
          readers: readers.length,
          tests: readers.filter((r) => r.isTest).length,
          services: serviceCount,
        },
      }));
    } catch (e) {
      refuse(res, 500, "ExceptionInternalError", String(e?.message ?? e));
    }
  });

  // Everything an edit of a class or interface reaches, transitively, and
  // which of those carry tests: the tests an edit should run (B1). Answered
  // from the warm registry's reverse index when it is primed -- always as
  // fresh as the last build -- and otherwise by walking the seeded
  // WBCROSSGT/WBCROSSGTX rows reader by reader, which are as fresh as the
  // last start of the serving process. `source` says which one answered.
  router.get(`${BASE}/core/http/xref/closure`, async (req, res) => {
    const type = String(req.query.type ?? "").toUpperCase();
    const name = String(req.query.name ?? "").toUpperCase();
    if (!["CLAS", "INTF"].includes(type) || name === "") {
      refuse(res, 400, "ExceptionInvalidRequest", "type (CLAS or INTF) and name are required");
      return;
    }
    if (!store.exists(type, name)) {
      refuse(res, 404, "ExceptionResourceNotFound", `${type} ${name} does not exist`);
      return;
    }
    try {
      const LIMIT = options.xrefLimit ?? 5000;
      let closure = xrefFact(store, "XREF_WARM", {operation: "CLOSURE", type, name}).objects;
      let source = "warm";
      let truncated = false;
      if (closure === undefined) {
        source = "xref";
        const typeOf = new Map(Object.entries(xrefFact(store, "OBJECT_TYPES")));
        const seen = new Set([name]);
        const todo = [name];
        while (todo.length > 0 && seen.size < LIMIT) {
          const escaped = todo.pop().replace(/'/g, "''");
          const result = await data.query(
            `SELECT include FROM wbcrossgt WHERE otype = 'TY' AND name = '${escaped}' ` +
            `UNION SELECT include FROM wbcrossgtx WHERE otype = 'TY' AND name = '${escaped}'`, {max: 5000});
          for (const row of result.rows) {
            const reader = String(row.include).toUpperCase();
            if (!seen.has(reader)) {
              seen.add(reader);
              todo.push(reader);
            }
          }
        }
        // a walk that stopped at the limit says so rather than looking whole
        truncated = todo.length > 0;
        closure = [...seen].map((n) => ({type: n === name ? type : (typeOf.get(n) ?? "UNKNOWN"), name: n}));
      }
      const tests = new Set(xrefFact(store, "TESTCLASSES"));
      const objects = closure
        .map((o) => ({...o, isTest: o.type === "CLAS" && tests.has(o.name)}))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.type("application/json; charset=utf-8").send(JSON.stringify({
        type, name, source, truncated,
        closure: objects,
        tests: objects.filter((o) => o.isTest).map((o) => o.name),
        counts: {objects: objects.length, tests: objects.filter((o) => o.isTest).length},
      }));
    } catch (e) {
      refuse(res, 500, "ExceptionInternalError", String(e?.message ?? e));
    }
  });

  // ---- The workbench type list, which the client pre-loads before it will
  // open anything.
  //
  // Answered from what this façade actually serves rather than copied from a
  // system: TYPES already names every kind here and where it lives under
  // /sap/bc/adt, which is exactly the two things a descriptor carries. A list
  // borrowed from somewhere else would advertise types that 404 on the first
  // click.
  //
  // The real one is 359 KB of the same shape — a flat run of descriptors
  // inside asx:abap — and reaches the client gzipped by the ICM, which is
  // where the "binary" first impression came from. Express compresses it
  // here for the same reason.
  const LABELS = {
    CLAS: ["Class", "Classes", "Source Code Library"],
    INTF: ["Interface", "Interfaces", "Source Code Library"],
    PROG: ["Program", "Programs", "Source Code Library"],
    INCL: ["Include", "Includes", "Source Code Library"],
    FUGR: ["Function Group", "Function Groups", "Source Code Library"],
    TABL: ["Database Table", "Database Tables", "Dictionary"],
    DTEL: ["Data Element", "Data Elements", "Dictionary"],
    DOMA: ["Domain", "Domains", "Dictionary"],
    TTYP: ["Table Type", "Table Types", "Dictionary"],
    DDLS: ["Data Definition", "Data Definitions", "Dictionary"],
    SRVD: ["Service Definition", "Service Definitions", "Dictionary"],
    VIEW: ["View", "Views", "Dictionary"],
    SHLP: ["Search Help", "Search Helps", "Dictionary"],
    MSAG: ["Message Class", "Message Classes", "Source Code Library"],
    SICF: ["SICF", "SICF", "Others"],
    SAPC: ["SAPC", "SAPC", "Others"],
    SAMC: ["SAMC", "SAMC", "Others"],
    DEVC: ["Package", "Packages", "Others"],
  };

  router.post(`${BASE}/repository/typestructure`, (req, res) => {
    const descriptors = Object.entries(TYPES).map(([code, type]) => {
      const [label, plural, category] = LABELS[code] ?? [code, code, "Others"];
      return "<SEU_ADT_OBJECT_TYPE_DESCRIPTOR>" +
        `<OBJECT_TYPE>${ADT_TYPE[code] ?? code}</OBJECT_TYPE>` +
        `<OBJECT_TYPE_LABEL>${label}</OBJECT_TYPE_LABEL>` +
        `<OBJECT_TYPE_LABEL_PLURAL>${plural}</OBJECT_TYPE_LABEL_PLURAL>` +
        `<CATEGORY>${category}</CATEGORY>` +
        `<CATEGORY_LABEL>${category}</CATEGORY_LABEL>` +
        `<URI_TEMPLATE>${BASE}/${type.adt}/{name}</URI_TEMPLATE>` +
        "<PARENT_OBJECT_TYPE/>" +
        "<OBJNAME_MAXLENGTH>30</OBJNAME_MAXLENGTH>" +
        "<CAPABILITIES/><USER_AUTHORIZATIONS/>" +
        "</SEU_ADT_OBJECT_TYPE_DESCRIPTOR>";
    }).join("");

    res.type(asXmlTypeFor(req, "com.sap.adt.RepositoryTypeList")).send(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>' +
      descriptors +
      "</DATA></asx:values></asx:abap>",
    );
  });

  // ---- What the client polls, and what a healthy system has to say about it.
  //
  // Measured: over a captured working session these were a quarter of every
  // request made — 108 calls to runtime/dumps and 54 to systemmessages, both
  // on a timer, both answered with an empty feed because nothing had gone
  // wrong. A façade that answers them sheds most of its traffic before
  // implementing anything interesting, and a façade that 404s them makes a
  // client report an error where the real answer is "nothing to report".
  //
  // An empty feed is not a stub. It is the correct answer, and it stays the
  // correct answer for as long as nothing here dumps.
  const emptyFeed = (res, title, self) => {
    res.type("application/atom+xml;type=feed").send(emptyFeedDocument({
      userFullName: identity.userFullName, systemID: identity.systemID, title, self,
      updated: new Date().toISOString(),
    }));
  };

  router.get(`${BASE}/runtime/dumps`, (req, res) => {
    emptyFeed(res, "Runtime Errors", `${BASE}/runtime/dumps`);
  });

  router.get(`${BASE}/runtime/systemmessages`, (req, res) => {
    emptyFeed(res, "System Messages", `${BASE}/runtime/systemmessages`);
  });

  router.get(`${BASE}/gw/errorlog`, (req, res) => {
    emptyFeed(res, "SAP Gateway Error Log", `${BASE}/gw/errorlog`);
  });

  // The debugger's long poll. A4H answers 200 with no body at all, to every
  // one of GET, POST and DELETE, and that is the whole contract: there is no
  // listener, nobody is being debugged, come back later. Nothing here can be
  // debugged either, so the same answer is honest rather than a placeholder.
  for (const method of ["get", "post", "delete"]) {
    router[method](`${BASE}/debugger/listeners`, (req, res) => {
      res.status(200).end();
    });
  }

  // Read once at startup and shown in the window title.
  router.get(`${BASE}/core/http/systeminformation`, (req, res) => {
    res.type("application/vnd.sap.adt.core.http.systeminformation.v1+json; charset=utf-8")
      .send(JSON.stringify(identity));
  });

  // ---- discovery: the handshake and the gatekeeper, at both of its names.
  // core/discovery is what a client probes for reachability and a token;
  // discovery is the collection list it scans. Both carry the same
  // collections; core/discovery puts each in a workspace of its own, the
  // form abap-adt-api's core reader takes (see discoveryDocument).
  const discoveryAt = (core) => (req, res) => {
    res.status(200).type("application/atomsvc+xml").send(discoveryDocument(resources, {core}));
  };
  // HEAD before GET on purpose: a client fetches its token with HEAD and
  // falls back to GET only if HEAD is refused, so HEAD must work
  for (const path of [BASE + "/core/discovery", BASE + "/discovery"]) {
    router.head(path, (req, res) => {
      res.status(200).type("application/atomsvc+xml").end();
    });
    router.get(path, discoveryAt(path.endsWith("/core/discovery")));
  }

  // ---- compatibility/graph: the logon probe, and the whole of what stands
  // between OSD and a real IDE.
  //
  // abap-adt-api, which is what the VS Code client adt-fs runs on, calls this
  // and nothing else from login(): it sends basic auth, asks for a token with
  // `x-csrf-token: fetch`, and keeps the cookies. It never reads the body and
  // never checks the content type. So a 404 here is a failed logon, and a 200
  // here is a connected IDE, with no reentrance ticket and no RFC anywhere in
  // it. That is the entire reason this route exists.
  //
  // The graph says which features this façade serves; see
  // compatibilityGraphDocument for what an empty one turned out to mean and
  // why it is no longer empty. A client reads it before it reads discovery,
  // and disables what it finds unclaimed.
  for (const path of [BASE + "/compatibility/graph"]) {
    router.head(path, (req, res) => {
      res.status(200).type("application/xml").end();
    });
    router.get(path, (req, res) => {
      res.status(200).type("application/xml").send(compatibilityGraphDocument());
    });
  }

  // ---- reading source
  for (const {type, adt} of SOURCE_TYPES) {
    advertise(adt);
    // a namespaced name arrives URL-encoded (%2Fdemo%2Fzreport) and Express
    // has already decoded it by the time it is a parameter
    router.get(`${BASE}/${adt}/:name/source/main`, (req, res) => {
      answer(res, () => {
        const part = store.read(type, req.params.name, "main", req.query.version);
        const source = part.source;
        res.type("text/plain; charset=utf-8");
        sendEntity(req, res, source, part.etag);
      });
    });
    // the base resource of a class include. A client resolving a method body
    // asks for the include object before it asks for the include's source, so
    // a 404 here stops a method read that would otherwise work.
    router.get(`${BASE}/${adt}/:name/includes/:include`, (req, res) => {
      answer(res, () => {
        const {name, include} = req.params;
        if (type !== "CLAS") {
          throw new NotFound(type, `${name} include ${include}`);
        }
        const part = store.read(type, name, include, req.query.version);
        // READ's empty flag describes the requested version, including active snapshots.
        if (part.empty === true && include === "testclasses") {
          const missing = missingTestInclude(part.name);
          return void refuse(res, 404, "ExceptionResourceNotFound", missing.message, missing);
        }
        if (part.empty === true && classIncludeTemplates[include]) { part.source = classIncludeTemplates[include]; part.etag = entityTag(part.source); }
        // VSP and the source links in class properties use this URL directly
        // with */*. Only an explicit include-property request wants XML.
        if (!String(req.headers.accept ?? "").includes("application/vnd.sap.adt.oo.classes.includes.")) {
          res.type("text/plain; charset=utf-8");
          sendEntity(req, res, part.source, part.etag);
          return;
        }
        const document = classIncludeDocument(store.find(type, name).name, include, `${BASE}/${adt}/${encodeURIComponent(String(name).toLowerCase())}/includes/${include}/source/main`);
        res.type("application/vnd.sap.adt.oo.classes.includes.v2+xml");
        sendEntity(req, res, document);
      });
    });
    // a class's other includes: definitions, implementations, macros, tests
    router.get(`${BASE}/${adt}/:name/includes/:include/source/main`, (req, res) => {
      answer(res, () => {
        if (type !== "CLAS") {
          throw new NotFound(type, `${req.params.name} include ${req.params.include}`);
        }
        const part = store.read(type, req.params.name, req.params.include, req.query.version);
        if (part.empty === true && req.params.include === "testclasses") {
          return void res.status(404).type("text/plain; charset=utf-8").send("No suitable resource found");
        }
        if (part.empty === true && classIncludeTemplates[req.params.include]) { part.source = classIncludeTemplates[req.params.include]; part.etag = entityTag(part.source); }
        const source = part.source;
        res.type("text/plain; charset=utf-8");
        sendEntity(req, res, source, part.etag);
      });
    });
    // the versions of the source (tools/adt-versions.mjs): the feed, and one
    // version's source. A class keeps them per include, at .../includes/
    // <include>/versions, and so does an interface's main include, which is
    // where vsp asks (resolveRevisionURL); everything else at .../source/main.
    const versionsOf = (req, res, include) => answer(res, () => {
      // Git history is keyed by the working file, independently of whether
      // there is an active snapshot (the HISTORY host command does the same).
      const part = store.read(type, req.params.name, include);
      const base = `${BASE}/${adt}/${encodeURIComponent(String(req.params.name).toLowerCase())}` +
        (include === undefined ? "/source/main/versions" : `/includes/${include}/versions`);
      const feed = objectVersions(store.root, part.empty ? undefined : part.file, identity.userName);
      if (feed.note !== "") res.set("X-OSD-History", `none: ${feed.note}`);
      // exactly A4H's header: a string body would get "; charset=utf-8" added
      res.set("Content-Type", "application/atom+xml;type=feed");
      sendEntity(req, res, Buffer.from(versionsFeedDocument(part.name, type, base, feed)));
    });
    const versionContent = (req, res, include) => answer(res, () => {
      const working = store.read(type, req.params.name, include);
      const part = req.params.version === "00000" ? store.read(type, req.params.name, include, "active") : working;
      let source;
      try {
        source = versionSource(store.root, working.empty ? undefined : working.file, req.params.version, part.source);
      } catch (error) {
        throw new NotFound(type, `${req.params.name} version ${req.params.version} (${error.message})`);
      }
      res.type("text/plain; charset=utf-8");
      sendEntity(req, res, source);
    });
    router.get(`${BASE}/${adt}/:name/source/main/versions`, (req, res) => versionsOf(req, res));
    router.get(`${BASE}/${adt}/:name/source/main/versions/:stamp/:version/content`, (req, res) => versionContent(req, res));
    if (type === "DDLS") {
      // a CDS source links its versions as a sibling of source/, not below it
      router.get(`${BASE}/${adt}/:name/versions`, (req, res) => versionsOf(req, res));
      router.get(`${BASE}/${adt}/:name/versions/:stamp/:version/content`, (req, res) => versionContent(req, res));
    }
    if (type === "CLAS" || type === "INTF") {
      const includeOf = (req) => {
        if (type === "INTF" && req.params.include !== "main") {
          throw new NotFound(type, `${req.params.name} include ${req.params.include}`);
        }
        return req.params.include;
      };
      router.get(`${BASE}/${adt}/:name/includes/:include/versions`, (req, res) =>
        answer(res, () => versionsOf(req, res, includeOf(req))));
      router.get(`${BASE}/${adt}/:name/includes/:include/versions/:stamp/:version/content`, (req, res) =>
        answer(res, () => versionContent(req, res, includeOf(req))));
    }
    // the object structure: what a client reads before asking for one method
    // rather than the whole source. A plain full-source read never comes
    // through here, which is why wave 0 could do without it.
    // The object itself, at two spellings of one resource.
    //
    // `.../objectstructure` is the one vsp asks for. The bare object URI is
    // the one abap-adt-api asks for, and through it adt-fs: its
    // objectStructure() GETs the object's own address and reads the
    // structure out of whatever comes back, taking the source from the
    // root's abapsource:sourceUri. So opening a class in VS Code hit the
    // bare path, met the catch-all, and failed with "not served by OSD"
    // after the tree had already opened — the object was there and its
    // front door was not.
    const structure = (req, res) => {
      answer(res, () => {
        const found = structureOf(store, type, req.params.name, req.query.version);
        if (found === undefined) {
          throw new NotFound(type, req.params.name);
        }
        // xml:base on the root is not decoration. The client merges this
        // structure with its own parse of the source and, first thing, takes
        // getBaseLinks().get(0) — a list filled only from xml:base
        // (abapsource!AdtStructuralInfoService#mergeOutlineContentWithRndBasedOutline@78-93,
        // ObjectStructureContentHandler#parseRecursively@135-231). Without it:
        // "Index 0 out of bounds for length 0" on every keystroke in the editor.
        const accept = req.get("accept") ?? "";
        const version = !accept.includes("application/vnd.sap.adt.objectstructure.v2+xml")
          && (accept.includes("application/vnd.sap.adt.objectstructure+xml") || accept.includes("application/xml")) ? "" : ".v2";
        res.type(`application/vnd.sap.adt.objectstructure${version}+xml`)
          .send(objectStructureDocument(found, {base: req.originalUrl}));
      });
    };
    router.get(`${BASE}/${adt}/:name/objectstructure`, structure);

    // A class answers as a class here, whatever the client asked for.
    //
    // This went through two wrong versions before the oracle settled it. The
    // first served the object structure, on a note saying abap-adt-api GETs
    // this address expecting one — written when a class would not open in VS
    // Code. The second served whichever the Accept header named, on the
    // reasoning that Eclipse and abap-adt-api want different things and both
    // could be right.
    //
    // They do not want different things. VS Code, handed the structure, said
    // "Operation not supported for object CLAS/OC CL_ICF_TREE" — it had
    // recognised the type and refused, because it wanted a class document
    // too. And the real system does not negotiate at all: asked with
    // Accept: */* and asked with the versioned class type, A4H answers
    // class:abapClass both times.
    //
    // So content negotiation here was a dialect no system speaks, invented to
    // reconcile a conflict that did not exist. The structure keeps its own
    // address under /objectstructure, which is where a client that wants one
    // asks.
    if (type === "CLAS") {
      router.get(`${BASE}/${adt}/:name`, (req, res) => {
        answer(res, () => {
          const found = store.find(type, req.params.name);
          if (found === undefined) {
            throw new NotFound(type, req.params.name);
          }
          // with its state: written and not activated reads as inactive, and
          // the document changes with it, which is what the client re-reads
          // for after a save
          const document = classDocument({...found, ...store.stateOf(found)}, {includes: store.classIncludes?.(found.name) ?? []});
          res.type("application/vnd.sap.adt.oo.classes.v4+xml");
          sendEntity(req, res, document);
        });
      });
    } else if (SOURCE_PROPERTY_MIME[type] !== undefined) {
      router.get(`${BASE}/${adt}/:name`, (req, res) => {
        answer(res, () => {
          const object = store.read(type, req.params.name);
          const document = sourcePropertiesDocument(type, {...object, version: store.stateOf(object).version});
          res.type(SOURCE_PROPERTY_MIME[type]);
          sendEntity(req, res, document);
        });
      });
    } else {
      router.get(`${BASE}/${adt}/:name`, structure);
    }
  }

  // ---- classrun: F9, "Run as ABAP Application (Console)" (docs/adt-facade.md).
  //
  // A resource, not a collection of named operations like checkruns or
  // activation: POST the class name in the path, get back what it wrote as
  // text/plain, whatever it did. No compatibility-graph node gates it (the
  // real system's own graph, .local/adt-corpus/latest/bodies/00008-response.xml,
  // has no "classrun" entry anywhere), so discovery's collection alone is
  // what a client checks -- advertised above, `advertise("oo/classrun")`
  // and the CATEGORY/TITLE/TEMPLATE_LINKS entries at the top of this file.
  //
  // A dump is still a 200, the way ADT's own console shows it: whatever the
  // class had already written, then the trace, in one text/plain body. Only
  // the request itself being wrong -- no such class, or a class that does
  // not implement IF_OO_ADT_CLASSRUN, or nothing transpiled yet -- is an
  // HTTP error, the same distinction `answered()` draws for every object
  // read here.
  advertise("oo/classrun");
  router.post(`${BASE}/oo/classrun/:name`, async (req, res) => {
    await rawBody(req);
    try {
      const runner = await store.classrun();
      // `data` is the façade's own (whatever it shares its connection
      // with), not `store.data()` -- see tools/osd-classrun.mjs for why a
      // second one must not boot a second runtime
      const result = await runner.run(req.params.name, {data});
      res.status(200).type("text/plain; charset=utf-8").send(result.ok
        ? result.text
        : `${result.text}${result.text ? "\n\n" : ""}Runtime error: ${result.error.message} at ${result.error.where}`);
    } catch (e) {
      if (e instanceof NotFound) {
        record?.(req, "object", e.message);
        refuse(res, 404, "ExceptionResourceNotFound", e.message);
      } else if (e?.code === "NOT_CLASSRUN") {
        refuse(res, 400, "ExceptionInvalidRequest", e.message);
      } else if (e?.code === "NOT_TRANSPILED" || e?.code === "NOT_SUPPORTED" || e?.code === "NOT_BUILT") {
        refuse(res, 503, "ExceptionInternalError", e.message);
      } else {
        refuse(res, 500, "ExceptionInternalError", String(e?.message ?? e), {namespace: "org.open-steamgate.osd"});
      }
    }
  });

  // A notebook ABAP cell is one generated class in the permanent scratch
  // pack. Reuse the regular store, build and classrun path so it has exactly
  // the same database and activation boundary as another class. The fixed
  // class name makes runs one-at-a-time: activation replaces the process's
  // module graph, and another cell must not replace its source before its
  // classrun has read it.
  let notebookCellRun = Promise.resolve();
  router.post(`${BASE}/notebook/abap`, async (req, res) => {
    let asked;
    try {
      const body = await rawBody(req);
      asked = JSON.parse(body.toString("utf8"));
    } catch {
      res.status(400).json({error: {code: "BAD_REQUEST", message: "a JSON body with source is required"}});
      return;
    }
    if (typeof asked?.source !== "string" || asked.source.trim() === "") {
      res.status(400).json({error: {code: "BAD_REQUEST", message: "notebook ABAP source is empty"}});
      return;
    }

    const run = notebookCellRun.then(async () => {
      const scratch = store.roots.find((root) => root.pack === "notebook-scratch" && root.writable === true);
      if (scratch === undefined) {
        const error = new Error("the notebook-scratch pack is not configured; start osd through the VS Code launcher");
        error.code = "NOTEBOOK_SCRATCH_MISSING";
        throw error;
      }
      const name = "ZCL_OSD_NOTEBOOK_CELL";
      const previousEntry = store.find("CLAS", name);
      const previous = previousEntry === undefined ? undefined : store.read("CLAS", name).source;
      const previousActive = previousEntry !== undefined && store.stateOf(previousEntry).version === "active";
      await store.write("CLAS", name, asked.source, "main", {root: scratch.path});
      const checked = store.warmActivation("CLAS", name);
      let notebookBuilt;
      try {
        const activation = await store.publish({activate: [{type: "CLAS", name}]});
        notebookBuilt = activation?.transpile?.built;
        if (activation?.ok === false) {
          const issue = activation.transpile?.issues?.flatMap((object) => object.issues ?? [])[0];
          const message = issue?.message ?? activation.error ?? activation.transpile?.output ?? "the notebook class did not activate";
          const error = new Error(String(message));
          error.code = "NOTEBOOK_ACTIVATION_FAILED";
          throw error;
        }
      } catch (error) {
        // The pack survives restarts, so a failed candidate must not become
        // the next launcher's build input. Keep the last source that built.
        if (previous === undefined) await store.delete("CLAS", name);
        else {
          await store.write("CLAS", name, previous, "main", {root: scratch.path});
          // The old source is still the serving generation. write() marks it
          // inactive, so restore its earlier ADT state for that revision.
          if (previousActive) await store.completeActivation(store.warmActivation("CLAS", name));
        }
        throw error;
      }
      if (!(await store.completeActivation(checked, notebookBuilt))) {
        const error = new Error("source changed during activation; run the notebook cell again");
        error.code = "NOTEBOOK_ACTIVATION_FAILED";
        throw error;
      }
      const runner = await store.classrun();
      const result = await runner.run(name, {data});
      return {
        text: result.ok ? result.text : `${result.text}${result.text ? "\n\n" : ""}Runtime error: ${result.error.message} at ${result.error.where}`,
        ok: result.ok,
        ms: result.ms,
        generation: result.generation,
      };
    });
    notebookCellRun = run.catch(() => undefined);
    try {
      res.status(200).json(await run);
    } catch (error) {
      const status = error?.code === "NOTEBOOK_SCRATCH_MISSING" ? 503
        : error?.code === "NOTEBOOK_ACTIVATION_FAILED" ? 422 : 500;
      res.status(status).json({error: {code: error?.code ?? "FAILED", message: String(error?.message ?? error)}});
    }
  });

  for (const [path, kind] of [["oo/validation/objectname", "OO"], ["packages/validation", "PACKAGE"]]) {
    router.post(`${BASE}/${path}`, (req, res) => {
      res.status(200).type("application/vnd.sap.as+xml; charset=utf-8")
        .send(validationDocument(validateCreation(store, {...req.query, kind})));
    });
  }

  // ---- the development loop: lock, write, unlock, activate.
  //
  // A lock is synthetic, because a local system has nobody to lock against
  // but itself. What makes it more than a formality is affinity: the handle
  // lives on the session, so a client that loses its context loses its lock,
  // which is exactly what a real system does and exactly what a client's
  // sequencing bugs look like.
  const collections = SOURCE_TYPES.map(({type, adt}) => [type, adt]);

  // CREATE is a POST on the collection, DELETE a DELETE on the object.
  // The create body is the object's own document with nothing in it but a
  // name, a description and the package it goes to (vsp!crud.go
  // buildCreateObjectBody; Eclipse's wizards send the same). Programs answer
  // an untyped empty 200, observed on SAP on 2026-10-03. Classes do too
  // (observed 2026-10-08). Other collections retain 201 + Location until observed. The client's next move is
  // the ordinary lock / PUT / activate, which is why a create writes a
  // skeleton and not a source. A package is created the same way under
  // /packages, with its parent in pack:superPackage. Function groups and
  // modules are not created here yet: a group is a folder of includes with
  // a header of its own, and nothing has asked for one.
  const attribute = (body, element, name) => {
    const [prefix,local]=name.split(":"), elements=requestElements(body);
    const scope=element === undefined ? elements[0] : (() => {
      const [p,l]=element.split(":"); return elementsNamed(elements,namespaces[p],l)[0];
    })();
    return attributeValue(scope,namespaces[prefix],local);
  };
  for (const {type, adt} of [...SOURCE_TYPES, {type: "DEVC", adt: "packages"}]) {
    router.post(`${BASE}/${adt}`, async (req, res) => {
      const body = await rawBody(req);
      answer(res, async () => {
        const name = attribute(body, undefined, "adtcore:name");
        if (name === undefined || name === "") {
          res.status(400).type("application/xml").send(exceptionDocument("ExceptionInvalidRequest", "the create body names no object"));
          return;
        }
        const home = type === "DEVC"
          ? attribute(body, "pack:superPackage", "adtcore:name")
          : attribute(body, "adtcore:packageRef", "adtcore:name") ?? attribute(body, "adtcore:packageRef", "adtcore:packageName");
        let made;
        try {
          made = await store.create(type, name, {
            description: attribute(body, undefined, "adtcore:description") ?? "",
            package: home ?? "",
            // an object of $TMP carries who made it (tools/osd-tmp.mjs)
            author: req.adt.session.user,
            activeSkeleton: type === "CLAS",
          });
        } catch (error) {
          if (type === "CLAS" && error instanceof Conflict) {
            refuse(res, 400, "ExceptionResourceAlreadyExists", `Class ${name.toUpperCase()} already exists`);
            return;
          }
          // SAP observation 2026-10-04, program v2/v3 only. Keep the
          // store's conflict and every other collection's answer unchanged.
          if (adt !== "programs/programs" || !(error instanceof Conflict)) throw error;
          const upper = name.toUpperCase();
          refuse(res, 500, "ExceptionResourceCreationFailure",
            `A program or include already exists with the name ${upper}`, {properties: [
              ["T100KEY-ID", "XI"], ["T100KEY-NO", "001"], ["T100KEY-V1", upper],
            ]});
          return;
        }
        if (adt === "programs/programs") {
          if (req.adt.programCreated !== undefined) await req.adt.programCreated();
          else res.status(200).end();
          return;
        }
        if (type === "CLAS") return void res.status(200).end();
        res.status(201)
          .set("Location", `${BASE}/${adt}/${encodeURIComponent(made.name.toLowerCase())}`)
          .end();
      });
    });
    router.delete(`${BASE}/${adt}/:name`, (req, res) => {
      answer(res, async () => {
        const name = decodeURIComponent(req.params.name);
        if (type === "CLAS") {
          const handle = String(req.query.lockHandle ?? "");
          const held = req.adt.session.locks.get(handle);
          if (!held || held.type !== type || held.name !== name.toUpperCase()) {
            return void refuse(res, 423, "ExceptionResourceInvalidLockHandle", "DELETE requires the object's lock handle");
          }
        }
        if (req.adt.sessions.deleteObject !== undefined) {
          const result = await req.adt.sessions.deleteObject(req.adt.session, type, name, store, type === "CLAS" ? String(req.query.lockHandle ?? "") : undefined);
          // the caller's session ended after the front resolved it (its own
          // logoff, queued behind the verdict): it may delete nothing
          if (result.ended === true) {
            refuseToken(res);
            return;
          }
          if (result.invalidHandle) return void refuse(res, 423, "ExceptionResourceInvalidLockHandle", "DELETE lock handle is no longer held");
          if (result.holder !== undefined) {
            res.status(403).type("application/xml").send(lockedByOtherDocument(result.holder.session.user, String(name).toUpperCase()));
            return;
          }
          res.status(200).end();
          return;
        }
        // an object another session holds is not this one's to delete
        const holder = await req.adt.sessions.holderOf(type, store.find(type, name)?.name ?? name);
        if (holder !== undefined && holder.session.id !== req.adt.session.id) {
          res.status(403).type("application/xml").send(lockedByOtherDocument(holder.session.user, String(name).toUpperCase()));
          return;
        }
        let gone;
        if (type === "CLAS") {
          const held = await req.adt.sessions.whileHeld(req.adt.session, String(req.query.lockHandle ?? ""), type, name,
            async () => {gone = await store.delete(type, name);});
          if (!held) return void refuse(res, 423, "ExceptionResourceInvalidLockHandle", "DELETE lock handle is no longer held");
        } else gone = await store.delete(type, name);
        // and a lock on an object that is gone holds nothing
        await req.adt.sessions.release(gone.type, gone.name);
        res.status(200).end();
      });
    });
  }

  // a package locks like a source object (a client locks it before it
  // deletes it), and has no source to write
  for (const {type, adt} of [...SOURCE_TYPES, {type: "DEVC", adt: "packages"}]) {
    // LOCK and UNLOCK arrive on the object's own URI, told apart by _action
    router.post(`${BASE}/${adt}/:name`, (req, res) => answer(res, async () => {
      const action = String(req.query._action ?? "").toUpperCase();
      const {session} = req.adt;
      const entry = store.find(type, req.params.name);
      if (entry === undefined) {
        res.status(404).type("application/xml").send(exceptionDocument("ExceptionResourceNotFound", `${type} ${req.params.name} does not exist`));
        return;
      }

      if (req.query._action === undefined && objectXMLRoots[type]) {
        const invalid = invalidObjectXML(type, await rawBody(req));
        if (invalid) return void refuse(res, 400, "ExceptionInvalidData", invalid.message, invalid);
        return void refuse(res, 501, "ExceptionResourceNoAccess", "object XML updates are not supported here");
      }

      if (action === "LOCK") {
        // Program offers measured 2026-10-04 ignore q and dataname, returning Result.
        // Our policies: case-insensitive media types, wildcards, and empty
        // list elements alone treated like missing Accept. HTTP OWS is SP/HTAB.
        // Negotiate before enqueue: SAP's 406 leaks a lock with no handle.
        const offers = String(req.headers.accept ?? "").split(",").map((offer) => offer.split(";")[0].replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase());
        if (offers.some(Boolean) && !offers.some((type) => ["application/vnd.sap.as+xml", "application/*", "*/*"].includes(type))) {
          return void refuse(res, 406, "ExceptionResourceNotAcceptable",
            "The message content is not acceptable. Accepted content types: application/vnd.sap.as+xml", {properties: [
              ["T100KEY-ID", "SADT_RESOURCE"], ["T100KEY-NO", "044"], ["T100KEY-V1", "application/vnd.sap.as+xml"],
            ]});
        }
        const contentType = "application/vnd.sap.as+xml; charset=utf-8; dataname=com.sap.adt.lock.Result";
        if (entry.writable === false && !entry.overlay) {
          // A library object is not ours to change, and the way to say so is
          // the lock envelope with no handle in it: that is what a real
          // system returns for an object ADT may not modify, and a client
          // reads it as "not modifiable" before it ever attempts a write.
          //
          // The observed Result leaves MODIFICATION_SUPPORT empty; the handle
          // is what tells the client whether it may write.
          res.status(200).type(contentType)
            .send(lockResultDocument(""));
          return;
        }
        // a lock lives with a stateful session: without one it is refused, not given (statelessLock)
        if (session.stateful !== true) return void refuse(res, 400, "ExceptionInvalidRequest", statelessLock(entry));
        // one holder per object; even its own session's second LOCK is refused
        const taken = await req.adt.sessions.lock(session, entry.type, entry.name, newLockHandle);
        if (taken.heldBy !== undefined) {
          res.status(403).type("application/xml").send(lockedByOtherDocument(taken.heldBy.user, entry.name));
          return;
        }
        res.status(200).type(contentType).send(lockResultDocument(taken.handle));
        return;
      }

      if (action === "UNLOCK") {
        await req.adt.sessions.unlock(session, String(req.query.lockHandle ?? ""));
        res.status(200).type("text/plain").send("");
        return;
      }

      res.status(400).type("application/xml").send(exceptionDocument("ExceptionInvalidRequest", `unknown action ${action || "(none)"}`));
    }));
    if (type === "DEVC") {
      continue;
    }

    // Whether this request may change the object: writable, and the handle
    // in lockHandle held by this session for this object. Answers the
    // refusal itself and returns false when not.
    const mayWrite = (req, res) => {
      const {session} = req.adt;
      const handle = String(req.query.lockHandle ?? "");
      const lock = session.locks.get(handle);
      const entry = store.find(type, req.params.name);
      if (entry !== undefined && entry.writable === false && !entry.overlay) {
        res.status(405).type("application/xml").send(exceptionDocument("ExceptionResourceNoAccess", `${entry.type} ${entry.name} is a library object and cannot be changed here`));
        return false;
      }
      if (lock === undefined || lock.type !== (entry?.type ?? type) || lock.name !== (entry?.name ?? String(req.params.name).toUpperCase())) {
        // the handle is the client's proof it owns the object right now, and
        // a handle from another session or another object is neither
        const measuredClass = type === "CLAS" && (req.params.include === undefined || req.params.include === "testclasses");
        res.status(measuredClass ? 423 : 409).type("application/xml").send(exceptionDocument(measuredClass ? "ExceptionResourceInvalidLockHandle" : "ExceptionResourceNotLocked", handle === "" ? "no lock handle was given" : `lock handle ${handle} does not hold this object in this session`));
        return false;
      }
      return true;
    };
    // the handle of mayWrite, asked again where the write happens: still this
    // session's, still the object's holder, and the write in the same step as
    // the question (sessions.whileHeld), so a logoff or an UNLOCK that runs
    // after the front's verdict cannot slip in between the two
    const stillHeld = async (req, res, write) => {
      const {session, sessions} = req.adt;
      const handle = String(req.query.lockHandle ?? "");
      const lock = session.locks.get(handle);
      if (lock === undefined || await sessions.whileHeld(session, handle, lock.type, lock.name, write) === false) {
        // A release race is unmeasured; preserve its previous refusal.
        res.status(409).type("application/xml").send(exceptionDocument("ExceptionResourceNotLocked",
          `lock handle ${handle} was released before the source arrived`));
        return false;
      }
      return true;
    };
    // WRITE. The file only: the transpile belongs to activation, where the
    // verdict is what the client waits for and the modules follow after.
    const writeSource = (req, res) => {
      if (type === "CLAS" && req.params.include === "testclasses" && !req.query.lockHandle) {
        return void refuse(res, 400, "ExceptionParameterNotFound", "Parameter lockHandle could not be found");
      }
      if (mayWrite(req, res) === false) {
        return;
      }
      rawBody(req).then((body) => {
        answer(res, async () => {
          const include = req.params.include ?? "main";
          // ADT requires explicit creation of testclasses. STORE WRITE remains
          // an implicit create for the non-ADT dev API.
          const part = store.read(type, req.params.name, include);
          if (type === "CLAS" && include === "testclasses" && part.empty) {
            const missing = missingTestInclude(part.name);
            return void refuse(res, 500, "ExceptionResourceSaveFailure", missing.message, missing);
          }
          // The handle proves this request belongs to the locking session; it
          // does not exclude Git, a watcher, another session or another
          // process from changing the file. Compare immediately beside the write: an earlier
          // preflight GET leaves a race in which the newer source is lost.
          const expected = req.headers["if-match"];
          const current = part.empty && classIncludeTemplates[include] ? classIncludeTemplates[include] : part.source;
          if (expected !== undefined && normalizedTag(expected) !== "*" &&
              normalizedTag(expected) !== entityTag(current)) {
            res.status(412).type("application/xml").send(exceptionDocument(
              "ExceptionResourceIsModified",
              "source changed since it was opened; reload before saving",
            ));
            return;
          }
          // The body arrives after the lock was checked, and the lock can go
          // while it does (an UNLOCK, a logoff, an expiry, another session
          // taking the object after that). Checked again right beside the
          // write, which is the moment the handle has to be good for.
          if (await stillHeld(req, res, () => store.write(type, req.params.name, body.toString("utf8"), include)) === false) {
            return;
          }
          // store.write invalidates the registry. SAVE only acknowledges
          // the text; the next outline, Check or Activate rebuilds it.
          // The tag of what was just written, computed from what a read now
          // returns so that it is the tag the next GET will carry. The
          // client files it beside the source it saved; a save answered
          // without one left "Properties file content do not contain an
          // entity tag for the source file" in the log and an editor that
          // showed nothing at all after the save had in fact succeeded.
          const stored = store.read(type, req.params.name, include).source;
          res.set("ETag", entityTag(stored));
          // A4H acknowledges SAVE with no representation or Content-Type.
          // An empty text/plain representation can replace the editor text.
          res.status(200).end();
        });
      });
    };
    router.put(`${BASE}/${adt}/:name/source/main`, writeSource);
    if (type === "CLAS") {
      router.put(`${BASE}/${adt}/:name/includes/:include`, writeSource);
      router.put(`${BASE}/${adt}/:name/includes/:include/source/main`, writeSource);
      // CREATE of a class include (a client's "new test class" makes the
      // testclasses one this way): a POST on the class's includes with the
      // include named in the body, under the class's lock like a PUT,
      //   <class:abapClassInclude adtcore:name="..." class:includeType="testclasses"/>
      // and the answer 201 with the include's URI. The include starts
      // empty; its source is the client's next PUT.
      router.post(`${BASE}/${adt}/:name/includes`, async (req, res) => {
        const body = await rawBody(req);
        // Measured locked-class include CREATE without a handle: 403 NoAccess.
        if (!req.query.lockHandle && await req.adt.sessions.holderOf("CLAS", String(req.params.name).toUpperCase())) {
          return void refuse(res, 403, "ExceptionResourceNoAccess", "The class is currently being edited");
        }
        if (!req.query.lockHandle) {
          return void refuse(res, 409, "ExceptionResourceNotLocked", "no lock handle was given");
        }
        if (mayWrite(req, res) === false) {
          return;
        }
        answer(res, async () => {
          const include = attribute(body, undefined, "class:includeType") ?? "";
          if (include === "" || include === "main" || Object.hasOwn(CLASS_INCLUDES, include) === false) {
            res.status(400).type("application/xml").send(exceptionDocument("ExceptionInvalidRequest",
              include === "" ? "the create body names no include type" : `${include} is not a class include`));
            return;
          }
          const current = store.read(type, req.params.name, include);
          if (current.empty !== true) {
            throw new Conflict(type, `${current.name} include ${include}`);
          }
          if (await stillHeld(req, res, () => store.write(type, req.params.name, "", include)) === false) {
            return;
          }
          warmOutline();
          res.status(201)
            .set("Location", `${BASE}/${adt}/${encodeURIComponent(current.name.toLowerCase())}/includes/${include}`)
            .end();
        });
      });
    }
  }

  // Include creation and activation prime the outline registry on the host;
  // source SAVE leaves it invalidated until requested. Compiler warm() is separate.
  function warmOutline() {
    try { store.registry?.(); }
    catch (error) { console.error(`outline: pre-warm failed: ${error.message}`); }
  }

  // SYNTAX CHECK. The source arrives inline, because a client checks what a
  // person has typed rather than what is on disk. The store checks the given
  // text against the parsed system without touching the file, so this is a
  // real check and not a formality: broken source comes back broken even
  // though nothing was written.
  advertise("checkruns");
  // ---- what a client asks before it writes: which transport would carry
  // this. Nothing would, and nothing needs to; the document says why.
  advertise("cts/transportchecks");
  router.post(`${BASE}/cts/transportchecks`, async (req, res) => {
    // express does not catch a rejection from an async handler, and an
    // uncaught one takes the listener down with it — which is how this route
    // killed the whole server the first time it ran. The façade holds a
    // developer's session; it does not get to die over one bad request.
    try {
      const asked = transportCheckRequest(await rawBody(req));
      const named = asked.uri === undefined ? undefined : objectFromUri(asked.uri, collections);
      let found;
      try {
        // an object the store does not know is still a question we can
        // answer: a write that creates one needs a transport no more than a
        // write that changes one does
        found = named === undefined ? undefined : store.find(named.type, named.name);
      } catch {
        found = undefined;
      }
      res.status(200).type("application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData")
        .send(transportCheckDocument({
          type: named?.type,
          name: named?.name,
          uri: asked.uri,
          operation: asked.operation,
          package: found?.package ?? asked.devclass ?? "$TMP",
        }));
    } catch (e) {
      if (res.headersSent === false) {
        res.status(500).type("application/xml").send(exceptionDocument("ExceptionTransportCheckFailed", String(e?.message ?? e)));
      }
    }
  });

  // Which checks this system offers, asked for before any check is run. A
  // client that cannot read this concludes checking is unavailable, and says
  // so about activation too, because the two travel together.
  //
  // One reporter, named as the real one names it, over the types this façade
  // actually holds — the list is what a client offers in its own UI, so
  // naming a type that is not here would advertise a check that finds nothing.
  advertise("checkruns/reporters");
  router.get(`${BASE}/checkruns/reporters`, (req, res) => {
    const supported = Object.keys(TYPES).map((code) =>
      `<chkrun:supportedType>${code}*</chkrun:supportedType>`).join("");
    res.type("application/vnd.sap.adt.reporters+xml; charset=utf-8").send(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<chkrun:checkReporters xmlns:chkrun="http://www.sap.com/adt/checkrun">' +
      `<chkrun:reporter chkrun:name="abapCheckRun">${supported}</chkrun:reporter>` +
      "</chkrun:checkReporters>",
    );
  });

  // What has been saved and not activated: the store's inactive set
  // (ObjectStore#inactiveObjects), the objects the build keeps out until
  // they are activated. A client that activates "everything inactive" (vsp's
  // ActivatePackage, Eclipse's Activate dialog) builds its list from this,
  // and an empty one made that impossible (vsp-i7, 2026-10-02). It is the
  // resource's absence, not an empty list, that a client reports as
  // "activation is not supported".
  // the logon user of a request, as its Basic credentials name it; the
  // inactive set is the system's, so every user sees all of it
  const sessionUser = (req) => {
    const basic = /^Basic\s+(\S+)/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const user = basic === undefined ? "" : Buffer.from(basic, "base64").toString("utf8").split(":")[0];
    return (user || "DEVELOPER").toUpperCase();
  };
  advertise("activation/inactiveobjects");
  router.get(`${BASE}/activation/inactiveobjects`, (req, res) => {
    res.type("application/vnd.sap.adt.inactivectsobjects.v1+xml; charset=utf-8").send(
      inactiveObjectsDocument(store.inactiveObjects(), sessionUser(req)));
  });

  router.post(`${BASE}/checkruns`, async (req, res) => {
    const body = await rawBody(req);
    answer(res, async () => {
      // Every object this façade serves may be checked, not only the ones
      // with source. The data element editor checks its object the moment
      // it opens, and a URI it did not recognise here was a 400 — "Checking
      // object... has encountered a problem" as the first thing a person saw
      // after the editor finally opened. A dictionary object has no syntax
      // to check; what is reported for one is that it is here and readable,
      // and the status text says so rather than implying a check it did not
      // get.
      const objects = checkObjectsIn(body, Object.entries(TYPES).map(([type, meta]) => [type, meta.adt]));

      // A package is a legitimate thing to check, and this used to call it an
      // invalid request. Eclipse checks the package as soon as its editor
      // opens, so the first thing a person does after opening one produced
      // "Checking object... encountered a problem".
      //
      // A real system checks everything beneath it. This checks what is in
      // the package itself, not its subpackages: the tree here can be several
      // thousand objects deep and a check that takes a minute is reported as
      // a hang rather than as thoroughness.
      const packages = requestElements(body).map(e => attributeValue(e,namespaces.adtcore,"uri"))
        .filter(uri => uri?.startsWith(`${BASE}/packages/`)).map(uri => decodeURIComponent(uri.slice(`${BASE}/packages/`.length)));
      const packageReports = [];
      for (const name of packages) {
        const uri = `${BASE}/packages/${encodeURIComponent(name.toLowerCase())}`;
        try {
          const pkg = store.package(name.toUpperCase());
          // CheckHandler looks up the result by the URI it submitted. Reports
          // for children do not stand in for the package itself; without this
          // row an empty/top-level package produces checkResult=null in the
          // Eclipse automatic syntax-check trigger.
          packageReports.push({uri, issues: []});
          for (const object of pkg.objects) {
            const adt = TYPES[object.type]?.adt;
            if (adt !== undefined) {
              objects.push({
                type: object.type,
                name: object.name,
                uri: `${BASE}/${adt}/${encodeURIComponent(object.name.toLowerCase())}`,
              });
            }
          }
        } catch {
          packageReports.push({uri, issues: [], status: "notProcessed", statusText: `package ${name} does not exist`});
        }
      }

      if (objects.length === 0 && packageReports.length === 0) {
        // Nothing to check is not the same as a request that made no sense.
        // An empty report is the honest answer for an empty package, and the
        // 400 stays for a body that named no object at all.
        res.status(400).type("application/xml").send(exceptionDocument("ExceptionInvalidRequest", "no check object in the request"));
        return;
      }
      const reports = [...packageReports];
      for (const o of objects) reports.push({uri: o.uri, ...await checkRunReport(store, o)});
      res.status(200).type("application/vnd.sap.adt.checkmessages+xml").send(checkReportDocument(reports));
    });
  });

  // What an activation's build was, for a client that shows it (the VS Code
  // extension, editors/vscode): warm or cold and why, how long the swap took,
  // how many objects the change reached and which of them carry tests -- the
  // tests an edit should run next. Headers, because ADT's activation document
  // has no place for them and Eclipse ignores headers it does not know.
  const warmHeaders = (res, result) => {
    const t = result?.transpile ?? {};
    if (result?.committed && result.generation) res.set("X-OSD-Generation", result.generation + (result.verified ? "" : " warm-unverified"));
    const w = store.warm?.();
    // a header value is one line of printable ASCII, whatever a reason says
    // and no host path, whatever a reason quotes (a refused swap names a module file)
    const header = (v) => withoutHostPaths(String(v), store.root).replace(/[^\x20-\x7e]+/g, " ").slice(0, 300);
    // "warm" is the build AND the load: a warm build the runtime was
    // recycled for (a refused swap, a host-held module) is a cold activation
    // and says why -- ObjectStore#publish sets result.why exactly then
    // a publish that did not load anything -- the build refused, a runtime
    // still changing hands, a recycle that failed -- is neither warm nor
    // cold: "failed; <why>". The extensions read this header only on an
    // activation that succeeded (editors/vscode/extension.js), and this one
    // answers with a failure document, so they show its issue instead
    if (result?.ok === false) {
      res.set("X-OSD-Build", header(`failed; ${result.error ?? t.error ?? "the build after activation failed"}`));
      return;
    }
    res.set("X-OSD-Build", header(t.warm === true && result?.recycled !== true && result?.why === undefined ? "warm"
      : t.warm === true ? `cold; recycled after a warm build: ${result?.why ?? "the runtime was recycled"}`
        : `cold${w?.on === true && w.reason ? `; ${w.reason}` : ""}`));
    // the swap that made the source live: this activation's own, or the one
    // that had already brought the same generation in (the dev loop's, for a
    // save it saw first) -- ObjectStore#publish answers only once it landed
    const swapMs = result?.hot === true ? result.ms : result?.swapMs;
    if (swapMs !== undefined) res.set("X-OSD-Swap-Ms", String(swapMs));
    if (Array.isArray(t.closure)) {
      const tests = new Set(testClassesIn(store.root).map((n) => n.replace(/\s+\(.*$/, "")));
      res.set("X-OSD-Closure", String(t.closure.length));
      res.set("X-OSD-Closure-Tests", t.closure.filter((o) => o.type === "CLAS" && tests.has(o.name)).map((o) => o.name).join(",").slice(0, 4000));
    }
  };

  // ACTIVATE is host orchestration (HOST_ALLOWED A6/A7, variant C).
  // Missing method is a parameter error; present values other than activate return an empty 200.
  advertise("activation");
  router.post(`${BASE}/activation`, async (req, res) => {
    if (req.query.method === undefined) {
      // Exact A4H bytes; exceptionDocument adds whitespace to its documents.
      res.status(400).type("application/xml").send('<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><namespace id="com.sap.adt"/><type id="ExceptionParameterNotFound"/><message lang="EN">Parameter method could not be found.</message><localizedMessage lang="EN">Parameter method could not be found.</localizedMessage><properties><entry key="T100KEY-ID">SADT_RESOURCE</entry><entry key="T100KEY-NO">017</entry><entry key="T100KEY-V1">method</entry></properties></exc:exception>');
      return;
    }
    if (req.query.method !== "activate") {
      res.status(200).end();
      return;
    }
    // Observed 2026-10-04: forced is not parsed as a boolean. "false", empty
    // and absent keep the check; "0", "true" and junk (SYN_INVALID) skip it.
    const forced = [req.query.forced].flat().some((value) => typeof value === "string" && value !== "" && value !== "false");
    const checklist = {checkExecuted: !forced};
    const successDocument = () => activationSuccessDocument(checklist);
    const failureDocument = (entries) => activationFailureDocument(entries, checklist);
    const body = await rawBody(req);
    let named = [];
    let checked = [];
    let published = false;
    let attempt;
    answer(res, () => {
      named = objectReferencesIn(body, collections);
      if (named.length === 0) {
        res.status(400).type("application/xml").send(exceptionDocument("ExceptionInvalidRequest", "no object references in the request"));
        return;
      }
      attempt = beginActivation(store, named);
      try {
        // Workbench sends the entity tag of the exact source that passed its
        // check. Refuse activation if Git or another editor replaced it in the
        // meantime; otherwise a green Check could activate different bytes.
        const expected = req.headers["if-match"];
        if (expected !== undefined) {
          if (named.length !== 1) {
            attempt.fail("validation", {note: "If-Match activation requires exactly one object reference"});
            res.status(400).type("application/xml").send(exceptionDocument(
              "ExceptionInvalidRequest", "If-Match activation requires exactly one object reference"));
            return;
          }
          const current = store.read(named[0].type, named[0].name).source;
          if (normalizedTag(expected) !== "*" && normalizedTag(expected) !== entityTag(current)) {
            attempt.fail("validation", {note: "source changed after it was checked; check and activate again"});
            res.status(412).type("application/xml").send(exceptionDocument(
              "ExceptionResourceIsModified",
              "source changed after it was checked; check and activate again",
            ));
            return;
          }
        }
        checked = prepareActivation(store, named, {transpile: options.transpileOnActivate !== false, forced});
        const failed = checked.filter((r) => r.active === false);
        if (failed.length > 0) {
          // Include diagnostics for the named objects and any dependents
          // whose active source would break.
          const entries = failed.flatMap((r) => [r, ...(r.dependents ?? [])]);
          attempt.fail("validation", {issues: activationIssues(failed)});
          res.status(200).type("application/xml").send(failureDocument(entries));
          return;
        }
        published = true;
      } catch (error) {
        attempt.fail("validation", {note: withoutHostPaths(String(error.message ?? error), store.root)});
        throw error;
      }
    });
    if (published === false || options.transpileOnActivate === false) {
      if (published === true) {
        let completed;
        try { completed = await store.completeActivations(checked); }
        catch (error) {
          attempt.fail("revision", {note: withoutHostPaths(String(error.message ?? error), store.root)});
          throw error;
        }
        if (!completed) {
          attempt.fail("revision", {note: "source changed during activation; check and activate again"});
          res.status(200).type("application/xml").send(failureDocument(
            named.map((o) => ({...o, issues: [{message: "source changed during activation; check and activate again", severity: "E", line: 1, column: 1}]})),
          ));
          return;
        }
        // A successful activation reports whether the separate check ran;
        // activation and generation remain executed, including when forced.
        // No build is promised by this fixture/source-only mode.
        attempt.update({state: "published", active: true, live: false, generation_id: liveHash(store.root) ?? ""});
        warmOutline();
        res.status(200).type("application/xml").send(successDocument());
      }
      return;
    }
    // The activation is finished here rather than promised. It used to
    // answer and then transpile behind the client's back, so a 200 meant
    // "the source is good" while the code a client would next read was still
    // the old code, and nothing said when that stopped being true. Awaiting
    // publish() makes the success properties mean what a real system means by them:
    // the modules are written, and the process that serves them is the one
    // that has them.
    attempt.update({state: "pending", active: true, note: "publication pending"});
    try {
      // the named objects are built with their saved version; every other
      // inactive object is built with its last active one, or left out
      // (ObjectStore#overlay), so one broken save fails its own activation
      // and nobody else's
      const result = await publishActivation(store, checked);
      attempt.finish(result, activationIssues(result.transpile?.issues ?? []));
      warmHeaders(res, result);
      if (result?.ok === false && result.transpile?.check === true && (result.transpile.issues ?? []).length > 0) {
        // the build refused, warm or cold: each object's own issues at their
        // own lines, the activated ones first and listed even when their
        // issues are all in the objects that read them. A name is matched
        // whatever type the build filed it under (an include is a PROG to it)
        const same = (a, b) => String(a.name).toUpperCase() === String(b.name).toUpperCase();
        const entries = [
          ...named.map((o) => ({type: o.type, name: o.name,
            issues: result.transpile.issues.filter((i) => same(i, o)).flatMap((i) => i.issues ?? [])})),
          ...result.transpile.issues.filter((o) => !named.some((n) => same(n, o))),
        ];
        res.status(200).type("application/xml").send(failureDocument(entries));
        return;
      }
      if (result?.ok === false) {
        // one line, without the build log: that is the host's console's
        const why = withoutHostPaths(result.error ?? result.transpile?.error ?? "the build after activation failed", store.root);
        res.status(200).type("application/xml").send(failureDocument(
          named.map((o) => ({type: o.type, name: o.name, issues: [{message: String(why).split("\n")[0].slice(0, 500), severity: "E", line: 1, column: 1}]})),
        ));
        return;
      }
      // promoted only if what was built is what was checked (and still saved)
      if (!result.committed) {
        res.status(200).type("application/xml").send(failureDocument(
          named.map((o) => ({...o, issues: [{message: "source changed during activation; check and activate again", severity: "E", line: 1, column: 1}]})),
        ));
        return;
      }
      // Forced activation skips only the separate check. Compilation and
      // generation have succeeded before these properties are returned.
      if (result?.transpile?.warm !== true) warmOutline();
      res.status(200).type("application/xml").send(successDocument());
    } catch (e) {
      attempt.fail("build", {note: withoutHostPaths(String(e?.message ?? e), store.root)});
      res.status(200).type("application/xml").send(failureDocument(
        named.map((o) => ({type: o.type, name: o.name, issues: [{message: withoutHostPaths(String(e?.message ?? e), store.root).split("\n")[0].slice(0, 500), severity: "E", line: 1, column: 1}]})),
      ));
    }
  });

  // ABAP UNIT. The runtime actually runs the tests, in a child process of its
  // own: a test writes to the database, and the database is the one this
  // server is answering requests from, so a client's test data must not land
  // in the gateway's rows. About a second for one class.
  advertise("abapunit/testruns");
  // The name of a run result follows what the client asks by. Eclipse's
  // ABAP Unit view asks for abapunit.testruns.result.v2 (a4h-adt.jsonl:495)
  // and has handlers for v1 and v2 and nothing else; vsp asks by the junit
  // name. The document is the classic aunit:runResult in every case.
  const unitResultType = (req, kind) => {
    const accept = String(req.headers.accept ?? "");
    if (/junit\.run-result/.test(accept)) {
      return "application/vnd.sap.adt.api.junit.run-result.v1+xml";
    }
    // v2 unless a version is asked for: the view's handler for its result
    // type is registered for v2, and a v1-named answer to a client that
    // sent Accept: application/xml was "No content-handler found for
    // content-type ...testruns.result.v1+xml and data-type IAbapUnitResult"
    const version = /testruns\.(?:evaluation\.)?result\.v(\d)/.exec(accept)?.[1] ?? "2";
    return `application/vnd.sap.adt.abapunit.testruns.${kind}.v${version}+xml`;
  };

  // abap-adt-api follows every unit-test class and method with this request
  // before it can publish the result into VS Code's Testing tree. Returning
  // an empty, well-formed marker collection tells the client to keep the
  // result's navigation selector; a missing endpoint aborts the successful
  // run and leaves the UI at 0/0.
  router.post(`${BASE}/abapsource/occurencemarkers`, async (req, res) => {
    await rawBody(req);
    if (typeof req.query.uri !== "string" || req.query.uri === "") {
      res.status(400).type("application/xml")
        .send(exceptionDocument("ExceptionInvalidRequest", "uri is required"));
      return;
    }
    res.status(200).type("application/xml; charset=utf-8").send(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<occurrenceInfo xmlns="http://www.sap.com/adt/abapsource"><occurrences/></occurrenceInfo>',
    );
  });

  const unitReferences = body => elementsNamed(requestElements(body),namespaces.adtcore,"objectReference")
    .map(e => attributeValue(e,namespaces.adtcore,"uri")).filter(uri => uri !== undefined);
  const unitObjects = references => references.map(uri => objectFromUri(uri,collections)).filter(Boolean);

  // The evaluation of a run: the same result for the objects named, which
  // the client asks for after the run to show the report and to navigate
  // from a result to its method (a4h-adt.jsonl:497). Its references carry
  // the test class and method as a fragment; the run is that of the object.
  router.post(`${BASE}/abapunit/testruns/evaluation`, async (req, res) => {
    const body = await rawBody(req);
    const named = unitObjects(unitReferences(body));
    if (named.length === 0) {
      res.status(400).type("application/xml").send(exceptionDocument("ExceptionInvalidRequest", "no object references in the request"));
      return;
    }
    try {
      const runner = await store.unit();
      const run = await runner.runDetached(named[0].type, named[0].name);
      res.status(200).type(unitResultType(req, "evaluation.result"))
        .send(unitResultDocument(run, unitResultOptions(body, named[0])));
    } catch (e) {
      res.status(e?.code === "NOT_FOUND" ? 404 : 500).type("application/xml")
        .send(exceptionDocument("ExceptionTestRunFailed", String(e?.message ?? e)));
    }
  });

  router.post(`${BASE}/abapunit/testruns`, async (req, res) => {
    const body = await rawBody(req);
    const references = unitReferences(body);
    const named = unitObjects(references);
    if (named.length !== 1 || references.length !== 1) {
      res.status(400).type("application/xml").send(exceptionDocument("ExceptionInvalidRequest",
        references.length > 1 ? "exactly one object reference is supported" : "one object reference is required"));
      return;
    }
    try {
      const fragmentText = references[0].includes("#")
        ? references[0].slice(references[0].indexOf("#")) : "";
      const fragment = /^#testclass=([^;"#]+)(?:;testmethod=([^;"#]+))?$/i.exec(fragmentText);
      if (fragmentText !== "" && fragment === null) {
        const error = new Error("invalid ABAP Unit testclass/testmethod selector");
        error.code = "INVALID_REQUEST";
        throw error;
      }
      const selected = fragment === null ? {} : {
        testClass: decodeURIComponent(fragment[1]).toUpperCase(),
        method: fragment[2] === undefined ? undefined : decodeURIComponent(fragment[2]).toUpperCase(),
      };
      const runner = await store.unit();
      const plan = runner.classes(named[0].type, named[0].name);
      const run = await runner.runDetached(named[0].type, named[0].name,
        selectedUnitPlan(plan, selected.testClass, selected.method));
      // The document is the classic aunit:runResult either way; only its
      // name differs by client. Eclipse's ABAP Unit view has a handler for
      // abapunit.testruns.result (v1 and v2 in com.sap.adt.abapunit, no
      // other) and reported "No content-handler found for content-type
      // ...api.junit.run-result.v1+xml" for the name vsp asks by. A client
      // that asks for the junit name still gets it.
      res.status(200).type(unitResultType(req, "result"))
        .send(unitResultDocument(run, unitResultOptions(body, named[0])));
    } catch (e) {
      const invalid = e instanceof URIError || e?.code === "INVALID_REQUEST";
      const missing = e?.code === "NOT_FOUND";
      res.status(invalid ? 400 : missing ? 404 : 500).type("application/xml")
        .send(exceptionDocument(invalid ? "ExceptionInvalidRequest" :
          missing ? "ExceptionResourceNotFound" : "ExceptionTestRunFailed",
        String(e?.message ?? e)));
    }
  });

  // ---- packages: what a package is, and what is inside it. A package here
  // is a folder, which is what abapGit already means when it writes one; when
  // a real repository arrives with its DEVC objects, the same two resources
  // answer from those instead.
  advertise("packages");
  advertise("packages/validation");
  advertise("packages/settings");
  advertise("oo/validation/objectname");
  // The dropdowns of the package editor. Empty, because this façade has no
  // application components, software components or transport layers, and an
  // empty list is the true answer rather than a missing resource.
  router.get(`${BASE}/packages/valuehelps/:what`, (req, res) => {
    res.type("application/vnd.sap.adt.nameditems.v1+xml; charset=utf-8")
      .send(namedItemsDocument(req.params.what === "abaplanguageversions"
        ? [{name: "standard", description: "Standard ABAP"}]
        : []));
  });

  router.get(`${BASE}/packages/:name`, (req, res) => {
    answer(res, () => {
      // Answered at the version asked for. The document is the same either
      // way; what differs is whether the client recognises it.
      const wants2 = String(req.headers.accept ?? "").includes("packages.v2+xml");
      const describe = (name) => store.packages().find((p) => p.name === name)?.description ?? "";
      res.type(`application/vnd.sap.adt.packages.v${wants2 ? 2 : 1}+xml`)
        .send(packageDocument(packageOf(store, req.params.name, {user: req.adt.session.user}), {describe}));
    });
  });

  // the tree, one level at a time, which is how a client walks it
  // A data element, for the client's form editor. Read-only: the editor
  // opens on this document and the flags it needs to save are not offered.
  advertise("ddic/dataelements");
  router.get(`${BASE}/ddic/dataelements/:name`, (req, res) => {
    answer(res, () => {
      const entry = store.read("DTEL", req.params.name);
      res.type("application/vnd.sap.adt.dataelements.v2+xml; charset=utf-8").send(dataElementDocument(entry));
    });
  });

  advertise("repository/nodestructure");
  router.post(`${BASE}/repository/nodepath`, (req, res) => answer(res, async () => {
    await rawBody(req);
    const uri = typeof req.query.uri === "string" ? req.query.uri : "";
    let parsed;
    try {
      parsed = objectFromUri(uri.replace(/\/includes\/.*$/, ""), collections);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      refuse(res, 400, "ExceptionInvalidRequest", "an object uri is required");
      return;
    }
    if (parsed === undefined || parsed.type === "DEVC") {
      res.status(400).type("application/xml")
        .send(exceptionDocument("ExceptionInvalidRequest", "an object uri is required"));
      return;
    }
    const entry = store.find(parsed.type, parsed.name);
    if (entry === undefined) {
      res.status(404).type("application/xml")
        .send(exceptionDocument("ExceptionResourceNotFound", `${parsed.type} ${parsed.name} does not exist`));
      return;
    }
    const packages = (entry.packages ?? []).map((name) => ({
      name,
      type: ADT_TYPE.DEVC,
      uri: `${BASE}/packages/${encodeURIComponent(name.toLowerCase())}`,
    }));
    const objectUri = uri.split(/[?#]/)[0].replace(/\/includes\/.*$/, "").replace(/\/source\/main$/, "");
    res.status(200).type("application/xml; charset=utf-8").send(nodePathDocument([
      ...packages,
      {name: entry.name, type: ADT_TYPE[entry.type] ?? entry.type, uri: objectUri},
    ]));
  }));
  router.post(`${BASE}/repository/nodestructure`, async (req, res) => {
    const body = await rawBody(req);
    answer(res, () => {
      const name = req.query.parent_name ?? req.query.parentName ?? req.query.package ?? "";
      const parentType = req.query.parent_type ?? req.query.parentType;
      const nodeKeys = elementsNamed(requestElements(body),"","TV_NODEKEY").map(e => e.text)
        .filter(key => key !== "" && key !== "000000");
      // Answered in the type the client asked for, which is not the one this
      // resource is named after.
      //
      // A client sends Accept: application/vnd.sap.as+xml; dataname=com.sap.
      // adt.RepositoryObjectTreeContent, and this used to answer
      // …nodestructure.v1+xml. The body was right all along — the asx:abap
      // with TREE_CONTENT that the client wanted — and only the label was
      // wrong, so the client reported "No content-handler found" for a
      // document it would have understood. The dataname is the client's own
      // name for the shape it expects; echoing it is the whole fix.
      res.type(asXmlTypeFor(req, "com.sap.adt.RepositoryObjectTreeContent"))
        // Who is asking decides whether a class is a folder: the Project
        // Explorer names the exact shape it wants and gets leaves, because
        // its outline is parked; a client that accepts anything builds its
        // own tree from this and needs the flag to name a class's files.
        .send(nodeStructureDocument(nodesOf(store, name, parentType, {
          // whose objects of $TMP: the logged-on user's, as on A4H, unless the
          // client names a user (user_name; its exact semantics UNMEASURED)
          user: String(req.query.user_name ?? "") || req.adt.session.user,
          classFolders: /dataname=com\.sap\.adt\.RepositoryObjectTreeContent/i.test(String(req.headers.accept ?? "")) === false,
        }), {
          flat: name === "" && parentType === "DEVC",
          nodeKeys,
        }));
    });
  });

  // ---- searching the repository: a flat list of references into the tree
  advertise("repository/informationsystem/search");
  router.get(`${BASE}/repository/informationsystem/search`, (req, res) => {
    answer(res, () => {
      const found = searchObjects(store, req.query.query ?? req.query.search ?? "", {
        max: Number(req.query.maxResults ?? 100),
        // a client narrows by ADT type code (DEVC/K) or by the bare type
        type: typeOf(req.query.objectType ?? req.query.type),
      });
      res.type("application/xml").send(objectReferencesDocument(found));
    });
  });

  // ---- reading table contents: freestyle SQL in the body, rows back. This
  // is how the client's whole graph layer works, not only its table preview.
  // ---- a table as an object, and its content on F8.
  //
  // The client's table editor is source-shaped: it reads the object
  // (a4h-adt.jsonl:403) and then a DDL source (:405). Its parser
  // information — a 30 KB grammar the system ships for the editor's
  // highlighting — is the system's and not served here; what the editor does
  // without it is the next thing to observe.
  advertise("ddic/tables");
  router.get(`${BASE}/ddic/tables/parser/info`, (req, res) => {
    record(req, "resource");
    refuse(res, 404, "ExceptionResourceNotFound", "the DDL parser information is the system's own and is not served here");
  });
  router.get(`${BASE}/ddic/tables/:name`, (req, res) => {
    answer(res, () => {
      const entry = store.read("TABL", req.params.name);
      const table = tableFieldsOf(store, entry);
      res.type("application/vnd.sap.adt.tables.v2+xml; charset=utf-8");
      sendEntity(req, res, tableDocument(entry, {description: table.description}));
    });
  });
  router.get(`${BASE}/ddic/tables/:name/source/main`, (req, res) => {
    answer(res, () => {
      const entry = store.read("TABL", req.params.name);
      res.type("text/plain; charset=utf-8");
      sendEntity(req, res, tableSourceDocument(tableFieldsOf(store, entry)));
    });
  });
  // F8: the columns first (a4h-adt.jsonl:642), then the rows for a SELECT
  // the client writes over the table (:643) — or over the whole table when
  // it sends none.
  advertise("datapreview/ddic");
  router.get(`${BASE}/datapreview/ddic/:name/metadata`, (req, res) => {
    answer(res, () => {
      const entry = store.read("TABL", req.params.name);
      const table = tableFieldsOf(store, entry);
      res.type("application/vnd.sap.adt.datapreview.table.v1+xml; charset=utf-8")
        .send(tableDataDocument({rows: [], columns: table.fields.map((f) => f.name)},
          {fields: table.fields, name: entry.name, maxRowsLink: true}));
    });
  });
  router.post(`${BASE}/datapreview/ddic`, async (req, res) => {
    const name = String(req.query.ddicEntityName ?? "").toUpperCase();
    const asked = (await rawBody(req)).toString("utf8").trim();
    let table;
    try {
      table = tableFieldsOf(store, store.read("TABL", name));
    } catch (e) {
      // The raw-data page deliberately uses the DDIC colcount relation for
      // both table and CDS previews. Its body still names the CDS entity, so
      // resolve that entity here instead of making the shared endpoint
      // table-only after advertising the shared operation.
      table = cdsEntityOf(store, name);
      if (table === undefined) {
        refuse(res, 404, "ExceptionResourceNotFound", `TABL or DDLS ${name} does not exist`);
        return;
      }
    }
    const query = asked === "" ? `SELECT * FROM ${name}` : asked;
    const started = Date.now();
    try {
      const result = await data.query(query, {max: Number(req.query.rowNumber ?? 100)});
      res.status(200).type("application/vnd.sap.adt.datapreview.table.v1+xml; charset=utf-8")
        .send(tableDataDocument(result, {ms: Date.now() - started, fields: table.fields, name}));
    } catch (e) {
      // a refusal with an empty message told nobody anything: the database
      // client's error carries its text in a field of its own, or nowhere
      refuse(res, e?.code === "NOT_BUILT" ? 503 : 400,
        e?.code === "NOT_BUILT" ? "ExceptionResourceNoAccess" : "ExceptionResourceWrongData",
        String(e?.message || e?.cause?.message || e?.code || `the statement was refused: ${query}`));
    }
  });

  // F8 on a CDS view. The rows come from the view the transpiler generated
  // under the entity's own name, so a client that writes "FROM ZC_STG_TRAVEL"
  // is answered by the database, not by a translation of it.
  advertise("datapreview/cds");
  router.get(`${BASE}/datapreview/cds/:name/metadata`, (req, res) => {
    answer(res, () => {
      const entity = cdsEntityOf(store, req.params.name);
      if (entity === undefined) {
        refuse(res, 404, "ExceptionResourceNotFound", `DDLS ${String(req.params.name).toUpperCase()} does not exist`);
        return;
      }
      res.type("application/vnd.sap.adt.datapreview.table.v1+xml; charset=utf-8")
        .send(tableDataDocument({rows: [], columns: entity.fields.map((f) => f.name)},
          {fields: entity.fields, name: entity.name, cdsEntityName: entity.name, maxRowsLink: true}));
    });
  });
  router.post(`${BASE}/datapreview/cds`, async (req, res) => {
    const name = String(req.query.ddlSourceName ?? "").toUpperCase();
    const entity = cdsEntityOf(store, name);
    if (entity === undefined) {
      refuse(res, 404, "ExceptionResourceNotFound", `DDLS ${name} does not exist`);
      return;
    }
    const asked = (await rawBody(req)).toString("utf8").trim();
    const query = asked === "" ? `SELECT * FROM ${entity.name}` : asked;
    const started = Date.now();
    try {
      const result = await data.query(query, {max: Number(req.query.rowNumber ?? 100)});
      res.status(200).type("application/vnd.sap.adt.datapreview.table.v1+xml; charset=utf-8")
        .send(tableDataDocument(result, {ms: Date.now() - started, fields: entity.fields, name: entity.name,
          cdsEntityName: entity.name, cdsCamelCaseName: entity.name}));
    } catch (e) {
      refuse(res, e?.code === "NOT_BUILT" ? 503 : 400,
        e?.code === "NOT_BUILT" ? "ExceptionResourceNoAccess" : "ExceptionResourceWrongData",
        String(e?.message || e?.cause?.message || e?.code || `the statement was refused: ${query}`));
    }
  });

  advertise("datapreview/freestyle");
  router.post(`${BASE}/datapreview/freestyle`, async (req, res) => {
    const query = (await rawBody(req)).toString("utf8");
    if (req.query.action === "checkSyntax") {
      const uri = String(req.query.uniqueURI ?? `${BASE}/datapreview/freestyle/sqlconsole0`);
      try {
        // Prepare through the live backend, but never execute or fetch. It
        // follows the active DB dialect without maintaining a second SQL
        // grammar in the façade or materialising a Check button's SELECT.
        await data.check(query);
        res.status(200).type("application/vnd.sap.adt.checkmessages+xml; charset=utf-8")
          .send(checkReportDocument([{uri, issues: [], statusText: "processed"}], {omitEmptyList: true}));
      } catch (e) {
        const message = String(e?.message || e?.cause?.message || e?.code || "SQL syntax check failed");
        const infrastructure = ["NOT_BUILT", "NOT_SERVING", "CHECK_UNAVAILABLE"].includes(e?.code);
        res.status(200).type("application/vnd.sap.adt.checkmessages+xml; charset=utf-8")
          .send(checkReportDocument([infrastructure
            ? {uri, issues: [], status: "notProcessed", statusText: message}
            : {uri, issues: [{line: 1, column: 1, severity: "E", message}]}], {omitEmptyList: true}));
      }
      return;
    }
    const started = Date.now();
    try {
      const result = await data.query(query, {max: Number(req.query.rowNumber ?? 100)});
      res.status(200).type("application/xml").send(tableDataDocument(result, {ms: Date.now() - started}));
    } catch (e) {
      // NOT_ALLOWED is a statement that is not a SELECT, NOT_BUILT is a
      // system that has never been transpiled; both are the client's answer
      // to give, and neither is a 403 (see below)
      refuse(res, e?.code === "NOT_BUILT" ? 503 : 400,
        e?.code === "NOT_BUILT" ? "ExceptionResourceNoAccess" : "ExceptionResourceWrongData",
        String(e?.message ?? e));
    }
  });

  // Everything under the façade that nothing above answered. A 404 is the
  // right answer and also the most useful thing a strange client can tell
  // us: Eclipse asks for far more than vsp does, and the list of what it
  // asked for and did not get is exactly the next wave's work. So each one
  // is recorded once, by method and path, and the server can print the set.
  router.all(`${BASE}/*`, (req, res) => {
    record(req, "resource");
    res.status(404).type("application/xml").send(exceptionDocument("ExceptionResourceNotFound", `${req.path} is not served by OSD`));
  });

  return {router, sessions, store, data, resources, missed, middleware};
}

// a client names a type either as ADT does (DEVC/K, CLAS/OC) or bare (DEVC)
function typeOf(asked) {
  if (asked === undefined || asked === "") {
    return undefined;
  }
  return String(asked).toUpperCase().split("/")[0];
}

// asXmlTypeFor echoes back the vnd.sap.as+xml dataname a client asked for.
//
// These resources carry ABAP serialization rather than a document of their
// own, and the dataname is how a client knows which structure is inside.
// Naming a different one is how a correct body gets refused.
function asXmlTypeFor(req, fallback) {
  const asked = /dataname=([\w.]+)/.exec(String(req.headers.accept ?? ""));
  return `application/vnd.sap.as+xml; charset=utf-8; dataname=${asked === null ? fallback : asked[1]}`;
}

// facadeBuildStamp digests the files that decide what this façade answers.
//
// Cached after the first call: the answer cannot change without the process
// restarting, and hashing on every request would be a cost paid for nothing.
let stamp;
function facadeBuildStamp() {
  if (stamp !== undefined) {
    return stamp;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const digest = createHash("sha256");
  for (const file of ["adt-facade.mjs", "adt-documents.mjs", "adt-session.mjs", "adt-source-properties.mjs", "osd-store.mjs", "osd-store-types.mjs", "osd-git-history.mjs", "segw-registry.mjs"]) {
    try {
      digest.update(readFileSync(join(here, file)));
    } catch {
      digest.update(file); // a missing file is itself part of what this build is
    }
  }
  stamp = digest.digest("hex").slice(0, 16);
  return stamp;
}
