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

Reads (GET), entity writes, ETags and JSON `$batch`. Responses carry
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

CSDL includes entity keys, nullable properties, string/binary maximum
lengths, decimal precision and scale, navigation cardinality, known reverse
partners, the entity container and navigation bindings. DATS-backed V2
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
outer entity; expanded entities contain their structural properties.

Keys and filters accept V4 literals such as `Day=2026-11-07`,
`Guid=12345678-1234-1234-1234-123456789abc`, and
`Moment eq 2026-11-07T12:30:45Z`. Timestamp filter offsets are converted to
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

Request bodies are V4 JSON: `Edm.Date` as `2026-11-07`, `Edm.DateTimeOffset`
with `Z` or an offset (stored as UTC), `Edm.TimeOfDay` as `12:30:45`,
hyphenated GUIDs, JSON numbers and booleans. Control information and
instance annotations (`@odata.type`, `Name@...`) are ignored. An unknown
property or a value that does not fit its type is 400 before the DPC is
called. The key of a PATCH or PUT is the one in the URL; a key property in
the body cannot move the update to another entity. A missing entity is 404.
Nested objects or arrays (deep insert, complex values) and `@odata.bind`
answer 501. A write to a collection other than POST answers 405 with
`Allow: GET, POST`; POST to an entity, `Allow: GET, PATCH, PUT, DELETE`.

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
matches and answers 412; `*` passes. The current ETag is read through the
DPC's `get_entity` right before the write; the check and the write are not
one locked step (no enqueue), as on a Gateway without a lock in the DPC.
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
  entity request `<id>` created (`$new`, `$new?$select=...`).
- An `atomicityGroup` is one LUW: a `COMMIT WORK` fences it, the first
  failing member rolls the whole group back, and the group commits only when
  every member succeeded. Of a failed group, the failing request carries its
  own error, members that ran before it answer 424 ("rolled back"), members
  after it are not executed and answer 424. Requests of one group must be
  adjacent (400 otherwise). A request outside any group is its own LUW.
- `dependsOn` names earlier request ids or ended groups (a forward or
  unknown name is 400 for the whole batch). If one of them failed, the
  request is not executed and answers 424.
- Without `Prefer: odata.continue-on-error` processing stops after the
  first failed request (or after the group it belongs to); with it every
  request is answered and `Preference-Applied` says so.
- Duplicate ids, requests without id/method/url, or a nested `$batch` are 400.
- A multipart `$batch` (`multipart/mixed`) answers **501**; another
  content type, 415.

Requests are executed in array order; the service does not reorder or run
independent requests in parallel.

## Not served in this slice

- Deep insert, `@odata.bind`, writes through navigation properties,
  bound/unbound actions and functions.
- Multipart `$batch`, `If-None-Match`, conditional GET, SADL ETags.
- Binary property values in request bodies (base64url is not decoded).
- Nested `$expand`, slash expand paths, and options inside `$expand(...)`.
  These explicitly return 501. Multiple single-level navigation names work.
- `$apply`, `$search`, lambda expressions or a general expression evaluator.
- Navigation resource URLs, structural-property URLs and media streams.
- Complex types, vocabulary annotations, inheritance and containment.
- Metadata-level negotiation, JSON CSDL, IEEE754Compatible, next links and
  other server-driven paging features.
- Fiori Elements V4 applications and the V4 provider API.

## Next slices

Add model-driven capabilities/annotations and complex types, then expand
query support (nested options, navigation resources and count pushdown),
then actions/functions, deep insert and a Fiori V4 consumer.

## Verification and references

The registered Mocha suite is `test/odata-v4.mjs`. It parses metadata as XML
and exercises demo reads, SADL reads, a YAML service, literals/facets,
projection, counts, ordering/paging, expansion and errors, and the writes,
ETags (a writable `NoteSet` with `set_as_etag` in the synthetic `test/v4/`
service) and JSON batches (two atomicity groups, one rolled back while the
other commits, `dependsOn` and `$<id>`). Run it against a
fresh transpile together with the targeted V2 wire tests in `test/mocha.mjs`.

The public wire contracts are
[OASIS CSDL XML 4.01](https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/os/odata-csdl-xml-v4.01-os.html)
and [OData JSON Format 4.01](https://docs.oasis-open.org/odata/odata-json-format/v4.01/os/odata-json-format-v4.01-os.html).
This is the subset above, not a claim of full protocol conformance.
