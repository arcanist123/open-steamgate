CLASS ltcl_read DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* What a SEGW sample's business set needs of the gateway, on synthetic rows:
* five partners, one of them without an address (the inner join drops it),
* inserted out of key order. Each case names the fix it holds in place.
  PRIVATE SECTION.
    CONSTANTS c_base TYPE string VALUE '/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/PartnerSet'.

    METHODS setup.
    METHODS ordered_page_with_address FOR TESTING RAISING cx_static_check.
    METHODS skip_drops_the_first_rows FOR TESTING RAISING cx_static_check.
    METHODS count_is_the_joined_rows FOR TESTING RAISING cx_static_check.
    METHODS filter_on_a_complex_path FOR TESTING RAISING cx_static_check.
    METHODS order_is_in_abap_names FOR TESTING RAISING cx_static_check.
    METHODS encoded_option_names FOR TESTING RAISING cx_static_check.
    METHODS default_sets_in_metadata FOR TESTING RAISING cx_static_check.
    METHODS malformed_option_name FOR TESTING RAISING cx_static_check.
    METHODS client_order_maps_back FOR TESTING RAISING cx_static_check.
* milestone 3 (B2): single reads, the navigation contract, two-step paths,
* $expand over them, and the blank-separated dynamic ORDER BY
    METHODS single_direct_read FOR TESTING RAISING cx_static_check.
    METHODS single_two_part_key FOR TESTING RAISING cx_static_check.
    METHODS single_guid_key FOR TESTING RAISING cx_static_check.
    METHODS nav_source_keys_to_many FOR TESTING RAISING cx_static_check.
    METHODS nav_source_keys_to_one FOR TESTING RAISING cx_static_check.
    METHODS nav_step_key_in_abap_names FOR TESTING RAISING cx_static_check.
    METHODS nav_step_two_part_key FOR TESTING RAISING cx_static_check.
    METHODS nav_guid_both_ways FOR TESTING RAISING cx_static_check.
    METHODS nav_two_step_path FOR TESTING RAISING cx_static_check.
    METHODS expand_navigations FOR TESTING RAISING cx_static_check.
    METHODS expand_nested FOR TESTING RAISING cx_static_check.
    METHODS order_two_columns_default FOR TESTING RAISING cx_static_check.
    METHODS order_two_properties FOR TESTING RAISING cx_static_check.
    METHODS nav_names_the_source FOR TESTING RAISING cx_static_check.
* milestone 3 (B3): the wire form
    METHODS filter_or_two_properties FOR TESTING RAISING cx_static_check.
    METHODS filter_not_applied_refused FOR TESTING RAISING cx_static_check.
    METHODS business_error_t100_text FOR TESTING RAISING cx_static_check.
    METHODS unknown_key_t100_text FOR TESTING RAISING cx_static_check.
    METHODS select_projects_members FOR TESTING RAISING cx_static_check.
    METHODS etag_v2_literal_form FOR TESTING RAISING cx_static_check.
    METHODS if_none_match_is_304 FOR TESTING RAISING cx_static_check.
    METHODS session_language FOR TESTING RAISING cx_static_check.
    METHODS conversion_exit_output FOR TESTING RAISING cx_static_check.
    METHODS guid_wire_form FOR TESTING RAISING cx_static_check.
    METHODS inline_count_before_rows FOR TESTING RAISING cx_static_check.
    METHODS batch_part_length FOR TESTING RAISING cx_static_check.
    METHODS select_unknown_property FOR TESTING RAISING cx_static_check.
    METHODS select_below_expansion FOR TESTING RAISING cx_static_check.
    METHODS quantity_in_unit_decimals FOR TESTING RAISING cx_static_check.
    METHODS count_error_is_xml FOR TESTING RAISING cx_static_check.
    METHODS decimal_literal_suffix FOR TESTING RAISING cx_static_check.

    METHODS get
      IMPORTING
        iv_path            TYPE string
        iv_query           TYPE string OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    METHODS has
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
    METHODS lacks
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
    METHODS before
      IMPORTING
        iv_body   TYPE string
        iv_first  TYPE string
        iv_second TYPE string.
    METHODS ok
      IMPORTING
        is_response TYPE zcl_stg_dispatcher=>ty_response.
ENDCLASS.

CLASS ltcl_read IMPLEMENTATION.

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
    DATA lt_options TYPE tihttpnvp.

    IF iv_query IS NOT INITIAL.
      lt_options = cl_http_utility=>string_to_fields( iv_query ).
    ENDIF.
    rs_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = iv_path
                                                it_options = lt_options ).
  ENDMETHOD.

  METHOD has.
    cl_abap_unit_assert=>assert_true( act = boolc( iv_body CS iv_text )
                                      msg = |expected { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD lacks.
    cl_abap_unit_assert=>assert_false( act = boolc( iv_body CS iv_text )
                                       msg = |did not expect { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD before.
    DATA lv_first  TYPE i.
    DATA lv_second TYPE i.

    FIND iv_first IN iv_body MATCH OFFSET lv_first.
    cl_abap_unit_assert=>assert_subrc( exp = 0
                                       msg = |expected { iv_first } in { iv_body }| ).
    FIND iv_second IN iv_body MATCH OFFSET lv_second.
    cl_abap_unit_assert=>assert_subrc( exp = 0
                                       msg = |expected { iv_second } in { iv_body }| ).
    cl_abap_unit_assert=>assert_true( act = boolc( lv_first < lv_second )
                                      msg = |expected { iv_first } before { iv_second } in { iv_body }| ).
  ENDMETHOD.

  METHOD ok.
    cl_abap_unit_assert=>assert_equals( act = is_response-status
                                        exp = 200
                                        msg = is_response-body ).
  ENDMETHOD.

  METHOD ordered_page_with_address.
* the complex property is an object with its type in __metadata (without
* the fix: no Address object at all), read under the namespace it was
* addressed in, and a DEC 21,7 timestamp is an Edm.DateTime
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$top=2&$orderby=PartnerID` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"Address":{"__metadata":{"type":"ZOSD_H5X.CT_Address"},"City":"Alpha City","Country":"AA"},"PartnerID":"0000000001"` ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000002"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000003"` ).
    has( iv_body = ls_response-body
         iv_text = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/PartnerSet('0000000001')` ).
    has( iv_body = ls_response-body
         iv_text = `"ChangedAt":"\/Date(1609556645000)\/"` ).
  ENDMETHOD.

  METHOD skip_drops_the_first_rows.
* $skip=1&$top=2 is rows 2 and 3 of the ordered set: UP TO 3 ROWS, the
* first dropped by sy-dbcnt, which must count per row of the ENDSELECT
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$skip=1&$top=2&$orderby=PartnerID&$inlinecount=allpages` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000001"` ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000002"` ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000003"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000004"` ).
    has( iv_body = ls_response-body
         iv_text = `"__count":"4"` ).
  ENDMETHOD.

  METHOD count_is_the_joined_rows.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && '/$count' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = '4' ).
  ENDMETHOD.

  METHOD filter_on_a_complex_path.
* Address/City is ADDRESS-CITY in the technical WHERE, which the DPC maps
* onto its join (without the fix: 400, the property does not exist)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$filter=Address/City eq 'Gamma City'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000003"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000001"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000004"` ).
  ENDMETHOD.

  METHOD order_is_in_abap_names.
* the technical order names PARTNER_ID, which the DPC maps onto b~PARTNER_ID
* (without the fix: ORDER BY PartnerID, a column that does not exist)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$top=1&$orderby=PartnerID desc` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000004"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000003"` ).
  ENDMETHOD.

  METHOD encoded_option_names.
* %24top is $top: an options table as a server hands it over, names raw
    DATA lt_options  TYPE tihttpnvp.
    DATA ls_option   TYPE ihttpnvp.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_option-name  = '%24top'.
    ls_option-value = '1'.
    APPEND ls_option TO lt_options.
    ls_option-name  = '%24orderby'.
    ls_option-value = 'PartnerID desc'.
    APPEND ls_option TO lt_options.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_base
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000004"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000003"` ).
  ENDMETHOD.

  METHOD default_sets_in_metadata.
* the association set the Gateway builds itself (name cut to 40), and the
* return type's set on a function import that named only the type
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( '/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/$metadata' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200 ).
    has( iv_body = ls_response-body
         iv_text = `<AssociationSet Name="Assoc_Partner_Orders_With_A_Long_Name_As" Association="ZOSD_H5X.Assoc_Partner_Orders_With_A_Long_Name"` ).
    has( iv_body = ls_response-body
         iv_text = `<End EntitySet="PartnerSet" Role="FromRole_Assoc_Partner_Orders_With_A_Long_Name"/>` ).
    has( iv_body = ls_response-body
         iv_text = `<End EntitySet="OrderSet" Role="ToRole_Assoc_Partner_Orders_With_A_Long_Name"/>` ).
    has( iv_body = ls_response-body
         iv_text = `<FunctionImport Name="Partner_Touch" ReturnType="ZOSD_H5X.Partner" EntitySet="PartnerSet"` ).
  ENDMETHOD.

  METHOD malformed_option_name.
* %zz is no escape: the option is ignored, as a system ignores it -- the
* decoder would throw on it (500)
    DATA lt_options  TYPE tihttpnvp.
    DATA ls_option   TYPE ihttpnvp.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_option-name  = '%zztop'.
    ls_option-value = '1'.
    APPEND ls_option TO lt_options.
    ls_option-name  = '%'.
    ls_option-value = '1'.
    APPEND ls_option TO lt_options.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_base
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000004"` ).
  ENDMETHOD.

  METHOD client_order_maps_back.
* the in-process OData client asks the other service by OData names: a
* field by its property, a complex path by its OData path
    DATA ls_service TYPE zcl_stg_model_info=>ty_service.
    DATA ls_set     TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lt_orderby TYPE /iwbep/t_mgw_tech_order.
    DATA ls_orderby LIKE LINE OF lt_orderby.

    ls_service = zcl_stg_model_info=>get( 'ZOSD_H5X_SRV' ).
    ls_set = zcl_stg_model_info=>find_set( is_service    = ls_service
                                           iv_entity_set = 'PartnerSet' ).
    ls_orderby-property      = 'PARTNER_ID'.
    ls_orderby-property_path = 'PARTNER_ID'.
    ls_orderby-order         = 'desc'.
    APPEND ls_orderby TO lt_orderby.
    CLEAR ls_orderby.
    ls_orderby-property_path = 'ADDRESS-CITY'.
    ls_orderby-order         = 'asc'.
    APPEND ls_orderby TO lt_orderby.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_stg_odata_client=>orderby_option( it_orderby = lt_orderby
                                                  is_set     = ls_set )
      exp = `PartnerID desc,Address/City asc` ).
  ENDMETHOD.

  METHOD single_direct_read.
* a direct single read has no source set: the provider reads the key
* (without the fix: the set was answered as the source, the provider took
* its navigation branch with an empty path, 404 without a statement)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && `('0000000003')` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000003"` ).
    has( iv_body = ls_response-body
         iv_text = `"Name":"Gamma Ltd"` ).
  ENDMETHOD.

  METHOD single_two_part_key.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet(OrderID='S1',ItemPosition='0000000020')` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"one-twenty"` ).
  ENDMETHOD.

  METHOD single_guid_key.
* the guid'...' literal is the RAW 16 value of the key
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/ContactSet(guid'c0ffee00-0000-4000-8000-0000000000a1')` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Name":"Carol"` ).
  ENDMETHOD.

  METHOD nav_source_keys_to_many.
* the partner's key converted against the partner, not the order (whose
* reference field is BUYER_ID): without the fix the source key was dropped
* and the provider looked for partner ' '
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && `('0000000001')/ToOrders` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"OrderID":"S1"` ).
    has( iv_body = ls_response-body
         iv_text = `"OrderID":"S2"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"OrderID":"S3"` ).
    ls_response = get( c_base && `('0000000001')/ToOrders/$count` ).
    ok( ls_response ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = '2' ).
  ENDMETHOD.

  METHOD nav_source_keys_to_one.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderSet('S3')/ToPartner` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000002"` ).
    has( iv_body = ls_response-body
         iv_text = `"Name":"Beta Ltd"` ).
  ENDMETHOD.

  METHOD nav_step_key_in_abap_names.
* the step's key_tab is the target's key, ORDER_ID: without the fix it held
* the source's PartnerID and the provider read order '0000000001'
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && `('0000000001')/ToOrders('S2')` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"OrderID":"S2"` ).
  ENDMETHOD.

  METHOD nav_step_two_part_key.
* a two-part target key, read by name (ORDER_ID, ITEM_POS)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderSet('S1')/ToItems(OrderID='S1',ItemPosition='0000000010')` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"one-ten"` ).
  ENDMETHOD.

  METHOD nav_guid_both_ways.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && `('0000000002')/ToContacts(guid'c0ffee00-0000-4000-8000-0000000000a1')` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Name":"Carol"` ).
    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/ContactSet(guid'c0ffee00-0000-4000-8000-0000000000a2')/ToPartner` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000001"` ).
  ENDMETHOD.

  METHOD nav_two_step_path.
* A('k')/ToB('k2')/ToC (without the fix: 400, unsupported resource path);
* the items of S1 only, in the default two-column order
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && `('0000000001')/ToOrders('S1')/ToItems` ).
    ok( ls_response ).
    before( iv_body   = ls_response-body
            iv_first  = `"Note":"one-ten"`
            iv_second = `"Note":"one-twenty"` ).
    before( iv_body   = ls_response-body
            iv_first  = `"Note":"one-twenty"`
            iv_second = `"Note":"one-thirty"` ).
    lacks( iv_body = ls_response-body
           iv_text = `two-ten` ).
  ENDMETHOD.

  METHOD expand_navigations.
* each parent row is the source of its own navigation: values compared,
* not counts
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$filter=PartnerID eq '0000000002'&$expand=ToOrders,ToContacts` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"ToOrders":{"results":[` ).
    has( iv_body = ls_response-body
         iv_text = `"OrderID":"S3"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"OrderID":"S1"` ).
    has( iv_body = ls_response-body
         iv_text = `"Name":"Carol"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Name":"Dave"` ).

    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderSet('S3')`
                       iv_query = `$expand=ToItems,ToPartner` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"three-ten"` ).
    lacks( iv_body = ls_response-body
           iv_text = `one-ten` ).
    has( iv_body = ls_response-body
         iv_text = `"Name":"Beta Ltd"` ).

    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$top=2&$expand=ToOrder` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"ToOrder":{"__metadata"` ).
    has( iv_body = ls_response-body
         iv_text = `"BuyerID":"0000000001"` ).
  ENDMETHOD.

  METHOD expand_nested.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base && `('0000000001')`
                       iv_query = `$expand=ToOrders/ToItems` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"one-ten"` ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"two-ten"` ).
    lacks( iv_body = ls_response-body
           iv_text = `three-ten` ).
  ENDMETHOD.

  METHOD order_two_columns_default.
* the provider's default order is `s~ORDER_ID i~ITEM_POS` (without the fix:
* SQL refused it, the provider answered a business exception, 400)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$top=3` ).
    ok( ls_response ).
    before( iv_body   = ls_response-body
            iv_first  = `"Note":"one-ten"`
            iv_second = `"Note":"one-twenty"` ).
    before( iv_body   = ls_response-body
            iv_first  = `"Note":"one-twenty"`
            iv_second = `"Note":"one-thirty"` ).
    lacks( iv_body = ls_response-body
           iv_text = `two-ten` ).
  ENDMETHOD.

  METHOD order_two_properties.
* $orderby of two properties, concatenated with blanks by the provider
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$orderby=OrderID desc,ItemPosition desc&$top=3` ).
    ok( ls_response ).
    before( iv_body   = ls_response-body
            iv_first  = `"Note":"three-ten"`
            iv_second = `"Note":"two-ten"` ).
    before( iv_body   = ls_response-body
            iv_first  = `"Note":"two-ten"`
            iv_second = `"Note":"one-thirty"` ).
    lacks( iv_body = ls_response-body
           iv_text = `one-twenty` ).
  ENDMETHOD.

  METHOD nav_names_the_source.
* iv_source_name on a navigation read is the source type, as a system
* passes it (the provider refuses any other name; without the fix the
* reads passed '' and a provider filtering by it answered every parent's
* children)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && `('0000000001')/ToOrders` ).
    ok( ls_response ).
    ls_response = get( c_base && `('0000000001')/ToOrders/$count` ).
    ok( ls_response ).
    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderSet('S3')/ToPartner` ).
    ok( ls_response ).
    ls_response = get( c_base && `('0000000001')/ToOrders('S1')/ToItems` ).
    ok( ls_response ).
    lacks( iv_body = ls_response-body
           iv_text = `iv_source_name` ).
  ENDMETHOD.

  METHOD filter_or_two_properties.
* an OR across two properties has no select-option form; the condition is
* built from the expression tree (without the fix: an empty condition, all
* four partners -- on the system the rows of either property, M3 oracle
* 06-07-or-two-props)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$filter=Name eq 'Alpha Ltd' or Address/City eq 'Gamma City'` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000001"` ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000003"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000002"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":"0000000004"` ).
    ls_response = get( iv_path  = c_base && '/$count'
                       iv_query = `$filter=Name eq 'Alpha Ltd' or Address/City eq 'Gamma City'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = '2' ).
  ENDMETHOD.

  METHOD filter_not_applied_refused.
* the contact set reads no filter at all: a filter only the condition can
* carry would come back as every contact -- refused, never dropped
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/ContactSet`
                       iv_query = `$filter=Name eq 'Carol' or PartnerID eq '0000000001'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 501
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `STG/FILTER_NOT_APPLIED` ).
  ENDMETHOD.

  METHOD business_error_t100_text.
* the provider refuses the filter with a T100 key: the code is class/number
* and the message its text, &1 filled from attr1 (a text, not an attribute
* name; M3 oracle 06-00-substringof: 400, code class/number, the
* message's text). Without the fix: STG/BUSINESS and a fixed sentence
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$filter=ChangedAt ge datetime'2021-01-01T00:00:00'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"code":"ZOSD_H5X/001"` ).
    has( iv_body = ls_response-body
         iv_text = `"value":"Filter on CHANGED_AT is not supported"` ).
  ENDMETHOD.

  METHOD unknown_key_t100_text.
* an unknown key: 400 with the provider's message, the key in its text (M3
* oracle 03-50-BusinessPartnerSet-unknown)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( c_base && `('0000000099')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"code":"ZOSD_H5X/002"` ).
    has( iv_body = ls_response-body
         iv_text = `"value":"Partner with key '0000000099' does not exist"` ).
  ENDMETHOD.

  METHOD select_projects_members.
* $select answers the selected properties and nothing else, the ETag stays
* in __metadata (M3 oracle 03-60-BP-single-select, 09-e0-bp-select-two;
* without the fix every member and every deferred link came back)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base && `('0000000001')`
                       iv_query = `$select=PartnerID,Name` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"PartnerID":"0000000001","Name":"Alpha Ltd"}}` ).
    lacks( iv_body = ls_response-body
           iv_text = `"ChangedAt"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Address"` ).
    lacks( iv_body = ls_response-body
           iv_text = `__deferred` ).
    has( iv_body = ls_response-body
         iv_text = `"etag":` ).
    ls_response = get( iv_path  = c_base
                       iv_query = `$top=2&$orderby=PartnerID&$select=Name` ).
    ok( ls_response ).
    lacks( iv_body = ls_response-body
           iv_text = `"PartnerID":` ).
    has( iv_body = ls_response-body
         iv_text = `"Name":"Beta Ltd"}` ).
  ENDMETHOD.

  METHOD etag_v2_literal_form.
* one ETag property: W/"<its URI literal>", the colons escaped upper case,
* in the header and in __metadata (M3 oracle 07-01-single-for-etag; before,
* the V4 facade's W/"2021-01-02T03%3a04%3a05.0000000Z")
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA ls_header   TYPE ihttpnvp.

    ls_response = get( c_base && `('0000000003')` ).
    ok( ls_response ).
    READ TABLE ls_response-headers INTO ls_header WITH KEY name = 'etag'.
    cl_abap_unit_assert=>assert_equals( act = ls_header-value
                                        exp = `W/"datetime'2021-01-02T03%3A04%3A05.0000000'"` ).
    has( iv_body = ls_response-body
         iv_text = `"etag":"W/\"datetime'2021-01-02T03%3A04%3A05.0000000'\""` ).
  ENDMETHOD.

  METHOD if_none_match_is_304.
* If-None-Match with the entity's tag: 304 and no body; another tag: 200
* (M3 oracle 07-02-single-if-none-match)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_headers  TYPE tihttpnvp.
    DATA ls_header   TYPE ihttpnvp.

    ls_header-name  = 'If-None-Match'.
    ls_header-value = `W/"datetime'2021-01-02T03%3A04%3A05.0000000'"`.
    APPEND ls_header TO lt_headers.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_base && `('0000000003')`
                                                it_headers = lt_headers ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 304
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_initial( ls_response-body ).

    CLEAR lt_headers.
    ls_header-value = `W/"datetime'2020-01-01T00%3A00%3A00.0000000'"`.
    APPEND ls_header TO lt_headers.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_base && `('0000000003')`
                                                it_headers = lt_headers ).
    ok( ls_response ).
  ENDMETHOD.

  METHOD session_language.
* sap-language names the session language of the request: the provider's
* sy-langu read answers in it, and the logon language is back afterwards
* (M3 oracle 09-a0-SO-top5-DE; without the fix the note stayed English)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_logon    TYPE sy-langu.

    lv_logon = sy-langu.
    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderSet('S1')`
                       iv_query = `sap-language=DE` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"Auftrag eins","NoteLanguage":"DE"` ).
    cl_abap_unit_assert=>assert_equals( act = sy-langu
                                        exp = lv_logon ).
    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderSet('S1')` ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"Order one"` ).
  ENDMETHOD.

  METHOD conversion_exit_output.
* NoteLanguage carries the ISOLA exit: E on the database, EN on the wire,
* as the system writes NameLanguage (M3 oracle 02-01a: "NameLanguage":"EN";
* without the fix "E", M3-B0 W8)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderSet`
                       iv_query = `sap-language=EN` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"Order one","NoteLanguage":"EN"` ).
  ENDMETHOD.

  METHOD guid_wire_form.
* an Edm.Guid is lower case and dashed in the body, guid'...' in the URI
* (M3 oracle 03-04a-ContactSet-single; before, 32 upper-case hex digits
* in both, M3-B0 W6)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/ContactSet(guid'c0ffee00-0000-4000-8000-0000000000a1')` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"ContactGuid":"c0ffee00-0000-4000-8000-0000000000a1"` ).
    has( iv_body = ls_response-body
         iv_text = `ContactSet(guid'c0ffee00-0000-4000-8000-0000000000a1')` ).
  ENDMETHOD.

  METHOD inline_count_before_rows.
* {"d":{"__count":"4","results":[...]}}, the system's member order (M3
* oracle 04-01a)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base
                       iv_query = `$top=1&$inlinecount=allpages` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `{"d":{"__count":"4","results":[{` ).
  ENDMETHOD.

  METHOD batch_part_length.
* $batch answers 202, each part says how long its HTTP message is -- the
* status line to the end of the body (M3 oracle 08-01-batch: the count
* part's Content-Length 186). Without the fix the part had no length
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_crlf     TYPE string.
    DATA lv_body     TYPE string.

    lv_crlf = cl_abap_char_utilities=>cr_lf.
    lv_body = |--batch_b3{ lv_crlf }Content-Type: application/http{ lv_crlf }Content-Transfer-Encoding: binary{ lv_crlf }{ lv_crlf }| &&
              |GET PartnerSet/$count HTTP/1.1{ lv_crlf }Accept: application/json{ lv_crlf }{ lv_crlf }{ lv_crlf }--batch_b3--{ lv_crlf }|.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method       = 'POST'
                                                iv_path         = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/$batch`
                                                iv_body         = lv_body
                                                iv_content_type = 'multipart/mixed; boundary=batch_b3' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 202
                                        msg = ls_response-body ).
* HTTP/1.1 200 OK, Content-Type: text/plain, Content-Length: 1,
* DataServiceVersion: 2.0, a blank line, 4: 17 + 26 + 19 + 25 + 2 + 1
    has( iv_body = ls_response-body
         iv_text = |Content-Type: application/http{ lv_crlf }Content-Length: 90{ lv_crlf }| ).
    has( iv_body = ls_response-body
         iv_text = |{ lv_crlf }{ lv_crlf }4{ lv_crlf }--| ).
  ENDMETHOD.

  METHOD select_unknown_property.
* a $select path the type does not have is 400, as an unknown $orderby
* property is (critic M1; before, 200 with an empty entity)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base && `('0000000001')`
                       iv_query = `$select=NoSuchProperty` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `STG/PROPERTY_NOT_FOUND` ).
    ls_response = get( iv_path  = c_base
                       iv_query = `$select=Name,Address/Nowhere` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
* a complex member path and a navigation path are known
    ls_response = get( iv_path  = c_base
                       iv_query = `$select=Address/City,ToOrders&$top=1` ).
    ok( ls_response ).
  ENDMETHOD.

  METHOD select_below_expansion.
* $select=PartnerID,ToOrders/Note&$expand=ToOrders projects the expanded
* rows to Note (critic S1; before, every member of each order)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = c_base && `('0000000001')`
                       iv_query = `$expand=ToOrders&$select=PartnerID,ToOrders/Note` ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Note":"Order one"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"BuyerID"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Name"` ).
  ENDMETHOD.

  METHOD quantity_in_unit_decimals.
* a quantity is written with its unit's rounding decimals (ANDEC) when the
* digits beyond them are zero (M3 oracle: line items' Quantity, the
* products' dimensions); a unit the table does not hold, or a non-zero
* digit, keeps the field's scale. Units here are the twin's own
* (ZOSD_H5X_UOM), their display decimals (DECAN) set to other values: read
* from DECAN, PC wrote 3.000 and MTR 1 (M3 second measured pass: DECAN 0
* for every unit, the system wrote each unit's ANDEC decimals)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_unit     TYPE STANDARD TABLE OF zosd_h5x_uom WITH DEFAULT KEY.
    DATA ls_unit     TYPE zosd_h5x_uom.
    DATA lv_reads    TYPE i.

    DELETE FROM zosd_h5x_uom.
    ls_unit-client = sy-mandt.
    ls_unit-msehi = 'PC'.
    ls_unit-decan = 3.
    ls_unit-andec = 0.
    APPEND ls_unit TO lt_unit.
    ls_unit-msehi = 'MTR'.
    ls_unit-decan = 0.
    ls_unit-andec = 2.
    APPEND ls_unit TO lt_unit.
    ls_unit-msehi = 'CMT'.
    ls_unit-decan = 0.
    ls_unit-andec = 3.
    APPEND ls_unit TO lt_unit.
    INSERT zosd_h5x_uom FROM TABLE lt_unit.
    zcl_stg_json=>unit_table( 'ZOSD_H5X_UOM' ).

    lv_reads = zcl_stg_json=>unit_reads( ).
    ls_response = get( `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/ItemSet` ).
    zcl_stg_json=>unit_table( ).
* the unit table is read once for the request's quantities, not per unit
* (milestone 3 pass 3: a product list ran one statement per unit)
    cl_abap_unit_assert=>assert_equals( act = zcl_stg_json=>unit_reads( ) - lv_reads
                                        exp = 1 ).
    ok( ls_response ).
    has( iv_body = ls_response-body
         iv_text = `"Quantity":"3","QuantityUnit":"PC"` ).
    has( iv_body = ls_response-body
         iv_text = `"Quantity":"0.65","QuantityUnit":"MTR"` ).
    has( iv_body = ls_response-body
         iv_text = `"Quantity":"24.800","QuantityUnit":"CMT"` ).
    has( iv_body = ls_response-body
         iv_text = `"Quantity":"2.500","QuantityUnit":"ZZZ"` ).
    has( iv_body = ls_response-body
         iv_text = `"Quantity":"1.250","QuantityUnit":"PC"` ).
* a negative quantity keeps its sign, and never becomes -0
    has( iv_body = ls_response-body
         iv_text = `"Quantity":"-2","QuantityUnit":"PC"` ).
    has( iv_body = ls_response-body
         iv_text = `"Quantity":"-0.500","QuantityUnit":"PC"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Quantity":"-0"` ).
* an amount keeps its scale (the oracle's amounts are in a currency of the
* field's own decimals: nothing to tell apart)
    has( iv_body = ls_response-body
         iv_text = `"Amount":"12.50"` ).
  ENDMETHOD.

  METHOD count_error_is_xml.
* an error on /$count is the XML error document, same code and text (M3
* oracle 09-c1); with $format=json it stays JSON
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_headers  TYPE tihttpnvp.
    DATA ls_header   TYPE ihttpnvp.
    DATA lt_options  TYPE tihttpnvp.
    DATA ls_option   TYPE ihttpnvp.

    ls_option-name  = '$filter'.
    ls_option-value = `ChangedAt ge datetime'2021-01-01T00:00:00'`.

    ls_response = get( iv_path  = c_base && '/$count'
                       iv_query = `$filter=ChangedAt ge datetime'2021-01-01T00:00:00'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_type
                                        exp = 'application/xml' ).
    has( iv_body = ls_response-body
         iv_text = `<code>ZOSD_H5X/001</code><message xml:lang="en">Filter on CHANGED_AT is not supported</message>` ).
    ls_response = get( iv_path  = c_base
                       iv_query = `$filter=ChangedAt ge datetime'2021-01-01T00:00:00'` ).
    has( iv_body = ls_response-body
         iv_text = `"code":"ZOSD_H5X/001"` ).
* Accept naming application/json asks for JSON; a count's usual Accept
* (text/plain, */*) keeps the XML
    CLEAR ls_header.
    ls_header-name  = 'Accept'.
    ls_header-value = 'application/json'.
    APPEND ls_header TO lt_headers.
    APPEND ls_option TO lt_options.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_base && '/$count'
                                                it_options = lt_options
                                                it_headers = lt_headers ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_type
                                        exp = 'application/json' ).
    CLEAR lt_headers.
    ls_header-value = '*/*'.
    APPEND ls_header TO lt_headers.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_base && '/$count'
                                                it_options = lt_options
                                                it_headers = lt_headers ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_type
                                        exp = 'application/xml' ).
* $format=json asked for, its $ encoded or not: JSON on /$count too
    ls_response = get( iv_path  = c_base && '/$count'
                       iv_query = `$filter=ChangedAt ge datetime'2021-01-01T00:00:00'&%24format=json` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_type
                                        exp = 'application/json' ).
    has( iv_body = ls_response-body
         iv_text = `"code":"ZOSD_H5X/001"` ).
  ENDMETHOD.

  METHOD decimal_literal_suffix.
* 100.00m is an Edm.Decimal literal, 1d a double, 1f a single, 9L an int64
* (M3 oracle 06-03: Price ge 100.00m); another letter after a number is
* still refused
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$filter=ItemPosition ge 10m and ItemPosition le 9999999999M` ).
    ok( ls_response ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_stg_filter=>osql_where( iv_filter = `Note eq 1.5d or Note eq 2f or Note eq 9L`
                                        is_set    = zcl_stg_model_info=>find_set( is_service    = zcl_stg_model_info=>get( 'ZOSD_H5X_SRV' )
                                                                                  iv_entity_set = 'OrderItemSet' ) )
      exp = `( ( NOTE = '1.5' OR NOTE = '2' ) OR NOTE = '9' )` ).
    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$filter=ItemPosition ge 10x` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$filter=ItemPosition ge 10mm` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
* a number ending in its decimal point is malformed, suffix or not
    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$filter=ItemPosition ge 1.` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
    ls_response = get( iv_path  = `/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/OrderItemSet`
                       iv_query = `$filter=ItemPosition ge 1.m` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_value_help DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The value help sets of a SEGW sample, one per kind of search help, read
* through the generated registry (test/hana-m2/zcl_osd_h5x_shlp_registry,
* written by tools/segw-shlp.mjs and kept equal to it by test/segw-shlp.mjs):
* a plain table, a table with a text table, a help view with no database
* object. Texts exist in two languages; one country has none; one unit is
* excluded by the view's condition, one by the help's default value.
  PRIVATE SECTION.
    CONSTANTS c_srv TYPE string VALUE '/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/'.

    METHODS setup.
    METHODS plain_table_sorted_page FOR TESTING RAISING cx_static_check.
    METHODS texts_in_session_language FOR TESTING RAISING cx_static_check.
    METHODS text_table_key_filter FOR TESTING RAISING cx_static_check.
    METHODS text_table_single FOR TESTING RAISING cx_static_check.
    METHODS help_view_join FOR TESTING RAISING cx_static_check.
    METHODS help_view_count FOR TESTING RAISING cx_static_check.
    METHODS default_yields_to_request FOR TESTING RAISING cx_static_check.
    METHODS exit_only_is_not_served FOR TESTING RAISING cx_static_check.
    METHODS unknown_field_is_refused FOR TESTING RAISING cx_static_check.
* milestone 3 tail: the unit key in its external form (CUNIT), the hit
* list in the order of that form, a single read by it, and the key of an
* entry's URI in the form the system writes
    METHODS external_unit_key_and_order FOR TESTING RAISING cx_static_check.
    METHODS external_unit_key_single FOR TESTING RAISING cx_static_check.
    METHODS entry_uri_key_encoded FOR TESTING RAISING cx_static_check.
* the link an entry carries reads that entry back, through the dispatcher's
* own URL parser: each key form the encoding writes
    METHODS link_reads_the_entry_back FOR TESTING RAISING cx_static_check.
    METHODS unit_link_reads_back FOR TESTING RAISING cx_static_check.
* milestone 3, pass 3: the hit list is read up to $top + $skip rows in key
* order and only those are sorted
    METHODS page_read_before_sort FOR TESTING RAISING cx_static_check.
    METHODS skip_page_reads_top_and_skip FOR TESTING RAISING cx_static_check.
    METHODS no_sort_keeps_key_order FOR TESTING RAISING cx_static_check.
    METHODS units_read_once_per_request FOR TESTING RAISING cx_static_check.
* $top / $skip: request-controlled numbers that reach a row limit
    METHODS paging_must_be_a_count FOR TESTING RAISING cx_static_check.
    METHODS top_zero_is_an_empty_page FOR TESTING RAISING cx_static_check.
    METHODS paging_at_the_cap FOR TESTING RAISING cx_static_check.
    METHODS inlinecount_is_the_page FOR TESTING RAISING cx_static_check.
    METHODS missing_unit_table_is_an_error FOR TESTING RAISING cx_static_check.
    METHODS unit
      IMPORTING
        iv_key      TYPE csequence
        iv_external TYPE csequence
        iv_new      TYPE abap_bool DEFAULT abap_false
        iv_text     TYPE csequence OPTIONAL.
    METHODS units
      IMPORTING
        iv_body         TYPE string
      RETURNING
        VALUE(rv_units) TYPE string.
    METHODS teardown.
* the first entry link of a body, from the set's name to its closing
* parenthesis (an encoded key holds no parenthesis)
    METHODS first_link
      IMPORTING
        iv_body        TYPE string
        iv_set         TYPE string
      RETURNING
        VALUE(rv_path) TYPE string.
* insert a category that sorts first, read it through its own link, check
* the link's key form, remove it
    METHODS category_round_trip
      IMPORTING
        iv_key     TYPE string
        iv_encoded TYPE string.

    METHODS get
      IMPORTING
        iv_path            TYPE string
        iv_query           TYPE string OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    METHODS has
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
    METHODS lacks
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
ENDCLASS.

CLASS ltcl_value_help IMPLEMENTATION.

  METHOD setup.
    DATA ls_cat  TYPE zosd_h5x_cat.
    DATA ls_cty  TYPE zosd_h5x_cty.
    DATA ls_ctyt TYPE zosd_h5x_ctyt.
    DATA ls_un   TYPE zosd_h5x_un.
    DATA ls_unt  TYPE zosd_h5x_unt.

    DELETE FROM zosd_h5x_cat.
    DELETE FROM zosd_h5x_cty.
    DELETE FROM zosd_h5x_ctyt.
    DELETE FROM zosd_h5x_un.
    DELETE FROM zosd_h5x_unt.

* inserted out of order: the value help sorts by its list fields
    ls_cat-client = sy-mandt.
    ls_cat-category = 'Pens'.
    INSERT zosd_h5x_cat FROM ls_cat.
    ls_cat-category = 'Binders'.
    INSERT zosd_h5x_cat FROM ls_cat.
    ls_cat-category = 'Lamps'.
    INSERT zosd_h5x_cat FROM ls_cat.

    ls_cty-client = sy-mandt.
    ls_cty-code = 'BB'.
    INSERT zosd_h5x_cty FROM ls_cty.
    ls_cty-code = 'AA'.
    INSERT zosd_h5x_cty FROM ls_cty.
* no text in any language: an outer join keeps it
    ls_cty-code = 'CC'.
    INSERT zosd_h5x_cty FROM ls_cty.
    ls_ctyt-client = sy-mandt.
    ls_ctyt-langu = 'E'.
    ls_ctyt-code = 'AA'.
    ls_ctyt-name = 'Aland'.
    INSERT zosd_h5x_ctyt FROM ls_ctyt.
    ls_ctyt-code = 'BB'.
    ls_ctyt-name = 'Bland'.
    INSERT zosd_h5x_ctyt FROM ls_ctyt.
    ls_ctyt-langu = 'D'.
    ls_ctyt-code = 'AA'.
    ls_ctyt-name = 'Aland DE'.
    INSERT zosd_h5x_ctyt FROM ls_ctyt.
    ls_ctyt-code = 'BB'.
    ls_ctyt-name = 'Bland DE'.
    INSERT zosd_h5x_ctyt FROM ls_ctyt.

    ls_un-client = sy-mandt.
    ls_un-unit = 'KG'.
    ls_un-dim = 'MASS'.
    ls_un-ext = 'X'.
    INSERT zosd_h5x_un FROM ls_un.
    ls_un-unit = 'G'.
    INSERT zosd_h5x_un FROM ls_un.
* not external: the view's selection condition leaves it out
    ls_un-unit = 'MG'.
    ls_un-ext = ' '.
    INSERT zosd_h5x_un FROM ls_un.
* another dimension: the help's default value leaves it out
    ls_un-unit = 'CM'.
    ls_un-dim = 'LENGTH'.
    ls_un-ext = 'X'.
    INSERT zosd_h5x_un FROM ls_un.
    ls_unt-client = sy-mandt.
    ls_unt-langu = 'E'.
    ls_unt-unit = 'KG'.
    ls_unt-ltxt = 'Kilogram'.
    INSERT zosd_h5x_unt FROM ls_unt.
    ls_unt-unit = 'G'.
    ls_unt-ltxt = 'Gram'.
    INSERT zosd_h5x_unt FROM ls_unt.
    ls_unt-unit = 'CM'.
    ls_unt-ltxt = 'Centimeter'.
    INSERT zosd_h5x_unt FROM ls_unt.
    ls_unt-langu = 'D'.
    ls_unt-unit = 'KG'.
    ls_unt-ltxt = 'Kilogramm'.
    INSERT zosd_h5x_unt FROM ls_unt.
* units whose external forms sort otherwise than their keys. In key order
* BAG BOT G IN1 KG KT LE TO UG XA XB XC, outside (English) BAG BT G " KG
* KT AU TO UG XA A1 XC: IN1 is a sign that sorts before the letters, inside
* the first five keys; LE (AU) and XB (A1) sort early outside but come
* late in the key order -- beyond row 5 and beyond row 10. A page sorted
* after its rows were read differs from a slice of the sorted whole list
    DELETE FROM zosd_h5x_uoma.
    zcl_osd_cunit=>text_table( 'ZOSD_H5X_UOMA' ).
    unit( iv_key = 'G'   iv_external = 'G' ).
    unit( iv_key = 'KG'  iv_external = 'KG' ).
    unit( iv_key = 'BAG' iv_external = 'BAG' iv_new = abap_true ).
    unit( iv_key = 'BOT' iv_external = 'BT'  iv_new = abap_true ).
    unit( iv_key = 'IN1' iv_external = '"'   iv_new = abap_true iv_text = 'Twin unit' ).
    unit( iv_key = 'KT'  iv_external = 'KT'  iv_new = abap_true ).
    unit( iv_key = 'LE'  iv_external = 'AU'  iv_new = abap_true ).
    unit( iv_key = 'TO'  iv_external = 'TO'  iv_new = abap_true ).
    unit( iv_key = 'UG'  iv_external = 'UG'  iv_new = abap_true ).
    unit( iv_key = 'XA'  iv_external = 'XA'  iv_new = abap_true ).
    unit( iv_key = 'XB'  iv_external = 'A1'  iv_new = abap_true ).
    unit( iv_key = 'XC'  iv_external = 'XC'  iv_new = abap_true ).

    zcl_oao_shlp_data=>clear( ).
    zcl_osd_h5x_shlp_registry=>register( ).
    zcl_oao_registry=>register( iv_service = 'ZOSD_H5X_SRV'
                                iv_mpc     = 'ZCL_OSD_H5X_MPC'
                                iv_dpc     = 'ZCL_OSD_H5X_DPC' ).
    zcl_stg_model_info=>clear( ).
  ENDMETHOD.

  METHOD get.
    DATA lt_options TYPE tihttpnvp.

    IF iv_query IS NOT INITIAL.
      lt_options = cl_http_utility=>string_to_fields( iv_query ).
    ENDIF.
    rs_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_srv && iv_path
                                                it_options = lt_options ).
  ENDMETHOD.

  METHOD has.
    cl_abap_unit_assert=>assert_true( act = boolc( iv_body CS iv_text )
                                      msg = |expected { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD lacks.
    cl_abap_unit_assert=>assert_false( act = boolc( iv_body CS iv_text )
                                       msg = |did not expect { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD plain_table_sorted_page.
* $skip=1&$top=1 of Binders, Lamps, Pens is Lamps
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_CategorySet'
                       iv_query = `$skip=1&$top=1` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"Category":"Lamps"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Category":"Binders"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Category":"Pens"` ).
  ENDMETHOD.

  METHOD texts_in_session_language.
* the text table joined on its key and the session language, as an outer
* join (without the fix: 400, the help was not served; the language bound
* off: each country twice; an inner join: CC gone)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( 'VH_CountrySet' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"Code":"AA","Name":"Aland"}` ).
    has( iv_body = ls_response-body
         iv_text = `"Code":"BB","Name":"Bland"}` ).
    has( iv_body = ls_response-body
         iv_text = `"Code":"CC","Name":""}` ).
    lacks( iv_body = ls_response-body
           iv_text = `land DE` ).
    ls_response = get( 'VH_CountrySet/$count' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = '3' ).
  ENDMETHOD.

  METHOD text_table_key_filter.
* CODE is a column of both tables: the selection option is written against
* the base table's (unqualified, the join's SELECT is ambiguous)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_CountrySet'
                       iv_query = `$filter=Code eq 'BB'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"Code":"BB","Name":"Bland"}` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Code":"AA"` ).
  ENDMETHOD.

  METHOD text_table_single.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( `VH_CountrySet('AA')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"Code":"AA","Name":"Aland"}` ).
  ENDMETHOD.

  METHOD help_view_join.
* the help view's tables joined, its condition (EXT = 'X') applied, the
* default DIM = 'MASS' applied, the text in the session language; LTXT is
* a list field without being an export parameter
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( 'VH_UnitSet' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"Unit":"G","Ltxt":"Gram"}` ).
    has( iv_body = ls_response-body
         iv_text = `"Unit":"KG","Ltxt":"Kilogram"}` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Unit":"MG"` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Unit":"CM"` ).
    lacks( iv_body = ls_response-body
           iv_text = `Kilogramm` ).
  ENDMETHOD.

  METHOD help_view_count.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( 'VH_UnitSet/$count' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = '12' ).
  ENDMETHOD.

  METHOD unit.
    DATA ls_un   TYPE zosd_h5x_un.
    DATA ls_unt  TYPE zosd_h5x_unt.
    DATA ls_uoma TYPE zosd_h5x_uoma.

    IF iv_new = abap_true.
      ls_un-client = sy-mandt.
      ls_un-unit = iv_key.
      ls_un-dim = 'MASS'.
      ls_un-ext = 'X'.
      INSERT zosd_h5x_un FROM ls_un.
    ENDIF.
    IF iv_text IS NOT INITIAL.
      ls_unt-client = sy-mandt.
      ls_unt-langu = 'E'.
      ls_unt-unit = iv_key.
      ls_unt-ltxt = iv_text.
      INSERT zosd_h5x_unt FROM ls_unt.
    ENDIF.
    ls_uoma-client = sy-mandt.
    ls_uoma-spras = 'E'.
    ls_uoma-msehi = iv_key.
    ls_uoma-mseh3 = iv_external.
    INSERT zosd_h5x_uoma FROM ls_uoma.
  ENDMETHOD.

  METHOD units.
* the Unit values of a body in their order, as JSON writes them, joined by |
    DATA lt_parts TYPE string_table.
    DATA lv_part  TYPE string.
    DATA lv_value TYPE string.

    SPLIT iv_body AT `"Unit":"` INTO TABLE lt_parts.
    LOOP AT lt_parts INTO lv_part FROM 2.
      SPLIT lv_part AT `","Ltxt"` INTO lv_value lv_part.
      IF rv_units IS INITIAL.
        rv_units = lv_value.
      ELSE.
        rv_units = |{ rv_units }\|{ lv_value }|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD units_read_once_per_request.
* one request converts every unit of the list (output, and the sort of the
* hit list) and a key (input): the unit text table is read once for it
* (milestone 3 pass 3: one statement per converted value)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_reads    TYPE i.

    lv_reads = zcl_osd_cunit=>reads( ).
    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_cunit=>reads( ) - lv_reads
                                        exp = 1
                                        msg = 'twelve units, one read' ).
    lv_reads = zcl_osd_cunit=>reads( ).
    ls_response = get( iv_path  = `VH_UnitSet('"')`
                       iv_query = `sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_cunit=>reads( ) - lv_reads
                                        exp = 1
                                        msg = 'a key in, a unit out, one read' ).
  ENDMETHOD.

  METHOD paging_must_be_a_count.
* OData V2: $top and $skip are non-negative integers; anything else, and a
* value beyond the cap, is a 400 -- never a row limit (a negative or a
* huge one read every row, or overflowed top + skip in the generated DPC)
    DATA lt_query    TYPE string_table.
    DATA lv_query    TYPE string.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    APPEND `$top=-1` TO lt_query.
    APPEND `$top=abc` TO lt_query.
    APPEND `$top=1.5` TO lt_query.
    APPEND `$top=99999999999` TO lt_query.
    APPEND `$top=1000000001` TO lt_query.
    APPEND `$skip=-5` TO lt_query.
    APPEND `$skip=x` TO lt_query.
    APPEND `$top=5&$skip=1000000001` TO lt_query.
    LOOP AT lt_query INTO lv_query.
      ls_response = get( iv_path  = 'VH_UnitSet'
                         iv_query = lv_query ).
      cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                          exp = 400
                                          msg = |{ lv_query }: { ls_response-body }| ).
      has( iv_body = ls_response-body
           iv_text = `"code":"STG/BAD_PAGING"` ).
    ENDLOOP.
    ls_response = get( iv_path  = 'PartnerSet'
                       iv_query = `$top=-1` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400
                                        msg = ls_response-body ).
  ENDMETHOD.

  METHOD top_zero_is_an_empty_page.
* $top=0 asks for no row, on a business set and on a value help alike (a
* provider reads a top of 0 as "no limit": every row came back)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$top=0` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = `{"d":{"results":[]}}` ).
    ls_response = get( iv_path  = 'VH_CategorySet'
                       iv_query = `$top=0&$skip=1` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = `{"d":{"results":[]}}` ).
    ls_response = get( iv_path  = 'PartnerSet'
                       iv_query = `$top=0` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = `{"d":{"results":[]}}` ).
  ENDMETHOD.

  METHOD paging_at_the_cap.
* the largest $top and $skip together still fit the generated DPC's sum
* (lv_max_hits = top + skip, a 4-byte integer): the read answers, empty
* beyond the twelve rows
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$top=1000000000&$skip=1000000000` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                        exp = `{"d":{"results":[]}}` ).
    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$top=1000000000&sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = units( ls_response-body )
                                        exp = `\"|A1|AU|BAG|BT|G|KG|KT|TO|UG|XA|XC` ).
  ENDMETHOD.

  METHOD inlinecount_is_the_page.
* PINNED, NOT MEASURED: $inlinecount=allpages on a value-help set with
* $top answers the page's size (the generated DPC counts nothing, the
* dispatcher counts the rows it got). What a system answers here is not
* measured; this pins today's answer so a change is a decision
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$top=2&$inlinecount=allpages` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `{"d":{"__count":"2",` ).
  ENDMETHOD.

  METHOD missing_unit_table_is_an_error.
* a unit-converted property in a system without the unit text table: an
* error naming the exit and the table, not the internal key
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    zcl_osd_cunit=>text_table( 'ZOSD_H5X_NO_SUCH_TABLE' ).
    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$top=1&sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 500
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"code":"OSD/CONVERSION_TABLE"` ).
    has( iv_body = ls_response-body
         iv_text = `ZOSD_H5X_NO_SUCH_TABLE` ).
    lacks( iv_body = ls_response-body
           iv_text = `"Unit":"BAG"` ).
  ENDMETHOD.

  METHOD page_read_before_sort.
* $top=5: the provider reads the first five keys (BAG BOT G IN1 KG) and
* sorts those five by their external form; AU and A1, early outside but
* late in the key order, stay out (M3 oracle 02-10a: the page of the
* system's generated DPC, maxrows = $top + $skip, then the sort). A slice
* of the sorted whole list would be " A1 AU BAG BT
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$top=5&sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = units( ls_response-body )
                                        exp = `\"|BAG|BT|G|KG` ).
  ENDMETHOD.

  METHOD skip_page_reads_top_and_skip.
* $skip=5&$top=5: ten rows read in key order, the ten sorted, the first
* five dropped (the sorted whole list would give G KG KT TO UG)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$skip=5&$top=5&sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = units( ls_response-body )
                                        exp = `KG|KT|TO|UG|XA` ).
  ENDMETHOD.

  METHOD no_sort_keeps_key_order.
* iv_sort initial: the rows read come back in the key order of the read,
* internal values (the provider's contract)
    DATA lo_sh_data TYPE REF TO /iwbep/if_sb_shlp_data.
    DATA lt_selopt  TYPE ddshselops.
    DATA lt_result  TYPE /iwbep/if_sb_gendpc_shlp_data=>tt_result_list.
    DATA ls_result  LIKE LINE OF lt_result.
    DATA ls_message TYPE bapiret2.
    DATA lv_units   TYPE string.

    lo_sh_data = /iwbep/cl_sb_shlp_data_factory=>get_sh_data_obj( ).
    lo_sh_data->/iwbep/if_sb_gendpc_shlp_data~get_search_help_values(
      EXPORTING
        iv_shlp_name   = 'ZOSD_H5X_SH_UN'
        iv_maxrows     = 5
        iv_sort        = abap_false
        it_selopt      = lt_selopt
      IMPORTING
        et_return_list = lt_result
        es_message     = ls_message ).
    cl_abap_unit_assert=>assert_initial( ls_message ).
    LOOP AT lt_result INTO ls_result WHERE field_name = 'UNIT'.
      lv_units = |{ lv_units }{ ls_result-field_value }.|.
    ENDLOOP.
    cl_abap_unit_assert=>assert_equals( act = lv_units
                                        exp = `BAG.BOT.G.IN1.KG.` ).
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_cunit=>text_table( ).
  ENDMETHOD.

  METHOD external_unit_key_and_order.
* the key in its external form in the body and in the entry's URI, and --
* no $top, so no row limit -- the whole list in the order of that form
* (M3 oracle 02-12a: the sign first; without the output conversion the key
* was IN1, without the sort exit " came after G)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `VH_UnitSet('%22')","type"` ).
    has( iv_body = ls_response-body
         iv_text = `"Unit":"\"","Ltxt":"Twin unit"}` ).
    lacks( iv_body = ls_response-body
           iv_text = `IN1` ).
    cl_abap_unit_assert=>assert_equals( act = units( ls_response-body )
                                        exp = `\"|A1|AU|BAG|BT|G|KG|KT|TO|UG|XA|XC` ).
* $top=1 reads one row, the first key: BAG, whatever sorts first outside
    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `$top=1&sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = units( ls_response-body )
                                        exp = `BAG` ).
  ENDMETHOD.

  METHOD external_unit_key_single.
* a single read names the external key; the provider reads the internal
* one (M3 oracle 03-12a: a single read by the external form, 200; without
* the input conversion a 404)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = `VH_UnitSet('"')`
                       iv_query = `sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `VH_UnitSet('%22')","type"` ).
    has( iv_body = ls_response-body
         iv_text = `"Unit":"\"","Ltxt":"Twin unit"}` ).
  ENDMETHOD.

  METHOD entry_uri_key_encoded.
* the key of an entry's URI percent-encoded as a system writes it: a blank
* %20, & %26 (M3 oracle 02-08a), / %2F, % %25, the
* quote doubled and raw like the delimiters (without the fix the key went
* out raw: ('A b/c''d%e&f'))
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA ls_cat      TYPE zosd_h5x_cat.

    ls_cat-client = sy-mandt.
    ls_cat-category = `A b/c'd%e&f`.
    INSERT zosd_h5x_cat FROM ls_cat.
    ls_response = get( iv_path  = 'VH_CategorySet'
                       iv_query = `$top=1` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `VH_CategorySet('A%20b%2Fc''d%25e%26f')","uri"` ).
    has( iv_body = ls_response-body
         iv_text = `"Category":"A b/c'd%e&f"` ).
  ENDMETHOD.

  METHOD first_link.
    DATA lv_off TYPE i.
    DATA lv_len TYPE i.

    FIND FIRST OCCURRENCE OF REGEX |{ iv_set }\\([^)]*\\)| IN iv_body MATCH OFFSET lv_off MATCH LENGTH lv_len.
    cl_abap_unit_assert=>assert_subrc( exp = 0
                                       msg = |no link of { iv_set } in { iv_body }| ).
    rv_path = iv_body+lv_off(lv_len).
  ENDMETHOD.

  METHOD category_round_trip.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA ls_cat      TYPE zosd_h5x_cat.
    DATA lv_path     TYPE string.

    ls_cat-client = sy-mandt.
    ls_cat-category = iv_key.
    INSERT zosd_h5x_cat FROM ls_cat.
    ls_response = get( iv_path  = 'VH_CategorySet'
                       iv_query = `$top=1` ).
    lv_path = first_link( iv_body = ls_response-body
                          iv_set  = 'VH_CategorySet' ).
    cl_abap_unit_assert=>assert_equals( act = lv_path
                                        exp = |VH_CategorySet('{ iv_encoded }')| ).
    ls_response = get( lv_path ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = |{ lv_path }: { ls_response-body }| ).
    has( iv_body = ls_response-body
         iv_text = |"Category":"{ zcl_stg_json=>escape( iv_key ) }"\}| ).
    has( iv_body = ls_response-body
         iv_text = |{ lv_path }","type"| ).
    DELETE FROM zosd_h5x_cat WHERE category = ls_cat-category.
  ENDMETHOD.

  METHOD link_reads_the_entry_back.
* every key sorts before the setup's rows (they start with A); the text is
* 7-bit ASCII, so the characters beyond it are built from code points: a
* Cyrillic letter (two UTF-8 bytes) and one outside the BMP (a surrogate
* pair, four UTF-8 bytes)
    DATA lv_zhe    TYPE string.
    DATA lv_smiley TYPE string.

    lv_zhe = cl_abap_conv_in_ce=>uccp( '0416' ).
    lv_smiley = cl_abap_conv_in_ce=>uccp( 'D83D' ) && cl_abap_conv_in_ce=>uccp( 'DE00' ).
    category_round_trip( iv_key     = `A b/c'd%e&f`
                         iv_encoded = `A%20b%2Fc''d%25e%26f` ).
    category_round_trip( iv_key     = `A#1?2+3`
                         iv_encoded = `A%231%3F2%2B3` ).
    category_round_trip( iv_key     = |A{ lv_zhe }b|
                         iv_encoded = `A%D0%96b` ).
    category_round_trip( iv_key     = |A{ lv_smiley }b|
                         iv_encoded = `A%F0%9F%98%80b` ).
  ENDMETHOD.

  METHOD unit_link_reads_back.
* the converted unit key: its link names the external form, and reading the
* link converts it back to the internal key
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_path     TYPE string.

    ls_response = get( iv_path  = 'VH_UnitSet'
                       iv_query = `sap-language=EN` ).
    lv_path = first_link( iv_body = ls_response-body
                          iv_set  = 'VH_UnitSet' ).
    cl_abap_unit_assert=>assert_equals( act = lv_path
                                        exp = `VH_UnitSet('%22')` ).
    ls_response = get( iv_path  = lv_path
                       iv_query = `sap-language=EN` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    has( iv_body = ls_response-body
         iv_text = `"Unit":"\"","Ltxt":"Twin unit"}` ).
  ENDMETHOD.

  METHOD default_yields_to_request.
* a selection option on the field replaces its default value; without one
* the default restricts the field
    DATA lo_shlp   TYPE REF TO zcl_oao_shlp_ddic.
    DATA lt_selopt TYPE ddshselops.
    DATA ls_selopt LIKE LINE OF lt_selopt.

    lo_shlp = zcl_oao_shlp_ddic=>create( 'ZOSD_H5X_SH_X' ).
    lo_shlp->add_parameter( iv_name    = 'DIM'
                            iv_default = 'MASS' ).
    ls_selopt-shlpfield = 'DIM'.
    ls_selopt-sign      = 'I'.
    ls_selopt-option    = 'EQ'.
    ls_selopt-low       = 'LENGTH'.
    APPEND ls_selopt TO lt_selopt.
    cl_abap_unit_assert=>assert_equals( act = lo_shlp->where_clause( lo_shlp->with_defaults( lt_selopt ) )
                                        exp = `( dim = 'LENGTH' )` ).
    CLEAR lt_selopt.
    cl_abap_unit_assert=>assert_equals( act = lo_shlp->where_clause( lo_shlp->with_defaults( lt_selopt ) )
                                        exp = `( dim = 'MASS' )` ).
  ENDMETHOD.

  METHOD exit_only_is_not_served.
* an exit-only search help answers an E message, which the generated DPC
* turns into a business error (a 400), not a dump and not an empty set
    DATA lo_shlp    TYPE REF TO zcl_oao_shlp_ddic.
    DATA lt_selopt  TYPE ddshselops.
    DATA lt_result  TYPE /iwbep/if_sb_gendpc_shlp_data=>tt_result_list.
    DATA ls_message TYPE bapiret2.

    lo_shlp = zcl_oao_shlp_ddic=>create( iv_shlp_name = 'ZOSD_H5X_SH_EXIT'
                                         iv_selmexit  = 'ZOSD_H5X_SHEXIT' ).
    lo_shlp->add_parameter( iv_name          = 'CODE'
                            iv_list_position = 1 ).
    lo_shlp->/iwbep/if_sb_gendpc_shlp_data~get_search_help_values(
      EXPORTING
        iv_shlp_name   = 'ZOSD_H5X_SH_EXIT'
        it_selopt      = lt_selopt
      IMPORTING
        et_return_list = lt_result
        es_message     = ls_message ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-type
                                        exp = 'E' ).
    cl_abap_unit_assert=>assert_initial( lt_result ).
  ENDMETHOD.

  METHOD unknown_field_is_refused.
* a selection option on a field that is no parameter of the help is refused
* with an E message; its name never reaches the WHERE clause
    DATA lo_sh_data TYPE REF TO /iwbep/if_sb_shlp_data.
    DATA lt_selopt  TYPE ddshselops.
    DATA ls_selopt  LIKE LINE OF lt_selopt.
    DATA lt_result  TYPE /iwbep/if_sb_gendpc_shlp_data=>tt_result_list.
    DATA ls_message TYPE bapiret2.

    ls_selopt-shlpname  = 'ZOSD_H5X_SH_CTY'.
    ls_selopt-shlpfield = `CODE) OR (1 = 1`.
    ls_selopt-sign      = 'I'.
    ls_selopt-option    = 'EQ'.
    ls_selopt-low       = 'AA'.
    APPEND ls_selopt TO lt_selopt.
    lo_sh_data = /iwbep/cl_sb_shlp_data_factory=>get_sh_data_obj( ).
    lo_sh_data->/iwbep/if_sb_gendpc_shlp_data~get_search_help_values(
      EXPORTING
        iv_shlp_name   = 'ZOSD_H5X_SH_CTY'
        it_selopt      = lt_selopt
      IMPORTING
        et_return_list = lt_result
        es_message     = ls_message ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-type
                                        exp = 'E' ).
    cl_abap_unit_assert=>assert_initial( lt_result ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_annotations DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The $metadata annotations a SEGW model gets from its text pool and from
* the dictionary structure it binds (milestone 3 B4, measured on a SEGW
* sample's $metadata against its system). The twin's Item type is bound to
* ZOSD_H5X_S_ITEM by name; its class XML carries a text pool (001, 002 in
* English, 002 in German too), its data elements carry field labels, two
* of them a German one.
  PRIVATE SECTION.
    CONSTANTS c_metadata TYPE string VALUE '/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/$metadata'.

    METHODS setup.
    METHODS text_pool_labels FOR TESTING RAISING cx_static_check.
    METHODS dictionary_labels FOR TESTING RAISING cx_static_check.
    METHODS units_and_semantics FOR TESTING RAISING cx_static_check.
    METHODS unicode_as_the_model_says FOR TESTING RAISING cx_static_check.
    METHODS labels_in_the_request_language FOR TESTING RAISING cx_static_check.
    METHODS class_pool_container FOR TESTING RAISING cx_static_check.
    METHODS accept_language FOR TESTING RAISING cx_static_check.

    METHODS metadata
      IMPORTING
        iv_language    TYPE string OPTIONAL
      RETURNING
        VALUE(rv_body) TYPE string.
* the element <Property Name="..." .../> (or <Parameter ...>) of the body
    METHODS element
      IMPORTING
        iv_body        TYPE string
        iv_start       TYPE string
      RETURNING
        VALUE(rv_xml)  TYPE string.
    METHODS has
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
    METHODS lacks
      IMPORTING
        iv_body TYPE string
        iv_text TYPE string.
    METHODS utf8
      IMPORTING
        iv_hex         TYPE xstring
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS ltcl_annotations IMPLEMENTATION.

  METHOD setup.
    zcl_oao_registry=>register( iv_service = 'ZOSD_H5X_SRV'
                                iv_mpc     = 'ZCL_OSD_H5X_MPC'
                                iv_dpc     = 'ZCL_OSD_H5X_DPC' ).
    zcl_stg_model_info=>clear( ).
  ENDMETHOD.

  METHOD metadata.
    DATA lt_options  TYPE tihttpnvp.
    DATA ls_option   TYPE ihttpnvp.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    IF iv_language IS NOT INITIAL.
      ls_option-name  = 'sap-language'.
      ls_option-value = iv_language.
      APPEND ls_option TO lt_options.
    ENDIF.
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_metadata
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    rv_body = ls_response-body.
  ENDMETHOD.

  METHOD element.
    DATA lv_from TYPE i.
    DATA lv_end  TYPE i.
    DATA lv_rest TYPE string.

    FIND FIRST OCCURRENCE OF iv_start IN iv_body MATCH OFFSET lv_from.
    cl_abap_unit_assert=>assert_subrc( exp = 0
                                       msg = |{ iv_start } not in $metadata| ).
    lv_rest = iv_body+lv_from.
    FIND FIRST OCCURRENCE OF '>' IN lv_rest MATCH OFFSET lv_end.
    rv_xml = lv_rest(lv_end).
  ENDMETHOD.

  METHOD has.
    cl_abap_unit_assert=>assert_true( act = boolc( iv_body CS iv_text )
                                      msg = |expected { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD lacks.
    cl_abap_unit_assert=>assert_false( act = boolc( iv_body CS iv_text )
                                       msg = |did not expect { iv_text } in { iv_body }| ).
  ENDMETHOD.

  METHOD utf8.
    rv_text = cl_abap_codepage=>convert_from( iv_hex ).
  ENDMETHOD.

  METHOD text_pool_labels.
* set_label_from_text_element resolves the class's text symbol: 001 on a
* property, 002 on a function import parameter -- not the ABAP field name
* the library used to write, and not the data element's label either
    DATA lv_body TYPE string.

    lv_body = metadata( ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="ItemNo"` )
         iv_text = `sap:label="Line Item"` ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Parameter Name="ItemNo"` )
         iv_text = `sap:label="Item to Release"` ).
  ENDMETHOD.

  METHOD dictionary_labels.
* no text element: the medium field label of the component's data element,
* through an include too; a component without a data element has none --
* never the ABAP field name (a system writes no sap:label then)
    DATA lv_body TYPE string.

    lv_body = metadata( ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="Amount"` )
         iv_text = `sap:label="Gross Amount"` ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="ChangedBy"` )
         iv_text = `sap:label="Changed By"` ).
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="Note"` )
           iv_text = `sap:label=` ).
* the twin's address type is bound to a local type: nothing to derive
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="City"` )
           iv_text = `sap:label=` ).
  ENDMETHOD.

  METHOD units_and_semantics.
* an amount or a quantity: sap:unit names the property bound to its
* reference field; a currency key and a unit get their semantics; a date
* gets no sap:display-format (the system writes none)
    DATA lv_body     TYPE string.
    DATA lv_currency TYPE string.
    DATA lv_from     TYPE i.

    lv_body = metadata( ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="Amount"` )
         iv_text = `sap:unit="Currency"` ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="Quantity"` )
         iv_text = `sap:unit="QuantityUnit"` ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="Currency"` )
         iv_text = `sap:semantics="currency-code"` ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="QuantityUnit"` )
         iv_text = `sap:semantics="unit-of-measure"` ).
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="Currency"` )
           iv_text = `sap:unit=` ).
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="DeliveryDate"` )
           iv_text = `sap:display-format` ).
* a type of the class: RTTI names the data element of the component
* (searched from VH_Currency on: VH_Country has a Code property too)
    FIND FIRST OCCURRENCE OF `<EntityType Name="VH_Currency"` IN lv_body MATCH OFFSET lv_from.
    cl_abap_unit_assert=>assert_subrc( exp = 0
                                       msg = `VH_Currency not in $metadata` ).
    lv_currency = lv_body+lv_from.
    has( iv_body = element( iv_body  = lv_currency
                            iv_start = `<Property Name="Code"` )
         iv_text = `sap:semantics="currency-code"` ).
    lacks( iv_body = element( iv_body  = lv_currency
                              iv_start = `<Property Name="Text"` )
           iv_text = `sap:semantics` ).
  ENDMETHOD.

  METHOD unicode_as_the_model_says.
* sap:unicode="false" where the model added the annotation, nothing where
* it did not (a complex type's properties on a system)
    DATA lv_body TYPE string.

    lv_body = metadata( ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="ItemNo"` )
         iv_text = `sap:unicode="false"` ).
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="Note"` )
           iv_text = `sap:unicode` ).
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="City"` )
           iv_text = `sap:unicode` ).
  ENDMETHOD.

  METHOD labels_in_the_request_language.
* sap-language=DE: the texts that exist in German, and nothing for those
* that do not -- no English, and a text symbol without German does not
* fall back to the data element's German label (measured on the system)
    DATA lv_body TYPE string.
    DATA lv_langu TYPE sy-langu.

    lv_langu = sy-langu.
    lv_body = metadata( 'DE' ).
    has( iv_body = lv_body
         iv_text = `xml:lang="de"` ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="Currency"` )
         iv_text = |sap:label="W{ utf8( 'C3A4' ) }hrung"| ).
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Parameter Name="ItemNo"` )
         iv_text = `sap:label="Freizugebende Position"` ).
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="ItemNo"` )
           iv_text = `sap:label=` ).
    lacks( iv_body = element( iv_body  = lv_body
                              iv_start = `<Property Name="Amount"` )
           iv_text = `sap:label=` ).
* the request's language ends with the request
    cl_abap_unit_assert=>assert_equals( act = sy-langu
                                        exp = lv_langu ).
    has( iv_body = element( iv_body  = metadata( )
                            iv_start = `<Property Name="Currency"` )
         iv_text = `sap:label="Currency"` ).
    has( iv_body = metadata( )
         iv_text = `xml:lang="en"` ).
  ENDMETHOD.

  METHOD accept_language.
* without sap-language the first tag of Accept-Language; sap-language wins;
* a wildcard or an unknown language is none
    DATA lt_options  TYPE tihttpnvp.
    DATA lt_headers  TYPE tihttpnvp.
    DATA ls_pair     TYPE ihttpnvp.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_pair-name  = 'Accept-Language'.
    ls_pair-value = 'de-DE,de;q=0.9,en;q=0.8'.
    APPEND ls_pair TO lt_headers.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_session_langu=>requested( it_headers = lt_headers )
                                        exp = 'D' ).
    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = c_metadata
                                                it_headers = lt_headers ).
    has( iv_body = element( iv_body  = ls_response-body
                            iv_start = `<Parameter Name="ItemNo"` )
         iv_text = `sap:label="Freizugebende Position"` ).
    ls_pair-name  = 'sap-language'.
    ls_pair-value = 'EN'.
    APPEND ls_pair TO lt_options.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_session_langu=>requested( it_options = lt_options
                                                                                it_headers = lt_headers )
                                        exp = 'E' ).
    CLEAR lt_headers.
    ls_pair-name  = 'accept-language'.
    ls_pair-value = '*'.
    APPEND ls_pair TO lt_headers.
    cl_abap_unit_assert=>assert_initial( zcl_osd_session_langu=>requested( it_headers = lt_headers ) ).
  ENDMETHOD.

  METHOD class_pool_container.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_textpool=>program_of( 'ZCL_OSD_H5X_MPC===============CP' )
                                        exp = `ZCL_OSD_H5X_MPC` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_textpool=>program_of( 'ZOSD_TEST_DEMO_PROG' )
                                        exp = `ZOSD_TEST_DEMO_PROG` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_textpool=>text_symbol( iv_container = 'ZCL_OSD_H5X_MPC===============CP'
                                                                             iv_symbol    = '001'
                                                                             iv_langu     = 'E' )
                                        exp = `Line Item` ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_textpool=>text_symbol( iv_container = 'ZCL_OSD_H5X_MPC===============CP'
                                                                        iv_symbol    = '001'
                                                                        iv_langu     = 'D' ) ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_literals DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* A value in a $filter is data for everything after the escaper as well.
* The runtime's dynamic WHERE and the database clients ran their rewrites
* (EQ, field symbols, ~, DESCENDING, LIMIT 0, UP TO n ROWS) over the whole
* statement, literals included (ANORMALIES.md, "SQL literals re-read as
* statement text"). Each value below is a partner's name, and beside it is
* the name the old rewrite made of it, so a rewrite that still reads the
* value finds the decoy's row instead of none.
  PRIVATE SECTION.
    CONSTANTS c_base TYPE string VALUE '/sap/opu/odata/OSDNS/ZOSD_H5X_SRV/PartnerSet'.

    METHODS setup.
    METHODS each_value_finds_its_row FOR TESTING RAISING cx_static_check.
    METHODS up_to_in_value_limits_nothing FOR TESTING RAISING cx_static_check.

    METHODS add
      IMPORTING
        iv_id   TYPE string
        iv_name TYPE string.
    METHODS get
      IMPORTING
        iv_path            TYPE string
        iv_filter          TYPE string
      RETURNING
        VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
ENDCLASS.

CLASS ltcl_literals IMPLEMENTATION.

  METHOD setup.
    DATA ls_ad TYPE zosd_h5x_ad.

    DELETE FROM zosd_h5x_bp.
    DELETE FROM zosd_h5x_ad.
    ls_ad-client = sy-mandt.
    ls_ad-node_key = 'A1'.
    ls_ad-city = 'Alpha City'.
    ls_ad-country = 'AA'.
    INSERT zosd_h5x_ad FROM ls_ad.

    add( iv_id = `0000000101` iv_name = `a~b` ).
    add( iv_id = `0000000102` iv_name = `a.b` ).
    add( iv_id = `0000000103` iv_name = `A EQ B` ).
    add( iv_id = `0000000104` iv_name = `A = B` ).
    add( iv_id = `0000000105` iv_name = `x DESCENDING` ).
    add( iv_id = `0000000106` iv_name = `x DESC` ).
    add( iv_id = `0000000107` iv_name = `x UP TO 9 ROWS` ).
    add( iv_id = `0000000108` iv_name = `x` ).
    add( iv_id = `0000000109` iv_name = `x LIMIT 0` ).
    add( iv_id = `0000000110` iv_name = `q <ls_key> r` ).
    add( iv_id = `0000000111` iv_name = `O'Hara` ).
    add( iv_id = `0000000112` iv_name = `a``b` ).
    add( iv_id = `0000000113` iv_name = `--x` ).
    add( iv_id = `0000000114` iv_name = `a;b` ).

    zcl_oao_registry=>register( iv_service = 'ZOSD_H5X_SRV'
                                iv_mpc     = 'ZCL_OSD_H5X_MPC'
                                iv_dpc     = 'ZCL_OSD_H5X_DPC' ).
    zcl_stg_model_info=>clear( ).
  ENDMETHOD.

  METHOD add.
    DATA ls_bp TYPE zosd_h5x_bp.

    ls_bp-client = sy-mandt.
    ls_bp-partner_id = iv_id.
    ls_bp-name = iv_name.
    ls_bp-addr_key = 'A1'.
    INSERT zosd_h5x_bp FROM ls_bp.
  ENDMETHOD.

  METHOD get.
* the option is built here and not parsed from a query string: a value may
* hold = and ;, which is the point of the test
    DATA lt_options TYPE tihttpnvp.
    DATA ls_option LIKE LINE OF lt_options.

    ls_option-name = '$filter'.
    ls_option-value = iv_filter.
    APPEND ls_option TO lt_options.
    rs_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = iv_path
                                                it_options = lt_options ).
  ENDMETHOD.

  METHOD each_value_finds_its_row.
    TYPES: BEGIN OF ty_case,
             value TYPE string,
             id    TYPE string,
           END OF ty_case.
    DATA lt_case TYPE STANDARD TABLE OF ty_case WITH DEFAULT KEY.
    DATA ls_case TYPE ty_case.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_filter TYPE string.

* the value as an OData literal writes a quote twice
    ls_case-value = `a~b`.
    ls_case-id = `0000000101`.
    APPEND ls_case TO lt_case.
    ls_case-value = `A EQ B`.
    ls_case-id = `0000000103`.
    APPEND ls_case TO lt_case.
    ls_case-value = `x DESCENDING`.
    ls_case-id = `0000000105`.
    APPEND ls_case TO lt_case.
    ls_case-value = `x UP TO 9 ROWS`.
    ls_case-id = `0000000107`.
    APPEND ls_case TO lt_case.
    ls_case-value = `x LIMIT 0`.
    ls_case-id = `0000000109`.
    APPEND ls_case TO lt_case.
    ls_case-value = `q <ls_key> r`.
    ls_case-id = `0000000110`.
    APPEND ls_case TO lt_case.
    ls_case-value = `O''Hara`.
    ls_case-id = `0000000111`.
    APPEND ls_case TO lt_case.
    ls_case-value = `a``b`.
    ls_case-id = `0000000112`.
    APPEND ls_case TO lt_case.
    ls_case-value = `--x`.
    ls_case-id = `0000000113`.
    APPEND ls_case TO lt_case.
    ls_case-value = `a;b`.
    ls_case-id = `0000000114`.
    APPEND ls_case TO lt_case.

    LOOP AT lt_case INTO ls_case.
      lv_filter = `Name eq '` && ls_case-value && `'`.
      ls_response = get( iv_path   = c_base && `/$count`
                         iv_filter = lv_filter ).
      cl_abap_unit_assert=>assert_equals( act = ls_response-body
                                          exp = `1`
                                          msg = |{ lv_filter }: { ls_response-body }| ).
      ls_response = get( iv_path   = c_base
                         iv_filter = lv_filter ).
      cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                          exp = 200
                                          msg = |{ lv_filter }: { ls_response-body }| ).
      cl_abap_unit_assert=>assert_true(
        act = boolc( ls_response-body CS `"PartnerID":"` && ls_case-id && `"` )
        msg = |{ lv_filter }: { ls_response-body }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD up_to_in_value_limits_nothing.
* a value naming a row count appends no LIMIT: every partner comes back
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path   = c_base
                       iv_filter = `Name eq 'x UP TO 1 ROWS' or PartnerID ge '0000000000'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( act = boolc( ls_response-body CS `"PartnerID":"0000000101"` )
                                      msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( act = boolc( ls_response-body CS `"PartnerID":"0000000114"` )
                                      msg = ls_response-body ).
  ENDMETHOD.

ENDCLASS.
