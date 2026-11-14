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
    DATA lv_body TYPE string.

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
    has( iv_body = element( iv_body  = lv_body
                            iv_start = `<Property Name="Code"` )
         iv_text = `sap:semantics="currency-code"` ).
    lacks( iv_body = element( iv_body  = lv_body
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
