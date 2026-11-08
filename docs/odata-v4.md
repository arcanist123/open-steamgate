# OData V4 reads over the existing model

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

Only GET is supported. Responses carry `OData-Version: 4.0`. JSON uses
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

Errors use `{"error":{"code":"...","message":"..."}}`: malformed options
and keys return 400; unknown services, sets and missing entities return 404;
writes return 405 with `Allow: GET`; unsupported operations/options return
501. The V4 handler catches provider exceptions using the existing error
conventions (business failures 400, missing implementation 501, technical
failures 500).

## Not served in this slice

- Writes, deep insert and update semantics.
- ETag / `If-Match`, `$batch`, actions and functions.
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
query support (nested options, navigation resources and count pushdown).
Treat writes with ETags and transaction semantics as a separate slice,
followed by batch/actions and a Fiori V4 consumer.

## Verification and references

The registered Mocha suite is `test/odata-v4.mjs`. It parses metadata as XML
and exercises demo reads, SADL reads, a YAML service, literals/facets,
projection, counts, ordering/paging, expansion and errors. Run it against a
fresh transpile together with the targeted V2 wire tests in `test/mocha.mjs`.

The public wire contracts are
[OASIS CSDL XML 4.01](https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/os/odata-csdl-xml-v4.01-os.html)
and [OData JSON Format 4.01](https://docs.oasis-open.org/odata/odata-json-format/v4.01/os/odata-json-format-v4.01-os.html).
This is the read subset above, not a claim of full protocol conformance.
