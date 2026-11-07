CLASS zcl_osd_v4_model DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_property,
             entity_type TYPE string,
             name TYPE string,
             edm_type TYPE string,
             facets TYPE string,
           END OF ty_property.
    TYPES ty_properties TYPE STANDARD TABLE OF ty_property WITH DEFAULT KEY.
    DATA ms_service TYPE zcl_stg_model_info=>ty_service READ-ONLY.
    DATA mt_properties TYPE ty_properties READ-ONLY.
    METHODS constructor IMPORTING iv_service TYPE string
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    METHODS metadata RETURNING VALUE(rv_xml) TYPE string.
    METHODS property IMPORTING iv_type TYPE string iv_name TYPE string
      RETURNING VALUE(rs_property) TYPE ty_property.
    CLASS-METHODS xml IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string.
  PRIVATE SECTION.
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

    ms_service = zcl_stg_model_info=>get( iv_service ).
    lo_mpc = zcl_oao_registry=>create_mpc( ms_service-name ).
    lo_mpc->define( ).
    lo_model ?= lo_mpc->model.
    lt_names = lo_model->get_entity_type_names( ).
    LOOP AT lt_names INTO lv_name.
      lo_type ?= lo_model->/iwbep/if_mgw_odata_model~get_entity_type( lv_name ).
      lt_props = lo_type->/iwbep/if_mgw_odata_entity_typ~get_properties( ).
      LOOP AT lt_props INTO ls_prop.
        lo_property ?= ls_prop-property.
        CLEAR ls_info.
        ls_info-entity_type = lv_name.
        ls_info-name = ls_prop-name.
        ls_info-edm_type = lo_property->mv_edm_type.
        CASE ls_info-edm_type.
          WHEN ''.
            ls_info-edm_type = 'Edm.String'.
          WHEN 'Edm.DateTime'.
            IF lo_property->mv_display_format = 'Date'.
              ls_info-edm_type = 'Edm.Date'.
            ELSE.
              ls_info-edm_type = 'Edm.DateTimeOffset'.
            ENDIF.
          WHEN 'Edm.Time'.
            ls_info-edm_type = 'Edm.TimeOfDay'.
          WHEN 'Edm.Float'.
            ls_info-edm_type = 'Edm.Single'.
        ENDCASE.
        CASE ls_info-edm_type.
          WHEN 'Edm.Decimal'.
* The existing MPC contract stores total digits in maxlength and decimal
* places in precision (the same interpretation as the V2 metadata writer).
            IF lo_property->mv_maxlength > 0.
              ls_info-facets = | Precision="{ lo_property->mv_maxlength }" Scale="{ lo_property->mv_precision }"|.
            ELSE.
              ls_info-facets = ' Scale="variable"'.
            ENDIF.
          WHEN 'Edm.String' OR 'Edm.Binary'.
            IF lo_property->mv_maxlength > 0.
              ls_info-facets = | MaxLength="{ lo_property->mv_maxlength }"|.
            ENDIF.
          WHEN 'Edm.DateTimeOffset' OR 'Edm.TimeOfDay'.
            ls_info-facets = | Precision="{ lo_property->mv_precision }"|.
        ENDCASE.
        APPEND ls_info TO mt_properties.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD property.
    READ TABLE mt_properties INTO rs_property WITH KEY entity_type = iv_type name = iv_name.
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

    lv_ns = xml( ms_service-namespace ).
    rv_xml = '<?xml version="1.0" encoding="utf-8"?>' &&
      '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">' &&
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
    rv_xml = rv_xml && '<EntityContainer Name="Container">'.
    LOOP AT ms_service-entity_sets INTO ls_set.
      rv_xml = rv_xml && |<EntitySet Name="{ xml( ls_set-name ) }" EntityType="{ lv_ns }.{ xml( ls_set-entity_type ) }">|.
      LOOP AT ls_set-navs INTO ls_nav WHERE target_set IS NOT INITIAL.
        rv_xml = rv_xml && |<NavigationPropertyBinding Path="{ xml( ls_nav-name ) }" Target="{ xml( ls_nav-target_set ) }"/>|.
      ENDLOOP.
      rv_xml = rv_xml && '</EntitySet>'.
    ENDLOOP.
    rv_xml = rv_xml && '</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>'.
  ENDMETHOD.
ENDCLASS.
