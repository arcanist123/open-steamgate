CLASS zcl_oao_association DEFINITION PUBLIC.
* Overlay of open-abap-odata's association (milestone 4): an item -- its
* label from the text pool (sap:label on the Association, written after
* sap:content-version as a system does) and set_disabled; the constraint is
* read back; create_assoc_set adds a set of the given name to the model,
* between the default entity sets of the two ends (resolved when the
* model is read: the sets may be created after the association).
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_assoc.

    DATA mv_name           TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_left_type      TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_right_type     TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_left_card      TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_cardinality.
    DATA mv_right_card     TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_cardinality.
    DATA mo_ref_constraint TYPE REF TO zcl_oao_ref_constraint.
    DATA mv_text_symbol    TYPE textpoolky.
    DATA mv_text_container TYPE string.
    DATA mv_disabled       TYPE abap_bool.
* the model the association belongs to (create_assoc_set adds to it)
    DATA mo_model          TYPE REF TO zcl_oao_model.
ENDCLASS.

CLASS zcl_oao_association IMPLEMENTATION.

  METHOD /iwbep/if_mgw_odata_assoc~create_ref_constraint.
    CREATE OBJECT mo_ref_constraint.
    mo_ref_constraint->mv_principal_is_left = iv_principal_is_left.
    ro_ref_constraint = mo_ref_constraint.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_assoc~get_ref_constraint.
    IF mo_ref_constraint IS NOT BOUND.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_med_exception.
    ENDIF.
    ro_ref_constraint = mo_ref_constraint.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_assoc~create_assoc_set.
    DATA lo_set TYPE REF TO zcl_oao_assoc_set.

    IF mo_model IS NOT BOUND.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_med_exception.
    ENDIF.
    CREATE OBJECT lo_set.
    lo_set->mv_name        = iv_assoc_set_name.
    lo_set->mv_association = mv_name.
    mo_model->add_association_set( lo_set ).
    ro_assoc_set = lo_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_item~set_label_from_text_element.
    mv_text_symbol    = iv_text_element_symbol.
    mv_text_container = iv_text_element_container.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_item~set_disabled.
    mv_disabled = iv_disabled.
  ENDMETHOD.

ENDCLASS.
