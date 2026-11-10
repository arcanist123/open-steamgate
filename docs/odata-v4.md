# OData V4 over the existing model

Every registered service has a second endpoint:

```text
/sap/opu/odata4/sap/<service>/
```

The existing `/sap/opu/odata/sap/<service>/` endpoint keeps its V2 behavior.
V4 runs the same MPC and DPC, including SADL/CDS and services produced by
`stg-compile`; it is a wire facade, not the `/IWBEP/` V4 provider API. No
service opt-in or separate registration is needed. The standalone
[`src/gateway_v4`](../src/gateway_v4/README.md) package mounts through the SICF
registry used by the server and preview.

## Served now

Reads (GET, HEAD), reads through a navigation property, entity writes,
deep insert, ETags, JSON and multipart `$batch`, the MPC's vocabulary
annotations, sticky-session editing, which is what a Fiori Elements V4 app
needs (see the last sections), the model's function imports as bound and
unbound operations, options inside `$expand(...)` and `$search`. Responses carry
`OData-Version: 4.0`. JSON uses
`application/json;odata.metadata=minimal` with full `@odata.context` and
`@odata.count` names for compatibility with 4.0 clients.

| Request | Response |
| --- | --- |
| service root | V4 service document with entity-set names and URLs |
| `$metadata` | CSDL XML, `edmx:Edmx Version="4.0"`, OASIS EDM/EDMX namespaces |
| `TravelSet` | `{"@odata.context":".../$metadata#TravelSet","value":[...]}` |
| `TravelSet('T0001')` | one object with `@odata.context` ending in `/$entity` |
| `BookingSet(TravelId='T0001',BookingId='B001')` | composite-key lookup |
| `TravelSet?$select=TravelId,Description` | selected structural properties; `*` selects all |
| `TravelSet?$filter=Status eq 'A'` | existing filter parser and DPC select-options |
| `TravelSet?$orderby=TravelId desc&$skip=1&$top=2` | DPC ordering, then facade paging |
| `TravelSet?$count=true&$top=1` | numeric `@odata.count` before paging |
| `TravelSet/$count?$filter=Status eq 'A'` | plain-text count of matching rows |
| `TravelSet?$expand=to_Bookings` | navigation inlined as an array |
| `BookingSet(...)?$expand=to_Travel` | navigation inlined as an object or `null` |
| `TravelSet?$expand=to_Bookings($select=BookingId;$filter=...;$orderby=...;$top=1;$skip=1;$count=true)` | the options of the expanded collection; `to_Bookings@odata.count` before the array |
| `BookingSet(...)?$expand=to_Travel($select=Description;$expand=to_Bookings)` | several levels, each with its own options |
| `TravelSet?$select=TravelId,to_Bookings/Customer&$expand=to_Bookings` | a `$select` path through the expanded navigation |
| `TravelSet?$search=Copenhagen`, `$search="to Aarhus"` | the DPC's `iv_search_string` of a searchable entity set |
| `TravelCount(Status='A')`, `TravelSet('T0001')/ZSTG_DEMO_SRV.CancelTravel` | the model's function imports as a function import and a bound action (see Operations) |
| `TravelSet('T0001')/to_Bookings?$count=true&$top=10` | the navigation target read through the DPC with the source key, query options on the target |
| `BookingSet(...)/to_Travel` | a single-valued navigation; 204 when it leads nowhere |
| `TravelSet('T0001')/to_Bookings/$count` | plain-text count of the related rows |
| `HEAD` on any resource, `X-CSRF-Token: Fetch` | the GET's headers without a body; a token is handed out (any token is accepted, as on V2) |

Query options whose names start with `sap-` (`sap-client`, `sap-language`,
`sap-context-token`, ...) are host hints and ignored; any other unknown
option is 501.

CSDL includes entity keys, nullable properties, string/binary maximum
lengths, decimal precision and scale, navigation cardinality, known reverse
partners, the entity container and navigation bindings, and the vocabulary
annotations the MPC builds through `vocab_anno_model` (what `stg-compile`
writes from a YAML `annotations:` block into `ZCL_<project>_MPC_ANN`:
`UI.HeaderInfo`, `UI.SelectionFields`, `UI.LineItem`, `UI.Facets`,
`UI.FieldGroup`, `Common.Label`, `Common.Text`, `Common.ValueList`...).
Their XML is the same in V2 and V4 `$metadata`, so the facade emits what the
model renders, inside the schema after the container, with references to the
Core, Common and UI vocabularies; a V2 target on the entity container
(`<ns>.<ns>_Entities/...`) is moved to the V4 one (`<ns>.Container/...`). DATS-backed V2
`Edm.DateTime` becomes `Edm.Date`; other `Edm.DateTime` becomes
`Edm.DateTimeOffset`, V2 `Edm.Time` becomes `Edm.TimeOfDay`. Decimal facets
follow the existing MPC convention: `set_maxlength` is total digits and
`set_precison` is decimal places. An unspecified decimal precision uses
`Scale="variable"`. Entity types referenced by multiple sets are emitted once.

Dates serialize as `2026-11-07`; timestamps as ISO timestamps with UTC `Z`;
GUIDs use the hyphenated form. Decimal and integer values are JSON numbers
(the IEEE754-compatible string-number negotiation is a later slice).
Numeric text backing an EDM number is normalized without a numeric cast, so
leading zeros are removed without rounding Decimal or Int64 digits.
Collections and navigation arrays have no `d`/`results` wrappers, and rows
have no `__metadata` or deferred navigation links. `$select` applies to the
outer entity; an expanded navigation contains the structural properties its
own `$select` (inside the parentheses) or a `$select=nav/prop` path on the
parent names, all of them otherwise.

Keys and filters accept V4 literals such as `Day=2026-11-07`,
`Guid=<32 hex digits, hyphenated 8-4-4-4-12>`, and
`Moment eq 2026-11-07T12:30:45Z`. A Guid literal reaches the DPC as its
internal form, the same digits upper case and unhyphenated, and serializes
back hyphenated and lower case. Timestamp filter offsets are converted to
UTC before reaching the DPC. Temporal literals must match the property's
Date or DateTimeOffset type, with valid calendar dates, clock times and
UTC offsets (at most 14 hours). Numeric and quoted string literals are not
accepted for temporal properties. V2 `datetime'...'` and `guid'...'` forms are
rejected. Quoted strings use doubled apostrophes and retain embedded spaces.

The existing filter subset is retained: comparisons, per-property ORs
joined by AND, range comparisons, and supported string functions
(`startswith`, `endswith`, `substringof`). Filters which cannot be expressed
as select-options return 501 rather than silently dropping predicates.
`tolower`, `toupper` and `trim` are rejected with 501 because select-options
cannot preserve their transformations. Intersecting a same-property OR with
another bound on that property also returns 501: the shared converter cannot
apply the bound to every OR branch. Independent per-property OR groups joined
by AND and ordinary lower/upper range pairs remain supported. The
DPC remains responsible for applying supported filters and ordering, just
as on the V2 path.

Counts are computed from an unpaged DPC read and paging is applied to that
result. This ensures correct pre-paging counts for hand-written DPCs which
do not supply an inline count. It materializes the matching collection and
is not a streaming or server-driven paging implementation. A provider which
imposes its own row limit can only expose the rows it returns. `$top=0`
returns an empty value array while retaining the requested count.

Errors use `{"error":{"code":"...","message":"..."}}`: malformed options,
keys and bodies return 400; unknown services, sets and missing entities return
404; a method the resource does not take returns 405 with an `Allow` header;
unsupported operations/options return 501. The V4 handler catches provider exceptions using the existing error
conventions (business failures 400, missing implementation 501, technical
failures 500).

## Expand options and $search

`$expand=nav(option;option;...)` ([OData 4.01 Part 1, 11.2.5.2](https://docs.oasis-open.org/odata/odata/v4.01/os/part1-protocol/odata-v4.01-os-part1-protocol.html#sec_SystemQueryOptionexpand))
is read as a query of the target entity set with those options, so it has
the same validation, the same `$filter` converter (and its 501s), the same
`$orderby` through the DPC and the same facade paging as a request to that
set: `$select`, `$filter`, `$orderby`, `$top`, `$skip`, `$count` (answered as
`nav@odata.count`, counted before `$top`/`$skip`), `$search` and a nested
`$expand`, to any depth. The target is read as before, through the DPC's
`GET_ENTITYSET` / `GET_ENTITY` with the navigation path and the source
key; the options travel in the request context. A single-valued navigation
takes `$select` and `$expand` only (400 otherwise). `$select=nav/prop` on
the parent selects `prop` in that expansion when the expansion has no
`$select` of its own; `$select=nav` alone is accepted and changes nothing
(minimal metadata carries no navigation links). The context URL names an
expanded navigation with its selected properties,
`$metadata#TravelSet(TravelId,to_Bookings(BookingId))`. `$expand=*`,
`nav/nav` paths (type casts in 4.01) and `$levels` are 501; an unknown
option inside the parentheses is 501 as on the collection.

`$search=term` or `$search="a phrase"` ([Part 1, 11.2.5.6](https://docs.oasis-open.org/odata/odata/v4.01/os/part1-protocol/odata-v4.01-os-part1-protocol.html#sec_SystemQueryOptionsearch))
is handed to the DPC's `GET_ENTITYSET` as `iv_search_string`, which is what
the V2 `search=` option does and what a SEGW DPC implements itself (the
demo's Travel matches the id or the description, its value help the status
text): **which properties are searched is the DPC's**, as on a Gateway. The
model decides whether a set takes it: `set_has_ftxt_search` on the entity
set (`sap:searchable`, `searchable: true` in a `stg.yaml` entity) and
otherwise 501, which names the flag. The search expression grammar is not
implemented: `AND`, `OR`, `NOT`, several terms or phrases answer 501; the
DPC receives one term or one phrase (its quotes removed, `\"` and `\\`
undone in one left-to-right pass). A phrase ends at its first unescaped
quote: anything after it is 501, a phrase without its closing quote or with
a backslash before anything but a quote or a backslash is 400. The term is
data for the DPC: quotes, backslashes and JSON in it are never read as
syntax, and a NUL is 400 like everywhere else. Inside `$expand(...)` it applies to the target set the same way.
`$search` on a single entity is 400. A set the model does not mark
searchable carries `Capabilities.SearchRestrictions/Searchable=false` in
`$metadata`, which is what makes sap.fe leave out its search field.
SADL/CDS sets have no search flag yet.

## Operations

The model's function imports are V4 operations ([Part 1, 11.5](https://docs.oasis-open.org/odata/odata/v4.01/os/part1-protocol/odata-v4.01-os-part1-protocol.html#sec_Operations))
in `$metadata` and on the wire, executed through the DPC's `execute_action`
with the parameter table the V2 path builds. The kind follows the HTTP
method of the function import: `GET` is a `<Function>`, anything else an
`<Action>`. The binding follows SEGW's "Action for" (`set_action_for`;
`for:` in a `stg.yaml` function):

| Model | CSDL | Invocation |
| --- | --- | --- |
| action for `Travel`, parameters cover Travel's key | `<Action Name="CancelTravel" IsBound="true">` with the binding parameter `_it` of type `Travel` and the other parameters; the key parameters are not listed | `POST TravelSet('T0001')/ZSTG_DEMO_SRV.CancelTravel` with a JSON object of the other parameters (or `{}`); a function: `GET Set(key)/<ns>.<Fn>(p=v)` |
| action for `Travel`, a key property missing from the parameters | bound to `Collection(Travel)`, every parameter listed | `POST TravelSet/<ns>.<Op>`, `GET TravelSet/<ns>.<Fn>(p=v)` |
| no action for | unbound `<Function>` + `<FunctionImport>` or `<Action>` + `<ActionImport>` in the container (`EntitySet` when the model names the return set) | `GET TravelCount(Status='A')`, `GET TravelCount()`, `POST <ActionImport>` with the parameters in the body |

The key of the binding fills the parameters named like the key properties
and cannot be moved by a parameter in the body or URL. URL parameters are
V4 literals (`'...'` strings, bare dates and GUIDs, numbers) converted like
keys: an `Edm.String` parameter takes a quoted literal only
(`TravelCount(Status=1)` is 400) and any other type an unquoted one;
`null` is handed over empty. Body parameters are V4 JSON values converted
like a write's, and an `Edm.String` parameter takes a JSON string (or
`null`), not a number or a boolean. An unknown parameter or one given twice
is 400, a missing one is handed over empty (as on V2), parameter aliases
(`@p`) and non-primitive parameters are 501. A parameter's facets from the
MPC (`set_maxlength`, precision, scale) are written on its `<Parameter>` as
on a property; a parameter value longer than its MaxLength is 400 before the
DPC runs, the same `check_length` as a read's key (docs/key-length.md).

The binding parameter of an entity-bound operation is the entity the URL
names ([Part 1, 11.5.5](https://docs.oasis-open.org/odata/odata/v4.01/os/part1-protocol/odata-v4.01-os-part1-protocol.html#sec_InvokinganAction)):
it is read through `GET_ENTITY` first and a key nobody has is 404 before
the DPC's `execute_action` runs. An action then takes the entity lock
(`EZOSD_V4_LOCK`, 409 when another request holds it) and checks `If-Match`
against the entity's current ETag (412 on a mismatch), as a PATCH does;
sap.fe sends the ETag it holds. Without `If-Match` an action on an entity
type with an ETag is 428, the same rule as PATCH/PUT/DELETE (`If-Match: *`
opts out of the comparison); an entity type without an ETag needs none.
A bound function only checks that the entity exists.
An operation bound to an entity type that returns that type says
`EntitySetPath="_it"`. A bound action called inside a sticky session
(`SAP-ContextId`) runs against the database, not the session's buffer. A function
takes `GET` and an action `POST`; the other method is 405 with `Allow`.

The return type is the entity type (`Collection()` of it for a
multiplicity other than 1) or the complex type the model names, and
`Edm.PrimitiveType` when it names none, because classic SEGW's tree has no
primitive return kind (the demo's `TravelCount` is `GET` with no
`ReturnType` on a system too). The answer follows what the DPC returned: an
entity as a single read (`$metadata#TravelSet/$entity`, `@odata.etag`,
deep components inlined), a table as a collection (`$metadata#TravelSet`,
`value`), a complex value with the complex type's properties
(`$metadata#<ns>.<CT>`), a primitive as
`{"@odata.context":".../$metadata#Edm.Int32","value":3}` typed by its ABAP
kind, and no data as 204. A collection of primitive or complex values is 501.
The sticky-session actions keep their names and are served as before.
Every operation goes to the DPC's `execute_action` with the context a V2
function import gets: `mv_function_import` and `mt_parameter` (the binding's
key included) set, and for an action for an entity type, which names no set
of its own, the first set of that type as `mv_entity_set`. So a DPC that
SADL serves (one implementing `IF_SADL_GW_DPC_UTIL`, as SEGW generates for a
reference data source and the RAP services, or `IF_SADL_GW_DPC` itself) runs
its bound actions here too: a RAP service's BDEF action runs through the
behavior, under the same 404 / lock / If-Match / MaxLength rules as any
bound action (`docs/rap-runtime.md`, "V4"; `test/rap-serve.mjs`). An entity
SADL serves without a behavior, or an action its behavior does not declare,
is SADL's `not_impl`, 501.

## Writes

Writes go to the same DPC methods the V2 path calls (`create_entity`,
`update_entity`, `delete_entity`), and the model's `set_creatable` /
`set_updatable` / `set_deletable` on the entity set decides first: a write
the model refuses answers 405 and never reaches the DPC.

| Request | Response |
| --- | --- |
| `POST TravelSet` with a JSON object | 201, the entity as in a single read, `Location` |
| same with `Prefer: return=minimal` | 204, `Location`, `OData-EntityId`, `Preference-Applied` |
| `PATCH TravelSet('T0001')` | 204; only the properties sent change (the entity is read and the body laid over it) |
| `PUT TravelSet('T0001')` | 204; the entity is replaced, a property left out becomes initial |
| `PATCH`/`PUT` with `Prefer: return=representation` | 200 with the entity after the update |
| `DELETE TravelSet('T0001')` | 204 |

The `Location` (and `OData-EntityId`) of a create percent-encodes every string
key value per UTF-8 byte, `TravelSet('%D0%96%D1%83%D0%BA')` for the key
`Жук`, so a key outside ASCII reads back with a plain GET. An ASCII key keeps
the exact bytes `cl_http_utility=>escape_url` wrote for it — the kept
characters raw, the rest `%` and lowercase hex (`TravelSet('It%27%27s')` for
`It's`, `TravelSet('a%2cb')` for `a,b`); the per-byte form reaches only the
characters outside ASCII.

Request bodies are V4 JSON, read with their token kinds (ajson) and, for
numbers, the literal text as the client wrote it (no float round trip): strings
for `Edm.String`, `Edm.Date` (`2026-11-07`), `Edm.DateTimeOffset` (`Z` or an
offset, stored as UTC), `Edm.TimeOfDay` (`12:30:45`) and hyphenated GUIDs;
JSON numbers for numeric types; `true`/`false` for booleans. Integers must be
written as integers (no fraction, no exponent: `2.0000000000000001` and
`1e3` are 400) and lie within the range of their type (Byte, SByte, Int16, Int32,
Int64); a Decimal must fit its Precision and Scale; a string must fit its
MaxLength. `Int64` and `Decimal` may come as strings under
`IEEE754Compatible=true`. A JSON `null` clears a nullable property and is
400 for a non-nullable one or a key; the string `"null"` is a string.
Control information and instance annotations (`@odata.type`, `Name@...`)
are ignored. An unknown property (also a V2 `{"d":{...}}` envelope) or a
value that does not fit is 400 before the DPC is called and the entity is
unchanged. The key of a PATCH or PUT is the one in the URL; a key property in
the body cannot move the update to another entity. A missing entity is 404.
A key, or an operation's parameter value (a function's from the URL, an
action's from the body), longer than the property's MaxLength is 400 before
the DPC runs (`zcl_stg_model_info=>check_keys` / `check_length`,
docs/key-length.md): the DPC's CHAR field would cut
`TravelSet('T0002    X')` down to `T0002` and read, change, delete or call a
bound action on that entity instead.
A relationship binding (`Nav@odata.bind` or `Nav@bind`, scalar or array)
answers 501; a binding is never acknowledged and dropped. Binary values in
bodies are 501. A write to a collection other than POST answers 405 with
`Allow: GET, POST`; POST to an entity, `Allow: GET, PATCH, PUT, DELETE`.

A `POST` whose body carries related entities under navigation properties is
a deep insert ([Part 1, 11.4.2.2](https://docs.oasis-open.org/odata/odata/v4.01/os/part1-protocol/odata-v4.01-os-part1-protocol.html#sec_CreateRelatedEntitiesWhenCreatinganE)):
it goes to the DPC's `create_deep_entity` with the expand tree of the
payload, as on V2, so the parent and its children are one LUW (a child the
DPC refuses takes the parent with it). A to-many navigation takes an array
and a to-one an object (400 otherwise), each nested entity is checked and
converted like the entity itself (unknown property 400, V4 dates and GUIDs
converted, any depth), and the answer is 201 with the deep entity the DPC
returned: a component named like a navigation property is inlined as an
array or an object (`to_Bookings:[...]`, OData 4.01 "expanded children in
the body"), the `Location` and `ETag` are the parent's. A deep update
(related entities in a `PATCH` or `PUT`, or in a sticky session's copy) is
501.

As on the V2 path, one modifying request is one LUW: a `COMMIT WORK`
fences it off from what ran before, a 4xx/5xx rolls it back, a success
commits; a dump is rolled back by the host's dialog step
(`tools/osd-dialog-step.mjs`).

## ETags

A property the MPC marks with `set_as_etag( )` (SEGW's "ETag" flag; the
generators emit it) makes the entity's ETag. It is weak and built from the
property values: `W/"<value>"`, several ETag properties joined by `;`, each
value URL-escaped. Where an entity type has one:

- `$metadata` annotates its entity sets with `Core.OptimisticConcurrency`
  (and references the Core vocabulary);
- every entity in JSON starts with `@odata.etag`, in collections, single
  reads, create and update responses;
- a single read, a create and an update answer with the `ETag` header;
- PATCH, PUT and DELETE need `If-Match`
  ([OData 4.01 Part 1, 11.4.1.1](https://docs.oasis-open.org/odata/odata/v4.01/os/part1-protocol/odata-v4.01-os-part1-protocol.html)):
  without it 428, with tags none of which matches the current one 412,
  `If-Match: *` or the current tag (a list is accepted; the `W/` prefix is
  not compared) goes through.

`If-Match` with a specific tag on an entity type without an ETag never
matches and answers 412; `*` passes.

The check and the write are one step: PATCH, PUT and DELETE first take an
exclusive lock on the entity (lock object `EZOSD_V4_LOCK` over
`ZOSD_V4_LOCK`, whose one key field is the SHA-256 of service, entity set
and key, since a system allows lock keys of at most 120 characters; nothing
is cut, and a hash collision would lock more, never less; the key is the
entity's identity,
its properties in the model's order with normalized values, so
`BookingSet(BookingId='B001',TravelId='T0001')` takes the same lock as the
other spelling), then read the current entity
and its ETag through the DPC's `get_entity`, check `If-Match`, and write.
The lock has `_SCOPE 2` and lasts until the LUW ends (the end of the request,
or of the batch). A write to an entity another session has locked answers
409 without waiting. This holds against writers that go through this
facade; a DPC or another program that writes without the lock is not
covered. On Node the lock server is `tools/osd-enq.mjs`; on a system it is
the enqueue server.
SADL services have no ETag source yet. `If-None-Match` and conditional GET
(304) are not served.

## JSON $batch

`POST $batch` with `Content-Type: application/json` takes the
[JSON batch format](https://docs.oasis-open.org/odata/odata-json-format/v4.01/os/odata-json-format-v4.01-os.html):
`{"requests":[{"id","method","url","headers","body","atomicityGroup","dependsOn"}]}`
and answers 200 with `{"responses":[{"id","atomicityGroup","status","headers","body"}]}`.
Each request runs through the same dispatch as a single request.

- `url` is relative to the service root, an absolute path, or an absolute
  URL; a `url` that starts with `$<id>` continues the `Location` of the
  entity request `<id>` created (`$new`, `$new?$select=...`), and `<id>`
  must be in its `dependsOn` (400 otherwise).
- `id`, `method`, `url` and `atomicityGroup` must be JSON strings (400).
- An `atomicityGroup` is one LUW: a `COMMIT WORK` fences it, the first
  failing member rolls the whole group back, and the group commits only when
  every member succeeded. Of a failed group, the failing request carries its
  own error, members that ran before it answer 424 ("rolled back"), members
  after it are not executed and answer 424. Requests of one group must be
  adjacent (400 otherwise). A request outside any group is its own LUW.
  What runs inside a group does not end the LUW itself: a RAP save (CRUD
  or a bound action) writes without `COMMIT WORK` while
  `ZCL_OSD_LUW_HOLD=>HELD` says the batch holds it.
- `dependsOn` names earlier request ids or ended groups (a forward or
  unknown name is 400 for the whole batch). A request of another atomicity
  group can only be depended on together with its group (s19.1; 400
  otherwise). If a dependency failed, the request is not executed and
  answers 424.
- Every request is processed, as JSON Format 4.01 s19.4 has it for JSON
  batches. `Prefer: odata.continue-on-error=false` stops after the first
  failed request (or after the group it belongs to); an explicit preference
  is echoed in `Preference-Applied`.
- Duplicate ids, requests without id/method/url, or a nested `$batch` are 400.
- Another content type than JSON or `multipart/mixed` is 415.

Requests are executed in array order; the service does not reorder or run
independent requests in parallel.

## Multipart $batch

`POST $batch` with `Content-Type: multipart/mixed; boundary=...` (OData 4.01
Part 1, 11.7.7; what the UI5 V4 model sends) is parsed by the V2 parser
(`ZCL_STG_BATCH`) into the same request list as a JSON batch and run by the
same loop: a part is a request outside any group, a change set is an
atomicity group (one LUW, all or nothing). The answer is `200` with
`multipart/mixed`: one `application/http` part per request, each with
`OData-Version: 4.0`; a change set that succeeded as a nested multipart;
a change set that failed as the one response of the member that failed.
Every response part carries the `Content-ID` of its request part (the
client's own identifier; a change set member without one is named by its
position), and a request's Content-ID is its id, so a URL `$<Content-ID>`
continues the `Location` of the entity that part created, as in the JSON
format. A change set holds changes: a GET in one is 400 (OData 4.01 Part 1,
11.7.7.1). Without `Prefer: odata.continue-on-error` the answer stops after
the first failure.

## Sticky-session editing (what Fiori Elements V4 edits through)

Fiori Elements V4 templates Edit and Save on the object page, and Create in
the list report, only for a draft-enabled entity set or one with
[`Session.StickySessionSupported`](https://github.com/SAP/odata-vocabularies/blob/main/vocabularies/Session.md);
there is no non-draft edit without one of the two (read off
`sap/fe/core/converters` in 1.120: `getInsertUpdateActionsTemplating`
and the header/footer action converters). SEGW has neither, so the facade
offers a sticky session itself (`ZCL_OSD_V4_STICKY`), **on request**: for an
entity set whose model marks the entity type with
`Session.StickySessionSupported` (`sticky: true` in the type's entry of a
YAML `annotations:` block, which `stg-compile` writes as that annotation
with an empty record), which the model lets update and whose entity type
has an ETag. The ETag is required because Save is optimistic: it is how
Save notices that the entity changed while the session held its copy. In
the demo only `Travel` asks for it.

For such a set `$metadata` carries, in the service namespace:

| Element | Call | What it does |
| --- | --- | --- |
| `OsdStickyEdit`, bound to the entity, `EntitySetPath="_it"` | `POST Set(key)/<ns>.OsdStickyEdit` | reads the entity through `GET_ENTITY` into the session's buffer; checks `If-Match` when one is sent; answers the entity, its `ETag` and `SAP-ContextId` |
| `OsdStickySave`, bound to the entity | `POST Set(key)/<ns>.OsdStickySave` | `If-Match` must name the ETag the session holds (428 without, 412 otherwise); compares the ETag taken at Edit with the database's (412 if it moved), writes the buffer through `UPDATE_ENTITY` (or `CREATE_ENTITY` for a new one), drops it, answers the entity |
| `OsdStickyNew`, bound to the collection, the key properties as parameters | `POST Set/<ns>.OsdStickyNew` | starts a new entity in the buffer (400 if it exists or a key is missing); Fiori Elements asks for the parameters in a dialog |
| `OsdStickyDiscard`, unbound, with an `ActionImport` | `POST OsdStickyDiscard` | drops every buffer of the session; 204 |

and the entity set is annotated `Session.StickySessionSupported` with those
four names. A request carrying `SAP-ContextId` reads (`GET Set(key)`) and
changes (`PATCH`/`PUT Set(key)`, `If-Match` against the buffer's ETag) the
session's copy instead of the database; every answer to such a request
names the session again, and a `$batch` names the session a part opened,
because the client reads that header on the batch. The copy keeps the ETag its
Edit (or New) started from until Save: buffered PATCHes do not move it, a
GET or PATCH in the session answers it, and PATCH and Save take `If-Match`
with exactly that tag (428 without, 412 with any other, nothing written).
Save answers the new ETag of what it wrote. The tag names the version the
session works on rather than each buffered change; that is also why the UI5
model's Save, which it sends before the answer to its last PATCH has
arrived (Fiori Elements 1.120, measured), carries a current tag.

A write (`PATCH`/`PUT`) that names a session (`SAP-ContextId`) on a sticky
entity set is never written through to the database: if the session has
ended (idle timeout, eviction, Save or Discard of all it held, or a context
the service never opened) it is 410, if the session is alive but does not
hold that entity it is 400 ("call Edit first").

The buffers live in the serving process (class data). There is no enqueue
lock. A session idle for 900 seconds is dropped (announced as
`SAP-Http-Session-Timeout`, so the UI5 model keeps a live one alive; any
request carrying `SAP-ContextId` counts as activity); at most 50 sessions
hold buffers and a new one evicts the least recently used. Both are
`ZCL_OSD_V4_STICKY=>CONFIGURE( )`. A Save in a session that was dropped
answers 400. Inside a `$batch`, an atomicity group (a change set) that
fails gives the buffers back as they were before it, like the rows: a PATCH
of a copy, an Edit, a New or a Save in a failed group leaves the session as
it was. The row type of a new entity is the line type of the DPC's
`GET_ENTITYSET` answer, since the model library keeps the bound structure
name private.

The demo's Travel asks for it (`sticky: true`) and has an ETag for it: `etag: true` on Description,
Status and Seats in `src/demo/zstg_demo.stg.yaml` (SEGW's ETag flag,
`set_as_etag`). Its V2 `$metadata` says `ConcurrencyMode="Fixed"` on those
properties since, and the V2 path honours what that promises: a
MERGE/PUT/DELETE of a type that declares an ETag takes `If-Match` (428
without it, 412 with a tag that is no longer the row's, `*` always passes),
and a single read answers the tag as the `ETag` header and as
`__metadata.etag`. The tag is the V4 computation above, byte for byte — the
V2 gateway calls `ZCL_OSD_V4_JSON=>ETAG` and `ZCL_OSD_V4_WRITE=>PRECONDITION`
rather than keeping a second one — so a row has one tag whatever the client
asked for. A guarded MERGE/PUT/PATCH answers the row's new tag with its
204, read back through the DPC, and a function import that returns such an
entity returns it with `__metadata.etag` like any read. A type without ETag
properties writes without the header, as before, and its PUT and DELETE
read nothing first even in a service where another type declares one: the
requirement follows the type, not the service and not the protocol.

## Fiori Elements V4

`webapp/travel4` (launchpad tile "Travels (OData V4)", intent
`TravelV4-manage`, BSP application `ZOSD_TRAVEL4`) is a Fiori Elements V4
list report and object page (`sap.fe.templates`, SAPUI5 1.120.50 from the
CDN like the other apps) over `ZSTG_DEMO_SRV` at `/sap/opu/odata4/`. It has
no local annotation file: the UI annotations come from the service's
`$metadata`, out of the same YAML block the V2 Travels app reads.
`test/e2e/travel4.spec.mjs` covers the list, the filter bar, the object page
with the bookings table, edit + save and create. What the app sends, and
what the facade had to learn for it:

| Fiori Elements V4 / UI5 V4 model | Facade |
| --- | --- |
| `$metadata?sap-language=EN` with UI annotations | vocabulary annotations in CSDL; `sap-*` options ignored |
| `HEAD <service>/` with `X-CSRF-Token: Fetch` | HEAD served, token handed out |
| everything in multipart `$batch` (`$auto.Workers`, `$auto.Heroes`, `$auto`, `direct`) | multipart `$batch` |
| `TravelSet?$count=true&$select=...&$skip=0&$top=30`, `$filter=Status eq 'X'` | already served |
| `TravelSet('T0001')/to_Bookings?$count=true&$select=...` for the object page table | navigation resource reads |
| Edit, field changes, Save, Cancel, Create (with a key dialog) | sticky session; `PATCH` with `If-Match` and `SAP-ContextId` |
| `Accept: ...;IEEE754Compatible=true` | not negotiated: the demo has no Int64/Decimal |

Not covered for Fiori Elements: draft (`Common.DraftRoot`), creating or
editing bookings below a travel (writes through a navigation property are
501), side effects, and value helps beyond what the V2 annotations already
describe. The list report's basic search field sends `$search="..."`,
which the facade now hands to the DPC (the demo's Travel is searchable). The `Photo`
column's URL is written by the DPC relative to a page one level below the
origin (`../sap/opu/odata/...`): inside the launchpad (`/app/flp.html`) it
resolves, from the standalone `/app/travel4/index.html` it does not.

## Not served in this slice

- `@odata.bind`, writes through navigation properties, deep update.
- `If-None-Match`, conditional GET, SADL ETags, draft.
- Binary property values in request bodies (501).
- `$expand=*`, `nav/nav` expand paths, `$levels`; parameter aliases,
  non-primitive operation parameters, collections of primitive or complex
  operation results; the `$search` expression grammar (one term or phrase
  only); SADL sets are not searchable.
- `$apply`, lambda expressions or a general expression evaluator.
- Navigation paths longer than one segment, structural-property URLs and
  media streams.
- Complex types, inheritance and containment.
- Metadata-level negotiation, JSON CSDL, IEEE754Compatible, next links and
  other server-driven paging features.
- The V4 provider API.

## Next slices

Complex types as property values, count pushdown, writes through
navigation properties (Create on the object page's bookings table), then
draft.

## Verification and references

The registered Mocha suite is `test/odata-v4.mjs`. It parses metadata as XML
and exercises demo reads, SADL reads, a YAML service, literals/facets,
projection, counts, ordering/paging, expansion and errors, and the writes,
ETags (a writable `NoteSet` with `set_as_etag` in the synthetic `test/v4/`
service, backed by the table `ZOSD_V4_NOTE` so that a rolled-back group
undoes it) and JSON batches (two atomicity groups, one rolled back while the
other commits, `dependsOn` and `$<id>`), plus the domain checks of body
values, the entity lock (taken from the test through
`tools/osd-enq-host.mjs`) and the continuation default, and what Fiori
Elements V4 needs (annotations, HEAD, `sap-*` options, navigation reads,
multipart batches, the sticky session), and the operations, deep insert,
expand options and `$search` (the demo's `CancelTravel` and `TravelCount`, a
travel with two bookings in one POST and its rollback, options and levels
inside `$expand`, `$select` paths, search terms and phrases, and the 501s of
what is not served). The browser side is `test/e2e/travel4.spec.mjs`. Run it
against a
fresh transpile together with the targeted V2 wire tests in `test/mocha.mjs`.

The public wire contracts are
[OASIS CSDL XML 4.01](https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/os/odata-csdl-xml-v4.01-os.html)
and [OData JSON Format 4.01](https://docs.oasis-open.org/odata/odata-json-format/v4.01/os/odata-json-format-v4.01-os.html).
This is the subset above, not a claim of full protocol conformance.
