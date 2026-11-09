CLASS zcl_osd_v4_model DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_property,
             entity_type TYPE string,
             name TYPE string,
             fieldname TYPE string,
             edm_type TYPE string,
             facets TYPE string,
* set_as_etag in the MPC: the property is (part of) the entity's ETag
             is_etag TYPE abap_bool,
           END OF ty_property.
    TYPES ty_properties TYPE STANDARD TABLE OF ty_property WITH DEFAULT KEY.
    DATA ms_service TYPE zcl_stg_model_info=>ty_service READ-ONLY.
    DATA mt_properties TYPE ty_properties READ-ONLY.
* the properties of the model's complex types (entity_type = the complex type)
    DATA mt_complex TYPE ty_properties READ-ONLY.
* the parameters of the model's function imports (entity_type = the function
* import), for their facets in the CSDL of the operation
    DATA mt_parameters TYPE ty_properties READ-ONLY.
* the vocabulary annotations the MPC built through vocab_anno_model (or
* added as raw XML), rendered as CSDL <Annotations> elements; the syntax is
* the same in V2 and V4 $metadata
    DATA mt_vocabulary TYPE string_table READ-ONLY.
    METHODS constructor IMPORTING iv_service TYPE string
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    METHODS metadata RETURNING VALUE(rv_xml) TYPE string.
    METHODS property IMPORTING iv_type TYPE string iv_name TYPE string
      RETURNING VALUE(rs_property) TYPE ty_property.
    METHODS parameter IMPORTING iv_action TYPE string iv_name TYPE string
      RETURNING VALUE(rs_parameter) TYPE ty_property.
    METHODS has_etag IMPORTING iv_type TYPE string RETURNING VALUE(rv_etag) TYPE abap_bool.
    CLASS-METHODS xml IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string.
* the V4 name of a V2 EDM type (DateTime without a display format is a timestamp)
    CLASS-METHODS v4_type IMPORTING iv_edm_type TYPE clike RETURNING VALUE(rv_type) TYPE string.
  PRIVATE SECTION.
    METHODS describe IMPORTING io_property TYPE REF TO zcl_oao_property iv_owner TYPE clike iv_name TYPE clike
      RETURNING VALUE(rs_info) TYPE ty_property.
ENDCLASS.

CLASS zcl_osd_v4_model IMPLEMENTATION.
  METHOD xml.
    rv_text = iv_text.
    REPLACE ALL OCCURRENCES OF '&' IN rv_text WITH '&amp;'.
    REPLACE ALL OCCURRENCES OF '<' IN rv_text WITH '&lt;'.
    REPLACE ALL OCCURRENCES OF '>' IN rv_text WITH '&gt;'.
    REPLACE ALL OCCURRENCES OF '"' IN rv_text WITH '&quot;'.
    REPLACE ALL OCCURRENCES OF |'| IN rv_text WITH '&apos;'.
  ENDMETHOD.

  METHOD v4_type.
    rv_type = iv_edm_type.
    CASE iv_edm_type.
      WHEN ''.
        rv_type = 'Edm.String'.
      WHEN 'Edm.DateTime'.
        rv_type = 'Edm.DateTimeOffset'.
      WHEN 'Edm.Time'.
        rv_type = 'Edm.TimeOfDay'.
      WHEN 'Edm.Float'.
        rv_type = 'Edm.Single'.
    ENDCASE.
  ENDMETHOD.

  METHOD describe.
    rs_info-entity_type = iv_owner.
    rs_info-name = iv_name.
    rs_info-fieldname = to_upper( io_property->mv_abap_fieldname ).
    IF rs_info-fieldname IS INITIAL.
      rs_info-fieldname = to_upper( iv_name ).
    ENDIF.
    rs_info-edm_type = v4_type( io_property->mv_edm_type ).
    rs_info-is_etag = io_property->mv_etag.
    IF io_property->mv_edm_type = 'Edm.DateTime' AND io_property->mv_display_format = 'Date'.
      rs_info-edm_type = 'Edm.Date'.
    ENDIF.
    CASE rs_info-edm_type.
      WHEN 'Edm.Decimal'.
* The existing MPC contract stores total digits in maxlength and decimal
* places in precision (the same interpretation as the V2 metadata writer).
        IF io_property->mv_maxlength > 0.
          rs_info-facets = | Precision="{ io_property->mv_maxlength }" Scale="{ io_property->mv_precision }"|.
        ELSE.
          rs_info-facets = ' Scale="variable"'.
        ENDIF.
      WHEN 'Edm.String' OR 'Edm.Binary'.
        IF io_property->mv_maxlength > 0.
          rs_info-facets = | MaxLength="{ io_property->mv_maxlength }"|.
        ENDIF.
      WHEN 'Edm.DateTimeOffset' OR 'Edm.TimeOfDay'.
        rs_info-facets = | Precision="{ io_property->mv_precision }"|.
    ENDCASE.
  ENDMETHOD.

  METHOD constructor.
    DATA lo_mpc TYPE REF TO /iwbep/cl_mgw_push_abs_model.
    DATA lo_model TYPE REF TO zcl_oao_model.
    DATA lo_type TYPE REF TO zcl_oao_entity_typ.
    DATA lo_property TYPE REF TO zcl_oao_property.
    DATA lt_names TYPE zcl_oao_model=>ty_entity_names.
    DATA lv_name LIKE LINE OF lt_names.
    DATA lt_props TYPE /iwbep/if_mgw_med_odata_types=>ty_t_mgw_odata_properties.
    DATA ls_prop LIKE LINE OF lt_props.
    DATA ls_info TYPE ty_property.
    DATA lt_complex TYPE zcl_oao_model=>ty_complex_types.
    DATA ls_complex LIKE LINE OF lt_complex.
    DATA lt_actions TYPE zcl_oao_model=>ty_actions.
    DATA lo_action TYPE REF TO zcl_oao_action.
    DATA lo_parameter TYPE REF TO zcl_oao_parameter.

    ms_service = zcl_stg_model_info=>get( iv_service ).
    lo_mpc = zcl_oao_registry=>create_mpc( ms_service-name ).
    lo_mpc->define( ).
    lo_model ?= lo_mpc->model.
    mt_vocabulary = lo_model->get_vocabulary_xml( ).
    lt_names = lo_model->get_entity_type_names( ).
    LOOP AT lt_names INTO lv_name.
      lo_type ?= lo_model->/iwbep/if_mgw_odata_model~get_entity_type( lv_name ).
      lt_props = lo_type->/iwbep/if_mgw_odata_entity_typ~get_properties( ).
      LOOP AT lt_props INTO ls_prop.
        lo_property ?= ls_prop-property.
        ls_info = describe( io_property = lo_property iv_owner = lv_name iv_name = ls_prop-name ).
        APPEND ls_info TO mt_properties.
      ENDLOOP.
    ENDLOOP.
* the complex types, for an operation that returns one
    lt_complex = lo_model->get_complex_types( ).
    LOOP AT lt_complex INTO ls_complex.
      lt_props = ls_complex-complex_type->/iwbep/if_mgw_odata_cmplx_type~get_properties( ).
      LOOP AT lt_props INTO ls_prop.
        lo_property ?= ls_prop-property.
        ls_info = describe( io_property = lo_property iv_owner = ls_complex-name iv_name = ls_prop-name ).
        APPEND ls_info TO mt_complex.
      ENDLOOP.
    ENDLOOP.
* the function imports' parameters
    lt_actions = lo_model->get_actions( ).
    LOOP AT lt_actions INTO lo_action.
      LOOP AT lo_action->mt_parameters INTO lo_parameter.
        ls_info = describe( io_property = lo_parameter iv_owner = lo_action->mv_name iv_name = lo_parameter->mv_name ).
        APPEND ls_info TO mt_parameters.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD property.
    READ TABLE mt_properties INTO rs_property WITH KEY entity_type = iv_type name = iv_name.
  ENDMETHOD.

  METHOD parameter.
    READ TABLE mt_parameters INTO rs_parameter WITH KEY entity_type = iv_action name = iv_name.
  ENDMETHOD.

  METHOD has_etag.
    READ TABLE mt_properties WITH KEY entity_type = iv_type is_etag = abap_true TRANSPORTING NO FIELDS.
    rv_etag = boolc( sy-subrc = 0 ).
  ENDMETHOD.

  METHOD metadata.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_nav TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_target TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ls_back TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_info TYPE ty_property.
    DATA lt_done TYPE string_table.
    DATA lv_ns TYPE string.
    DATA lv_type TYPE string.
    DATA lv_attr TYPE string.
    DATA lv_partner TYPE string.
    DATA lv_keys TYPE string.
    DATA lv_core TYPE string.
    DATA lv_paths TYPE string.
    DATA lv_vocabulary TYPE string.
    DATA lv_line TYPE string.
    DATA lv_sticky TYPE string.

    lv_ns = xml( ms_service-namespace ).
* Optimistic concurrency is announced through the Core vocabulary, which is
* referenced only when some entity type of the service has an ETag.
    READ TABLE mt_properties WITH KEY is_etag = abap_true TRANSPORTING NO FIELDS.
    IF sy-subrc = 0.
      lv_core = '<edmx:Reference Uri="https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.xml">' &&
        '<edmx:Include Namespace="Org.OData.Core.V1" Alias="Core"/></edmx:Reference>'.
    ENDIF.
* The MPC's vocabulary annotations (UI.LineItem, UI.HeaderInfo, Common.Label,
* Common.ValueList...) are written with full term names, so they need no
* alias; the references say where the vocabularies are. A V2 annotation
* that targets the V2 entity container (<ns>.<ns>_Entities/...) is moved
* to the V4 one, which is called Container.
    LOOP AT mt_vocabulary INTO lv_line.
      REPLACE ALL OCCURRENCES OF |Target="{ ms_service-namespace }.{ ms_service-namespace }_Entities|
        IN lv_line WITH |Target="{ ms_service-namespace }.Container|.
      lv_vocabulary = lv_vocabulary && lv_line.
    ENDLOOP.
    IF lv_vocabulary IS NOT INITIAL.
      IF lv_core IS INITIAL.
        lv_core = '<edmx:Reference Uri="https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.xml">' &&
          '<edmx:Include Namespace="Org.OData.Core.V1" Alias="Core"/></edmx:Reference>'.
      ENDIF.
      lv_core = lv_core &&
        '<edmx:Reference Uri="https://sap.github.io/odata-vocabularies/vocabularies/Common.xml">' &&
        '<edmx:Include Namespace="com.sap.vocabularies.Common.v1" Alias="Common"/></edmx:Reference>' &&
        '<edmx:Reference Uri="https://sap.github.io/odata-vocabularies/vocabularies/UI.xml">' &&
        '<edmx:Include Namespace="com.sap.vocabularies.UI.v1" Alias="UI"/></edmx:Reference>'.
    ENDIF.
* A set the model does not mark searchable (set_has_ftxt_search) answers
* $search with 501: Capabilities.SearchRestrictions says so, which is what
* makes sap.fe leave out its search field.
    READ TABLE ms_service-entity_sets WITH KEY searchable = abap_false TRANSPORTING NO FIELDS.
    IF sy-subrc = 0.
      lv_core = lv_core &&
        '<edmx:Reference Uri="https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Capabilities.V1.xml">' &&
        '<edmx:Include Namespace="Org.OData.Capabilities.V1" Alias="Capabilities"/></edmx:Reference>'.
    ENDIF.
    lv_sticky = zcl_osd_v4_sticky=>actions_xml( me ).
    IF lv_sticky IS NOT INITIAL.
      lv_core = lv_core &&
        '<edmx:Reference Uri="https://sap.github.io/odata-vocabularies/vocabularies/Session.xml">' &&
        '<edmx:Include Namespace="com.sap.vocabularies.Session.v1" Alias="Session"/></edmx:Reference>'.
    ENDIF.
    rv_xml = '<?xml version="1.0" encoding="utf-8"?>' &&
      '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">' && lv_core &&
      '<edmx:DataServices>' && |<Schema Namespace="{ lv_ns }" xmlns="http://docs.oasis-open.org/odata/ns/edm">|.
    LOOP AT ms_service-entity_sets INTO ls_set.
      READ TABLE lt_done WITH KEY table_line = ls_set-entity_type TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      APPEND ls_set-entity_type TO lt_done.
      rv_xml = rv_xml && |<EntityType Name="{ xml( ls_set-entity_type ) }">|.
      CLEAR lv_keys.
      LOOP AT ls_set-properties INTO ls_prop WHERE is_key = abap_true.
        lv_keys = lv_keys && |<PropertyRef Name="{ xml( ls_prop-name ) }"/>|.
      ENDLOOP.
      IF lv_keys IS NOT INITIAL.
        rv_xml = rv_xml && |<Key>{ lv_keys }</Key>|.
      ENDIF.
      LOOP AT ls_set-properties INTO ls_prop.
        ls_info = property( iv_type = ls_set-entity_type iv_name = ls_prop-name ).
        CLEAR lv_attr.
        IF ls_prop-nullable = abap_false OR ls_prop-is_key = abap_true.
          lv_attr = ' Nullable="false"'.
        ENDIF.
        rv_xml = rv_xml && |<Property Name="{ xml( ls_prop-name ) }" Type="{ xml( ls_info-edm_type ) }"{ lv_attr }{ ls_info-facets }/>|.
      ENDLOOP.
      LOOP AT ls_set-navs INTO ls_nav.
        lv_type = |{ lv_ns }.{ xml( ls_nav-target_type ) }|.
        IF ls_nav-to_many = abap_true.
          lv_type = |Collection({ lv_type })|.
        ENDIF.
        CLEAR lv_partner.
        LOOP AT ms_service-entity_sets INTO ls_target WHERE entity_type = ls_nav-target_type.
          LOOP AT ls_target-navs INTO ls_back WHERE association = ls_nav-association AND target_type = ls_set-entity_type.
            lv_partner = | Partner="{ xml( ls_back-name ) }"|.
            EXIT.
          ENDLOOP.
          IF lv_partner IS NOT INITIAL.
            EXIT.
          ENDIF.
        ENDLOOP.
        rv_xml = rv_xml && |<NavigationProperty Name="{ xml( ls_nav-name ) }" Type="{ lv_type }"{ lv_partner }/>|.
      ENDLOOP.
      rv_xml = rv_xml && '</EntityType>'.
    ENDLOOP.
    rv_xml = rv_xml && zcl_osd_v4_action=>schema_xml( me ) && lv_sticky && '<EntityContainer Name="Container">' &&
      zcl_osd_v4_action=>imports_xml( me ) && zcl_osd_v4_sticky=>imports_xml( me ).
    LOOP AT ms_service-entity_sets INTO ls_set.
      rv_xml = rv_xml && |<EntitySet Name="{ xml( ls_set-name ) }" EntityType="{ lv_ns }.{ xml( ls_set-entity_type ) }">|.
      LOOP AT ls_set-navs INTO ls_nav WHERE target_set IS NOT INITIAL.
        rv_xml = rv_xml && |<NavigationPropertyBinding Path="{ xml( ls_nav-name ) }" Target="{ xml( ls_nav-target_set ) }"/>|.
      ENDLOOP.
      CLEAR lv_paths.
      LOOP AT mt_properties INTO ls_info WHERE entity_type = ls_set-entity_type AND is_etag = abap_true.
        lv_paths = lv_paths && |<PropertyPath>{ xml( ls_info-name ) }</PropertyPath>|.
      ENDLOOP.
      IF lv_paths IS NOT INITIAL.
        rv_xml = rv_xml && |<Annotation Term="Core.OptimisticConcurrency"><Collection>{ lv_paths }</Collection></Annotation>|.
      ENDIF.
      IF ls_set-searchable = abap_false.
        rv_xml = rv_xml && '<Annotation Term="Capabilities.SearchRestrictions"><Record>' &&
          '<PropertyValue Property="Searchable" Bool="false"/></Record></Annotation>'.
      ENDIF.
      rv_xml = rv_xml && zcl_osd_v4_sticky=>set_annotation( io_model = me is_set = ls_set ).
      rv_xml = rv_xml && '</EntitySet>'.
    ENDLOOP.
    rv_xml = rv_xml && '</EntityContainer>' && lv_vocabulary && '</Schema></edmx:DataServices></edmx:Edmx>'.
  ENDMETHOD.
ENDCLASS.
