CLASS cl_sadl_gw_model_exposure DEFINITION PUBLIC CREATE PUBLIC.
* Clean-room model exposure: builds the OData model of a reference-data-
* source service from the SADL definition and the CDS registry. Entity
* types are the SADL structures, properties the CDS fields with their EDM
* types, keys and labels; associations from the CDS ON conditions;
* analytics and UI annotations become sap: attributes and vocabulary
* annotations in $metadata.
  PUBLIC SECTION.
    INTERFACES if_sadl_gw_model_exposure.

    CLASS-METHODS get_exposure_xml
      IMPORTING
        iv_uuid                  TYPE string
        iv_timestamp             TYPE timestamp OPTIONAL
        iv_sadl_xml              TYPE string
      RETURNING
        VALUE(ro_model_exposure) TYPE REF TO if_sadl_gw_model_exposure
      RAISING
        cx_sadl_exposure_error.

    METHODS constructor
      IMPORTING
        iv_uuid      TYPE string
        iv_timestamp TYPE timestamp
        iv_sadl_xml  TYPE string.

    METHODS get_last_modified
      RETURNING
        VALUE(rv_last_modified) TYPE timestamp.

    DATA mo_def TYPE REF TO zcl_stg_sadl_def READ-ONLY.
  PRIVATE SECTION.
    DATA mv_uuid      TYPE string.
    DATA mv_timestamp TYPE timestamp.

    METHODS expose_structure
      IMPORTING
        io_model     TYPE REF TO /iwbep/if_mgw_odata_model
        is_structure TYPE zcl_stg_sadl_def=>ty_structure
      RAISING
        cx_sadl_exposure_error
        /iwbep/cx_mgw_med_exception.

    METHODS expose_associations
      IMPORTING
        io_model     TYPE REF TO /iwbep/if_mgw_odata_model
        is_structure TYPE zcl_stg_sadl_def=>ty_structure
      RAISING
        /iwbep/cx_mgw_med_exception.

    METHODS expose_ui_annotations
      IMPORTING
        io_model     TYPE REF TO /iwbep/if_mgw_odata_model
        is_structure TYPE zcl_stg_sadl_def=>ty_structure
        is_entity    TYPE zcl_stg_cds_registry=>ty_entity.

    METHODS set_type
      IMPORTING
        io_property TYPE REF TO /iwbep/if_mgw_odata_property
        is_field    TYPE zcl_stg_cds_registry=>ty_field.

    CLASS-METHODS has_annotation
      IMPORTING
        it_annotations TYPE string_table
        iv_pattern     TYPE string
      RETURNING
        VALUE(rv_has)  TYPE abap_bool.

    CLASS-METHODS annotation_value
      IMPORTING
        it_annotations  TYPE string_table
        iv_pattern      TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.

    CLASS-METHODS is_aggregate
      IMPORTING
        is_entity     TYPE zcl_stg_cds_registry=>ty_entity
      RETURNING
        VALUE(rv_yes) TYPE abap_bool.

    CLASS-METHODS aggregation_of
      IMPORTING
        is_field           TYPE zcl_stg_cds_registry=>ty_field
      RETURNING
        VALUE(rv_function) TYPE string.
ENDCLASS.

CLASS cl_sadl_gw_model_exposure IMPLEMENTATION.

  METHOD get_exposure_xml.
    DATA lo_exposure TYPE REF TO cl_sadl_gw_model_exposure.

    CREATE OBJECT lo_exposure
      EXPORTING
        iv_uuid      = iv_uuid
        iv_timestamp = iv_timestamp
        iv_sadl_xml  = iv_sadl_xml.
    ro_model_exposure = lo_exposure.
  ENDMETHOD.

  METHOD constructor.
    mv_uuid      = iv_uuid.
    mv_timestamp = iv_timestamp.
    CREATE OBJECT mo_def
      EXPORTING
        iv_sadl_xml = iv_sadl_xml.
  ENDMETHOD.

  METHOD get_last_modified.
    rv_last_modified = mv_timestamp.
  ENDMETHOD.

  METHOD has_annotation.
    DATA lv_annotation TYPE string.

    LOOP AT it_annotations INTO lv_annotation.
      FIND REGEX iv_pattern IN lv_annotation IGNORING CASE.
      IF sy-subrc = 0.
        rv_has = abap_true.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD annotation_value.
    DATA lv_annotation TYPE string.

    LOOP AT it_annotations INTO lv_annotation.
      FIND REGEX iv_pattern IN lv_annotation IGNORING CASE SUBMATCHES rv_value.
      IF sy-subrc = 0.
        RETURN.
      ENDIF.
    ENDLOOP.
    CLEAR rv_value.
  ENDMETHOD.

  METHOD is_aggregate.
    rv_yes = has_annotation( it_annotations = is_entity-annotations
                             iv_pattern     = '@Analytics\.(dataCategory:\s*#(CUBE|AGGREGATIONLEVEL)|query:\s*true)' ).
  ENDMETHOD.

  METHOD aggregation_of.
    rv_function = to_upper( annotation_value( it_annotations = is_field-annotations
                                              iv_pattern     = '@Aggregation\.default:\s*#(\w+)' ) ).
  ENDMETHOD.

  METHOD set_type.
    CASE is_field-edm_type.
      WHEN 'Edm.Int32'.
        io_property->set_type_edm_int32( ).
      WHEN 'Edm.Int16'.
        io_property->set_type_edm_int16( ).
      WHEN 'Edm.Boolean'.
        io_property->set_type_edm_boolean( ).
      WHEN 'Edm.Decimal'.
        io_property->set_type_edm_decimal( ).
        io_property->set_precison( is_field-precision ).
        io_property->set_maxlength( is_field-scale ).
      WHEN 'Edm.DateTime'.
        io_property->set_type_edm_datetime( ).
        io_property->set_precison( is_field-precision ).
      WHEN 'Edm.Time'.
        io_property->set_type_edm_time( ).
      WHEN OTHERS.
        io_property->set_type_edm_string( ).
        IF is_field-maxlength > 0.
          io_property->set_maxlength( is_field-maxlength ).
        ENDIF.
    ENDCASE.
  ENDMETHOD.

  METHOD if_sadl_gw_model_exposure~expose.
    DATA ls_structure TYPE zcl_stg_sadl_def=>ty_structure.
    DATA lx_med       TYPE REF TO /iwbep/cx_mgw_med_exception.

    TRY.
        LOOP AT mo_def->mt_structures INTO ls_structure WHERE exposure = abap_true.
          expose_structure( io_model     = io_model
                            is_structure = ls_structure ).
        ENDLOOP.
        LOOP AT mo_def->mt_structures INTO ls_structure WHERE exposure = abap_true.
          expose_associations( io_model     = io_model
                               is_structure = ls_structure ).
        ENDLOOP.
      CATCH /iwbep/cx_mgw_med_exception INTO lx_med.
        RAISE EXCEPTION TYPE cx_sadl_exposure_error
          EXPORTING
            previous = lx_med
            message  = 'Model definition failed'.
    ENDTRY.
    ro_exposure = me.
  ENDMETHOD.

  METHOD if_sadl_gw_model_exposure~expose_vocabulary.
* the UI vocabulary went into the model during expose( ); nothing to add
    RETURN.
  ENDMETHOD.

  METHOD expose_structure.
    DATA ls_entity      TYPE zcl_stg_cds_registry=>ty_entity.
    DATA ls_field       TYPE zcl_stg_cds_registry=>ty_field.
    DATA lo_entity_type TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_property    TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_oao         TYPE REF TO zcl_oao_property.
    DATA lo_entity_set  TYPE REF TO /iwbep/if_mgw_odata_entity_set.
    DATA lo_set_anno    TYPE REF TO /iwbep/if_mgw_odata_annotatabl.
    DATA lv_aggregate   TYPE abap_bool.
    DATA lv_function    TYPE string.
    DATA lv_unit        TYPE string.
    DATA lv_editable    TYPE abap_bool.
    DATA lv_type_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_prop_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_set_name    TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.

    ls_entity = zcl_stg_cds_registry=>get( mo_def->binding_of( is_structure-data_source ) ).
    IF ls_entity-name IS INITIAL.
      RAISE EXCEPTION TYPE cx_sadl_exposure_error
        EXPORTING
          message = |CDS entity { is_structure-data_source } is not in the registry (run tools/cds2ddic.mjs)|.
    ENDIF.
    lv_aggregate = is_aggregate( ls_entity ).
* the definition of the service is the contract: maxEditMode="EX" exposes the
* set for writing, "RO" does not, whatever the CDS view would allow. The
* generated definition gets EX from the entity set of the tree, which for a
* published view comes from @ObjectModel.writeEnabled (docs/cds-writes.md).
    IF to_upper( is_structure-max_edit_mode ) <> 'RO' AND is_structure-max_edit_mode IS NOT INITIAL.
      lv_editable = abap_true.
    ENDIF.

    lv_type_name = is_structure-name.
    lo_entity_type = io_model->create_entity_type( iv_entity_type_name = lv_type_name
                                                   iv_def_entity_set   = abap_false ).
* a cube: the Gateway marks the entity type, analytical clients bind on it
    IF lv_aggregate = abap_true.
      lo_entity_type->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
        iv_key   = 'semantics'
        iv_value = 'aggregate' ).
    ENDIF.

    LOOP AT ls_entity-fields INTO ls_field.
      lv_prop_name = ls_field-name.
      lo_property = lo_entity_type->create_property( iv_property_name  = lv_prop_name
                                                     iv_abap_fieldname = ls_field-name ).
      lo_oao ?= lo_property.
      lo_oao->mv_label = ls_field-label.
      IF ls_field-is_key = abap_true.
        lo_property->set_is_key( ).
        lo_property->set_nullable( abap_false ).
      ELSE.
        lo_property->set_nullable( abap_true ).
      ENDIF.
      set_type( io_property = lo_property
                is_field    = ls_field ).
      lo_property->set_creatable( lv_editable ).
      lo_property->set_updatable( lv_editable ).
* a virtual element lives outside the SELECT: the database cannot order or
* filter by it, and SADL says so in $metadata
      lo_property->set_sortable( boolc( ls_field-virtual = abap_false ) ).
      lo_property->set_filterable( boolc( ls_field-virtual = abap_false ) ).
* sap:unicode="false" as this exposure has always written it: the writer
* now prints it only where the model says so (a system writes none for a
* property without the annotation); unmeasured for a SADL service, so the
* earlier output is kept
      lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add( iv_key   = 'unicode'
                                                                                   iv_value = 'false' ).

* analytics: measures carry an aggregation, everything else is a dimension
      IF lv_aggregate = abap_true.
        lv_function = aggregation_of( ls_field ).
        IF lv_function IS NOT INITIAL.
          lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add( iv_key   = 'aggregation-role'
                                                                                       iv_value = 'measure' ).
        ELSE.
          lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add( iv_key   = 'aggregation-role'
                                                                                       iv_value = 'dimension' ).
        ENDIF.
      ENDIF.
* semantics: currency / unit references
      lv_unit = annotation_value( it_annotations = ls_field-annotations
                                  iv_pattern     = '@Semantics\.(?:amount\.currencyCode|quantity\.unitOfMeasure):\s*''(\w+)''' ).
      IF lv_unit IS NOT INITIAL.
        lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add( iv_key   = 'unit'
                                                                                     iv_value = lv_unit ).
      ENDIF.
      IF has_annotation( it_annotations = ls_field-annotations iv_pattern = '@Semantics\.currencyCode:\s*true' ) = abap_true.
        lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add( iv_key   = 'semantics'
                                                                                     iv_value = 'currency-code' ).
      ELSEIF has_annotation( it_annotations = ls_field-annotations iv_pattern = '@Semantics\.unitOfMeasure:\s*true' ) = abap_true.
        lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add( iv_key   = 'semantics'
                                                                                     iv_value = 'unit-of-measure' ).
      ENDIF.
    ENDLOOP.

    lo_entity_type->bind_structure( iv_structure_name   = ls_entity-sql_view
                                    iv_bind_conversions = abap_true ).
* a date of the view is shown as a date: SADL writes sap:display-format=
* "Date" for it, as this exposure always has (bind_structure no longer
* does: a SEGW model on a system gets none, measured in milestone 3)
    LOOP AT ls_entity-fields INTO ls_field.
      lv_prop_name = ls_field-name.
      lo_oao ?= lo_entity_type->get_property( lv_prop_name ).
      IF lo_oao->mv_is_date = abap_true AND lo_oao->mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-datetime.
        lo_oao->mv_display_format = 'Date'.
      ENDIF.
    ENDLOOP.

    lv_set_name = zcl_stg_sadl_def=>set_name_of( is_structure-name ).
    lo_entity_set = lo_entity_type->create_entity_set( lv_set_name ).
* within a writable exposure, what the view itself allows; a view that says
* nothing finer than "writable" allows all three
    IF lv_editable = abap_false.
      lo_entity_set->set_creatable( abap_false ).
      lo_entity_set->set_updatable( abap_false ).
      lo_entity_set->set_deletable( abap_false ).
    ELSEIF ls_entity-creatable = abap_false AND ls_entity-updatable = abap_false AND ls_entity-deletable = abap_false.
      lo_entity_set->set_creatable( abap_true ).
      lo_entity_set->set_updatable( abap_true ).
      lo_entity_set->set_deletable( abap_true ).
    ELSE.
      lo_entity_set->set_creatable( ls_entity-creatable ).
      lo_entity_set->set_updatable( ls_entity-updatable ).
      lo_entity_set->set_deletable( ls_entity-deletable ).
    ENDIF.
    lo_entity_set->set_pageable( abap_true ).
    lo_entity_set->set_addressable( abap_true ).
    lo_entity_set->set_has_ftxt_search( abap_false ).
    lo_entity_set->set_subscribable( abap_false ).
    lo_entity_set->set_filter_required( abap_false ).
    IF lv_aggregate = abap_true.
      lo_set_anno ?= lo_entity_set.
      lo_set_anno->create_annotation( 'sap' )->add( iv_key   = 'semantics'
                                                    iv_value = 'aggregate' ).
    ENDIF.

    expose_ui_annotations( io_model     = io_model
                           is_structure = is_structure
                           is_entity    = ls_entity ).
  ENDMETHOD.

  METHOD expose_associations.
    DATA ls_entity        TYPE zcl_stg_cds_registry=>ty_entity.
    DATA ls_assoc         TYPE zcl_stg_sadl_def=>ty_association.
    DATA ls_cds_assoc     TYPE zcl_stg_cds_registry=>ty_assoc.
    DATA ls_pair          TYPE zcl_stg_cds_registry=>ty_pair.
    DATA ls_target        TYPE zcl_stg_sadl_def=>ty_structure.
    DATA lo_association   TYPE REF TO /iwbep/if_mgw_odata_assoc.
    DATA lo_ref           TYPE REF TO /iwbep/if_mgw_odata_ref_constr.
    DATA lo_entity_type   TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lv_assoc_name    TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_set_name      TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_left_type     TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_right_type    TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_left_set      TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_right_set     TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_nav_name      TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_principal     TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_dependent     TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA lv_right_card    TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_cardinality.

    ls_entity = zcl_stg_cds_registry=>get( mo_def->binding_of( is_structure-data_source ) ).
    lv_left_type = is_structure-name.
    lo_entity_type = io_model->get_entity_type( lv_left_type ).

    LOOP AT is_structure-associations INTO ls_assoc.
      ls_target = mo_def->structure_by_name( ls_assoc-target ).
      IF ls_target-name IS INITIAL.
        CONTINUE.
      ENDIF.
      CLEAR ls_cds_assoc.
      READ TABLE ls_entity-associations INTO ls_cds_assoc WITH KEY name = ls_assoc-binding.
      IF sy-subrc <> 0.
        LOOP AT ls_entity-associations INTO ls_cds_assoc.
          IF to_upper( ls_cds_assoc-name ) = to_upper( ls_assoc-binding ).
            EXIT.
          ENDIF.
          CLEAR ls_cds_assoc.
        ENDLOOP.
      ENDIF.

      CASE to_lower( ls_assoc-cardinality ).
        WHEN 'many'.
          lv_right_card = 'N'.
        WHEN 'zerotoone' OR 'zeroone'.
          lv_right_card = '0'.
        WHEN OTHERS.
          lv_right_card = '1'.
      ENDCASE.

      lv_assoc_name  = |{ is_structure-name }_{ ls_assoc-name }|.
      lv_right_type  = ls_target-name.
      lo_association = io_model->create_association( iv_association_name = lv_assoc_name
                                                     iv_left_type        = lv_left_type
                                                     iv_right_type       = lv_right_type
                                                     iv_left_card        = '1'
                                                     iv_right_card       = lv_right_card
                                                     iv_def_assoc_set    = abap_false ).
      IF ls_cds_assoc-pairs IS NOT INITIAL.
        lo_ref = lo_association->create_ref_constraint( ).
        LOOP AT ls_cds_assoc-pairs INTO ls_pair.
          lv_principal = ls_pair-source.
          lv_dependent = ls_pair-target.
          lo_ref->add_property( iv_principal_property = lv_principal
                                iv_dependent_property = lv_dependent ).
        ENDLOOP.
      ENDIF.
      lv_set_name  = |{ lv_assoc_name }Set|.
      lv_left_set  = zcl_stg_sadl_def=>set_name_of( is_structure-name ).
      lv_right_set = zcl_stg_sadl_def=>set_name_of( ls_target-name ).
      io_model->create_association_set( iv_association_set_name  = lv_set_name
                                        iv_left_entity_set_name  = lv_left_set
                                        iv_right_entity_set_name = lv_right_set
                                        iv_association_name      = lv_assoc_name ).
      lv_nav_name = ls_assoc-name.
      lo_entity_type->create_navigation_property( iv_property_name    = lv_nav_name
                                                  iv_association_name = lv_assoc_name ).
    ENDLOOP.
  ENDMETHOD.

  METHOD expose_ui_annotations.
* @UI.lineItem / @UI.selectionField on CDS fields -> UI vocabulary in the
* schema, the same thing a local annotations file would say
    DATA lo_model    TYPE REF TO zcl_oao_model.
    DATA ls_field    TYPE zcl_stg_cds_registry=>ty_field.
    DATA lv_position TYPE string.
    DATA lv_pos_i    TYPE i.
    DATA lv_ns       TYPE string.
    DATA lv_xml      TYPE string.
    TYPES: BEGIN OF ty_item,
             position TYPE i,
             name     TYPE string,
             label    TYPE string,
           END OF ty_item.
    DATA lt_line_items TYPE STANDARD TABLE OF ty_item WITH DEFAULT KEY.
    DATA lt_selection  TYPE STANDARD TABLE OF ty_item WITH DEFAULT KEY.
    DATA ls_item       TYPE ty_item.

    LOOP AT is_entity-fields INTO ls_field.
      lv_position = annotation_value( it_annotations = ls_field-annotations
                                      iv_pattern     = '@UI\.lineItem:.*position:\s*(\d+)' ).
      IF lv_position IS NOT INITIAL OR has_annotation( it_annotations = ls_field-annotations iv_pattern = '@UI\.lineItem' ) = abap_true.
        CLEAR ls_item.
        lv_pos_i = lv_position.
        ls_item-position = lv_pos_i.
        ls_item-name  = ls_field-name.
        ls_item-label = ls_field-label.
        APPEND ls_item TO lt_line_items.
      ENDIF.
      lv_position = annotation_value( it_annotations = ls_field-annotations
                                      iv_pattern     = '@UI\.selectionField:.*position:\s*(\d+)' ).
      IF lv_position IS NOT INITIAL OR has_annotation( it_annotations = ls_field-annotations iv_pattern = '@UI\.selectionField' ) = abap_true.
        CLEAR ls_item.
        lv_pos_i = lv_position.
        ls_item-position = lv_pos_i.
        ls_item-name = ls_field-name.
        APPEND ls_item TO lt_selection.
      ENDIF.
    ENDLOOP.
    IF lt_line_items IS INITIAL AND lt_selection IS INITIAL.
      RETURN.
    ENDIF.
    SORT lt_line_items BY position.
    SORT lt_selection BY position.

    io_model->get_schema_namespace( IMPORTING ev_namespace = lv_ns ).
    lv_xml = |      <Annotations xmlns="http://docs.oasis-open.org/odata/ns/edm" Target="{ lv_ns }.{ is_structure-name }">\n|.
    IF lt_line_items IS NOT INITIAL.
      lv_xml = lv_xml && |        <Annotation Term="com.sap.vocabularies.UI.v1.LineItem">\n          <Collection>\n|.
      LOOP AT lt_line_items INTO ls_item.
        lv_xml = lv_xml && |            <Record Type="com.sap.vocabularies.UI.v1.DataField">\n| &&
                           |              <PropertyValue Property="Value" Path="{ ls_item-name }"/>\n| &&
                           |              <PropertyValue Property="Label" String="{ ls_item-label }"/>\n| &&
                           |            </Record>\n|.
      ENDLOOP.
      lv_xml = lv_xml && |          </Collection>\n        </Annotation>\n|.
    ENDIF.
    IF lt_selection IS NOT INITIAL.
      lv_xml = lv_xml && |        <Annotation Term="com.sap.vocabularies.UI.v1.SelectionFields">\n          <Collection>\n|.
      LOOP AT lt_selection INTO ls_item.
        lv_xml = lv_xml && |            <PropertyPath>{ ls_item-name }</PropertyPath>\n|.
      ENDLOOP.
      lv_xml = lv_xml && |          </Collection>\n        </Annotation>\n|.
    ENDIF.
    lv_xml = lv_xml && |      </Annotations>\n|.

    lo_model ?= io_model.
    lo_model->add_vocabulary_xml( lv_xml ).
  ENDMETHOD.

ENDCLASS.
