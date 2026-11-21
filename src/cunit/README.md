# src/cunit -- the unit of measure conversion exit

`CONVERSION_EXIT_CUNIT_OUTPUT` and `CONVERSION_EXIT_CUNIT_INPUT`, clean room:
SAP's interface (`INPUT`, `LANGUAGE`, `OUTPUT`, `SHORT_TEXT`, `LONG_TEXT`,
exception `UNIT_NOT_FOUND`), our body in `ZCL_OSD_CUNIT`. open-abap-core has
no CUNIT (ANORMALIES `2026-11-15-cunit-missing`), so a Gateway property with
`set_conversion_exit( 'CUNIT' )` wrote its unit as stored.

- Output: the internal key (`MSEHI`) as the commercial form `MSEH3` of the
  language (`SY-LANGU` when not passed), with `MSEHT` and `MSEHL` as the
  texts.
- Input: the unit whose `MSEH3` is the input, in that language.
- The table is `T006A` on a system (`ZCL_OSD_CUNIT=>C_TEXT_TABLE`, which
  `tools/hana-closure-convexit.mjs` reads to ask the island for it);
  `ZCL_OSD_CUNIT=>TEXT_TABLE( )` names a twin's table of the same columns in
  a test. A unit without a row: `UNIT_NOT_FOUND`, and the gateway
  (`ZCL_OSD_CONV_EXIT`) keeps the value. No table at all: `ZCX_OSD_CONV_TABLE`
  (cx_no_check), which the dispatcher answers as a 500 -- never the internal
  key as if it were converted.
- Reads: inside a scope (`SCOPE_BEGIN`/`SCOPE_END`, one per gateway request)
  a language's whole table is read once and answers both directions; the
  scope's end drops it, so a customizing change is seen by the next request.
  Outside a scope each conversion reads its row.

Who calls it: the gateway's conversion exits on output (`ZCL_STG_JSON`: the
body and the entry's URI key), on input (`ZCL_STG_REQUEST_CONTEXT`: the
converted keys), and the search help provider's hit-list order
(`ZCL_OAO_SHLP_DDIC`). Tests: `test/unit/zcl_osd_h5x_test` (`ltcl_value_help`) and
`test/unit/zcl_osd_cunit_test` (`ltcl_cunit`).
