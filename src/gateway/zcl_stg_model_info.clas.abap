CLASS zcl_stg_model_info DEFINITION PUBLIC CREATE PUBLIC.
* Runs the registered MPC once per service and keeps what the dispatcher and
* the serializer need: entity sets, their types, properties, keys.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_property,
             name      TYPE string,
             fieldname TYPE string,
             edm_type  TYPE string,
             is_key    TYPE abap_bool,
             nullable  TYPE abap_bool,
* set_as_etag in the MPC: the property is (part of) the entity's ETag
             is_etag   TYPE abap_bool,
* set_maxlength of an Edm.String property or parameter (0: none); a key or a
* parameter value longer than it is refused, see check_length
             max_length TYPE i,
* create_complex_property in the MPC: the property is a structure of the
* named complex type, its members are listed in the set's components
             complex_type TYPE string,
* a member of a complex property (a row of ty_entity_set-components): the
* name of the complex property it belongs to. Its own name is the OData
* path (Address/City), its fieldname the ABAP path (ADDRESS-CITY)
             parent     TYPE string,
           END OF ty_property.
    TYPES ty_properties TYPE STANDARD TABLE OF ty_property WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_nav,
             name        TYPE string,
             association TYPE string,
             target_type TYPE string,
             target_set  TYPE string,
             to_many     TYPE abap_bool,
           END OF ty_nav.
    TYPES ty_navs TYPE STANDARD TABLE OF ty_nav WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_entity_set,
             name        TYPE string,
             entity_type TYPE string,
             properties  TYPE ty_properties,
             navs        TYPE ty_navs,
             aggregate   TYPE abap_bool,
* what the model allows on the set; a write the model refuses never reaches
* the DPC
             creatable   TYPE abap_bool,
             updatable   TYPE abap_bool,
             deletable   TYPE abap_bool,
* set_is_media on the entity type: the content is a stream at <entity>/$value
             is_media    TYPE abap_bool,
* set_has_ftxt_search (sap:searchable): the DPC's GET_ENTITYSET takes a search string
             searchable  TYPE abap_bool,
* the members of the type's complex properties, one row per member, in the
* order of the complex type: what a property path ($filter Address/City)
* and the serializer's nested object are resolved against
             components  TYPE ty_properties,
           END OF ty_entity_set.
    TYPES ty_entity_sets TYPE STANDARD TABLE OF ty_entity_set WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_association,
             name              TYPE string,
             left_type         TYPE string,
             right_type        TYPE string,
             left_card         TYPE string,
             right_card        TYPE string,
             left_set          TYPE string,
             right_set         TYPE string,
             principal_is_left TYPE abap_bool,
             pairs             TYPE zcl_oao_ref_constraint=>ty_pairs,
           END OF ty_association.
    TYPES ty_associations TYPE STANDARD TABLE OF ty_association WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_action,
             name                TYPE string,
             http_method         TYPE string,
             return_entity_type  TYPE string,
             return_entity_set   TYPE string,
             return_complex_type TYPE string,
             return_many         TYPE abap_bool,
             parameters          TYPE ty_properties,
* set_action_for: the entity type the function import belongs to (SEGW's
* "Action for"); the V4 facade binds the operation to it
             action_for          TYPE string,
           END OF ty_action.
    TYPES ty_actions TYPE STANDARD TABLE OF ty_action WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_service,
             name         TYPE string,
             namespace    TYPE string,
             entity_sets  TYPE ty_entity_sets,
             associations TYPE ty_associations,
             actions      TYPE ty_actions,
           END OF ty_service.

    CLASS-METHODS get
      IMPORTING
        iv_service        TYPE string
      RETURNING
        VALUE(rs_service) TYPE ty_service
      RAISING
        zcx_stg_error.

    CLASS-METHODS find_set
      IMPORTING
        is_service    TYPE ty_service
        iv_entity_set TYPE string
      RETURNING
        VALUE(rs_set) TYPE ty_entity_set
      RAISING
        zcx_stg_error.

    CLASS-METHODS key_names
      IMPORTING
        is_set          TYPE ty_entity_set
      RETURNING
        VALUE(rt_names) TYPE string_table.

* does the entity type declare an ETag (set_as_etag on a property)? A write
* of such an entity is only lost-update protected when the client sends
* If-Match, so the model asking for it is what makes the header required
    CLASS-METHODS has_etag
      IMPORTING
        is_set         TYPE ty_entity_set
      RETURNING
        VALUE(rv_etag) TYPE abap_bool.

    CLASS-METHODS find_property
      IMPORTING
        is_set             TYPE ty_entity_set
        iv_name            TYPE string
      RETURNING
        VALUE(rs_property) TYPE ty_property
      RAISING
        zcx_stg_error.

    CLASS-METHODS find_action
      IMPORTING
        is_service       TYPE ty_service
        iv_name          TYPE string
      RETURNING
        VALUE(rs_action) TYPE ty_action.

    CLASS-METHODS find_nav
      IMPORTING
        is_set        TYPE ty_entity_set
        iv_name       TYPE string
      RETURNING
        VALUE(rs_nav) TYPE ty_nav
      RAISING
        zcx_stg_error.

* A key predicate or a function import parameter longer than the MaxLength
* of its property is a 400, the way the Gateway's URI parser checks a
* literal against the facets of its property. Without the check the value
* reaches a CHAR field of the DPC cut to the DDIC length, and
* TravelSet('T0002    X') reads, changes or deletes T0002. The trailing
* blanks of the value do not count: the length is CHAR semantics, so
* 'T0001    ' is 5 against a MaxLength 8 and is T0001 in the DPC. A $filter
* literal is not checked at all: what a comparison does with it is the
* DPC's code, not the gateway's (docs/key-length.md).
    CLASS-METHODS check_length
      IMPORTING
        is_property TYPE ty_property
        iv_value    TYPE string
        iv_what     TYPE string
      RAISING
        zcx_stg_error.

    CLASS-METHODS check_keys
      IMPORTING
        is_set     TYPE ty_entity_set
        it_key_tab TYPE /iwbep/t_mgw_name_value_pair
      RAISING
        zcx_stg_error.

    CLASS-METHODS clear.
  PRIVATE SECTION.
    CLASS-DATA gt_services TYPE HASHED TABLE OF ty_service WITH UNIQUE KEY name.

    CLASS-METHODS build
      IMPORTING
        iv_service        TYPE string
      RETURNING
        VALUE(rs_service) TYPE ty_service
      RAISING
        zcx_stg_error.

    CLASS-METHODS components
      IMPORTING
        io_model  TYPE REF TO zcl_oao_model
        is_parent TYPE ty_property
      CHANGING
        ct_rows   TYPE ty_properties
      RAISING
        zcx_stg_error.
ENDCLASS.

CLASS zcl_stg_model_info IMPLEMENTATION.

  METHOD get.
    DATA lv_service TYPE string.

    lv_service = to_upper( iv_service ).
    READ TABLE gt_services INTO rs_service WITH TABLE KEY name = lv_service.
    IF sy-subrc <> 0.
      rs_service = build( lv_service ).
      INSERT rs_service INTO TABLE gt_services.
    ENDIF.
  ENDMETHOD.

  METHOD clear.
    CLEAR gt_services.
  ENDMETHOD.

  METHOD build.
    DATA lo_mpc         TYPE REF TO /iwbep/cl_mgw_push_abs_model.
    DATA lo_model       TYPE REF TO zcl_oao_model.
    DATA lt_type_names  TYPE zcl_oao_model=>ty_entity_names.
    DATA lv_type_name   LIKE LINE OF lt_type_names.
    DATA lo_entity      TYPE REF TO zcl_oao_entity_typ.
    DATA lt_properties  TYPE /iwbep/if_mgw_med_odata_types=>ty_t_mgw_odata_properties.
    DATA ls_property    LIKE LINE OF lt_properties.
    DATA lo_property    TYPE REF TO zcl_oao_property.
    DATA ls_info        TYPE ty_property.
    DATA lt_info        TYPE ty_properties.
    DATA lt_components  TYPE ty_properties.
    DATA lt_entity_sets TYPE zcl_oao_entity_typ=>ty_entity_sets.
    DATA ls_entity_set  LIKE LINE OF lt_entity_sets.
    DATA ls_set         TYPE ty_entity_set.
    DATA lx_gateway     TYPE REF TO /iwbep/cx_mgw_base_exception.
    DATA lt_assocs      TYPE zcl_oao_model=>ty_associations.
    DATA lo_assoc       TYPE REF TO zcl_oao_association.
    DATA lt_assoc_sets  TYPE zcl_oao_model=>ty_assoc_sets.
    DATA lo_assoc_set   TYPE REF TO zcl_oao_assoc_set.
    DATA ls_association TYPE ty_association.
    DATA lt_navs        TYPE zcl_oao_entity_typ=>ty_nav_props.
    DATA lo_nav         TYPE REF TO zcl_oao_nav_prop.
    DATA ls_nav         TYPE ty_nav.
    DATA ls_other       TYPE ty_entity_set.
    DATA lt_actions     TYPE zcl_oao_model=>ty_actions.
    DATA lo_action      TYPE REF TO zcl_oao_action.
    DATA lo_parameter   TYPE REF TO zcl_oao_parameter.
    DATA ls_action      TYPE ty_action.
    DATA lt_annotations TYPE zcl_oao_annotation=>ty_annotations.
    DATA ls_annotation  TYPE zcl_oao_annotation=>ty_annotation.
    FIELD-SYMBOLS <ls_set> TYPE ty_entity_set.

    rs_service-name = iv_service.
    TRY.
        lo_mpc = zcl_oao_registry=>create_mpc( iv_service ).
        lo_mpc->define( ).
      CATCH /iwbep/cx_mgw_base_exception INTO lx_gateway.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING
            status   = 404
            code     = 'STG/SERVICE_NOT_FOUND'
            message  = |Service { iv_service } is not registered|
            previous = lx_gateway.
    ENDTRY.

    lo_model ?= lo_mpc->model.
    lo_model->/iwbep/if_mgw_odata_model~get_schema_namespace( IMPORTING ev_namespace = rs_service-namespace ).
    lt_type_names = lo_model->get_entity_type_names( ).

    LOOP AT lt_type_names INTO lv_type_name.
      TRY.
          lo_entity ?= lo_model->/iwbep/if_mgw_odata_model~get_entity_type( lv_type_name ).
        CATCH /iwbep/cx_mgw_med_exception INTO lx_gateway.
          RAISE EXCEPTION TYPE zcx_stg_error
            EXPORTING
              status   = 500
              code     = 'STG/MODEL'
              message  = |Entity type { lv_type_name } vanished from the model|
              previous = lx_gateway.
      ENDTRY.

      CLEAR: lt_info, lt_components.
      lt_properties = lo_entity->/iwbep/if_mgw_odata_entity_typ~get_properties( ).
      LOOP AT lt_properties INTO ls_property.
        lo_property ?= ls_property-property.
        CLEAR ls_info.
        ls_info-name      = ls_property-name.
        ls_info-fieldname = to_upper( lo_property->mv_abap_fieldname ).
        IF ls_info-fieldname IS INITIAL.
          ls_info-fieldname = to_upper( ls_property-name ).
        ENDIF.
        ls_info-edm_type = lo_property->mv_edm_type.
        IF ls_info-edm_type IS INITIAL.
          ls_info-edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-string.
        ENDIF.
        ls_info-is_key   = lo_property->mv_is_key.
        ls_info-nullable = lo_property->mv_nullable.
        ls_info-is_etag  = lo_property->mv_etag.
        IF ls_info-edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-string.
          ls_info-max_length = lo_property->mv_maxlength.
        ENDIF.
        ls_info-complex_type = lo_property->mv_complex_type.
        APPEND ls_info TO lt_info.
        IF ls_info-complex_type IS NOT INITIAL.
          components( EXPORTING io_model  = lo_model
                                is_parent = ls_info
                      CHANGING  ct_rows   = lt_components ).
        ENDIF.
      ENDLOOP.

      lt_entity_sets = lo_entity->get_entity_sets( ).
      LOOP AT lt_entity_sets INTO ls_entity_set.
        CLEAR ls_set.
        ls_set-name        = ls_entity_set-name.
        ls_set-entity_type = lv_type_name.
        ls_set-properties  = lt_info.
        ls_set-components  = lt_components.
        ls_set-creatable   = ls_entity_set-entity_set->mv_creatable.
        ls_set-updatable   = ls_entity_set-entity_set->mv_updatable.
        ls_set-deletable   = ls_entity_set-entity_set->mv_deletable.
        ls_set-is_media    = lo_entity->mv_is_media.
        ls_set-searchable  = ls_entity_set-entity_set->mv_fsearch.
        IF ls_entity_set-entity_set->mo_annotation IS BOUND.
          lt_annotations = ls_entity_set-entity_set->mo_annotation->get_all( ).
          READ TABLE lt_annotations INTO ls_annotation WITH KEY key = 'semantics'.
          IF sy-subrc = 0 AND ls_annotation-value = 'aggregate'.
            ls_set-aggregate = abap_true.
          ENDIF.
        ENDIF.
        APPEND ls_set TO rs_service-entity_sets.
      ENDLOOP.
    ENDLOOP.

* associations and their sets
    lt_assocs     = lo_model->get_associations( ).
    lt_assoc_sets = lo_model->get_association_sets( ).
    LOOP AT lt_assocs INTO lo_assoc.
      CLEAR ls_association.
      ls_association-name       = lo_assoc->mv_name.
      ls_association-left_type  = lo_assoc->mv_left_type.
      ls_association-right_type = lo_assoc->mv_right_type.
      ls_association-left_card  = lo_assoc->mv_left_card.
      ls_association-right_card = lo_assoc->mv_right_card.
      IF lo_assoc->mo_ref_constraint IS BOUND.
        ls_association-principal_is_left = lo_assoc->mo_ref_constraint->mv_principal_is_left.
        ls_association-pairs             = lo_assoc->mo_ref_constraint->mt_pairs.
      ENDIF.
      LOOP AT lt_assoc_sets INTO lo_assoc_set.
        IF lo_assoc_set->mv_association = lo_assoc->mv_name.
          ls_association-left_set  = lo_assoc_set->mv_left_set.
          ls_association-right_set = lo_assoc_set->mv_right_set.
        ENDIF.
      ENDLOOP.
      APPEND ls_association TO rs_service-associations.
    ENDLOOP.

* function imports
    lt_actions = lo_model->get_actions( ).
    LOOP AT lt_actions INTO lo_action.
      CLEAR ls_action.
      ls_action-name                = lo_action->mv_name.
      ls_action-http_method         = to_upper( lo_action->mv_http_method ).
      ls_action-return_entity_type  = lo_action->mv_return_entity_type.
      ls_action-return_entity_set   = lo_action->mv_return_entity_set.
      ls_action-return_complex_type = lo_action->mv_return_complex_type.
      ls_action-action_for          = lo_action->mv_action_for.
      IF lo_action->mv_return_multiplicity <> '1' AND lo_action->mv_return_multiplicity <> '0'.
        ls_action-return_many = abap_true.
      ENDIF.
      LOOP AT lo_action->mt_parameters INTO lo_parameter.
        CLEAR ls_info.
        ls_info-name      = lo_parameter->mv_name.
        ls_info-fieldname = to_upper( lo_parameter->mv_abap_fieldname ).
        IF ls_info-fieldname IS INITIAL.
          ls_info-fieldname = to_upper( lo_parameter->mv_name ).
        ENDIF.
        ls_info-edm_type = lo_parameter->mv_edm_type.
        IF ls_info-edm_type IS INITIAL.
          ls_info-edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-string.
        ENDIF.
        IF ls_info-edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-string.
          ls_info-max_length = lo_parameter->mv_maxlength.
        ENDIF.
        APPEND ls_info TO ls_action-parameters.
      ENDLOOP.
      APPEND ls_action TO rs_service-actions.
    ENDLOOP.

* navigation properties, resolved to a target set per entity set
    LOOP AT rs_service-entity_sets ASSIGNING <ls_set>.
      lv_type_name = <ls_set>-entity_type.
      TRY.
          lo_entity ?= lo_model->/iwbep/if_mgw_odata_model~get_entity_type( lv_type_name ).
        CATCH /iwbep/cx_mgw_med_exception.
          CONTINUE.
      ENDTRY.
      lt_navs = lo_entity->get_navigation_properties( ).
      LOOP AT lt_navs INTO lo_nav.
        CLEAR ls_nav.
        ls_nav-name        = lo_nav->mv_name.
        ls_nav-association = lo_nav->mv_association.
        READ TABLE rs_service-associations INTO ls_association WITH KEY name = lo_nav->mv_association.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        IF ls_association-left_type = <ls_set>-entity_type.
          ls_nav-target_type = ls_association-right_type.
          ls_nav-target_set  = ls_association-right_set.
          IF ls_association-right_card <> '1' AND ls_association-right_card <> '0'.
            ls_nav-to_many = abap_true.
          ENDIF.
        ELSE.
          ls_nav-target_type = ls_association-left_type.
          ls_nav-target_set  = ls_association-left_set.
          IF ls_association-left_card <> '1' AND ls_association-left_card <> '0'.
            ls_nav-to_many = abap_true.
          ENDIF.
        ENDIF.
        IF ls_nav-target_set IS INITIAL.
          LOOP AT rs_service-entity_sets INTO ls_other WHERE entity_type = ls_nav-target_type.
            ls_nav-target_set = ls_other-name.
            EXIT.
          ENDLOOP.
        ENDIF.
        APPEND ls_nav TO <ls_set>-navs.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD check_length.
* the length of the value is the position of its last non-blank character,
* the way a CHAR field holds a value: the DPC's field drops trailing blanks
* (or pads with them), so they can never address another entity, and a
* system's parser measures the same way. Only a non-blank character beyond
* the MaxLength is refused. SHIFT RIGHT DELETING TRAILING is no way to find
* that position: it moves a trailing blank to the front (zcl_stg_json,
* trim_blanks, measured there).
    DATA lv_len  TYPE i.
    DATA lv_last TYPE i.

    lv_len = strlen( iv_value ).
    WHILE lv_len > 0.
      lv_last = lv_len - 1.
* the blank is the backtick literal, not space: a substring of a string is a
* string here, and a string never equals the Character constant space
* (ANOMALY-2026-11-09-space-eq-string-substring)
      IF iv_value+lv_last(1) <> ` `.
        EXIT.
      ENDIF.
      lv_len = lv_len - 1.
    ENDWHILE.

    IF is_property-max_length <= 0 OR lv_len <= is_property-max_length.
      RETURN.
    ENDIF.
    RAISE EXCEPTION TYPE zcx_stg_error
      EXPORTING
        status  = 400
        code    = 'STG/VALUE_TOO_LONG'
        message = |{ iv_what } { is_property-name } is longer than its MaxLength { is_property-max_length }|.
  ENDMETHOD.

  METHOD check_keys.
    DATA ls_key      LIKE LINE OF it_key_tab.
    DATA ls_property TYPE ty_property.

    LOOP AT it_key_tab INTO ls_key.
      LOOP AT is_set-properties INTO ls_property WHERE is_key = abap_true.
        IF to_upper( ls_property-name ) = to_upper( ls_key-name ).
          check_length( is_property = ls_property
                        iv_value    = ls_key-value
                        iv_what     = 'Key property' ).
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD find_action.
    READ TABLE is_service-actions INTO rs_action WITH KEY name = iv_name.
    IF sy-subrc <> 0.
      CLEAR rs_action.
    ENDIF.
  ENDMETHOD.

  METHOD find_nav.
    READ TABLE is_set-navs INTO rs_nav WITH KEY name = iv_name.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 404
          code    = 'STG/NAVIGATION_NOT_FOUND'
          message = |{ is_set-entity_type } has no navigation property { iv_name }|.
    ENDIF.
  ENDMETHOD.

  METHOD find_set.
    READ TABLE is_service-entity_sets INTO rs_set WITH KEY name = iv_entity_set.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 404
          code    = 'STG/ENTITY_SET_NOT_FOUND'
          message = |Entity set { iv_entity_set } does not exist in { is_service-name }|.
    ENDIF.
  ENDMETHOD.

  METHOD key_names.
    DATA ls_property LIKE LINE OF is_set-properties.

    LOOP AT is_set-properties INTO ls_property WHERE is_key = abap_true.
      APPEND ls_property-name TO rt_names.
    ENDLOOP.
  ENDMETHOD.

  METHOD has_etag.
    READ TABLE is_set-properties TRANSPORTING NO FIELDS WITH KEY is_etag = abap_true.
    rv_etag = boolc( sy-subrc = 0 ).
  ENDMETHOD.

  METHOD components.
* the members of one complex property, as rows the serializer and a property
* path read: name Address/City, fieldname ADDRESS-CITY, parent Address. A
* complex type the model does not hold is a broken model, said as one
    DATA lo_type       TYPE REF TO /iwbep/if_mgw_odata_cmplx_type.
    DATA lt_properties TYPE /iwbep/if_mgw_med_odata_types=>ty_t_mgw_odata_properties.
    DATA ls_property   LIKE LINE OF lt_properties.
    DATA lo_property   TYPE REF TO zcl_oao_property.
    DATA ls_row        TYPE ty_property.
    DATA lv_field      TYPE string.
    DATA lx_gateway    TYPE REF TO /iwbep/cx_mgw_base_exception.
    DATA lv_type_name  TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.

    lv_type_name = is_parent-complex_type.
    TRY.
        lo_type = io_model->/iwbep/if_mgw_odata_model~get_complex_type( lv_type_name ).
      CATCH /iwbep/cx_mgw_med_exception INTO lx_gateway.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING
            status   = 500
            code     = 'STG/MODEL'
            message  = |Complex type { is_parent-complex_type } of property { is_parent-name } is not in the model|
            previous = lx_gateway.
    ENDTRY.

    lt_properties = lo_type->get_properties( ).
    LOOP AT lt_properties INTO ls_property.
      lo_property ?= ls_property-property.
      CLEAR ls_row.
      lv_field = to_upper( lo_property->mv_abap_fieldname ).
      IF lv_field IS INITIAL.
        lv_field = to_upper( ls_property-name ).
      ENDIF.
      ls_row-name      = |{ is_parent-name }/{ ls_property-name }|.
      ls_row-fieldname = |{ is_parent-fieldname }-{ lv_field }|.
      ls_row-parent    = is_parent-name.
      ls_row-edm_type  = lo_property->mv_edm_type.
      IF ls_row-edm_type IS INITIAL.
        ls_row-edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-string.
      ENDIF.
      ls_row-nullable = lo_property->mv_nullable.
      IF ls_row-edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-string.
        ls_row-max_length = lo_property->mv_maxlength.
      ENDIF.
      APPEND ls_row TO ct_rows.
    ENDLOOP.
  ENDMETHOD.

  METHOD find_property.
    DATA ls_property LIKE LINE OF is_set-properties.

    LOOP AT is_set-properties INTO ls_property.
      IF to_upper( ls_property-name ) = to_upper( iv_name ).
        rs_property = ls_property.
        RETURN.
      ENDIF.
    ENDLOOP.
* a property path into a complex property: Address/City
    LOOP AT is_set-components INTO ls_property.
      IF to_upper( ls_property-name ) = to_upper( iv_name ).
        rs_property = ls_property.
        RETURN.
      ENDIF.
    ENDLOOP.
    RAISE EXCEPTION TYPE zcx_stg_error
      EXPORTING
        status  = 400
        code    = 'STG/PROPERTY_NOT_FOUND'
        message = |Property { iv_name } does not exist in { is_set-entity_type }|.
  ENDMETHOD.

ENDCLASS.
