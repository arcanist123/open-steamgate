CLASS ltcl_base DEFINITION FOR TESTING ABSTRACT.
* what every case of the twin needs: the service registered, a GET through
* the dispatcher, and assertions on the body
  PROTECTED SECTION.
    CONSTANTS c_srv TYPE string VALUE '/sap/opu/odata/sap/ZOSD_M4A_SRV/'.

    METHODS register.
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

CLASS ltcl_base IMPLEMENTATION.

  METHOD register.
    zcl_oao_registry=>register( iv_service = 'ZOSD_M4A_SRV'
                                iv_mpc     = 'ZCL_OSD_M4A_MPC'
                                iv_dpc     = 'ZCL_OSD_M4A_DPC' ).
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

ENDCLASS.

CLASS ltcl_metadata DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL
  INHERITING FROM ltcl_base.
* The model members, observed where a client reads them: $metadata. The
* expected forms are the ones a system writes for service A
* (attribute names, their place among the others).
  PRIVATE SECTION.
    DATA mv_xml TYPE string.

    METHODS setup.
    METHODS thing_type FOR TESTING RAISING cx_static_check.
    METHODS type_label FOR TESTING RAISING cx_static_check.
    METHODS set_label FOR TESTING RAISING cx_static_check.
    METHODS association_label FOR TESTING RAISING cx_static_check.
    METHODS navigation_label FOR TESTING RAISING cx_static_check.
    METHODS function_import_label FOR TESTING RAISING cx_static_check.
    METHODS unit_property FOR TESTING RAISING cx_static_check.
    METHODS title_keeps_content FOR TESTING RAISING cx_static_check.
    METHODS updated_not_kept FOR TESTING RAISING cx_static_check.
    METHODS features_keep_medium_label FOR TESTING RAISING cx_static_check.
    METHODS disabled_property FOR TESTING RAISING cx_static_check.
    METHODS disabled_set FOR TESTING RAISING cx_static_check.
    METHODS disabled_type FOR TESTING RAISING cx_static_check.
    METHODS disabled_association FOR TESTING RAISING cx_static_check.
    METHODS disabled_navigation FOR TESTING RAISING cx_static_check.
    METHODS disabled_constraint FOR TESTING RAISING cx_static_check.
    METHODS disabled_assoc_set FOR TESTING RAISING cx_static_check.
    METHODS disabled_action FOR TESTING RAISING cx_static_check.
    METHODS disabled_parameter FOR TESTING RAISING cx_static_check.
    METHODS assoc_set_named_by_model FOR TESTING RAISING cx_static_check.
    METHODS absent_names_raise FOR TESTING RAISING cx_static_check.
* fix round: a disabled endpoint leaves nothing that names it
    METHODS endpoint_type_disabled FOR TESTING RAISING cx_static_check.
    METHODS endpoint_set_disabled FOR TESTING RAISING cx_static_check.
    METHODS model_info_no_dangling FOR TESTING RAISING cx_static_check.

* the text of one element, from its start tag to its end tag
    METHODS element
      IMPORTING
        iv_start       TYPE string
        iv_end         TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS ltcl_metadata IMPLEMENTATION.

  METHOD setup.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    register( ).
    ls_response = get( '$metadata' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200
                                        msg = ls_response-body ).
    mv_xml = ls_response-body.
  ENDMETHOD.

  METHOD element.
    DATA lv_from TYPE i.
    DATA lv_rest TYPE string.
    DATA lv_to   TYPE i.

    FIND FIRST OCCURRENCE OF iv_start IN mv_xml MATCH OFFSET lv_from.
    cl_abap_unit_assert=>assert_subrc( exp = 0
                                       msg = |no { iv_start } in { mv_xml }| ).
    lv_rest = mv_xml+lv_from.
    FIND FIRST OCCURRENCE OF iv_end IN lv_rest MATCH OFFSET lv_to.
    cl_abap_unit_assert=>assert_subrc( exp = 0
                                       msg = |no { iv_end } after { iv_start }| ).
    rv_text = lv_rest(lv_to).
  ENDMETHOD.

  METHOD thing_type.
* set_is_thing_type: on the type that set it, and only there
    has( iv_body = element( iv_start = '<EntityType Name="Order"'
                            iv_end   = '>' )
         iv_text = ` sap:is-thing-type="true"` ).
    lacks( iv_body = element( iv_start = '<EntityType Name="Item"'
                              iv_end   = '>' )
           iv_text = `sap:is-thing-type` ).
  ENDMETHOD.

  METHOD type_label.
    has( iv_body = element( iv_start = '<EntityType Name="Order"'
                            iv_end   = '>' )
         iv_text = ` sap:label="Widget"` ).
  ENDMETHOD.

  METHOD set_label.
* on the EntitySet, between EntityType and the sap: booleans
    has( iv_body = mv_xml
         iv_text = `<EntitySet Name="Orders" EntityType="ZOSD_M4A_SRV.Order" sap:label="Widgets" sap:creatable=` ).
    lacks( iv_body = element( iv_start = '<EntitySet Name="Items"'
                              iv_end   = '/>' )
           iv_text = `sap:label` ).
  ENDMETHOD.

  METHOD association_label.
* after sap:content-version, as a system writes it
    has( iv_body = mv_xml
         iv_text = `<Association Name="OrderItems" sap:content-version="1" sap:label="Order to its items">` ).
  ENDMETHOD.

  METHOD navigation_label.
    has( iv_body = element( iv_start = '<NavigationProperty Name="Items"'
                            iv_end   = '/>' )
         iv_text = ` sap:label="Items of the order"` ).
  ENDMETHOD.

  METHOD function_import_label.
    has( iv_body = mv_xml
         iv_text = `<FunctionImport Name="Approve" ReturnType="ZOSD_M4A_SRV.Order" EntitySet="Orders" m:HttpMethod="POST" sap:label="Approve the order"` ).
  ENDMETHOD.

  METHOD unit_property.
* set_unit_property on a property the dictionary binds to nothing
    has( iv_body = element( iv_start = '<Property Name="Amount"'
                            iv_end   = '/>' )
         iv_text = ` Precision="15" Scale="2" sap:unit="Currency"` ).
  ENDMETHOD.

  METHOD title_keeps_content.
* after the facets, before the sap: annotations
    has( iv_body = element( iv_start = '<Property Name="Title"'
                            iv_end   = '/>' )
         iv_text = ` MaxLength="40" m:FC_TargetPath="SyndicationTitle" m:FC_KeepInContent="true" sap:creatable=` ).
  ENDMETHOD.

  METHOD updated_not_kept.
    has( iv_body = element( iv_start = '<Property Name="ChangedAt"'
                            iv_end   = '/>' )
         iv_text = ` Precision="7" m:FC_TargetPath="SyndicationUpdated" m:FC_KeepInContent="false"` ).
  ENDMETHOD.

  METHOD features_keep_medium_label.
* the model asked for long labels; service A did too, and a
* system answered its properties with the medium label all the same
    DATA lo_mpc      TYPE REF TO /iwbep/cl_mgw_push_abs_model.
    DATA lo_model    TYPE REF TO zcl_oao_model.
    DATA ls_features TYPE /iwbep/if_mgw_odata_model=>ty_s_model_features.

    has( iv_body = element( iv_start = '<Property Name="ChangedBy"'
                            iv_end   = '/>' )
         iv_text = ` sap:label="Changed By"` ).
    lacks( iv_body = mv_xml
           iv_text = `Last Changed By` ).
    lo_mpc = zcl_oao_registry=>create_mpc( 'ZOSD_M4A_SRV' ).
    lo_mpc->define( ).
    lo_model ?= lo_mpc->model.
    ls_features = lo_model->get_model_features( ).
    cl_abap_unit_assert=>assert_equals( act = ls_features-use_long_label_for_property
                                        exp = abap_true ).
  ENDMETHOD.

  METHOD disabled_property.
    lacks( iv_body = mv_xml
           iv_text = `<Property Name="Hidden"` ).
    has( iv_body = mv_xml
         iv_text = `<Property Name="Currency"` ).
  ENDMETHOD.

  METHOD disabled_set.
    lacks( iv_body = mv_xml
           iv_text = `<EntitySet Name="OrdersHidden"` ).
  ENDMETHOD.

  METHOD disabled_type.
* the type and its set
    lacks( iv_body = mv_xml
           iv_text = `<EntityType Name="Gone"` ).
    lacks( iv_body = mv_xml
           iv_text = `<EntitySet Name="GoneSet"` ).
  ENDMETHOD.

  METHOD disabled_association.
    lacks( iv_body = mv_xml
           iv_text = `<Association Name="OrderGone"` ).
    lacks( iv_body = mv_xml
           iv_text = `OrderGone_AssocSet` ).
  ENDMETHOD.

  METHOD disabled_navigation.
    lacks( iv_body = mv_xml
           iv_text = `<NavigationProperty Name="ItemsHidden"` ).
    has( iv_body = mv_xml
         iv_text = `<NavigationProperty Name="Items"` ).
  ENDMETHOD.

  METHOD disabled_constraint.
* the association stays, without its referential constraint
    lacks( iv_body = element( iv_start = '<Association Name="OrderItemsNoRc"'
                              iv_end   = '</Association>' )
           iv_text = `ReferentialConstraint` ).
    has( iv_body = element( iv_start = '<Association Name="OrderItems"'
                            iv_end   = '</Association>' )
         iv_text = `<ReferentialConstraint>` ).
  ENDMETHOD.

  METHOD disabled_assoc_set.
* the set goes, its association stays
    lacks( iv_body = mv_xml
           iv_text = `OrderStamp_AssocSet` ).
    has( iv_body = mv_xml
         iv_text = `<Association Name="OrderStamp"` ).
  ENDMETHOD.

  METHOD disabled_action.
    lacks( iv_body = mv_xml
           iv_text = `<FunctionImport Name="Drop"` ).
  ENDMETHOD.

  METHOD disabled_parameter.
    lacks( iv_body = mv_xml
           iv_text = `<Parameter Name="Note"` ).
    has( iv_body = mv_xml
         iv_text = `<Parameter Name="OrderId"` ).
  ENDMETHOD.

  METHOD assoc_set_named_by_model.
* create_assoc_set: the model's name, between the ends' default sets, and no
* derived set beside it
    has( iv_body = mv_xml
         iv_text = `<AssociationSet Name="OrderItemsNoRcSet" Association="ZOSD_M4A_SRV.OrderItemsNoRc"` ).
    has( iv_body = element( iv_start = '<AssociationSet Name="OrderItemsNoRcSet"'
                            iv_end   = '</AssociationSet>' )
         iv_text = `<End EntitySet="Orders" Role="FromRole_OrderItemsNoRc"/>` ).
    has( iv_body = element( iv_start = '<AssociationSet Name="OrderItemsNoRcSet"'
                            iv_end   = '</AssociationSet>' )
         iv_text = `<End EntitySet="Items" Role="ToRole_OrderItemsNoRc"/>` ).
    lacks( iv_body = mv_xml
           iv_text = `OrderItemsNoRc_AssocSet` ).
  ENDMETHOD.

  METHOD endpoint_type_disabled.
* the association to the disabled type, its derived set, the navigation
* over it and the function import answering with the type all go: nothing
* in the document names the type
    lacks( iv_body = mv_xml
           iv_text = `<Association Name="OrderGoneKept"` ).
    lacks( iv_body = mv_xml
           iv_text = `OrderGoneKept_AssocSet` ).
    lacks( iv_body = mv_xml
           iv_text = `<NavigationProperty Name="GoneNav"` ).
    lacks( iv_body = mv_xml
           iv_text = `<FunctionImport Name="Archive"` ).
    lacks( iv_body = mv_xml
           iv_text = `ZOSD_M4A_SRV.Gone"` ).
  ENDMETHOD.

  METHOD endpoint_set_disabled.
* the set goes and so does every association set ending in it; the
* association and its navigation stay (both types are enabled)
    lacks( iv_body = mv_xml
           iv_text = `<EntitySet Name="Parts"` ).
    lacks( iv_body = mv_xml
           iv_text = `EntitySet="Parts"` ).
    lacks( iv_body = mv_xml
           iv_text = `OrderParts_AssocSet` ).
    has( iv_body = mv_xml
         iv_text = `<Association Name="OrderParts"` ).
    has( iv_body = mv_xml
         iv_text = `<NavigationProperty Name="Parts"` ).
  ENDMETHOD.

  METHOD model_info_no_dangling.
* the model info the dispatcher routes by: no disabled set, and every
* navigation's target set (when it has one) is a set of the service
    DATA ls_service TYPE zcl_stg_model_info=>ty_service.
    DATA ls_set     LIKE LINE OF ls_service-entity_sets.
    DATA ls_nav     TYPE zcl_stg_model_info=>ty_nav.

    ls_service = zcl_stg_model_info=>get( 'ZOSD_M4A_SRV' ).
    LOOP AT ls_service-entity_sets INTO ls_set.
      cl_abap_unit_assert=>assert_false(
        act = boolc( ls_set-name = 'Parts' OR ls_set-name = 'GoneSet' OR ls_set-name = 'OrdersHidden' )
        msg = |disabled set { ls_set-name } in the model info| ).
      LOOP AT ls_set-navs INTO ls_nav.
        cl_abap_unit_assert=>assert_differs( act = ls_nav-name
                                             exp = 'GoneNav' ).
        IF ls_nav-target_set IS NOT INITIAL.
          READ TABLE ls_service-entity_sets WITH KEY name = ls_nav-target_set TRANSPORTING NO FIELDS.
          cl_abap_unit_assert=>assert_subrc(
            exp = 0
            msg = |{ ls_set-name }/{ ls_nav-name } leads to { ls_nav-target_set }, not a set of the service| ).
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD absent_names_raise.
* every getter asked for a name the model lacks raised the med exception
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_m4a_mpc=>gv_absent_raised
                                        exp = 8 ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_request DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL
  INHERITING FROM ltcl_base.
* The request-context members, asked by the twin's provider during a real
* request: each must answer what the request carried.
  PRIVATE SECTION.
    METHODS setup.
    METHODS search_string FOR TESTING RAISING cx_static_check.
    METHODS select_adds_keys FOR TESTING RAISING cx_static_check.
    METHODS select_nothing_is_all FOR TESTING RAISING cx_static_check.
    METHODS select_star_is_all FOR TESTING RAISING cx_static_check.
    METHODS select_on_single_read FOR TESTING RAISING cx_static_check.
    METHODS source_type_on_navigation FOR TESTING RAISING cx_static_check.
    METHODS source_type_direct_empty FOR TESTING RAISING cx_static_check.
    METHODS skiptoken FOR TESTING RAISING cx_static_check.
    METHODS select_disabled_property FOR TESTING RAISING cx_static_check.
    METHODS update_facet_type_name FOR TESTING RAISING cx_static_check.
    METHODS ok
      IMPORTING
        is_response TYPE zcl_stg_dispatcher=>ty_response.
ENDCLASS.

CLASS ltcl_request IMPLEMENTATION.

  METHOD setup.
    register( ).
  ENDMETHOD.

  METHOD ok.
    cl_abap_unit_assert=>assert_equals( act = is_response-status
                                        exp = 200
                                        msg = is_response-body ).
  ENDMETHOD.

  METHOD search_string.
    ok( get( iv_path  = 'Orders'
             iv_query = 'search=abc' ) ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_m4a_dpc=>gs_seen-search
                                        exp = 'abc' ).
  ENDMETHOD.

  METHOD select_adds_keys.
* OData names in the URL, ABAP names out, the key added
    ok( get( iv_path  = 'Orders'
             iv_query = '$select=Title,Amount' ) ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_m4a_dpc=>gs_seen-selected
                                        exp = 'AMOUNT ORDER_ID TITLE' ).
  ENDMETHOD.

  METHOD select_nothing_is_all.
    ok( get( 'Orders' ) ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_m4a_dpc=>gs_seen-selected ).
  ENDMETHOD.

  METHOD select_star_is_all.
    ok( get( iv_path  = 'Orders'
             iv_query = '$select=*' ) ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_m4a_dpc=>gs_seen-selected ).
  ENDMETHOD.

  METHOD select_on_single_read.
    ok( get( iv_path  = `Orders('1')`
             iv_query = '$select=Title' ) ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_m4a_dpc=>gs_seen-selected
                                        exp = 'ORDER_ID TITLE' ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_m4a_dpc=>gs_seen-source_type ).
  ENDMETHOD.

  METHOD source_type_on_navigation.
    ok( get( `Orders('1')/Items` ) ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_m4a_dpc=>gs_seen-entity_set
                                        exp = 'Items' ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_m4a_dpc=>gs_seen-source_type
                                        exp = 'Order' ).
  ENDMETHOD.

  METHOD source_type_direct_empty.
    ok( get( 'Items' ) ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_m4a_dpc=>gs_seen-source_type ).
  ENDMETHOD.

  METHOD select_disabled_property.
* a disabled property is not a property of the set: $select naming it is
* refused like an unknown name (400, before the provider runs), and
* get_select_with_mandtry_fields can never name it
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    CLEAR zcl_osd_m4a_dpc=>gs_seen.
    ls_response = get( iv_path  = 'Orders'
                       iv_query = '$select=Hidden' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400 ).
    has( iv_body = ls_response-body
         iv_text = `STG/PROPERTY_NOT_FOUND` ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_m4a_dpc=>gs_seen-entity_set ).
  ENDMETHOD.

  METHOD skiptoken.
* the context answers the skip token it holds; the dispatcher does not fill
* it yet (the PR that brought the getter names the line), so this is the
* getter's own contract
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lo_set     TYPE REF TO /iwbep/if_mgw_req_entityset.

    CREATE OBJECT lo_context.
    lo_context->mv_skiptoken = '20'.
    lo_set = lo_context.
    cl_abap_unit_assert=>assert_equals( act = lo_set->get_skiptoken( )
                                        exp = '20' ).
  ENDMETHOD.

  METHOD update_facet_type_name.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lo_update  TYPE REF TO /iwbep/if_mgw_req_entity_u.

    CREATE OBJECT lo_context.
    lo_context->mv_entity_type = 'Order'.
    lo_update = lo_context.
    cl_abap_unit_assert=>assert_equals( act = lo_update->get_entity_type_name( )
                                        exp = 'Order' ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_exceptions DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL
  INHERITING FROM ltcl_base.
* The exception and message-container members: what the exceptions carry,
* and what reaches the error response.
  PRIVATE SECTION.
    METHODS setup.
    METHODS not_found_code_and_type FOR TESTING RAISING cx_static_check.
    METHODS filter_param_is_variable FOR TESTING RAISING cx_static_check.
    METHODS http_status_carried FOR TESTING RAISING cx_static_check.
    METHODS exception_container_answers FOR TESTING RAISING cx_static_check.
    METHODS container_given_is_kept FOR TESTING RAISING cx_static_check.
    METHODS tech_missing_authorization FOR TESTING RAISING cx_static_check.
    METHODS constants FOR TESTING RAISING cx_static_check.
    METHODS container_reset FOR TESTING RAISING cx_static_check.
    METHODS container_from_exception FOR TESTING RAISING cx_static_check.
    METHODS container_without_previous FOR TESTING RAISING cx_static_check.
    METHODS container_entity_parameters FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_exceptions IMPLEMENTATION.

  METHOD setup.
    register( ).
  ENDMETHOD.

  METHOD not_found_code_and_type.
* the Gateway's own message for a resource it does not find, its variable
* the entity type (a system answers /IWBEP/CM_MGW_RT/020)
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lx_busi     TYPE REF TO /iwbep/cx_mgw_busi_exception.

    ls_response = get( iv_path  = 'Orders'
                       iv_query = 'search=notfound' ).
    has( iv_body = ls_response-body
         iv_text = `/IWBEP/CM_MGW_RT/020` ).
    CREATE OBJECT lx_busi
      EXPORTING
        textid      = /iwbep/cx_mgw_busi_exception=>resource_not_found
        entity_type = 'Order'.
    cl_abap_unit_assert=>assert_equals( act = lx_busi->entity_type
                                        exp = 'Order' ).
    cl_abap_unit_assert=>assert_equals( act = lx_busi->if_t100_message~t100key-attr1
                                        exp = 'ENTITY_TYPE' ).
  ENDMETHOD.

  METHOD filter_param_is_variable.
    DATA lx_busi TYPE REF TO /iwbep/cx_mgw_busi_exception.

    CREATE OBJECT lx_busi
      EXPORTING
        textid       = /iwbep/cx_mgw_busi_exception=>filter_not_supported
        filter_param = 'Title'.
    cl_abap_unit_assert=>assert_equals( act = lx_busi->filter_param
                                        exp = 'Title' ).
    cl_abap_unit_assert=>assert_equals( act = lx_busi->if_t100_message~t100key-attr1
                                        exp = 'FILTER_PARAM' ).
  ENDMETHOD.

  METHOD http_status_carried.
* a subclass sets it in its constructor; the constructor takes it too
    DATA lx_busi TYPE REF TO /iwbep/cx_mgw_busi_exception.
    DATA lx_tech TYPE REF TO /iwbep/cx_mgw_tech_exception.

    CREATE OBJECT lx_busi
      EXPORTING
        http_status_code = /iwbep/cx_mgw_busi_exception=>gcs_http_status_codes-not_found.
    cl_abap_unit_assert=>assert_equals( act = lx_busi->http_status_code
                                        exp = 404 ).
    CREATE OBJECT lx_tech.
    cl_abap_unit_assert=>assert_equals( act = lx_tech->http_status_code
                                        exp = 0 ).
  ENDMETHOD.

  METHOD exception_container_answers.
* what the provider added through the exception's container reaches the
* error response with the exception
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = get( iv_path  = 'Orders'
                       iv_query = 'search=container' ).
    has( iv_body = ls_response-body
         iv_text = `Added through the exception container` ).
    has( iv_body = ls_response-body
         iv_text = `Order refused` ).
  ENDMETHOD.

  METHOD container_given_is_kept.
    DATA lo_given TYPE REF TO /iwbep/if_message_container.
    DATA lx_busi  TYPE REF TO /iwbep/cx_mgw_busi_exception.

    CREATE OBJECT lo_given TYPE zcl_oao_msg_container.
    CREATE OBJECT lx_busi
      EXPORTING
        message_container = lo_given.
    cl_abap_unit_assert=>assert_true( act = boolc( lx_busi->get_msg_container( ) = lo_given ) ).
    CREATE OBJECT lx_busi.
    cl_abap_unit_assert=>assert_true(
      act = boolc( lx_busi->get_msg_container( ) = /iwbep/cl_mgw_msg_container=>get_mgw_msg_container( ) ) ).
  ENDMETHOD.

  METHOD tech_missing_authorization.
    DATA lx_tech TYPE REF TO /iwbep/cx_mgw_tech_exception.

    CREATE OBJECT lx_tech
      EXPORTING
        textid                = /iwbep/cx_mgw_tech_exception=>missing_authorization
        entity_type           = 'Order'
        internal_service_name = 'ZOSD_M4A_SRV'
        http_status_code      = /iwbep/cx_mgw_tech_exception=>gcs_http_status_codes-forbidden.
    cl_abap_unit_assert=>assert_equals( act = lx_tech->entity_type
                                        exp = 'Order' ).
    cl_abap_unit_assert=>assert_equals( act = lx_tech->internal_service_name
                                        exp = 'ZOSD_M4A_SRV' ).
    cl_abap_unit_assert=>assert_equals( act = lx_tech->http_status_code
                                        exp = 403 ).
    cl_abap_unit_assert=>assert_equals( act = lx_tech->if_t100_message~t100key-attr2
                                        exp = 'INTERNAL_SERVICE_NAME' ).
  ENDMETHOD.

  METHOD constants.
* the trivial ones, grouped: HTTP codes by name and the text ids' class
    cl_abap_unit_assert=>assert_equals( act = /iwbep/cx_mgw_busi_exception=>gcs_http_status_codes-bad_request
                                        exp = 400 ).
    cl_abap_unit_assert=>assert_equals( act = /iwbep/cx_mgw_busi_exception=>gcs_http_status_codes-precondition_failed
                                        exp = 412 ).
    cl_abap_unit_assert=>assert_equals( act = /iwbep/cx_mgw_busi_exception=>gcs_http_status_codes-internal_server_error
                                        exp = 500 ).
    cl_abap_unit_assert=>assert_equals( act = /iwbep/cx_mgw_busi_exception=>resource_not_found-msgno
                                        exp = '020' ).
    cl_abap_unit_assert=>assert_equals( act = /iwbep/cx_mgw_busi_exception=>resource_duplicate-msgid
                                        exp = '/IWBEP/CM_MGW_RT' ).
    cl_abap_unit_assert=>assert_equals( act = /iwbep/cx_mgw_busi_exception=>precondition_failed-msgid
                                        exp = '/IWBEP/CM_MGW_RT' ).
  ENDMETHOD.

  METHOD container_reset.
    DATA lo_container TYPE REF TO zcl_oao_msg_container.
    DATA lo_messages  TYPE REF TO /iwbep/if_message_container.

    CREATE OBJECT lo_container.
    lo_messages = lo_container.
    lo_messages->add_message_text_only( iv_msg_type = 'E'
                                        iv_msg_text = 'one' ).
    lo_messages->reset( ).
    cl_abap_unit_assert=>assert_initial( lo_container->get_messages( ) ).
  ENDMETHOD.

  METHOD container_from_exception.
* the exception and what it wraps, one message each, the T100 key kept
    DATA lo_container TYPE REF TO zcl_oao_msg_container.
    DATA lo_messages  TYPE REF TO /iwbep/if_message_container.
    DATA lx_inner     TYPE REF TO /iwbep/cx_mgw_busi_exception.
    DATA lx_outer     TYPE REF TO /iwbep/cx_mgw_busi_exception.
    DATA lt_messages  TYPE bapirettab.
    DATA ls_message   TYPE bapiret2.

    CREATE OBJECT lx_inner
      EXPORTING
        message = 'inner'.
    CREATE OBJECT lx_outer
      EXPORTING
        textid      = /iwbep/cx_mgw_busi_exception=>resource_not_found
        entity_type = 'Order'
        previous    = lx_inner.
    CREATE OBJECT lo_container.
    lo_messages = lo_container.
    lo_messages->add_message_from_exception( io_exception      = lx_outer
                                             iv_entity_type    = 'Order'
                                             iv_message_target = 'OrderId' ).
    lt_messages = lo_container->get_messages( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_messages )
                                        exp = 2 ).
    READ TABLE lt_messages INTO ls_message INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_message-id
                                        exp = '/IWBEP/CM_MGW_RT' ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-number
                                        exp = '020' ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-type
                                        exp = 'E' ).
  ENDMETHOD.

  METHOD container_without_previous.
    DATA lo_container TYPE REF TO zcl_oao_msg_container.
    DATA lo_messages  TYPE REF TO /iwbep/if_message_container.
    DATA lx_inner     TYPE REF TO /iwbep/cx_mgw_busi_exception.
    DATA lx_outer     TYPE REF TO /iwbep/cx_mgw_busi_exception.

    CREATE OBJECT lx_inner.
    CREATE OBJECT lx_outer
      EXPORTING
        previous = lx_inner.
    CREATE OBJECT lo_container.
    lo_messages = lo_container.
    lo_messages->add_message_from_exception( io_exception   = lx_outer
                                             iv_add_previous = abap_false ).
    cl_abap_unit_assert=>assert_equals( act = lines( lo_container->get_messages( ) )
                                        exp = 1 ).
  ENDMETHOD.

  METHOD container_entity_parameters.
* the entity type, keys and target a page service passes are accepted
    DATA lo_container TYPE REF TO zcl_oao_msg_container.
    DATA lo_messages  TYPE REF TO /iwbep/if_message_container.
    DATA lt_keys      TYPE /iwbep/t_mgw_name_value_pair.
    DATA lt_bapi      TYPE bapirettab.
    DATA ls_bapi      TYPE bapiret2.

    CREATE OBJECT lo_container.
    lo_messages = lo_container.
    lo_messages->add_message_text_only( iv_msg_type       = 'W'
                                        iv_msg_text       = 'text'
                                        iv_entity_type    = 'Order'
                                        it_key_tab        = lt_keys
                                        iv_message_target = 'Title' ).
    ls_bapi-type = 'E'.
    ls_bapi-message = 'bapi'.
    APPEND ls_bapi TO lt_bapi.
    lo_messages->add_messages_from_bapi( it_bapi_messages = lt_bapi
                                         iv_entity_type   = 'Order'
                                         it_key_tab       = lt_keys ).
    cl_abap_unit_assert=>assert_equals( act = lines( lo_container->get_messages( ) )
                                        exp = 2 ).
  ENDMETHOD.

ENDCLASS.
