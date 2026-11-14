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

    DELETE FROM zosd_h5x_bp.
    DELETE FROM zosd_h5x_ad.
    DELETE FROM zosd_h5x_so.
    DELETE FROM zosd_h5x_soi.
    DELETE FROM zosd_h5x_ct.

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

ENDCLASS.
