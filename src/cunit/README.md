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
- The table is `T006A` on a system; `ZCL_OSD_CUNIT=>TEXT_TABLE( )` names a
  twin's table of the same columns in a test. No table, or no row: the
  exception, and the callers in the gateway (`ZCL_OSD_CONV_EXIT`) keep the
  value as it is.

Who calls it: the gateway's conversion exits on output (`ZCL_STG_JSON`: the
body and the entry's URI key), on input (`ZCL_STG_REQUEST_CONTEXT`: the
converted keys), and the search help provider's hit-list order
(`ZCL_OAO_SHLP_DDIC`). Tests: `test/unit/zcl_osd_h5x_test` (`ltcl_value_help`) and
`test/unit/zcl_osd_cunit_test` (`ltcl_cunit`).
