CLASS ltcl_guard DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* $filter -> Open SQL condition: what a request must not be able to do.
* The first twelve cases come from the security review of #951 (findings
* 1, 2, 4 and what held); the rest from its critic (S2, S3) and finding 5.
  PRIVATE SECTION.
    CONSTANTS c_base TYPE string VALUE '/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/PartnerSet'.

    METHODS setup.
    METHODS or_group_is_not_folded_to_bt FOR TESTING RAISING cx_static_check.
    METHODS or_group_not_folded_mirror FOR TESTING RAISING cx_static_check.
    METHODS or_group_has_no_select_options FOR TESTING RAISING cx_static_check.
    METHODS bt_pair_still_folds FOR TESTING RAISING cx_static_check.
    METHODS folded_operator_is_checked FOR TESTING RAISING cx_static_check.
    METHODS case_folding_is_not_dropped FOR TESTING RAISING cx_static_check.
    METHODS folded_has_no_select_options FOR TESTING RAISING cx_static_check.
    METHODS long_filter_refused FOR TESTING RAISING cx_static_check.
    METHODS deep_filter_refused FOR TESTING RAISING cx_static_check.
    METHODS quote_stays_a_value FOR TESTING RAISING cx_static_check.
    METHODS wildcards_stay_values FOR TESTING RAISING cx_static_check.
    METHODS navigation_key_stays_and_ed FOR TESTING RAISING cx_static_check.
    METHODS unterminated_literal_refused FOR TESTING RAISING cx_static_check.
    METHODS wildcard_text_matches_itself FOR TESTING RAISING cx_static_check.
    METHODS complex_property_refused FOR TESTING RAISING cx_static_check.
    METHODS literal_is_not_a_field FOR TESTING RAISING cx_static_check.
    METHODS add_partner
      IMPORTING
        iv_id   TYPE clike
        iv_name TYPE clike.

    METHODS get
      IMPORTING
        iv_path            TYPE string
        iv_filter          TYPE string
      RETURNING
        VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    METHODS partner_set
      RETURNING
        VALUE(rs_set) TYPE zcl_stg_model_info=>ty_entity_set
      RAISING
        zcx_stg_error.
    METHODS has
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
    METHODS lacks
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
ENDCLASS.

CLASS ltcl_guard IMPLEMENTATION.

  METHOD setup.
    DATA lt_bp TYPE STANDARD TABLE OF zosd_h5x_bp WITH DEFAULT KEY.
    DATA ls_bp TYPE zosd_h5x_bp.
    DATA lt_ad TYPE STANDARD TABLE OF zosd_h5x_ad WITH DEFAULT KEY.
    DATA ls_ad TYPE zosd_h5x_ad.
    DATA lt_so TYPE STANDARD TABLE OF zosd_h5x_so WITH DEFAULT KEY.
    DATA ls_so TYPE zosd_h5x_so.
    DATA lt_soi TYPE STANDARD TABLE OF zosd_h5x_soi WITH DEFAULT KEY.
    DATA ls_soi TYPE zosd_h5x_soi.
    DATA lt_ct TYPE STANDARD TABLE OF zosd_h5x_ct WITH DEFAULT KEY.
    DATA ls_ct TYPE zosd_h5x_ct.
    DATA lt_sot TYPE STANDARD TABLE OF zosd_h5x_sot WITH DEFAULT KEY.
    DATA ls_sot TYPE zosd_h5x_sot.

    DELETE FROM zosd_h5x_bp.
    DELETE FROM zosd_h5x_ad.
    DELETE FROM zosd_h5x_so.
    DELETE FROM zosd_h5x_soi.
    DELETE FROM zosd_h5x_ct.
    DELETE FROM zosd_h5x_sot.

* an order's note in two languages: the session language picks one
    ls_sot-client = sy-mandt.
    ls_sot-order_id = 'S1'.
    ls_sot-spras = 'E'.
    ls_sot-note = 'Order one'.
    APPEND ls_sot TO lt_sot.
    ls_sot-spras = 'D'.
    ls_sot-note = 'Auftrag eins'.
    APPEND ls_sot TO lt_sot.
    INSERT zosd_h5x_sot FROM TABLE lt_sot.

* orders name their partner as BUYER_ID: a source key converted against
* the target finds no field of that name (M3-B0, RC2)
    ls_so-client = sy-mandt.
    ls_so-order_id = 'S1'.
    ls_so-buyer_id = '0000000001'.
    APPEND ls_so TO lt_so.
    ls_so-order_id = 'S2'.
    ls_so-buyer_id = '0000000001'.
    APPEND ls_so TO lt_so.
    ls_so-order_id = 'S3'.
    ls_so-buyer_id = '0000000002'.
    APPEND ls_so TO lt_so.
    INSERT zosd_h5x_so FROM TABLE lt_so.

* items out of key order: the default order (two columns) sorts them
    ls_soi-client = sy-mandt.
    ls_soi-order_id = 'S2'.
    ls_soi-item_pos = '0000000010'.
    ls_soi-note = 'two-ten'.
    APPEND ls_soi TO lt_soi.
    ls_soi-order_id = 'S1'.
    ls_soi-item_pos = '0000000020'.
    ls_soi-note = 'one-twenty'.
    APPEND ls_soi TO lt_soi.
    ls_soi-order_id = 'S3'.
    ls_soi-item_pos = '0000000010'.
    ls_soi-note = 'three-ten'.
    APPEND ls_soi TO lt_soi.
    ls_soi-order_id = 'S1'.
    ls_soi-item_pos = '0000000030'.
    ls_soi-note = 'one-thirty'.
    APPEND ls_soi TO lt_soi.
    ls_soi-order_id = 'S1'.
    ls_soi-item_pos = '0000000010'.
    ls_soi-note = 'one-ten'.
    APPEND ls_soi TO lt_soi.
    INSERT zosd_h5x_soi FROM TABLE lt_soi.

    ls_ct-client = sy-mandt.
    ls_ct-contact_guid = 'C0FFEE000000400080000000000000A1'.
    ls_ct-partner_id = '0000000002'.
    ls_ct-name = 'Carol'.
    APPEND ls_ct TO lt_ct.
    ls_ct-contact_guid = 'C0FFEE000000400080000000000000A2'.
    ls_ct-partner_id = '0000000001'.
    ls_ct-name = 'Dave'.
    APPEND ls_ct TO lt_ct.
    INSERT zosd_h5x_ct FROM TABLE lt_ct.

    ls_bp-client = sy-mandt.
    ls_bp-partner_id = '0000000003'.
    ls_bp-name = 'Gamma Ltd'.
    ls_bp-addr_key = 'A3'.
    ls_bp-changed_at = '20210102030405.0000000'.
    APPEND ls_bp TO lt_bp.
    ls_bp-partner_id = '0000000001'.
    ls_bp-name = 'Alpha Ltd'.
    ls_bp-addr_key = 'A1'.
    APPEND ls_bp TO lt_bp.
    ls_bp-partner_id = '0000000004'.
    ls_bp-name = 'Delta Ltd'.
    ls_bp-addr_key = 'A4'.
    APPEND ls_bp TO lt_bp.
    ls_bp-partner_id = '0000000002'.
    ls_bp-name = 'Beta Ltd'.
    ls_bp-addr_key = 'A2'.
    APPEND ls_bp TO lt_bp.
* no address row: an inner join does not return it, a count must not count it
    ls_bp-partner_id = '0000000000'.
    ls_bp-name = 'Nowhere Ltd'.
    ls_bp-addr_key = 'A9'.
    APPEND ls_bp TO lt_bp.
    INSERT zosd_h5x_bp FROM TABLE lt_bp.

    ls_ad-client = sy-mandt.
    ls_ad-node_key = 'A1'.
    ls_ad-city = 'Alpha City'.
    ls_ad-country = 'AA'.
    APPEND ls_ad TO lt_ad.
    ls_ad-node_key = 'A2'.
    ls_ad-city = 'Beta City'.
    ls_ad-country = 'BB'.
    APPEND ls_ad TO lt_ad.
    ls_ad-node_key = 'A3'.
    ls_ad-city = 'Gamma City'.
    ls_ad-country = 'CC'.
    APPEND ls_ad TO lt_ad.
    ls_ad-node_key = 'A4'.
    ls_ad-city = 'Delta City'.
    ls_ad-country = 'DD'.
    APPEND ls_ad TO lt_ad.
    INSERT zosd_h5x_ad FROM TABLE lt_ad.

    zcl_oao_registry=>register( iv_service = 'ZOSD_H5X_SRV'
                                iv_mpc     = 'ZCL_OSD_H5X_MPC'
                                iv_dpc     = 'ZCL_OSD_H5X_DPC' ).
    zcl_stg_model_info=>clear( ).
  ENDMETHOD.

  METHOD get.
* the filter as one decoded option value, the way the dispatcher gets it
    DATA lt_options TYPE tihttpnvp.
    DATA ls_option  TYPE ihttpnvp.

    ls_option-name  = '$filter'.
    ls_option-value = iv_filter.
    APPEND ls_option TO lt_options.
    rs_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = iv_path
                                                it_options = lt_options ).
  ENDMETHOD.

  METHOD partner_set.
    rs_set = zcl_stg_model_info=>find_set( is_service    = zcl_stg_model_info=>get( 'ZOSD_H5X_SRV' )
                                           iv_entity_set = 'PartnerSet' ).
  ENDMETHOD.

  METHOD has.
    cl_abap_unit_assert=>assert_true( act = boolc( iv_body CS iv_text )
                                      msg = |expected { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD lacks.
    cl_abap_unit_assert=>assert_false( act = boolc( iv_body CS iv_text )
                                       msg = |did not expect { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD or_group_is_not_folded_to_bt.
* ( id <= 3 OR id = 1 ) AND id >= 2 is partners 2 and 3. Folded into the
* ranges { BT 2..3, EQ 1 } it answered partner 1 as well: a row the request
* excluded
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `(PartnerID le '0000000003' or PartnerID eq '0000000001') and PartnerID ge '0000000002'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000002"` ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000003"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000001"` ).
  ENDMETHOD.

  METHOD or_group_not_folded_mirror.
* ( id >= 3 OR id = 4 ) AND id <= 3 is partner 3 alone
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `(PartnerID ge '0000000003' or PartnerID eq '0000000004') and PartnerID le '0000000003'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000003"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000004"` ).
  ENDMETHOD.

  METHOD or_group_has_no_select_options.
* ranges cannot say it, so there are none: the condition carries it
    DATA lt_options TYPE /iwbep/t_mgw_select_option.

    lt_options = zcl_stg_filter=>parse(
      iv_filter = `(PartnerID le '0000000003' or PartnerID eq '0000000001') and PartnerID ge '0000000002'`
      is_set    = partner_set( ) ).
    cl_abap_unit_assert=>assert_initial( lt_options ).
  ENDMETHOD.

  METHOD bt_pair_still_folds.
* the one fold ranges can hold is kept: ge X and le Y is BT X..Y
    DATA lt_options TYPE /iwbep/t_mgw_select_option.
    DATA ls_option  LIKE LINE OF lt_options.
    DATA ls_range   LIKE LINE OF ls_option-select_options.

    lt_options = zcl_stg_filter=>parse(
      iv_filter = `PartnerID ge '0000000002' and PartnerID le '0000000003' and PartnerID ne '0000000002'`
      is_set    = partner_set( ) ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_options )
                                        exp = 1 ).
    READ TABLE lt_options INDEX 1 INTO ls_option.
    READ TABLE ls_option-select_options INDEX 1 INTO ls_range.
    cl_abap_unit_assert=>assert_equals( act = ls_range-option
                                        exp = 'BT' ).
    cl_abap_unit_assert=>assert_equals( act = ls_range-high
                                        exp = '0000000003' ).
  ENDMETHOD.

  METHOD folded_operator_is_checked.
* the operator after tolower( ) / toupper( ) / trim( ) is one of the six:
* unchecked, `cp '*'` reached the escaper as a pattern and answered every
* row, and any other word was read as eq
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `tolower(Name) cp '*'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `STG/BAD_FILTER` ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `toupper(Name) bogus 'Alpha Ltd'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
  ENDMETHOD.

  METHOD case_folding_is_not_dropped.
* tolower(Name) ne 'alpha ltd' excludes Alpha Ltd. With the folding dropped
* the condition was NAME <> 'alpha ltd', true for Alpha Ltd: a row the
* request excluded
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `tolower(Name) ne 'alpha ltd' and PartnerID le '0000000009'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000001"` ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000002"` ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `tolower(Name) eq 'alpha ltd'` ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000001"` ).
  ENDMETHOD.

  METHOD folded_has_no_select_options.
* a range has no case folding: a provider reading ranges alone must be
* refused (STG/FILTER_NOT_APPLIED), not handed an unfolded comparison
    DATA lt_options TYPE /iwbep/t_mgw_select_option.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    lt_options = zcl_stg_filter=>parse( iv_filter = `tolower(Name) eq 'alpha ltd'`
                                        is_set    = partner_set( ) ).
    cl_abap_unit_assert=>assert_initial( lt_options ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_stg_filter=>osql_where( iv_filter = `tolower(Name) eq 'alpha ltd'`
                                        is_set    = partner_set( ) )
      exp = `LOWER( NAME ) = 'alpha ltd'` ).
    ls_response = get( iv_path   = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/ContactSet`
                       iv_filter = `tolower(Name) eq 'carol'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 501
                                        msg = ls_response-body ).
  ENDMETHOD.

  METHOD long_filter_refused.
* a 100 000 character literal held the work process for 9.5 seconds
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq '` && repeat( val = `a` occ = 100000 ) && `'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = |status { ls_response-status }| ).
    has( iv_body = ls_response-body
         iv_text = `STG/BAD_FILTER` ).
  ENDMETHOD.

  METHOD deep_filter_refused.
* 2000 nested `not` overflowed the host's stack (a RangeError no ABAP
* handler sees); 1000 OR-ed comparisons are past the database's own depth
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = repeat( val = `not ` occ = 2000 ) && `Name eq 'Alpha Ltd'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    ls_response = get( iv_path   = c_base
                       iv_filter = repeat( val = `(` occ = 2000 ) && `Name eq 'Alpha Ltd'` && repeat( val = `)` occ = 2000 ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'Alpha Ltd'` && repeat( val = ` or PartnerID eq 'zz'` occ = 1000 ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
* and an ordinary nesting is still read
    ls_response = get( iv_path   = c_base
                       iv_filter = `not (((Name eq 'Alpha Ltd')) or (PartnerID eq '0000000002' and not Name eq 'x'))` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
  ENDMETHOD.

  METHOD quote_stays_a_value.
* holds today, and must keep holding: a quote in a literal is doubled by
* the one escaper, on the range path and on the tree path
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    cl_abap_unit_assert=>assert_equals(
      act = zcl_stg_filter=>osql_where( iv_filter = `Name eq 'x'' or ''1'' eq ''1' or PartnerID eq 'a''--'`
                                        is_set    = partner_set( ) )
      exp = `( NAME = 'x'' or ''1'' eq ''1' OR PARTNER_ID = 'a''--' )` ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'x'' or ''1'' eq ''1' or PartnerID eq 'a''--'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID"` ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'x') or (Name ne 'x` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'x'; DELETE FROM zosd_h5x_bp` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `b~NAME eq 'x'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
  ENDMETHOD.

  METHOD wildcards_stay_values.
* holds today: % _ # * + in a function's text are characters, on both paths
    cl_abap_unit_assert=>assert_equals(
      act = zcl_stg_filter=>osql_where( iv_filter = `substringof('%_#*+',Name) or PartnerID eq 'zz'`
                                        is_set    = partner_set( ) )
      exp = `( NAME LIKE '%#%#_##*+%' ESCAPE '#' OR PARTNER_ID = 'zz' )` ).
  ENDMETHOD.

  METHOD navigation_key_stays_and_ed.
* holds today: an OR in the filter does not reach past the parent's key
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base && `('0000000002')/ToOrders`
                       iv_filter = `BuyerID eq '0000000001' or OrderID eq 'S1'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    lacks( iv_body = ls_response-body
           iv_text = `"OrderID"` ).
  ENDMETHOD.

  METHOD add_partner.
    DATA ls_bp TYPE zosd_h5x_bp.
    DATA ls_ad TYPE zosd_h5x_ad.

    ls_bp-client = sy-mandt.
    ls_bp-partner_id = iv_id.
    ls_bp-name = iv_name.
    ls_bp-addr_key = ls_bp-partner_id.
    ls_bp-addr_key(1) = 'X'.
    INSERT zosd_h5x_bp FROM ls_bp.
    ls_ad-client = sy-mandt.
    ls_ad-node_key = ls_bp-addr_key.
    ls_ad-city = 'Extra City'.
    INSERT zosd_h5x_ad FROM ls_ad.
  ENDMETHOD.

  METHOD unterminated_literal_refused.
* 'abc with no closing quote is not the literal abc (critic S3): 400, on
* a plain and on a typed literal
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'Alpha Ltd` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `Unterminated` ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `ChangedAt ge datetime'2021-01-01T00:00:00` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
  ENDMETHOD.

  METHOD wildcard_text_matches_itself.
* critic S2 suspected a literal * or + to be lost on the way to LIKE: on
* the rows it is not -- substringof('a*b') finds the name with a*b and not
* the one with ab, both on the range path and on the condition path
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    add_partner( iv_id = '0000000007' iv_name = 'Star a*b' ).
    add_partner( iv_id = '0000000008' iv_name = 'Star ab' ).
    add_partner( iv_id = '0000000009' iv_name = 'Plus a+b' ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `substringof('a*b',Name)` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000007"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000008"` ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `substringof('a+b',Name) or PartnerID eq 'zz'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000009"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000008"` ).
  ENDMETHOD.

  METHOD complex_property_refused.
* a complex property compared as a whole is a 400, not ADDRESS = 'x' and
* an SQL error past every handler (security review, finding 5b)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `Address eq 'x'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `STG/BAD_FILTER` ).
  ENDMETHOD.

  METHOD literal_is_not_a_field.
* the twin maps field names outside literals only (finding 5a): a value
* spelled like a column stays a value -- before, Name eq 'CHANGED_AT' was
* refused as a filter on CHANGED_AT and Name eq 'NAME' compared b~NAME
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    add_partner( iv_id = '0000000007' iv_name = 'NAME' ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'CHANGED_AT'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'NAME'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000007"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000001"` ).
  ENDMETHOD.

ENDCLASS.
