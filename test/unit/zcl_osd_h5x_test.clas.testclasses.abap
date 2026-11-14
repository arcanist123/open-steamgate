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

CLASS ltcl_read IMPLEMENTATION.

  METHOD setup.
    DATA lt_bp TYPE STANDARD TABLE OF zosd_h5x_bp WITH DEFAULT KEY.
    DATA ls_bp TYPE zosd_h5x_bp.
    DATA lt_ad TYPE STANDARD TABLE OF zosd_h5x_ad WITH DEFAULT KEY.
    DATA ls_ad TYPE zosd_h5x_ad.

    DELETE FROM zosd_h5x_bp.
    DELETE FROM zosd_h5x_ad.

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
                                        exp = '2' ).
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

ENDCLASS.
