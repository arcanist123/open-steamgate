CLASS zcl_oao_model DEFINITION PUBLIC.
* Overlay of open-abap-odata's model (src/gateway/compat/README.md): the
* default association set. create_association( iv_def_assoc_set = abap_true )
* -- the interface's default -- makes the Gateway build the set itself,
* named <association>_AssocSet cut to 40 characters, between the default
* entity sets of the two types; the pinned class ignored the flag, and a
* SEGW-generated MPC (which creates no set of its own then) answered a
* $metadata with no AssociationSet at all (H5x-4 B4, measured against a
* system's $metadata of the SEGW sample service).
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_model.
    INTERFACES /iwbep/if_mgw_vocan_model.

    TYPES ty_entity_names TYPE STANDARD TABLE OF /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name WITH DEFAULT KEY.

    TYPES ty_associations TYPE STANDARD TABLE OF REF TO zcl_oao_association WITH DEFAULT KEY.
    TYPES ty_assoc_sets   TYPE STANDARD TABLE OF REF TO zcl_oao_assoc_set WITH DEFAULT KEY.
    TYPES ty_actions      TYPE STANDARD TABLE OF REF TO zcl_oao_action WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_complex_type,
             name         TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name,
             complex_type TYPE REF TO zcl_oao_cmplx_type,
           END OF ty_complex_type.
    TYPES ty_complex_types TYPE STANDARD TABLE OF ty_complex_type WITH DEFAULT KEY.

    METHODS get_entity_type_names
      RETURNING
        VALUE(rt_names) TYPE ty_entity_names.

    METHODS get_associations
      RETURNING
        VALUE(rt_associations) TYPE ty_associations.

    METHODS get_association_sets
      RETURNING
        VALUE(rt_sets) TYPE ty_assoc_sets.

    METHODS get_actions
      RETURNING
        VALUE(rt_actions) TYPE ty_actions.

    METHODS get_complex_types
      RETURNING
        VALUE(rt_complex_types) TYPE ty_complex_types.

* schema-level vocabulary annotations (<Annotations Target=...>), raw XML
    METHODS add_vocabulary_xml
      IMPORTING
        iv_xml TYPE string.

    METHODS get_vocabulary_xml
      RETURNING
        VALUE(rt_xml) TYPE string_table.
  PRIVATE SECTION.
    DATA mv_namespace TYPE string.
    DATA mt_entity_names TYPE ty_entity_names.
    DATA mt_associations TYPE ty_associations.
    DATA mt_assoc_sets   TYPE ty_assoc_sets.
    DATA mt_actions      TYPE ty_actions.
    DATA mt_complex_types TYPE ty_complex_types.
    DATA mt_vocabulary   TYPE string_table.
    DATA mt_targets      TYPE zcl_oao_vocan=>ty_nodes.

    TYPES: BEGIN OF ty_entity,
             entity_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name,
             entity      TYPE REF TO /iwbep/if_mgw_odata_entity_typ,
           END OF ty_entity.
    DATA mt_entities TYPE HASHED TABLE OF ty_entity WITH UNIQUE KEY entity_name.
* the associations created with iv_def_assoc_set = abap_true
    DATA mt_default_sets TYPE STANDARD TABLE OF REF TO zcl_oao_association WITH DEFAULT KEY.

    METHODS default_entity_set
      IMPORTING
        iv_type       TYPE string
      RETURNING
        VALUE(rv_set) TYPE string.
ENDCLASS.

CLASS zcl_oao_model IMPLEMENTATION.
  METHOD /iwbep/if_mgw_odata_model~create_action.
    DATA lo_action TYPE REF TO zcl_oao_action.

    CREATE OBJECT lo_action.
    lo_action->mv_name = iv_action_name.
    APPEND lo_action TO mt_actions.
    ro_action = lo_action.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~create_complex_type.
    DATA ls_row LIKE LINE OF mt_complex_types.

    CREATE OBJECT ls_row-complex_type.
    ls_row-name = iv_complex_type_name.
    APPEND ls_row TO mt_complex_types.
    ro_complex_type = ls_row-complex_type.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~get_complex_type.
    DATA ls_row LIKE LINE OF mt_complex_types.

    READ TABLE mt_complex_types INTO ls_row WITH KEY name = iv_complex_type_name.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_med_exception.
    ENDIF.
    ro_complex_type = ls_row-complex_type.
  ENDMETHOD.

  METHOD get_complex_types.
    rt_complex_types = mt_complex_types.
  ENDMETHOD.

  METHOD get_actions.
* a function import that names only its return entity TYPE answers with the
* type's default entity set, as the Gateway does (the SEGW sample sets the
* type alone and a system's $metadata carries EntitySet="<type>Set")
    DATA lo_action TYPE REF TO zcl_oao_action.

    rt_actions = mt_actions.
    LOOP AT rt_actions INTO lo_action.
      IF lo_action->mv_return_entity_set IS INITIAL AND lo_action->mv_return_entity_type IS NOT INITIAL.
        lo_action->mv_return_entity_set = default_entity_set( |{ lo_action->mv_return_entity_type }| ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD add_vocabulary_xml.
    APPEND iv_xml TO mt_vocabulary.
  ENDMETHOD.

  METHOD get_vocabulary_xml.
    DATA lo_target TYPE REF TO zcl_oao_vocan.
    DATA lv_xml    TYPE string.

    rt_xml = mt_vocabulary.
* what the _MPC_EXT built through vocab_anno_model, rendered now
    LOOP AT mt_targets INTO lo_target.
      lv_xml = lo_target->render( '      ' ).
      APPEND lv_xml TO rt_xml.
    ENDLOOP.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_vocan_model~create_annotations_target.
    DATA lo_target TYPE REF TO zcl_oao_vocan.

    CREATE OBJECT lo_target
      EXPORTING
        iv_kind      = zcl_oao_vocan=>gc_kind-target
        iv_name      = iv_target
        iv_qualifier = iv_qualifier.
    APPEND lo_target TO mt_targets.
    ro_annotations_target = lo_target.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~create_association.
    DATA lo_association TYPE REF TO zcl_oao_association.

    CREATE OBJECT lo_association.
    lo_association->mv_name       = iv_association_name.
    lo_association->mv_left_type  = iv_left_type.
    lo_association->mv_right_type = iv_right_type.
    lo_association->mv_left_card  = iv_left_card.
    lo_association->mv_right_card = iv_right_card.
    APPEND lo_association TO mt_associations.
    IF iv_def_assoc_set = abap_true.
      APPEND lo_association TO mt_default_sets.
    ENDIF.
    ro_association = lo_association.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~create_association_set.
    DATA lo_set TYPE REF TO zcl_oao_assoc_set.

    CREATE OBJECT lo_set.
    lo_set->mv_name        = iv_association_set_name.
    lo_set->mv_association = iv_association_name.
    lo_set->mv_left_set    = iv_left_entity_set_name.
    lo_set->mv_right_set   = iv_right_entity_set_name.
    APPEND lo_set TO mt_assoc_sets.
    ro_association_set = lo_set.
  ENDMETHOD.

  METHOD get_associations.
    rt_associations = mt_associations.
  ENDMETHOD.

  METHOD get_association_sets.
* the explicit sets, then a default set for every association that asked
* for one and has none: computed when read, as the types' entity sets may
* be created after the association
    DATA lo_association TYPE REF TO zcl_oao_association.
    DATA lo_set         TYPE REF TO zcl_oao_assoc_set.
    DATA lv_found       TYPE abap_bool.
    DATA lv_name        TYPE string.

    rt_sets = mt_assoc_sets.
    LOOP AT mt_default_sets INTO lo_association.
      lv_found = abap_false.
      LOOP AT mt_assoc_sets INTO lo_set.
        IF lo_set->mv_association = lo_association->mv_name.
          lv_found = abap_true.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_found = abap_true.
        CONTINUE.
      ENDIF.
      CREATE OBJECT lo_set.
      lv_name = |{ lo_association->mv_name }_AssocSet|.
      IF strlen( lv_name ) > 40.
        lv_name = lv_name(40).
      ENDIF.
      lo_set->mv_name        = lv_name.
      lo_set->mv_association = lo_association->mv_name.
      lo_set->mv_left_set    = default_entity_set( |{ lo_association->mv_left_type }| ).
      lo_set->mv_right_set   = default_entity_set( |{ lo_association->mv_right_type }| ).
      IF lo_set->mv_left_set IS INITIAL OR lo_set->mv_right_set IS INITIAL.
        CONTINUE.
      ENDIF.
      APPEND lo_set TO rt_sets.
    ENDLOOP.
  ENDMETHOD.

  METHOD default_entity_set.
* the first entity set of the type: SEGW gives each type one default set
    DATA lt_sets   TYPE zcl_oao_entity_typ=>ty_entity_sets.
    DATA ls_set    LIKE LINE OF lt_sets.
    DATA lo_entity TYPE REF TO zcl_oao_entity_typ.
    FIELD-SYMBOLS <ls_entity> LIKE LINE OF mt_entities.

    READ TABLE mt_entities ASSIGNING <ls_entity> WITH TABLE KEY entity_name = iv_type.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    lo_entity ?= <ls_entity>-entity.
    lt_sets = lo_entity->get_entity_sets( ).
    READ TABLE lt_sets INDEX 1 INTO ls_set.
    IF sy-subrc = 0.
      rv_set = ls_set-name.
    ENDIF.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~create_entity_type.
    DATA ls_row LIKE LINE OF mt_entities.

    DATA lo_entity TYPE REF TO zcl_oao_entity_typ.

    CREATE OBJECT lo_entity.
    lo_entity->mo_model = me.
    ro_entity = lo_entity.

    ls_row-entity_name = iv_entity_type_name.
    ls_row-entity      = ro_entity.
    INSERT ls_row INTO TABLE mt_entities.
    ASSERT sy-subrc = 0.
    APPEND iv_entity_type_name TO mt_entity_names.
  ENDMETHOD.

  METHOD get_entity_type_names.
    rt_names = mt_entity_names.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~get_entity_type.
    FIELD-SYMBOLS <ls_entity> LIKE LINE OF mt_entities.
    READ TABLE mt_entities ASSIGNING <ls_entity> WITH TABLE KEY entity_name = iv_entity_name.
    ASSERT sy-subrc = 0.
    ro_entity_type = <ls_entity>-entity.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~set_schema_namespace.
    mv_namespace = iv_namespace.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_model~get_schema_namespace.
    ev_namespace = mv_namespace.
  ENDMETHOD.

ENDCLASS.