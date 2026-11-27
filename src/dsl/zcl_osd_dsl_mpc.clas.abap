CLASS zcl_osd_dsl_mpc DEFINITION PUBLIC FINAL CREATE PRIVATE.
  PUBLIC SECTION.
    CLASS-METHODS entity_model
      IMPORTING is_type TYPE zcl_stg_segw_gen=>ty_entity_type
                iv_mpc TYPE string
      RETURNING VALUE(ri_model) TYPE REF TO zif_ajson
      RAISING cx_static_check.
    CLASS-METHODS entity_template RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS render_entity
      IMPORTING is_type TYPE zcl_stg_segw_gen=>ty_entity_type
                iv_mpc TYPE string
      RETURNING VALUE(rs_result) TYPE zcl_osd_tpl=>ty_result
      RAISING cx_static_check.
    CLASS-METHODS project_model
      IMPORTING is_model TYPE zcl_stg_segw_gen=>ty_model
      RETURNING VALUE(ri_model) TYPE REF TO zif_ajson
      RAISING cx_static_check.
    " the project model as the JSON text it is parsed from: a generator that
    " hashes the model (the trace's model field) hashes this text instead of
    " serialising the parsed tree again
    CLASS-METHODS project_model_json
      IMPORTING is_model TYPE zcl_stg_segw_gen=>ty_model
      RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS render_model
      IMPORTING io_model TYPE REF TO zif_ajson
      RETURNING VALUE(rs_result) TYPE zcl_osd_tpl=>ty_result
      RAISING cx_static_check.
    CLASS-METHODS render_method
      IMPORTING is_model TYPE zcl_stg_segw_gen=>ty_model
                iv_method TYPE string
      RETURNING VALUE(rs_result) TYPE zcl_osd_tpl=>ty_result
      RAISING cx_static_check.
    CLASS-METHODS template_source
      IMPORTING iv_name TYPE string RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS render_class
      IMPORTING is_model TYPE zcl_stg_segw_gen=>ty_model
      RETURNING VALUE(rs_result) TYPE zcl_osd_tpl=>ty_result
      RAISING cx_static_check.
  PRIVATE SECTION.
    " the entity model as JSON text; project_model_json splices it in as it is
    " rather than parsing it and serialising the tree again
    CLASS-METHODS entity_json
      IMPORTING is_type TYPE zcl_stg_segw_gen=>ty_entity_type
                iv_mpc TYPE string
      RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS flag_text IMPORTING iv_flag TYPE abap_bool RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS quoted IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS method_template
      IMPORTING iv_method TYPE string RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS class_template RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS type_template RETURNING VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_osd_dsl_mpc IMPLEMENTATION.
  METHOD template_source.
    CASE iv_name.
      WHEN 'mpc_class'.
        rv_text = class_template( ).
      WHEN 'entity' OR 'mpc_entity'.
        rv_text = entity_template( ).
      WHEN OTHERS.
        rv_text = method_template( iv_name ).
    ENDCASE.
  ENDMETHOD.

  METHOD quoted.
    rv_text = `"` && zcl_stg_json=>escape( iv_text ) && `"`.
  ENDMETHOD.

  METHOD flag_text.
    IF iv_flag = abap_true.
      rv_text = 'X'.
    ENDIF.
  ENDMETHOD.

  METHOD entity_model.
    ri_model = zcl_ajson=>parse( entity_json( is_type = is_type iv_mpc = iv_mpc ) ).
  ENDMETHOD.

  METHOD entity_json.
    DATA lv_json TYPE string.
    DATA ls_prop TYPE zcl_stg_segw_gen=>ty_property.
    DATA ls_set TYPE zcl_stg_segw_gen=>ty_entity_set.
    DATA lv_first TYPE abap_bool.
    DATA lv_has_label TYPE abap_bool.
    lv_json = `{"@id":` && quoted( `entity/` && is_type-name )
      && `,"name":` && quoted( is_type-name )
      && `,"define_stem":` && quoted( is_type-define_stem )
      && `,"type_stem":` && quoted( is_type-type_stem )
      && `,"mpc":` && quoted( iv_mpc )
      && `,"abap_struct":` && quoted( is_type-abap_struct )
      && `,"bind_ddic":` && quoted( is_type-abap_struct )
      && `,"media":` && quoted( flag_text( is_type-is_media ) )
      && `,"properties":[`.
    lv_first = abap_true.
    LOOP AT is_type-properties INTO ls_prop.
      IF ls_prop-text_element IS NOT INITIAL.
        lv_has_label = abap_true.
      ENDIF.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `entity/` && is_type-name && `/property/` && ls_prop-name )
        && `,"name":` && quoted( ls_prop-name )
        && `,"abap_field":` && quoted( ls_prop-abap_field )
        && `,"@type":{"@id":` && quoted( `entity/` && is_type-name && `/property/` && ls_prop-name && `/type` )
        && `,"built_in":` && quoted( ls_prop-type_kind )
        && `,"length":` && quoted( ls_prop-length )
        && `,"decimals":` && quoted( ls_prop-decimals )
        && `,"data_element":` && quoted( ls_prop-type_name ) && `}`
        && `,"complex":` && quoted( ls_prop-complex_type )
        && `,"complex_type":` && quoted( ls_prop-complex_type )
        && `,"key":` && quoted( flag_text( ls_prop-is_key ) )
        && `,"label":` && quoted( ls_prop-text_element )
        && `,"text_element":` && quoted( ls_prop-text_element )
        && `,"edm_setter":` && quoted( zcl_stg_segw_gen=>edm_setter( ls_prop-edm_type ) )
        && `,"precision":` && quoted( ls_prop-precision )
        && `,"max_length":` && quoted( ls_prop-max_length )
        && `,"semantics":` && quoted( ls_prop-semantics )
        && `,"etag":` && quoted( flag_text( ls_prop-as_etag ) )
        && `,"creatable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-creatable ) )
        && `,"updatable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-updatable ) )
        && `,"sortable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-sortable ) )
        && `,"nullable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-nullable ) )
        && `,"filterable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-filterable ) ) && `}`.
    ENDLOOP.
    lv_json = lv_json && `],"sets":[`.
    lv_first = abap_true.
    LOOP AT is_type-entity_sets INTO ls_set.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `entity/` && is_type-name && `/set/` && ls_set-name )
        && `,"name":` && quoted( ls_set-name )
        && `,"creatable":` && quoted( zcl_stg_segw_gen=>ab( ls_set-creatable ) )
        && `,"updatable":` && quoted( zcl_stg_segw_gen=>ab( ls_set-updatable ) )
        && `,"deletable":` && quoted( zcl_stg_segw_gen=>ab( ls_set-deletable ) )
        && `,"pageable":` && quoted( zcl_stg_segw_gen=>ab( ls_set-pageable ) )
        && `,"addressable":` && quoted( zcl_stg_segw_gen=>ab( ls_set-addressable ) )
        && `,"searchable":` && quoted( zcl_stg_segw_gen=>ab( ls_set-searchable ) )
        && `,"subscribable":` && quoted( zcl_stg_segw_gen=>ab( ls_set-subscribable ) )
        && `,"filter_required":` && quoted( zcl_stg_segw_gen=>ab( ls_set-filter_required ) ) && `}`.
    ENDLOOP.
    rv_json = lv_json && `],"has_texts":` && quoted( flag_text( lv_has_label ) ) && `}`.
  ENDMETHOD.

  METHOD entity_template.
    rv_text = rv_text && `  method DEFINE_{{define_stem}}.` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && zcl_stg_segw_gen=>banner( ) && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `  data:` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `        lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,                "#EC NEEDED` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `        lo_entity_type    type ref to /iwbep/if_mgw_odata_entity_typ,                "#EC NEEDED` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `        lo_complex_type   type ref to /iwbep/if_mgw_odata_cmplx_type,                "#EC NEEDED` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `        lo_property       type ref to /iwbep/if_mgw_odata_property,                  "#EC NEEDED` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `        lo_entity_set     type ref to /iwbep/if_mgw_odata_entity_set.                "#EC NEEDED` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `*   ENTITY - {{name}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_type = model->create_entity_type( iv_entity_type_name = '{{name}}' iv_def_entity_set = abap_false ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#media}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_type->set_is_media( 'X' ).  "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/media}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `*Properties` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#properties}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#complex}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_complex_type = lo_entity_type->create_complex_property( iv_property_name = '{{name}}'` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `                                                           iv_complex_type_name = '{{complex_type}}'` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `                                                           iv_abap_fieldname    = '{{abap_field}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/complex}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{^complex}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property = lo_entity_type->create_property( iv_property_name = '{{name}}' iv_abap_fieldname = '{{abap_field}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#key}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_is_key( ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/key}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#label}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_label_from_text_element( iv_text_element_symbol = '{{text_element}}' iv_text_element_container = gc_incl_name ).  "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/label}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_type_edm_{{edm_setter}}( ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#precision}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_precison( iv_precision = {{precision}} ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/precision}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#max_length}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_maxlength( iv_max_length = {{max_length}} ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/max_length}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#semantics}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_semantic( '{{semantics}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/semantics}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_creatable( {{creatable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_updatable( {{updatable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_sortable( {{sortable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_nullable( {{nullable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_filterable( {{filterable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `      EXPORTING` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `        iv_key      = 'unicode'` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `        iv_value    = 'false' ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#etag}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_property->set_as_etag( ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/etag}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/complex}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/properties}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{^properties}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/properties}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#bind_ddic}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_type->bind_structure( iv_structure_name   = '{{abap_struct}}'` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `                                iv_bind_conversions = 'X' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/bind_ddic}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{^bind_ddic}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_type->bind_structure( iv_structure_name  = '{{mpc}}=>TS_{{type_stem}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/bind_ddic}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `*   ENTITY SETS` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{#sets}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set = lo_entity_type->create_entity_set( '{{name}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_creatable( {{creatable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_updatable( {{updatable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_deletable( {{deletable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_pageable( {{pageable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_addressable( {{addressable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_has_ftxt_search( {{searchable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_subscribable( {{subscribable}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `lo_entity_set->set_filter_required( {{filter_required}} ).` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `{{/sets}}` && cl_abap_char_utilities=>newline.
    rv_text = rv_text && `  endmethod.` && cl_abap_char_utilities=>newline.
  ENDMETHOD.

  METHOD project_model.
    ri_model = zcl_ajson=>parse( project_model_json( is_model ) ).
  ENDMETHOD.

  METHOD project_model_json.
    DATA lv_json TYPE string.
    DATA lv_first TYPE abap_bool.
    DATA lv_incl TYPE abap_bool.
    DATA lv_inner TYPE abap_bool.
    DATA ls_type TYPE zcl_stg_segw_gen=>ty_entity_type.
    DATA ls_ct TYPE zcl_stg_segw_gen=>ty_complex_type.
    DATA ls_prop TYPE zcl_stg_segw_gen=>ty_property.
    DATA ls_aso TYPE zcl_stg_segw_gen=>ty_association.
    DATA ls_rc TYPE zcl_stg_segw_gen=>ty_constraint.
    DATA ls_set TYPE zcl_stg_segw_gen=>ty_assoc_set.
    DATA ls_nav TYPE zcl_stg_segw_gen=>ty_navigation.
    DATA ls_fi TYPE zcl_stg_segw_gen=>ty_function_import.
    DATA ls_fp TYPE zcl_stg_segw_gen=>ty_parameter.
    DATA ls_named TYPE zcl_stg_segw_gen=>ty_file.
    DATA lt_named TYPE zcl_stg_segw_gen=>tt_file.
    DATA ls_impl TYPE zcl_stg_segw_gen=>ty_file.
    DATA lt_impl TYPE zcl_stg_segw_gen=>tt_file.
    DATA lv_block TYPE string.
    DATA lv_blocks TYPE string.
    DATA lv_first_block TYPE string.
    DATA lv_count TYPE i.
    DATA lv_component_first TYPE abap_bool.
    DATA lv_kind TYPE string.
    DATA lv_pad TYPE string.
    DATA lv_stamp TYPE string.
    DATA lv_any TYPE abap_bool.
    lv_stamp = is_model-last_changed.
    IF strlen( lv_stamp ) > 14.
      lv_stamp = substring( val = lv_stamp len = 14 ).
    ENDIF.
    lv_json = `{"@id":` && quoted( `project/` && is_model-project )
      && `,"namespace":` && quoted( is_model-namespace )
      && `,"mpc":` && quoted( is_model-mpc )
      && `,"stamp":` && quoted( lv_stamp )
      && `,"complex_types":[`.
    lv_first = abap_true.
    LOOP AT is_model-complex_types INTO ls_ct.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `complex/` && ls_ct-name )
        && `,"name":` && quoted( ls_ct-name )
        && `,"bind_ddic":` && quoted( ls_ct-abap_struct )
        && `,"abap_struct":` && quoted( ls_ct-abap_struct )
        && `,"type_upper":` && quoted( to_upper( ls_ct-name ) )
        && `,"properties":[`.
      lv_inner = abap_true.
      LOOP AT ls_ct-properties INTO ls_prop.
        IF lv_inner = abap_false.
          lv_json = lv_json && `,`.
        ENDIF.
        lv_inner = abap_false.
        lv_json = lv_json && `{"@id":` && quoted( `complex/` && ls_ct-name && `/property/` && ls_prop-name )
          && `,"name":` && quoted( ls_prop-name )
          && `,"abap_field":` && quoted( ls_prop-abap_field )
          && `,"@type":{"@id":` && quoted( `complex/` && ls_ct-name && `/property/` && ls_prop-name && `/type` )
          && `,"built_in":` && quoted( ls_prop-type_kind )
          && `,"length":` && quoted( ls_prop-length )
          && `,"decimals":` && quoted( ls_prop-decimals )
          && `,"data_element":` && quoted( ls_prop-type_name ) && `}`
          && `,"edm_setter":` && quoted( zcl_stg_segw_gen=>edm_setter( ls_prop-edm_type ) )
          && `,"precision":` && quoted( ls_prop-precision )
          && `,"max_length":` && quoted( ls_prop-max_length )
          && `,"semantics":` && quoted( ls_prop-semantics )
          && `,"creatable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-creatable ) )
          && `,"updatable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-updatable ) )
          && `,"sortable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-sortable ) )
          && `,"nullable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-nullable ) )
          && `,"filterable":` && quoted( zcl_stg_segw_gen=>ab( ls_prop-filterable ) ) && `}`.
      ENDLOOP.
      lv_json = lv_json && `]}`.
    ENDLOOP.
    lv_json = lv_json && `],"entities":[`.
    lv_first = abap_true.
    LOOP AT is_model-entity_types INTO ls_type.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `entity/` && ls_type-name )
        && `,"name":` && quoted( ls_type-name )
        && `,"define_lower":` && quoted( to_lower( ls_type-define_stem ) ) && `}`.
    ENDLOOP.
    lv_json = lv_json && `],"associations":[`.
    lv_first = abap_true.
    LOOP AT is_model-associations INTO ls_aso.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `association/` && ls_aso-name )
        && `,"name":` && quoted( ls_aso-name )
        && `,"left_type":` && quoted( ls_aso-left_type )
        && `,"right_type":` && quoted( ls_aso-right_type )
        && `,"left_card":` && quoted( ls_aso-left_card )
        && `,"right_card":` && quoted( ls_aso-right_card )
        && `,"default_set":` && quoted( zcl_stg_segw_gen=>ab( xsdbool( ls_aso-sets IS INITIAL ) ) )
        && `,"has_constraints":` && quoted( flag_text( xsdbool( ls_aso-constraints IS NOT INITIAL ) ) )
        && `,"constraints":[`.
      lv_inner = abap_true.
      LOOP AT ls_aso-constraints INTO ls_rc.
        IF lv_inner = abap_false.
          lv_json = lv_json && `,`.
        ENDIF.
        lv_inner = abap_false.
        lv_json = lv_json && `{"@id":` && quoted( `association/` && ls_aso-name && `/constraint/` && ls_rc-principal )
          && `,"principal":` && quoted( ls_rc-principal )
          && `,"dependent":` && quoted( ls_rc-dependent ) && `}`.
      ENDLOOP.
      lv_json = lv_json && `],"sets":[`.
      lv_inner = abap_true.
      LOOP AT ls_aso-sets INTO ls_set.
        IF lv_inner = abap_false.
          lv_json = lv_json && `,`.
        ENDIF.
        lv_inner = abap_false.
        lv_json = lv_json && `{"@id":` && quoted( `association/` && ls_aso-name && `/set/` && ls_set-name )
          && `,"name":` && quoted( ls_set-name )
          && `,"left_set":` && quoted( ls_set-left_set )
          && `,"right_set":` && quoted( ls_set-right_set )
          && `,"association":` && quoted( ls_aso-name ) && `}`.
      ENDLOOP.
      lv_json = lv_json && `]}`.
    ENDLOOP.
    lv_json = lv_json && `],"navigation_groups":[`.
    lv_first = abap_true.
    LOOP AT is_model-entity_types INTO ls_type.
      lv_any = abap_false.
      LOOP AT is_model-navigation INTO ls_nav WHERE entity = ls_type-name.
        lv_any = abap_true.
        EXIT.
      ENDLOOP.
      IF lv_any = abap_false.
        CONTINUE.
      ENDIF.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `entity/` && ls_type-name )
        && `,"name":` && quoted( ls_type-name ) && `,"navigation":[`.
      lv_inner = abap_true.
      LOOP AT is_model-navigation INTO ls_nav WHERE entity = ls_type-name.
        IF lv_inner = abap_false.
          lv_json = lv_json && `,`.
        ENDIF.
        lv_inner = abap_false.
        lv_json = lv_json && `{"@id":` && quoted( `navigation/` && ls_type-name && `/` && ls_nav-name )
          && `,"name":` && quoted( ls_nav-name )
          && `,"abap_field":` && quoted( ls_nav-abap_field )
          && `,"association":` && quoted( ls_nav-association ) && `}`.
      ENDLOOP.
      lv_json = lv_json && `]}`.
    ENDLOOP.
    lv_json = lv_json && `],"actions":[`.
    lv_first = abap_true.
    LOOP AT is_model-function_imports INTO ls_fi.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `action/` && ls_fi-name )
        && `,"name":` && quoted( ls_fi-name )
        && `,"label":` && quoted( ls_fi-text_element )
        && `,"return_entity":` && quoted( flag_text( xsdbool( ls_fi-return_kind = 'ETYP' ) ) )
        && `,"return_complex":` && quoted( flag_text( xsdbool( ls_fi-return_kind = 'CTYP' ) ) )
        && `,"return_type":` && quoted( ls_fi-return_type )
        && `,"http_method":` && quoted( ls_fi-http_method )
        && `,"action_for":` && quoted( ls_fi-action_for )
        && `,"return_card":` && quoted( ls_fi-return_card )
        && `,"action_type":` && quoted( zcl_stg_segw_gen=>action_type( ls_fi ) )
        && `,"has_parameters":` && quoted( flag_text( xsdbool( ls_fi-parameters IS NOT INITIAL ) ) )
        && `,"parameters":[`.
      lv_inner = abap_true.
      LOOP AT ls_fi-parameters INTO ls_fp.
        IF lv_inner = abap_false.
          lv_json = lv_json && `,`.
        ENDIF.
        lv_inner = abap_false.
        lv_json = lv_json && `{"@id":` && quoted( `action/` && ls_fi-name && `/parameter/` && ls_fp-name )
          && `,"name":` && quoted( ls_fp-name )
          && `,"abap_field":` && quoted( ls_fp-abap_field )
          && `,"label":` && quoted( ls_fp-text_element )
          && `,"edm_setter":` && quoted( zcl_stg_segw_gen=>edm_setter( ls_fp-edm_type ) )
          && `,"string_max_length":` && quoted( flag_text( xsdbool( ls_fp-max_length IS NOT INITIAL AND ls_fp-edm_type = 'Edm.String' ) ) )
          && `,"max_length":` && quoted( ls_fp-max_length ) && `}`.
      ENDLOOP.
      lv_json = lv_json && `]}`.
    ENDLOOP.
    lv_json = lv_json && `],"has_complex":` && quoted( flag_text( xsdbool( is_model-complex_types IS NOT INITIAL ) ) )
      && `,"has_associations":` && quoted( flag_text( xsdbool( is_model-associations IS NOT INITIAL OR is_model-navigation IS NOT INITIAL ) ) )
      && `,"has_actions":` && quoted( flag_text( xsdbool( is_model-function_imports IS NOT INITIAL ) ) )
      && `,"texts":[`.
    lv_first = abap_true.
    LOOP AT is_model-entity_types INTO ls_type.
      LOOP AT ls_type-properties INTO ls_prop.
        IF ls_prop-text_element IS INITIAL.
          CONTINUE.
        ENDIF.
        IF lv_first = abap_false.
          lv_json = lv_json && `,`.
        ENDIF.
        lv_first = abap_false.
        lv_json = lv_json && `{"@id":` && quoted( `text/` && ls_type-name && `/` && ls_prop-name )
          && `,"name":` && quoted( ls_prop-name )
          && `,"entity":` && quoted( ls_type-name )
          && `,"symbol":` && quoted( ls_prop-text_element ) && `}`.
      ENDLOOP.
    ENDLOOP.
    lv_json = lv_json && `],"has_texts":` && quoted( flag_text( xsdbool( lv_first = abap_false ) ) ).
* the text element container: a labelled property, a function import or one
* of its parameters names it, so any of them needs it declared
    lv_incl = xsdbool( lv_first = abap_false ).
    LOOP AT is_model-function_imports INTO ls_fi.
      IF ls_fi-text_element IS NOT INITIAL.
        lv_incl = abap_true.
      ENDIF.
      LOOP AT ls_fi-parameters INTO ls_fp WHERE text_element IS NOT INITIAL.
        lv_incl = abap_true.
      ENDLOOP.
    ENDLOOP.
    lv_json = lv_json && `,"has_text_include":` && quoted( flag_text( lv_incl ) ).
    lv_blocks = ``.
    LOOP AT is_model-complex_types INTO ls_ct.
      lv_kind = 'inline'.
      IF ls_ct-abap_struct IS NOT INITIAL.
        lv_kind = 'ddic'.
      ENDIF.
      lv_block = `{"@id":` && quoted( `complex/` && ls_ct-name )
        && `,"kind":` && quoted( lv_kind )
        && `,"complex_ddic":` && quoted( flag_text( xsdbool( ls_ct-abap_struct IS NOT INITIAL ) ) )
        && `,"complex_inline":` && quoted( flag_text( xsdbool( ls_ct-abap_struct IS INITIAL ) ) )
        && `,"name":` && quoted( to_upper( ls_ct-name ) )
        && `,"ddic":` && quoted( ls_ct-abap_struct ) && `,"components":[`.
      lv_component_first = abap_true.
      IF ls_ct-abap_struct IS INITIAL.
        LOOP AT ls_ct-properties INTO ls_prop.
          IF lv_component_first = abap_false.
            lv_block = lv_block && `,`.
          ENDIF.
          lv_component_first = abap_false.
          lv_block = lv_block && `{"@id":` && quoted( `complex/` && ls_ct-name && `/property/` && ls_prop-name )
            && `,"name":` && quoted( ls_prop-abap_field )
            && `,"abap_type":` && quoted( zcl_stg_segw_gen=>inline_type( ls_prop ) ) && `}`.
        ENDLOOP.
      ENDIF.
      lv_block = lv_block && `]}`.
      IF lv_count = 0.
        lv_first_block = lv_block.
      ELSE.
        IF lv_blocks IS NOT INITIAL.
          lv_blocks = lv_blocks && `,`.
        ENDIF.
        lv_blocks = lv_blocks && lv_block.
      ENDIF.
      lv_count = lv_count + 1.
    ENDLOOP.
    LOOP AT is_model-function_imports INTO ls_fi.
      IF ls_fi-parameters IS INITIAL.
        CONTINUE.
      ENDIF.
      lv_block = `{"@id":` && quoted( `action/` && ls_fi-name )
        && `,"kind":"inline","name":` && quoted( zcl_stg_segw_gen=>action_type( ls_fi ) )
        && `,"is_action":"X"`
        && `,"components":[`.
      lv_component_first = abap_true.
      LOOP AT ls_fi-parameters INTO ls_fp.
        IF lv_component_first = abap_false.
          lv_block = lv_block && `,`.
        ENDIF.
        lv_component_first = abap_false.
        lv_block = lv_block && `{"@id":` && quoted( `action/` && ls_fi-name && `/parameter/` && ls_fp-name )
          && `,"name":` && quoted( ls_fp-abap_field )
          && `,"abap_type":` && quoted( zcl_stg_segw_gen=>action_parameter_type( ls_fp ) ) && `}`.
      ENDLOOP.
      lv_block = lv_block && `]}`.
      IF lv_count = 0.
        lv_first_block = lv_block.
      ELSE.
        IF lv_blocks IS NOT INITIAL.
          lv_blocks = lv_blocks && `,`.
        ENDIF.
        lv_blocks = lv_blocks && lv_block.
      ENDIF.
      lv_count = lv_count + 1.
    ENDLOOP.
    LOOP AT is_model-entity_types INTO ls_type.
      lv_kind = 'inline'.
      IF ls_type-abap_struct IS NOT INITIAL.
        lv_kind = 'ddic'.
      ENDIF.
      lv_block = `{"@id":` && quoted( `entity/` && ls_type-name )
        && `,"kind":` && quoted( lv_kind )
        && `,"entity_ddic":` && quoted( flag_text( xsdbool( ls_type-abap_struct IS NOT INITIAL ) ) )
        && `,"entity_inline":` && quoted( flag_text( xsdbool( ls_type-abap_struct IS INITIAL ) ) )
        && `,"name":` && quoted( `TS_` && ls_type-type_stem )
        && `,"table_name":` && quoted( `TT_` && ls_type-type_stem )
        && `,"ddic":` && quoted( ls_type-abap_struct ) && `,"components":[`.
      lv_component_first = abap_true.
      IF ls_type-abap_struct IS INITIAL.
        LOOP AT ls_type-properties INTO ls_prop.
          IF lv_component_first = abap_false.
            lv_block = lv_block && `,`.
          ENDIF.
          lv_component_first = abap_false.
          IF ls_prop-complex_type IS NOT INITIAL.
            lv_block = lv_block && `{"@id":` && quoted( `entity/` && ls_type-name && `/property/` && ls_prop-name )
              && `,"name":` && quoted( ls_prop-abap_field )
              && `,"abap_type":` && quoted( to_upper( ls_prop-complex_type ) ) && `}`.
          ELSE.
            lv_block = lv_block && `{"@id":` && quoted( `entity/` && ls_type-name && `/property/` && ls_prop-name )
              && `,"name":` && quoted( ls_prop-abap_field )
              && `,"abap_type":` && quoted( zcl_stg_segw_gen=>inline_type( ls_prop ) ) && `}`.
          ENDIF.
        ENDLOOP.
      ENDIF.
      lv_block = lv_block && `]}`.
      IF lv_count = 0.
        lv_first_block = lv_block.
      ELSE.
        IF lv_blocks IS NOT INITIAL.
          lv_blocks = lv_blocks && `,`.
        ENDIF.
        lv_blocks = lv_blocks && lv_block.
      ENDIF.
      lv_count = lv_count + 1.
    ENDLOOP.
    lv_json = lv_json && `,"other_types":[` && lv_blocks
      && `],"first_type":[` && lv_first_block && `]`.
    CLEAR lt_named.
    LOOP AT is_model-entity_types INTO ls_type.
      ls_named-name = ls_type-type_stem.
      ls_named-content = ls_type-name.
      APPEND ls_named TO lt_named.
    ENDLOOP.
    LOOP AT is_model-complex_types INTO ls_ct.
      ls_named-name = to_upper( ls_ct-name ).
      IF strlen( ls_named-name ) > 27.
        ls_named-name = substring( val = ls_named-name len = 27 ).
      ENDIF.
      ls_named-content = ls_ct-name.
      APPEND ls_named TO lt_named.
    ENDLOOP.
    SORT lt_named BY name.
    lv_json = lv_json && `,"constants":[`.
    lv_first = abap_true.
    LOOP AT lt_named INTO ls_named.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `constant/` && ls_named-name )
        && `,"name":` && quoted( ls_named-name )
        && `,"value":` && quoted( ls_named-content ) && `}`.
    ENDLOOP.
    lv_json = lv_json && `],"declarations":[`.
    CLEAR lt_named.
    IF is_model-complex_types IS NOT INITIAL.
      ls_named-name = 'DEFINE_COMPLEXTYPES'.
      APPEND ls_named TO lt_named.
    ENDIF.
    LOOP AT is_model-entity_types INTO ls_type.
      ls_named-name = `DEFINE_` && ls_type-define_stem.
      APPEND ls_named TO lt_named.
    ENDLOOP.
    IF is_model-associations IS NOT INITIAL OR is_model-navigation IS NOT INITIAL.
      ls_named-name = 'DEFINE_ASSOCIATIONS'.
      APPEND ls_named TO lt_named.
    ENDIF.
    IF is_model-function_imports IS NOT INITIAL.
      ls_named-name = 'DEFINE_ACTIONS'.
      APPEND ls_named TO lt_named.
    ENDIF.
    lv_first = abap_true.
    LOOP AT lt_named INTO ls_named.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && `{"@id":` && quoted( `declaration/` && ls_named-name )
        && `,"name":` && quoted( ls_named-name ) && `}`.
    ENDLOOP.
    lv_pad = is_model-mpc.
    WHILE strlen( lv_pad ) < 30.
      lv_pad = lv_pad && `=`.
    ENDWHILE.
    lv_json = lv_json && `],"text_include":` && quoted( lv_pad && `CP` ).
    CLEAR lt_impl.
    IF is_model-function_imports IS NOT INITIAL.
      ls_impl-name = 'DEFINE_ACTIONS'.
      ls_impl-content = `{"@id":"method/DEFINE_ACTIONS","is_actions":"X"}`.
      APPEND ls_impl TO lt_impl.
    ENDIF.
    IF is_model-associations IS NOT INITIAL OR is_model-navigation IS NOT INITIAL.
      ls_impl-name = 'DEFINE_ASSOCIATIONS'.
      ls_impl-content = `{"@id":"method/DEFINE_ASSOCIATIONS","is_associations":"X"}`.
      APPEND ls_impl TO lt_impl.
    ENDIF.
    IF is_model-complex_types IS NOT INITIAL.
      ls_impl-name = 'DEFINE_COMPLEXTYPES'.
      ls_impl-content = `{"@id":"method/DEFINE_COMPLEXTYPES","is_complex":"X"}`.
      APPEND ls_impl TO lt_impl.
    ENDIF.
    LOOP AT is_model-entity_types INTO ls_type.
      lv_block = entity_json( is_type = ls_type iv_mpc = is_model-mpc ).
      ls_impl-name = `DEFINE_` && ls_type-define_stem.
      ls_impl-content = substring( val = lv_block len = strlen( lv_block ) - 1 )
        && `,"is_entity":"X"}`.
      APPEND ls_impl TO lt_impl.
    ENDLOOP.
    ls_impl-name = 'GET_LAST_MODIFIED'.
    ls_impl-content = `{"@id":"method/GET_LAST_MODIFIED","is_last_modified":"X"}`.
    APPEND ls_impl TO lt_impl.
    ls_impl-name = 'LOAD_TEXT_ELEMENTS'.
    ls_impl-content = `{"@id":"method/LOAD_TEXT_ELEMENTS","is_load_texts":"X"}`.
    APPEND ls_impl TO lt_impl.
    SORT lt_impl BY name.
    lv_json = lv_json && `,"impls":[`.
    lv_first = abap_true.
    LOOP AT lt_impl INTO ls_impl.
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && ls_impl-content.
    ENDLOOP.
    lv_json = lv_json && `]`.
    rv_json = lv_json && `}`.
  ENDMETHOD.

  METHOD method_template.
    CASE iv_method.
      WHEN 'DEFINE'.
        rv_text = rv_text && `  method DEFINE.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && zcl_stg_segw_gen=>banner( ) && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `model->set_schema_namespace( '{{namespace}}' ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#has_complex}}define_complextypes( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/has_complex}}{{#entities}}define_{{define_lower}}( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/entities}}{{#has_associations}}define_associations( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/has_associations}}{{#has_actions}}define_actions( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/has_actions}}  endmethod.` && cl_abap_char_utilities=>newline.
      WHEN 'DEFINE_COMPLEXTYPES'.
        rv_text = rv_text && `  method DEFINE_COMPLEXTYPES.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && zcl_stg_segw_gen=>banner( ) && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && ` data:` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `       lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,             "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `       lo_complex_type   type ref to /iwbep/if_mgw_odata_cmplx_type,             "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `       lo_property       type ref to /iwbep/if_mgw_odata_property.                "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#complex_types}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `*   COMPLEX TYPE - {{name}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_complex_type = model->create_complex_type( '{{name}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `*Properties` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#properties}}lo_property = lo_complex_type->create_property( iv_property_name  = '{{name}}' iv_abap_fieldname = '{{abap_field}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_property->set_type_edm_{{edm_setter}}( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#precision}}lo_property->set_precison( iv_precision = {{precision}} ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/precision}}{{#max_length}}lo_property->set_maxlength( iv_max_length = {{max_length}} ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/max_length}}{{#semantics}}lo_property->set_semantic( '{{semantics}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/semantics}}lo_property->set_creatable( {{creatable}} ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_property->set_updatable( {{updatable}} ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_property->set_sortable( {{sortable}} ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_property->set_nullable( {{nullable}} ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_property->set_filterable( {{filterable}} ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/properties}}{{#bind_ddic}}lo_complex_type->bind_structure( iv_structure_name   = '{{abap_struct}}'` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                                 iv_bind_conversions = 'X' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/bind_ddic}}{{^bind_ddic}}lo_complex_type->bind_structure( iv_structure_name = '{{mpc}}=>{{type_upper}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/bind_ddic}}{{/complex_types}}  endmethod.` && cl_abap_char_utilities=>newline.
      WHEN 'DEFINE_ASSOCIATIONS'.
        rv_text = rv_text && `  method DEFINE_ASSOCIATIONS.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && zcl_stg_segw_gen=>banner( ) && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `data:` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,                   "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_entity_type    type ref to /iwbep/if_mgw_odata_entity_typ,                   "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_association    type ref to /iwbep/if_mgw_odata_assoc,                        "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_ref_constraint type ref to /iwbep/if_mgw_odata_ref_constr,                   "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_assoc_set      type ref to /iwbep/if_mgw_odata_assoc_set,                    "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_nav_property   type ref to /iwbep/if_mgw_odata_nav_prop.                     "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `*   ASSOCIATIONS` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#associations}} lo_association = model->create_association(` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                            iv_association_name = '{{name}}' "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                            iv_left_type        = '{{left_type}}' "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                            iv_right_type       = '{{right_type}}' "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                            iv_right_card       = '{{right_card}}' "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                            iv_left_card        = '{{left_card}}'  "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                            iv_def_assoc_set    = {{default_set}} ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#has_constraints}}* Referential constraint for association - {{name}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_ref_constraint = lo_association->create_ref_constraint( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/has_constraints}}{{#constraints}}lo_ref_constraint->add_property( iv_principal_property = '{{principal}}'   iv_dependent_property = '{{dependent}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/constraints}}{{#sets}}lo_assoc_set = model->create_association_set( iv_association_set_name  = '{{name}}'                         "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                                              iv_left_entity_set_name  = '{{left_set}}'              "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                                              iv_right_entity_set_name = '{{right_set}}'             "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                                              iv_association_name      = '{{association}}' ).                                 "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/sets}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/associations}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `*   NAVIGATION PROPERTIES` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#navigation_groups}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `* Navigation Properties for entity - {{name}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_entity_type = model->get_entity_type( iv_entity_name = '{{name}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#navigation}}lo_nav_property = lo_entity_type->create_navigation_property( iv_property_name  = '{{name}}' "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                                                              iv_abap_fieldname = '{{abap_field}}' "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `                                                              iv_association_name = '{{association}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/navigation}}{{/navigation_groups}}  endmethod.` && cl_abap_char_utilities=>newline.
      WHEN 'DEFINE_ACTIONS'.
        rv_text = rv_text && `  method DEFINE_ACTIONS.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && zcl_stg_segw_gen=>banner( ) && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `data:` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_action         type ref to /iwbep/if_mgw_odata_action,                 "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_parameter      type ref to /iwbep/if_mgw_odata_parameter.              "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#actions}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `*   ACTION - {{name}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_action = model->create_action( '{{name}}' ).  "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#label}}lo_action->set_label_from_text_element( iv_text_element_symbol = '{{label}}' iv_text_element_container = gc_incl_name ).  "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/label}}{{#return_entity}}*Set return entity type` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_action->set_return_entity_type( '{{return_type}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/return_entity}}{{#return_complex}}*Set return complex type` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_action->set_return_complex_type( '{{return_type}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/return_complex}}{{#http_method}}*Set HTTP method GET or POST` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_action->set_http_method( '{{http_method}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/http_method}}{{#action_for}}*Set the action for entity` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_action->set_action_for( '{{action_for}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/action_for}}* Set return type multiplicity` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `lo_action->set_return_multiplicity( '{{return_card}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#has_parameters}}***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `* Parameters` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `***********************************************************************************************************************************` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/has_parameters}}{{#parameters}}lo_parameter = lo_action->create_input_parameter( iv_parameter_name = '{{name}}'    iv_abap_fieldname = '{{abap_field}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#label}}lo_parameter->set_label_from_text_element( iv_text_element_symbol = '{{label}}' iv_text_element_container = gc_incl_name ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/label}}lo_parameter->/iwbep/if_mgw_odata_property~set_type_edm_{{edm_setter}}( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{#string_max_length}}lo_parameter->/iwbep/if_mgw_odata_property~set_maxlength( iv_max_length = {{max_length}} ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/string_max_length}}{{/parameters}}{{#has_parameters}}lo_action->bind_input_structure( iv_structure_name  = '{{mpc}}=>{{action_type}}' ). "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/has_parameters}}{{/actions}}  endmethod.` && cl_abap_char_utilities=>newline.
      WHEN 'GET_LAST_MODIFIED'.
        rv_text = rv_text && `  method GET_LAST_MODIFIED.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && zcl_stg_segw_gen=>banner( ) && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `  CONSTANTS: lc_gen_date_time TYPE timestamp VALUE '{{stamp}}'.                  "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `  rv_last_modified = super->get_last_modified( ).` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `  IF rv_last_modified LT lc_gen_date_time.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `    rv_last_modified = lc_gen_date_time.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `  ENDIF.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `  endmethod.` && cl_abap_char_utilities=>newline.
      WHEN 'LOAD_TEXT_ELEMENTS'.
        rv_text = rv_text && `  method LOAD_TEXT_ELEMENTS.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && zcl_stg_segw_gen=>banner( ) && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `DATA:` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `     ls_text_element TYPE ts_text_element.                                 "#EC NEEDED` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{^texts}}CLEAR ls_text_element.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/texts}}{{#has_texts}}` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/has_texts}}{{#texts}}clear ls_text_element.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `ls_text_element-artifact_name          = '{{name}}'.                 "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `ls_text_element-artifact_type          = 'PROP'.                                       "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `ls_text_element-parent_artifact_name   = '{{entity}}'.                            "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `ls_text_element-parent_artifact_type   = 'ETYP'.                                       "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `ls_text_element-text_symbol            = '{{symbol}}'.              "#EC NOTEXT` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `APPEND ls_text_element TO rt_text_elements.` && cl_abap_char_utilities=>newline.
        rv_text = rv_text && `{{/texts}}  endmethod.` && cl_abap_char_utilities=>newline.
    ENDCASE.
  ENDMETHOD.

  METHOD render_method.
    DATA ls_type TYPE zcl_stg_segw_gen=>ty_entity_type.
    LOOP AT is_model-entity_types INTO ls_type.
      IF iv_method = `DEFINE_` && ls_type-define_stem.
        rs_result = render_entity( is_type = ls_type iv_mpc = is_model-mpc ).
        RETURN.
      ENDIF.
    ENDLOOP.
    rs_result = zcl_osd_tpl=>render(
      iv_template = method_template( iv_method )
      ii_data = project_model( is_model )
      iv_name = iv_method ).
  ENDMETHOD.

  METHOD render_entity.
    rs_result = zcl_osd_tpl=>render(
      iv_template = entity_template( )
      ii_data = entity_model( is_type = is_type iv_mpc = iv_mpc )
      iv_name = 'mpc_entity' ).
  ENDMETHOD.

  METHOD type_template.
    rv_text = `{{#complex_ddic}}  types:` && cl_abap_char_utilities=>newline
      && `     {{name}} type {{ddic}} .` && cl_abap_char_utilities=>newline
      && `{{/complex_ddic}}{{#complex_inline}}  types:` && cl_abap_char_utilities=>newline
      && `        begin of {{name}},` && cl_abap_char_utilities=>newline
      && `{{#components}}        {{name}} type {{abap_type}},` && cl_abap_char_utilities=>newline
      && `{{/components}}    end of {{name}} .` && cl_abap_char_utilities=>newline
      && `{{/complex_inline}}{{#is_action}}  types:` && cl_abap_char_utilities=>newline
      && `    begin of {{name}},` && cl_abap_char_utilities=>newline
      && `{{#components}}        {{name}} type {{abap_type}},` && cl_abap_char_utilities=>newline
      && `{{/components}}    end of {{name}} .` && cl_abap_char_utilities=>newline
      && `{{/is_action}}{{#entity_ddic}}  types:` && cl_abap_char_utilities=>newline
      && `     {{name}} type {{ddic}} .` && cl_abap_char_utilities=>newline
      && `  types:` && cl_abap_char_utilities=>newline
      && `{{table_name}} type standard table of {{name}} .` && cl_abap_char_utilities=>newline
      && `{{/entity_ddic}}{{#entity_inline}}  types:` && cl_abap_char_utilities=>newline
      && `      begin of {{name}},` && cl_abap_char_utilities=>newline
      && `{{#components}}     {{name}} type {{abap_type}},` && cl_abap_char_utilities=>newline
      && `{{/components}}  end of {{name}} .` && cl_abap_char_utilities=>newline
      && `  types:` && cl_abap_char_utilities=>newline
      && `    {{table_name}} type standard table of {{name}} .` && cl_abap_char_utilities=>newline
      && `{{/entity_inline}}`.
  ENDMETHOD.

  METHOD class_template.
    rv_text = `class {{mpc}} definition` && cl_abap_char_utilities=>newline
      && `  public` && cl_abap_char_utilities=>newline
      && `  inheriting from /IWBEP/CL_MGW_PUSH_ABS_MODEL` && cl_abap_char_utilities=>newline
      && `  create public .` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `public section.` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `{{#first_type}}` && type_template( ) && `{{/first_type}}`
      && `  types:` && cl_abap_char_utilities=>newline
      && `   begin of ts_text_element,` && cl_abap_char_utilities=>newline
      && `      artifact_name  type c length 40,       " technical name` && cl_abap_char_utilities=>newline
      && `      artifact_type  type c length 4,` && cl_abap_char_utilities=>newline
      && `      parent_artifact_name type c length 40, " technical name` && cl_abap_char_utilities=>newline
      && `      parent_artifact_type type c length 4,` && cl_abap_char_utilities=>newline
      && `      text_symbol    type textpoolky,` && cl_abap_char_utilities=>newline
      && `   end of ts_text_element .` && cl_abap_char_utilities=>newline
      && `  types:` && cl_abap_char_utilities=>newline
      && `         tt_text_elements type standard table of ts_text_element with key text_symbol .` && cl_abap_char_utilities=>newline
      && `{{#other_types}}` && type_template( ) && `{{/other_types}}`
      && cl_abap_char_utilities=>newline
      && `{{#constants}}  constants GC_{{name}} type /IWBEP/IF_MGW_MED_ODATA_TYPES=>TY_E_MED_ENTITY_NAME value '{{value}}' ##NO_TEXT.` && cl_abap_char_utilities=>newline
      && `{{/constants}}` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `  methods LOAD_TEXT_ELEMENTS` && cl_abap_char_utilities=>newline
      && `  final` && cl_abap_char_utilities=>newline
      && `    returning` && cl_abap_char_utilities=>newline
      && `      value(RT_TEXT_ELEMENTS) type TT_TEXT_ELEMENTS` && cl_abap_char_utilities=>newline
      && `    raising` && cl_abap_char_utilities=>newline
      && `      /IWBEP/CX_MGW_MED_EXCEPTION .` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `  methods DEFINE` && cl_abap_char_utilities=>newline
      && `    redefinition .` && cl_abap_char_utilities=>newline
      && `  methods GET_LAST_MODIFIED` && cl_abap_char_utilities=>newline
      && `    redefinition .` && cl_abap_char_utilities=>newline
      && `protected section.` && cl_abap_char_utilities=>newline
      && `private section.` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `{{#has_text_include}}  constants GC_INCL_NAME type STRING value '{{text_include}}' ##NO_TEXT.` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `{{/has_text_include}}{{#declarations}}  methods {{name}}` && cl_abap_char_utilities=>newline
      && `    raising` && cl_abap_char_utilities=>newline
      && `      /IWBEP/CX_MGW_MED_EXCEPTION .` && cl_abap_char_utilities=>newline
      && `{{/declarations}}ENDCLASS.` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `CLASS {{mpc}} IMPLEMENTATION.` && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && cl_abap_char_utilities=>newline
      && `{{> DEFINE}}`
      && `{{#impls}}` && cl_abap_char_utilities=>newline && cl_abap_char_utilities=>newline
      && `{{#is_actions}}{{> DEFINE_ACTIONS}}{{/is_actions}}`
      && `{{#is_associations}}{{> DEFINE_ASSOCIATIONS}}{{/is_associations}}`
      && `{{#is_complex}}{{> DEFINE_COMPLEXTYPES}}{{/is_complex}}`
      && `{{#is_entity}}{{> entity}}{{/is_entity}}`
      && `{{#is_last_modified}}{{> GET_LAST_MODIFIED}}{{/is_last_modified}}`
      && `{{#is_load_texts}}{{> LOAD_TEXT_ELEMENTS}}{{/is_load_texts}}`
      && `{{/impls}}ENDCLASS.` && cl_abap_char_utilities=>newline.
  ENDMETHOD.

  METHOD render_class.
    rs_result = render_model( project_model( is_model ) ).
  ENDMETHOD.

  METHOD render_model.
    DATA lo_model TYPE REF TO zif_ajson.
    DATA lt_partials TYPE zcl_osd_tpl=>tt_partials.
    DATA ls_partial TYPE zcl_osd_tpl=>ty_partial.
    DATA lt_methods TYPE string_table.
    DATA lv_method TYPE string.
    lo_model = io_model.
    APPEND 'DEFINE' TO lt_methods.
    APPEND 'DEFINE_ACTIONS' TO lt_methods.
    APPEND 'DEFINE_ASSOCIATIONS' TO lt_methods.
    APPEND 'DEFINE_COMPLEXTYPES' TO lt_methods.
    APPEND 'GET_LAST_MODIFIED' TO lt_methods.
    APPEND 'LOAD_TEXT_ELEMENTS' TO lt_methods.
    LOOP AT lt_methods INTO lv_method.
      ls_partial-name = lv_method.
      ls_partial-template = method_template( lv_method ).
      APPEND ls_partial TO lt_partials.
    ENDLOOP.
    ls_partial-name = 'entity'.
    ls_partial-template = entity_template( ).
    APPEND ls_partial TO lt_partials.
    rs_result = zcl_osd_tpl=>render( iv_template = class_template( )
      ii_data = lo_model it_partials = lt_partials iv_name = 'mpc_class' ).
  ENDMETHOD.
ENDCLASS.
