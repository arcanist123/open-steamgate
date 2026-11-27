CLASS ltcl_shared_memory DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS setup.
    METHODS no_cluster_is_subrc_4 FOR TESTING.
    METHODS round_trip_between_methods FOR TESTING.
    METHODS later_export_replaces FOR TESTING.
    METHODS value_is_a_copy FOR TESTING.
    METHODS memory_and_buffer_differ FOR TESTING.
ENDCLASS.

CLASS ltcl_shared_memory IMPLEMENTATION.

  METHOD setup.
    zcl_osd_shared_memory_test=>reset( ).
  ENDMETHOD.

  METHOD no_cluster_is_subrc_4.
    DATA lv_value TYPE i VALUE 7.
    IMPORT value = lv_value FROM SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_NOTHING'.
    cl_abap_unit_assert=>assert_equals( act = sy-subrc exp = 4 ).
    cl_abap_unit_assert=>assert_equals( act = lv_value exp = 7 ).
  ENDMETHOD.

  METHOD round_trip_between_methods.
    DATA lt_sessions TYPE zcl_osd_shared_memory_test=>ty_sessions.
    DATA ls_session TYPE zcl_osd_shared_memory_test=>ty_session.
    zcl_osd_shared_memory_test=>register( 'B' ).
    zcl_osd_shared_memory_test=>register( 'A' ).
    zcl_osd_shared_memory_test=>register( 'C' ).
    zcl_osd_shared_memory_test=>unregister( 'C' ).
    lt_sessions = zcl_osd_shared_memory_test=>sessions( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_sessions ) exp = 2 ).
    READ TABLE lt_sessions INDEX 1 INTO ls_session.
    cl_abap_unit_assert=>assert_equals( act = ls_session-session_id exp = 'A' ).
    cl_abap_unit_assert=>assert_differs( act = ls_session-started_at exp = 0 ).
  ENDMETHOD.

  METHOD later_export_replaces.
    DATA a TYPE i VALUE 1.
    DATA b TYPE i VALUE 2.
    DATA x TYPE i VALUE 5.
    EXPORT a = a b = b TO SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_REPLACE'.
    EXPORT a = b TO SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_REPLACE'.
    IMPORT a = a b = x FROM SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_REPLACE'.
    cl_abap_unit_assert=>assert_equals( act = sy-subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = a exp = 2 ).
    cl_abap_unit_assert=>assert_equals( act = x exp = 5 ).
  ENDMETHOD.

  METHOD value_is_a_copy.
    DATA lv_text TYPE string.
    DATA lv_read TYPE string.
    lv_text = `before`.
    EXPORT text = lv_text TO SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_COPY'.
    lv_text = `after`.
    IMPORT text = lv_read FROM SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_COPY'.
    cl_abap_unit_assert=>assert_equals( act = lv_read exp = `before` ).
    lv_read = `changed`.
    IMPORT text = lv_read FROM SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_COPY'.
    cl_abap_unit_assert=>assert_equals( act = lv_read exp = `before` ).
  ENDMETHOD.

  METHOD memory_and_buffer_differ.
    DATA a TYPE i VALUE 1.
    DATA b TYPE i VALUE 9.
    EXPORT a = a TO SHARED BUFFER indx(zt) ID 'ZOSD_SHM_TEST_MEDIUM'.
    IMPORT a = b FROM SHARED MEMORY indx(zt) ID 'ZOSD_SHM_TEST_MEDIUM'.
    cl_abap_unit_assert=>assert_equals( act = sy-subrc exp = 4 ).
    cl_abap_unit_assert=>assert_equals( act = b exp = 9 ).
    IMPORT a = b FROM SHARED BUFFER indx(zt) ID 'ZOSD_SHM_TEST_MEDIUM'.
    cl_abap_unit_assert=>assert_equals( act = sy-subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = b exp = 1 ).
  ENDMETHOD.

ENDCLASS.
