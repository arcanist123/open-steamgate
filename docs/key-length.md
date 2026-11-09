# A value longer than its property's MaxLength

A hand-written DPC moves a key, a function import parameter or a `$filter`
value into a field of the DDIC type behind the property, and for a CHAR field
that move cuts the value to the field's length. Before this check,
`TravelSet('T0002    X')` (10 characters, `TravelId` is CHAR 8) became
`T0002` inside the DPC: V2 GET read T0002, MERGE / PUT / DELETE wrote T0002,
and `TravelCount?Status='A'''` (the value `A'`, `Status` is CHAR 1) counted the
`A` rows. The gateway layer now refuses such a value before the DPC sees it.

## What is refused, where

| value | check | answer |
|---|---|---|
| key predicate, V2 (GET, MERGE, PUT, DELETE, `$value`, navigation source, POST through navigation, `$batch` parts) | `zcl_stg_model_info=>check_keys` after `zcl_stg_url=>parse_keys` in `zcl_stg_dispatcher` | 400 `STG/VALUE_TOO_LONG` |
| key predicate, V4 | the same `check_keys`, at the end of `zcl_osd_v4_query->read_keys` | 400 `STG/VALUE_TOO_LONG` |
| key of a bound V4 operation, V4 function parameter (URL), V4 action parameter (body) | `check_keys` / `check_length` reached through `read_keys` and `zcl_osd_v4_action` (`url_parameters`, `body_parameters`) | 400 `STG/VALUE_TOO_LONG` |
| function import parameter, V2 | `zcl_stg_model_info=>check_length` in `zcl_stg_dispatcher=>function_import` | 400 `STG/VALUE_TOO_LONG` |
| `$filter` literal, V2 and V4 | none | the DPC's code: the demo's string ranges match no row, a CHAR range would cut it |

The MaxLength is the one the MPC set (`set_maxlength`) on an `Edm.String`
property or parameter; it is kept in `zcl_stg_model_info=>ty_property-max_length`
(0 = none, nothing is checked). The length counted is the value after
unquoting, so `'O''B'` is three characters, and trailing blanks do not count:
the value is measured the way a CHAR field holds it, at its last non-blank
character, so `'T0002   '` (exactly MaxLength 8) and `'T0002    '` (one blank
beyond) are both accepted and both address T0002 — the DPC's CHAR 8 field
drops or pads trailing blanks, so they can never reach another entity. A
non-blank character beyond the MaxLength (`'T0002    X'`) is still a 400.

## Why 400 for keys and parameters, and nothing for `$filter`

The Gateway's URI parser checks a key predicate and a function import
parameter as a literal of the property's EDM type *with its facets*, and a
value that does not fit is a bad request. A `$filter` literal is a bare
`Edm.String` literal with no facets of its own; it reaches the DPC's
select-options as written, and what happens next is the DPC's code. That is
the reasoning, from the protocol; it was not measured on a system for this
change.

So `$filter` is not refused. Where the gateway itself compares (the SADL /
CDS path, `get_osql_where_clause`), the literal is compared untruncated and a
value longer than the column matches no row. The demo DPC's own ranges were
CHAR 8 and cut the literal (`TravelId eq 'T0001    X'` found T0001, and a
`Description` longer than 8 was cut as well); they are strings now. A DPC that
copies select-options into a shorter CHAR range still cuts, as it would on a
system; this is a read, never a write to another row.

## Not covered yet

- V4 operations were merged onto this check (#875 onto #889): the key of a
  bound operation goes through `check_keys` in `read_keys` and every parameter
  value through `check_length` in `zcl_osd_v4_action`, both 400. The separate
  404 #875 had added inside `read_keys` for an over-long key was redundant
  beside `check_keys` and is gone.
- A property value in a V2 write body longer than MaxLength still goes to the
  entry provider as it is (V4 bodies are checked in `zcl_osd_v4_write`).
- `/IWBEP/IF_MGW_REQ_FILTER~CONVERT_SELECT_OPTION` does not yet report
  `ev_no_matching_values_found` for a value that does not fit the target range.

Tests: `test/mocha.mjs` ("a key or a parameter longer than its MaxLength is a
400 ...", "trailing blanks never make a key or a parameter too long ...") and
`test/odata-v4.mjs` ("refuses a key longer than its MaxLength ...", "accepts
a key of MaxLength characters plus trailing blanks ...").
