# functions-messages-xref

- Recommendation: **abap-first** (no Node route existed for any of these; the ABAP front is the only implementation, both hosts serve it)
- Effort: M
- Owner: dell (osg-nov adtm, 2026-11-08)
- Depends on: STORE READ of a function group's parts by program name (tools/osd-store.mjs `read`, go/objstore `storeRead`, landed with this family); the cross-reference tables on the serving database (tools/osd-xref-seed.mjs; Node seeds at start, osgo at build in tools/gogen/osg-build.mjs `osgDatabase`); ZCL_OSD_ADT_TYPES (FUGR and MSAG rows were already there).

What an ABAP-FS user gets back (docs/abapfs-conformance.md): opening a
function group, a function module and a message class, the main program of
an include, the New Program wizard's preflight, where-used, and a debugger
that can start (core discovery parses). Measured as `object.FUGR`,
`object.FM`, `object.MSAG`, `object.INCL.mainprograms`, `create.validate`,
`whereused.references` and `debugger.coreDiscovery` of the ABAP-FS kit, and
as F1-F7, M1-M2, I1, N1-N3, U1-U2, G1-G2 of `test/adt-conformance/cases/families.mjs`.

## Routes

### GET `functions/groups/:name`, `.../source/main`, `.../includes/:include[/source/main]`, `.../fmodules/:module[/source/main]` (ZCL_OSD_ADT_FUNCTION)

The group's abapGit XML (`<group>.fugr.xml`) is the truth: AREAT is the
description, INCLUDES are the FUGR/I children (the main program SAPL<group>
among them is the group's own `source/main`, not an include), FUNCTIONS in
file order are the FUGR/FF children with SHORT_TEXT as description and
REMOTE_CALL R as `fmodule:processingType="rfc"`. Every part is a file beside
the XML, `<group>.fugr.<part>.abap`, read with STORE READ type FUGR and the
part's program name as IV_INCLUDE (lower-cased, `/` as `#`); a part the XML
does not list is a 404 before the store is asked, a listed part whose file is
missing is the store's 404. Documents: `group:abapFunctionGroup`
(`http://www.sap.com/adt/functions/groups`), `fmodule:abapFunctionModule`
(`.../functions/fmodules`, with `adtcore:containerRef` to the group),
`include:abapFunctionGroupInclude` (`.../functions/includes`); each carries
`abapsource:sourceUri="source/main"` and a text/plain atom:link, which is
what abap-adt-api's `mainInclude` reads. Timestamps and users are the fixed
values the other documents use (epoch, OSD); the version is the store's.
Content types `application/vnd.sap.adt.functions.{groups.v2,fmodules.v3,includes.v2}+xml`.
`?version=` goes through to READ as for programs. The tree
(`nodestructure` with `parent_type=FUGR/F`) lists the modules then the
includes, which is where ABAP-FS and vsp read a group's content from.
Read-only: FUGR is not a lockable type, so no PUT, no create, no delete.

### GET `messageclass/:name`, `.../source/main` (ZCL_OSD_ADT_MSAG)

`<name>.msag.xml`: T100A gives STEXT and MASTERLANG, the T100 rows of the
master language give the messages in file order (rows of another language
are left out, not merged). Document `mc:messageClass`
(`http://www.sap.com/adt/MessageClass`) with one `<mc:messages mc:msgno
mc:msgtext/>` per message, the shape vsp reads with Accept
`application/vnd.sap.adt.mc.messageclass+xml`. `source/main` is OSD's text
form, `NNN text` per line, so a client that opens every object as a document
plus a source shows a message class as a file; no system has that resource,
and the atom:link that names it is typed text/plain and titled as OSD's.

### GET `programs/includes/:name/mainprograms` (ZCL_OSD_ADT_INCLUDES)

`SELECT DISTINCT master FROM d010inc WHERE include = :name`, sorted. A master
SAPL<group> (namespaced: /NS/SAPL<rest>, the inverse of the group's main
program) is answered as the group (FUGR/F, `functions/groups/<group>`),
any other as a program (PROG/P). The package comes from STORE OBJECT of the
master; a master the store does not know is still named, without a package.
`adtcore:objectReferences`, content type
`application/vnd.sap.adt.programs.includes.mainprograms+xml`. The include
itself must exist (STORE OBJECT INCL), else 404. At most 500 masters are
listed (`UP TO 500 ROWS`), silently. Registered only where the kernel has the
cross-reference tables (ZCL_OSD_KERNEL_GUARD=>HAS_CROSS_REFERENCE: osgo,
which seeds them at build, and Node with the ADT step in the serving child,
`OSD_ADT_ONE_RUNTIME=1`), not under HAS_SERVING_DATABASE as A9 is, so osgo
serves it.

### POST `programs/validation`, `includes/validation` (ZCL_OSD_ADT_CREATE_VALID, with the two it had)

The preflight is now native ABAP over STORE OBJECT for all four resources,
message for message the rules of tools/adt-create-validation.mjs and
tools/osd-object-name.mjs (test/adt-abap-c1.mjs diffs the OO and package
forms against Node byte for byte): unsupported type, type not matching the
resource, name policy, object exists, package missing / read-only, package
child name. PARSE CREATE_VALIDATION is no longer asked, so osgo, whose store
parses OUTLINE only, answers every preflight. `functions/validation` and
`messageclass/validation` stay unserved: nothing here creates those objects,
and a preflight that says yes to a wizard whose POST is refused would be a
lie.

### POST `repository/informationsystem/usageReferences?uri=` (ZCL_OSD_ADT_WHEREUSED)

Object level: the `uri` is resolved to a type and name
(ZCL_OSD_ADT_TYPES=>OBJECT_FROM_URI, a `#start=` fragment is accepted and
ignored), the object must exist (404), then `SELECT DISTINCT include FROM
wbcrossgt / wbcrossgtx WHERE otype = 'TY' AND name = :name`, the object
itself left out, sorted, capped at 200. INCLUDE is the referencing object's
own name (tools/osd-xref.mjs writes names, not ZCL_X=======CM001), so each
is resolved to its type with STORE SEARCH (exact match) and to its package
with STORE OBJECT. `usageReferences:usageReferenceResult` with one
`referencedObject` (uri, isResult true, canHaveChildren false), its
`adtObject` (adtcore uri/type/name, packageRef) and an unprefixed
`objectIdentifier` child `TYPE;NAME`, the shape abap-adt-api and vsp read.
The request body (`affectedObjects`) is not read. Not served:
`usageSnippets`, positions, where-used of a function module (CROSS type F).
Registered under ZCL_OSD_KERNEL_GUARD=>HAS_CROSS_REFERENCE, as `mainprograms` is.

### GET `core/discovery` (ZCL_OSD_ADT_DISCOVERY, iv_core)

The same collections as `discovery`, each in a workspace of its own, so a
reader that takes `app:collection` as one element per workspace
(abap-adt-api `adtCoreDiscovery`, the first call of `DebugService.create`)
parses it; `discovery` keeps the grouped form. HEAD is unchanged. The Node
façade answers the same bytes (`discoveryDocument(resources, {core: true})` in
tools/adt-facade.mjs), so gate 1 of test/adt-abap-diff.mjs stays byte-equal.

## Host dependencies

- STORE READ FUGR parts: Node `osd-store.mjs read()` and Go `objstore.storeRead` (goldens `read-fugr-*`, `object-fugr` in test/fixtures/osgo-store, both hosts compared).
- Cross-reference rows on osgo: `osgDatabase` appends tools/osd-xref-seed.mjs's statements for the tables the program defines, once per build (the Node hosts seed the same rows at start).
- STORE SEARCH and OBJECT, both hosts had them.

## Test plan

ABAP Unit on the pure parts (parse, documents, name policy, package child
names, core discovery counts). The kit cases above on JS and osgo; the
ABAP-FS kit with its pinned client on both hosts. Go: `go test ./objstore`
(goldens). Node: `test/osd-store.mjs` (FUGR parts).

## Risks

- A namespaced function group's main program is taken as `/NS/SAPL<rest>`; not measured against a system.
- The tree lists FUGR/FF and FUGR/I under the group's kind row (first-appearance rule of the Node tree), not under separate "Function Modules" / "Includes" labels.
- Where-used is object-level and type-reference-level (WBCROSSGT); a program that only CALL FUNCTIONs a module (CROSS F) is not a reader of the group.
