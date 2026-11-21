# HANA milestone 2: the SEGW sample's `$metadata` and a business-set read over an existing schema

Measured 2026-11-14. The service is SAP's SEGW sample service
[`/IWBEP/GWSAMPLE_BASIC`](https://help.sap.com/docs/ABAP_PLATFORM_NEW/68bf513362174d54b58cddec28794093/59283fc4528f486b83b1a58a4f1063c0.html)
(public SAP demo content; its entity sets are named below as that page names
them). Its classes were dumped from a HANA tenant that an SAP system holds,
closed over by `tools/hana-closure.mjs`, transpiled, and served by
`tools/hana-serve.mjs` straight over that tenant's schema, read-only. The
oracle is the same system's own answers to the same requests, captured with
the same data (the tenant backup the bed was restored from; the demo data
generator had not run since). The oracle and every SAP object name of the
dependency closure stay outside the repository; this page names roles.

## Recipe

Connection settings come only from an env file, loaded into the one process
that needs it. Its variable names: `HANA_HOST`, `HANA_PORT`, `HANA_DATABASE`,
`HANA_USER`, `HANA_PASSWORD`, `HANA_SCHEMA` (the tenant's schema),
`HANA_OWN_SCHEMA` (ours: the shadow views and synonyms live there).

0. The tree on the pinned transpiler: `npm ci --ignore-scripts && node
   tools/osd-bootstrap.mjs` (`node tools/osd-transpiler-pin.mjs` links the
   pin of `libs.lock.json`, oisee/transpiler `local/osd-build-4j` 28a3c53a or
   later). Nothing outside this tree is needed: the transpiler fixes the
   island depends on are in that pin.
1. The island, by iteration over the dumper (reads only):
   `OSD_HANA_DUMPER=<vsp> OSD_HANA_DUMP_ENV=<env file> OSD_HANA_CONVERTER=<converter>
   node tools/hana-closure.mjs --dump <dump> --system <SID> --max-iterations <n>
   --stub-unresolved --require-unstubbed '*_GET_ENTITYSET'`.
   It must end with `gen/hana-closure/closure-summary.json` saying
   `fixed_point: true` and `loads: true` (the generation imports, checked by
   `tools/osd-generation-check.mjs`), and no `*_GET_ENTITYSET` stubbed.
2. `npm run transpile`.
3. The host: `( set -a; . <env file>; set +a; STG_DB=hana HANA_EXISTING_SCHEMA=1
   OSD_CLIENT=001 OSD_SQL_TRACE=1 OSD_SQL_TRACE_FILE=<private path>
   node tools/hana-serve.mjs --port <port> )` -- loopback only, GET only, a
   boot that writes anything does not listen.
4. `GET /sap/opu/odata/IWBEP/GWSAMPLE_BASIC/$metadata`, then
   `node tools/odata-metadata-diff.mjs <ours> <the system's>`.
5. The reads, compared parsed with the system's answers (host and port in
   `__metadata` URIs are the only normalisation).
6. The controls: `node tools/hana-serve.mjs --check-trace <trace>` with the
   own schema (it fails a trace without its probe statement -- checked by
   cutting the probe out), and `/$count` against a direct `SELECT COUNT(*)`
   through the shadow schema.

## What was served

| request | status | rows / body | against the system |
|---|---|---|---|
| `$metadata` | 200 | 54,560 bytes | **structure 0**; annotations 140; order 2 (below) |
| service document (`$format=json`) | 200 | 306 bytes | equal |
| BusinessPartnerSet `$top=5&$orderby=BusinessPartnerID` | 200 | 5 | same keys, same order, every property equal incl. the `Address` complex property and the `/Date()/` values; `__metadata.etag` form differs |
| BusinessPartnerSet `$top=5` (default order) | 200 | 5 | as above |
| BusinessPartnerSet `$skip=2&$top=3&$orderby=...&$inlinecount=allpages` | 200 | rows 3-5, `__count` 21 | as above |
| BusinessPartnerSet `/$count` | 200 | `21` | equal |
| BusinessPartnerSet `$filter=CompanyName eq '<row 1>'` | 200 | 2 | as above |
| BusinessPartnerSet `$filter=Address/City eq '<row 1>'&$top=5` | 200 | 2 | as above |
| ProductSet `$top=5&$orderby=ProductID` (should) | 200 | 5 | same keys and order; etag form; `NameLanguage`/`DescriptionLanguage` `E` against `EN` |
| ProductSet `/$count` (should) | 200 | `205` | equal |

Answer times on the host: 20-60 ms per business-set request once warm.

Controls:
- `/$count` 21 = `SELECT COUNT(*)` of the join through the shadow schema for
  client 001 = 21; ProductSet 205 = 205.
- The client filter is **not** proven by these tables: only client 001 holds
  rows of them in this tenant (per client: 001 = 21), so a missing filter would
  give the same number. A table with two clients is the next control.
- `--check-trace`: 45 driver statements and 31 interface statements, the probe
  on both channels, 0 writes, 0 refused attempts; the same trace with the probe
  cut out fails.
- `$skip=2&$top=3` returns rows 3-5 of the ordered set: the transpiler's SELECT
  loop over a join with an INTO list (pin 4d/4e) on HANA.

## The fixes this needed

Gateway (`src/gateway`, tests in `test/unit/zcl_osd_h5x_test` over the
synthetic service `test/hana-m2`, which carries the sample's read shape -- a
join read with an INTO list into a complex component, UP TO top + skip with
`sy-dbcnt`, `COUNT( * )`, a namespace route):
- complex properties in the model info and the JSON; a `$filter` on a path
  into one; the technical order in ABAP names; `/$count` from the DPC's
  `es_response_context-count`; the inline count without the character field's
  blank; packed long timestamps by whole seconds (ANOMALY-2026-11-14-packed-21-format);
- `get_source_entity_set_name` answers nothing for a direct read: the sample's
  DPC took its navigation branch and every business-set read returned no rows
  -- the first bed read was the false green "200, `results: []`";
- an encoded option name (`%24top`) is the option
  (ANOMALY-2026-11-14-form-field-names-encoded);
- the default association set and a function import's entity set, as an
  overlay of the library's model class (ANOMALY-2026-11-14-default-association-set):
  20 AssociationSets and 4 EntitySet attributes, the whole structure difference.

The closure and the build (`tools/hana-closure*.mjs`, `tools/hana-src-gen.mjs`,
`tools/hana-ddic-gen.mjs`, `tools/osd-build.mjs`, `tools/hana-shadow-schema.mjs`,
`tools/osd-generation-check.mjs`): a structure pre-pass for a file abaplint
cannot structure; statements the transpiler refuses, learned and stubbed; a
class constructor that fails the load, learned and given the signal stub; an
exception class named `*_TEST` is island content; an excluded object leaves
the build and the closure's own validation whole; a shadow object only for a
name the tenant's catalog holds.

The transpiler fixes the island needs -- `[]` in JavaScript
(ANOMALY-2026-11-14-table-body-suffix-js), a local class of its own global
class (ANOMALY-2026-11-14-local-inherits-owner), interface constants from
other constants (ANOMALY-2026-11-14-intf-const-from-const) and the classes a
class constructor names loaded before it runs
(ANOMALY-2026-11-14-cctor-load-order) -- are in the pinned transpiler (pin
4j, #941). The bed measurement above was first made with the last of them as
a local commit; it is the pin's now, cycle-free.

## What still differs, and why

- `__metadata.etag`: ours `W/"2020-05-29T05%3a05%3a42.0000000Z"` (the V4 facade's
  tag, which the V2 path shares by design, pinned in `test/mocha.mjs`); the
  system's V2 tag is the property's URI literal,
  `W/"datetime'2020-05-29T05%3A05%3A42.0000000'"`. A decision for the V2/V4 tag
  design, not changed here.
- `$metadata` annotations (140): `sap:label` 108 (the labels come from the
  MPC's text pool, which the dump does not carry yet -- a later slice, the
  labels are not copied by hand), `sap:unit` 12 and `sap:semantics` 11 (not
  written by the library's writer), `sap:unicode="false"` 7, one
  `sap:display-format`, one `sap:supported-formats`. Order (2): associations and
  association sets in another order.
- `$metadata` normalisations the diff reports and does not hide: an absent
  `Nullable` reads as `"true"` (CSDL's default; ours writes it, the system does
  not: 62 on their side), and an absent `sap:creatable/updatable/deletable/
  sortable/filterable/pageable/unicode` reads as `"true"` (SAP's default).
- ProductSet: the language fields carry the one-letter key (`E`) where the
  system answers the ISO code (`EN`).

## Out of scope

Single-entity reads (not served by this milestone; another PR serves them), the value-help sets (search-help
runtime), the sales-order sets (a function module the tree does not have),
every write, `$batch`, Atom, and the host is not the product: it boots no ICF
registry, no cross-reference seed, no demo data.
