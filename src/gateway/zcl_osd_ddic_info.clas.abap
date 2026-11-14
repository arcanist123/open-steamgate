CLASS zcl_osd_ddic_info DEFINITION PUBLIC FINAL CREATE PUBLIC.
* What a Gateway model's bind_structure takes from the dictionary, which
* RTTI in open-abap-core does not carry: the data element of a component
* and its field labels, the reference field of an amount or a quantity,
* the dictionary type. Read from the registry
* tools/osd-ddic-info-registry.mjs writes at build time out of the TABL,
* DTEL and DOMA objects of the tree.
*
* Measured on a SEGW sample's $metadata against its system (milestone 3):
* - a property without a label of its own (no text element, no sap:label
*   annotation) gets the medium field label of its component's data
*   element, in the session language, and none when that language has no
*   text;
* - an amount (CURR) or a quantity (QUAN) gets sap:unit, the name of the
*   property bound to its reference field in the same structure -- none
*   when no property is bound to it;
* - a currency key (CUKY) gets sap:semantics="currency-code", a unit
*   (UNIT) "unit-of-measure", unless the model set a semantics itself;
* - a date (DATS) gets no sap:display-format.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_field,
             fieldname TYPE string,
             rollname  TYPE string,
             datatype  TYPE string,
             reftable  TYPE string,
             reffield  TYPE string,
           END OF ty_field.
    TYPES ty_fields TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_label,
             langu   TYPE c LENGTH 1,
             short   TYPE string,
             medium  TYPE string,
             long    TYPE string,
             heading TYPE string,
           END OF ty_label.
    TYPES ty_labels TYPE STANDARD TABLE OF ty_label WITH DEFAULT KEY.

* the components of a dictionary structure, includes resolved; for a type
* the dictionary of this tree does not hold (a type of a class: SEGW's
* value-help types), the components RTTI names a data element for --
* without reference fields, which only the dictionary knows
    CLASS-METHODS fields
      IMPORTING
        iv_structure     TYPE csequence
      RETURNING
        VALUE(rt_fields) TYPE ty_fields.
* the field labels of a data element in one language
    CLASS-METHODS label
      IMPORTING
        iv_rollname     TYPE csequence
        iv_langu        TYPE sy-langu DEFAULT sy-langu
      RETURNING
        VALUE(rs_label) TYPE ty_label.
* the sap:semantics a dictionary type implies, '' for most
    CLASS-METHODS semantic_of
      IMPORTING
        iv_datatype        TYPE csequence
      RETURNING
        VALUE(rv_semantic) TYPE string.
* bind_structure's dictionary part: fill the derived attributes of the
* properties bound to the structure's components
    CLASS-METHODS bind
      IMPORTING
        iv_structure  TYPE csequence
        it_properties TYPE /iwbep/if_mgw_med_odata_types=>ty_t_mgw_odata_properties.
ENDCLASS.

CLASS zcl_osd_ddic_info IMPLEMENTATION.

  METHOD fields.
    DATA lo_descr  TYPE REF TO cl_abap_typedescr.
    DATA lo_struct TYPE REF TO cl_abap_structdescr.
    DATA lt_comp   TYPE abap_component_tab.
    DATA ls_comp   LIKE LINE OF lt_comp.
    DATA ls_field  LIKE LINE OF rt_fields.

    rt_fields = zcl_osd_ddic_info_registry=>fields( to_upper( condense( iv_structure ) ) ).
    IF rt_fields IS NOT INITIAL.
      RETURN.
    ENDIF.
    cl_abap_typedescr=>describe_by_name( EXPORTING p_name = iv_structure
                                         RECEIVING type   = lo_descr
                                         EXCEPTIONS type_not_found = 1 OTHERS = 2 ).
    IF sy-subrc <> 0 OR lo_descr IS NOT BOUND OR lo_descr->kind <> cl_abap_typedescr=>kind_struct.
      RETURN.
    ENDIF.
    lo_struct ?= lo_descr.
    lt_comp = lo_struct->get_components( ).
    LOOP AT lt_comp INTO ls_comp WHERE type IS BOUND.
      IF ls_comp-type->kind <> cl_abap_typedescr=>kind_elem.
        CONTINUE.
      ENDIF.
      CLEAR ls_field.
      ls_field-fieldname = ls_comp-name.
      ls_field-rollname  = to_upper( ls_comp-type->get_relative_name( ) ).
      IF ls_field-rollname IS INITIAL.
        CONTINUE.
      ENDIF.
      ls_field-datatype = zcl_osd_ddic_info_registry=>datatype( ls_field-rollname ).
      APPEND ls_field TO rt_fields.
    ENDLOOP.
  ENDMETHOD.

  METHOD label.
    DATA lt_labels TYPE ty_labels.

    lt_labels = zcl_osd_ddic_info_registry=>labels( to_upper( condense( iv_rollname ) ) ).
    READ TABLE lt_labels INTO rs_label WITH KEY langu = iv_langu.
    IF sy-subrc <> 0.
      CLEAR rs_label.
    ENDIF.
  ENDMETHOD.

  METHOD semantic_of.
    CASE iv_datatype.
      WHEN 'CUKY'.
        rv_semantic = 'currency-code'.
      WHEN 'UNIT'.
        rv_semantic = 'unit-of-measure'.
    ENDCASE.
  ENDMETHOD.

  METHOD bind.
    DATA lt_fields   TYPE ty_fields.
    DATA ls_field    LIKE LINE OF lt_fields.
    DATA ls_prop     LIKE LINE OF it_properties.
    DATA ls_ref      LIKE LINE OF it_properties.
    DATA lo_property TYPE REF TO zcl_oao_property.
    DATA lo_ref      TYPE REF TO zcl_oao_property.
    DATA lv_struct   TYPE string.

    lv_struct = to_upper( condense( iv_structure ) ).
    lt_fields = fields( lv_struct ).
    IF lt_fields IS INITIAL.
      RETURN.
    ENDIF.

    LOOP AT it_properties INTO ls_prop.
      lo_property ?= ls_prop-property.
      IF lo_property->mv_complex_type IS NOT INITIAL.
        CONTINUE.
      ENDIF.
      READ TABLE lt_fields INTO ls_field WITH KEY fieldname = to_upper( lo_property->mv_abap_fieldname ).
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      lo_property->mv_rollname      = ls_field-rollname.
      lo_property->mv_ddic_datatype = ls_field-datatype.
      lo_property->mv_ddic_semantic = semantic_of( ls_field-datatype ).
      IF ls_field-datatype = 'DATS'.
        lo_property->mv_is_date = abap_true.
      ENDIF.
* the reference field must be a component of this structure, and a
* property of this type must be bound to it
      IF ( ls_field-datatype = 'CURR' OR ls_field-datatype = 'QUAN' )
          AND ls_field-reffield IS NOT INITIAL
          AND ( ls_field-reftable IS INITIAL OR ls_field-reftable = lv_struct ).
        LOOP AT it_properties INTO ls_ref.
          lo_ref ?= ls_ref-property.
          IF to_upper( lo_ref->mv_abap_fieldname ) = ls_field-reffield.
            lo_property->mv_unit_property = ls_ref-name.
            EXIT.
          ENDIF.
        ENDLOOP.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
