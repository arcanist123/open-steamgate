CLASS ltcl_status DEFINITION FOR TESTING RISK LEVEL DANGEROUS DURATION SHORT FINAL.

  PRIVATE SECTION.
    METHODS setup.
    METHODS round_trip FOR TESTING RAISING cx_static_check.
    METHODS database_round_trip FOR TESTING RAISING cx_static_check.
    METHODS second_refresh_replaces FOR TESTING RAISING cx_static_check.
    METHODS malformed_json_keeps_rows FOR TESTING RAISING cx_static_check.
    METHODS amdp_round_trip FOR TESTING RAISING cx_static_check.

    METHODS snapshot_json
      IMPORTING
        iv_sid         TYPE string
        iv_pid         TYPE string
      RETURNING
        VALUE(rv_json) TYPE string.

    METHODS count_rows
      RETURNING
        VALUE(rv_rows) TYPE i.

ENDCLASS.


CLASS ltcl_status IMPLEMENTATION.

  METHOD setup.
    DELETE FROM zosd_sys WHERE sid <> ''.
    DELETE FROM zosd_proc WHERE pid >= 0.
    DELETE FROM zosd_port WHERE port >= 0.
    DELETE FROM zosd_svc WHERE path <> ''.
    DELETE FROM zosd_pack WHERE name <> ''.
    DELETE FROM zosd_db WHERE name <> ''.
    DELETE FROM zosd_amdp WHERE class_name <> ''.
  ENDMETHOD.

  METHOD amdp_round_trip.
    DATA lv_json TYPE string.
    DATA lv_rows TYPE i.
    DATA ls_amdp TYPE zosd_amdp.
    DATA lv_count TYPE i.

* the contract of tools/amdp-status.mjs: a DuckDB system, one method in the
* portable subset and one the compiler refused
    lv_json = '{"system":{"sid":"OSG"},"amdp":{"db":"duckdb","driver":true,"configured":false,' &&
      '"session":"none","methods":[' &&
      '{"clsname":"ZCL_OSD_AMDP_DEMO","mtdname":"SQUARES","kind":"procedure","portable":true,"refusal":""},' &&
      '{"clsname":"ZCL_OSD_AMDP_DEMO","mtdname":"ODD_ONE","kind":"function","portable":false,' &&
      '"refusal":"TO_NCLOB has no measured portable rendering"}]}}'.
    lv_rows = zcl_osd_status=>refresh( lv_json ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows exp = 3 ).
    SELECT COUNT(*) FROM zosd_amdp INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 2 ).

    SELECT SINGLE * FROM zosd_amdp INTO ls_amdp WHERE method_name = 'SQUARES'.
    cl_abap_unit_assert=>assert_subrc( ).
    cl_abap_unit_assert=>assert_equals( act = ls_amdp-class_name exp = 'ZCL_OSD_AMDP_DEMO' ).
    cl_abap_unit_assert=>assert_equals( act = ls_amdp-kind exp = 'procedure' ).
    cl_abap_unit_assert=>assert_equals( act = ls_amdp-portable exp = 'X' ).
    cl_abap_unit_assert=>assert_equals( act = ls_amdp-engine exp = 'portable-duckdb' ).

    SELECT SINGLE * FROM zosd_amdp INTO ls_amdp WHERE method_name = 'ODD_ONE'.
    cl_abap_unit_assert=>assert_subrc( ).
    cl_abap_unit_assert=>assert_equals( act = ls_amdp-engine exp = 'unavailable' ).
    cl_abap_unit_assert=>assert_char_cp( act = ls_amdp-reason exp = '*TO_NCLOB*' ).
    cl_abap_unit_assert=>assert_char_cp( act = ls_amdp-refusal exp = 'TO_NCLOB*' ).

    lv_json = zcl_osd_status=>snapshot( ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
      exp = '*"amdp":*"methods":[*"mtdname":"ODD_ONE"*"engine":"unavailable"*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
      exp = '*"mtdname":"SQUARES"*"portable":true*"engine":"portable-duckdb"*' ).

* facts marked unknown (a work process that did not answer) are not facts:
* the rows of the last snapshot that had them stay as they were
    lv_rows = zcl_osd_status=>refresh( '{"system":{"sid":"OSG"},"amdp":{"unknown":true,"db":"unknown",' &&
      '"driver":false,"configured":false,"session":"none","methods":[]}}' ).
    SELECT COUNT(*) FROM zosd_amdp INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 2 ).

* a snapshot without the AMDP facts replaces the rows with none: a method
* that is gone from the tree must not linger with a stale engine
    zcl_osd_status=>refresh( snapshot_json( iv_sid = 'OSG' iv_pid = '4711' ) ).
    SELECT COUNT(*) FROM zosd_amdp INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
  ENDMETHOD.

  METHOD snapshot_json.
* the contract of tools/osd-status.mjs, written out by hand so that a
* change to either side shows up here
    rv_json =
      '{"system":{"sid":"' && iv_sid && '","host_kind":"node","gen_live":"abc123",' &&
      '"gen_serving":"abc123","synced":true,"workers":2,' &&
      '"started_at":"2026-09-17T09:00:00.000Z","snap_at":"2026-09-17T09:00:01.000Z",' &&
      '"root_hint":"open-steamgate"},' &&
      '"processes":[{"pid":' && iv_pid && ',"role":"work","port":38813,"generation":"abc123",' &&
      '"epoch":1,"since":"2026-09-17T09:00:00.000Z","sockets":0,"rss_mb":180,"alive":true}],' &&
      '"ports":[{"port":3030,"protocol":"HTTP","purpose":"OData, apps, ADT",' &&
      '"state":"listening","note":""},' &&
      '{"port":3300,"protocol":"RFC","purpose":"RFC gateway","state":"absent",' &&
      '"note":"open-rfc-go would serve this"}],' &&
      '"services":[{"path":"/sap/opu/odata/sap/ZSTG_DEMO_SRV","kind":"ODATA",' &&
      '"handler":"ZCL_ZSTG_DEMO_DPC_EXT","pack":""}],' &&
      '"packs":[{"name":"o4d","order":40,"objects":172,"folders":"upstream, src",' &&
      '"description":"the o4d demo"}]}'.
  ENDMETHOD.

  METHOD count_rows.
    DATA lv_count TYPE i.

    SELECT COUNT(*) FROM zosd_sys INTO lv_count.
    rv_rows = lv_count.
    SELECT COUNT(*) FROM zosd_proc INTO lv_count.
    rv_rows = rv_rows + lv_count.
    SELECT COUNT(*) FROM zosd_port INTO lv_count.
    rv_rows = rv_rows + lv_count.
    SELECT COUNT(*) FROM zosd_svc INTO lv_count.
    rv_rows = rv_rows + lv_count.
    SELECT COUNT(*) FROM zosd_pack INTO lv_count.
    rv_rows = rv_rows + lv_count.
    SELECT COUNT(*) FROM zosd_db INTO lv_count.
    rv_rows = rv_rows + lv_count.
    SELECT COUNT(*) FROM zosd_amdp INTO lv_count.
    rv_rows = rv_rows + lv_count.
  ENDMETHOD.

  METHOD round_trip.
    DATA lv_rows TYPE i.
    DATA lv_json TYPE string.

    lv_rows = zcl_osd_status=>refresh( snapshot_json( iv_sid = 'OSG'
                                                      iv_pid = '4711' ) ).
* one system, one process, two ports, one service, one pack
    cl_abap_unit_assert=>assert_equals( act = lv_rows
                                        exp = 6 ).
    cl_abap_unit_assert=>assert_equals( act = count_rows( )
                                        exp = 6 ).

    lv_json = zcl_osd_status=>snapshot( ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"sid":"OSG"*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"host_kind":"node"*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"synced":true*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"pid":4711*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"rss_mb":180*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"root_hint":"open-steamgate"*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"order":40*' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
                                         exp = '*"state":"absent"*' ).
  ENDMETHOD.

  METHOD database_round_trip.
    DATA lv_json TYPE string.
    DATA lv_rows TYPE i.
    DATA ls_db TYPE zosd_db.
    lv_json = '{"system":{"sid":"OSG"},"database":[' &&
      '{"section":"Database","name":"Engine","value":"duckdb","note":"connected backend"}]}'.
    lv_rows = zcl_osd_status=>refresh( lv_json ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows exp = 2 ).
    cl_abap_unit_assert=>assert_equals( act = count_rows( ) exp = 2 ).
    SELECT SINGLE * FROM zosd_db INTO ls_db.
    cl_abap_unit_assert=>assert_equals( act = ls_db-category exp = 'Database' ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-name exp = 'Engine' ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-value exp = 'duckdb' ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-note exp = 'connected backend' ).
    lv_json = zcl_osd_status=>snapshot( ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json
      exp = '*"database":[*"value":"duckdb"*"note":"connected backend"*' ).
    zcl_osd_status=>refresh( snapshot_json( iv_sid = 'OSG' iv_pid = '4711' ) ).
    lv_json = zcl_osd_status=>snapshot( ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_json exp = '*"database":[]*' ).
  ENDMETHOD.

  METHOD second_refresh_replaces.
    DATA lv_rows TYPE i.
    DATA lv_sid  TYPE zosd_sys-sid.
    DATA lv_pid  TYPE zosd_proc-pid.

    zcl_osd_status=>refresh( snapshot_json( iv_sid = 'OSG'
                                            iv_pid = '4711' ) ).
    lv_rows = zcl_osd_status=>refresh( snapshot_json( iv_sid = 'TWO'
                                                      iv_pid = '4712' ) ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows
                                        exp = 6 ).
* the second snapshot replaced the first: no duplicates, no leftovers
    cl_abap_unit_assert=>assert_equals( act = count_rows( )
                                        exp = 6 ).

    SELECT SINGLE sid FROM zosd_sys INTO lv_sid.
    cl_abap_unit_assert=>assert_equals( act = lv_sid
                                        exp = 'TWO' ).
    SELECT SINGLE pid FROM zosd_proc INTO lv_pid.
    cl_abap_unit_assert=>assert_equals( act = lv_pid
                                        exp = 4712 ).
  ENDMETHOD.

  METHOD malformed_json_keeps_rows.
    DATA lv_rows TYPE i.
    DATA lv_sid  TYPE zosd_sys-sid.

    zcl_osd_status=>refresh( snapshot_json( iv_sid = 'OSG'
                                            iv_pid = '4711' ) ).

    lv_rows = zcl_osd_status=>refresh( 'not json at all' ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows
                                        exp = 0 ).
    lv_rows = zcl_osd_status=>refresh( '' ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows
                                        exp = 0 ).
    lv_rows = zcl_osd_status=>refresh( '{"system":{"host_kind":"node"}}' ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows
                                        exp = 0 ).
* looks like an object and is cut in half: the parser, not the guard
    lv_rows = zcl_osd_status=>refresh( '{"system":{"sid":"OSG",' ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows
                                        exp = 0 ).

* what was there is still there
    cl_abap_unit_assert=>assert_equals( act = count_rows( )
                                        exp = 6 ).
    SELECT SINGLE sid FROM zosd_sys INTO lv_sid.
    cl_abap_unit_assert=>assert_equals( act = lv_sid
                                        exp = 'OSG' ).
  ENDMETHOD.

ENDCLASS.


CLASS ltcl_engine DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.
* ZCL_OSD_STATUS=>ENGINE on its own: the facts of one moment in, the label
* a person sees out. No table is touched, so every row of the truth table
* can be written down here and read against tools/amdp-destination.mjs.
  PRIVATE SECTION.
    METHODS duckdb_portable FOR TESTING RAISING cx_static_check.
    METHODS duckdb_refused_no_fallback FOR TESTING RAISING cx_static_check.
    METHODS duckdb_refused_at_call FOR TESTING RAISING cx_static_check.
    METHODS sqlite_no_hana FOR TESTING RAISING cx_static_check.
    METHODS no_driver FOR TESTING RAISING cx_static_check.
    METHODS hana_live FOR TESTING RAISING cx_static_check.
    METHODS hana_stale FOR TESTING RAISING cx_static_check.
    METHODS hana_idle FOR TESTING RAISING cx_static_check.
    METHODS hdb_system_still_destination FOR TESTING RAISING cx_static_check.

    METHODS classify
      IMPORTING
        iv_db            TYPE string
        iv_driver        TYPE abap_bool
        iv_configured    TYPE abap_bool
        iv_session       TYPE string
        iv_portable      TYPE abap_bool
        iv_refusal       TYPE string DEFAULT ''
        iv_engine        TYPE string
        iv_reason_cp     TYPE string.
ENDCLASS.


CLASS ltcl_engine IMPLEMENTATION.

  METHOD classify.
    DATA lv_engine TYPE string.
    DATA lv_reason TYPE string.

    zcl_osd_status=>engine( EXPORTING iv_db         = iv_db
                                      iv_driver     = iv_driver
                                      iv_configured = iv_configured
                                      iv_session    = iv_session
                                      iv_portable   = iv_portable
                                      iv_refusal    = iv_refusal
                            IMPORTING ev_engine     = lv_engine
                                      ev_reason     = lv_reason ).
    cl_abap_unit_assert=>assert_equals( act = lv_engine exp = iv_engine ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_reason exp = iv_reason_cp ).
  ENDMETHOD.

  METHOD duckdb_portable.
*   a DuckDB system never dials HANA for a method in the subset, whatever
*   the destination's session says
    classify( iv_db = 'duckdb' iv_driver = abap_true iv_configured = abap_true iv_session = 'connected'
              iv_portable = abap_true iv_engine = 'portable-duckdb' iv_reason_cp = 'pAMDP:*DuckDB*' ).
    classify( iv_db = 'duckdb' iv_driver = abap_false iv_configured = abap_false iv_session = 'none'
              iv_portable = abap_true iv_engine = 'portable-duckdb' iv_reason_cp = 'pAMDP:*' ).
  ENDMETHOD.

  METHOD duckdb_refused_no_fallback.
*   and a method outside the subset is refused there, even with a live HANA
    classify( iv_db = 'duckdb' iv_driver = abap_true iv_configured = abap_true iv_session = 'connected'
              iv_portable = abap_false iv_refusal = 'FLOOR has no measured portable rendering'
              iv_engine = 'unavailable' iv_reason_cp = '*no HANA fallback*FLOOR*' ).
  ENDMETHOD.

  METHOD duckdb_refused_at_call.
*   compiled into the IR, but DuckDB's lowering refuses a construct of it
*   (tools/amdp-gen.mjs writes the refusal down beside the IR): the call
*   refuses, so the label must not say portable-duckdb
    classify( iv_db = 'duckdb' iv_driver = abap_true iv_configured = abap_false iv_session = 'none'
              iv_portable = abap_true iv_refusal = 'the function FLOOR has no measured rendering on duckdb'
              iv_engine = 'portable-refused' iv_reason_cp = 'pAMDP:*refuses*call*FLOOR*' ).
*   on SQLite the call goes to HANA anyway; the note says what DuckDB would do
    classify( iv_db = 'sqlite' iv_driver = abap_true iv_configured = abap_true iv_session = 'connected'
              iv_portable = abap_true iv_refusal = 'the function FLOOR has no measured rendering on duckdb'
              iv_engine = 'hdb' iv_reason_cp = 'eAMDP:*DuckDB would refuse*FLOOR*' ).
*   a refusal without text still reads as a sentence
    classify( iv_db = 'duckdb' iv_driver = abap_true iv_configured = abap_false iv_session = 'none'
              iv_portable = abap_false iv_engine = 'unavailable' iv_reason_cp = '*no HANA fallback' ).
  ENDMETHOD.

  METHOD sqlite_no_hana.
*   the common case: SQLite, nothing configured; the portable flag is said
*   but not used, because the destination runs the IR on DuckDB only
    classify( iv_db = 'sqlite' iv_driver = abap_true iv_configured = abap_false iv_session = 'none'
              iv_portable = abap_true iv_engine = 'unavailable' iv_reason_cp = 'no HANA configured*portable subset: yes*DuckDB*' ).
    classify( iv_db = 'sqlite' iv_driver = abap_true iv_configured = abap_false iv_session = 'none'
              iv_portable = abap_false iv_engine = 'unavailable' iv_reason_cp = 'no HANA configured*' ).
  ENDMETHOD.

  METHOD no_driver.
    classify( iv_db = 'sqlite' iv_driver = abap_false iv_configured = abap_false iv_session = 'none'
              iv_portable = abap_true iv_engine = 'unavailable' iv_reason_cp = '*no HANA driver*' ).
  ENDMETHOD.

  METHOD hana_live.
    classify( iv_db = 'sqlite' iv_driver = abap_true iv_configured = abap_true iv_session = 'connected'
              iv_portable = abap_false iv_engine = 'hdb' iv_reason_cp = 'eAMDP:*live*' ).
  ENDMETHOD.

  METHOD hana_stale.
*   the backlog's lie: the system said HDB while this session was dead
    classify( iv_db = 'sqlite' iv_driver = abap_true iv_configured = abap_true iv_session = 'closed'
              iv_portable = abap_false iv_engine = 'hdb-stale' iv_reason_cp = 'eAMDP:*closed*reconnects*' ).
  ENDMETHOD.

  METHOD hana_idle.
    classify( iv_db = 'postgres' iv_driver = abap_true iv_configured = abap_true iv_session = 'none'
              iv_portable = abap_false iv_engine = 'hdb-idle' iv_reason_cp = 'eAMDP:*no session*' ).
  ENDMETHOD.

  METHOD hdb_system_still_destination.
*   a HANA system database does not make the method run: the destination
*   keeps its own session, and that one is what counts
    classify( iv_db = 'HDB' iv_driver = abap_true iv_configured = abap_false iv_session = 'none'
              iv_portable = abap_false iv_engine = 'unavailable' iv_reason_cp = 'no HANA configured*' ).
    classify( iv_db = 'HDB' iv_driver = abap_true iv_configured = abap_true iv_session = 'closed'
              iv_portable = abap_false iv_engine = 'hdb-stale' iv_reason_cp = 'eAMDP:*' ).
  ENDMETHOD.

ENDCLASS.
