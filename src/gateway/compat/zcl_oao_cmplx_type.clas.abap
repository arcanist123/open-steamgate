CLASS zcl_oao_cmplx_type DEFINITION PUBLIC.
* Overlay of open-abap-odata's complex type (src/gateway/compat/README.md):
* bind_structure reads the dictionary.
* A complex type as SEGW defines it: a named group of properties, used as
* the type of an entity type property or of a function import return
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_cmplx_type.

    DATA mv_structure_name TYPE string.
  PRIVATE SECTION.
    DATA mt_properties TYPE /iwbep/if_mgw_med_odata_types=>ty_t_mgw_odata_properties.
ENDCLASS.

CLASS zcl_oao_cmplx_type IMPLEMENTATION.

  METHOD /iwbep/if_mgw_odata_item~set_label_from_text_element.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_cmplx_type~bind_structure.
* the dictionary part as for an entity type (overlay, milestone 3 B4): a
* complex type's properties get their labels, units and semantics from the
* bound structure too (a SEGW sample's address type: labels from the data
* elements, measured)
    mv_structure_name = iv_structure_name.
    zcl_osd_ddic_info=>bind( iv_structure  = iv_structure_name
                             it_properties = mt_properties ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_cmplx_type~create_property.
    DATA ls_row      LIKE LINE OF mt_properties.
    DATA lo_property TYPE REF TO zcl_oao_property.

    CREATE OBJECT lo_property.
    lo_property->mv_abap_fieldname = iv_abap_fieldname.
    ro_property = lo_property.

    ls_row-name = iv_property_name.
    ls_row-property = ro_property.
    INSERT ls_row INTO TABLE mt_properties.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_cmplx_type~get_property.
    DATA ls_row LIKE LINE OF mt_properties.

    READ TABLE mt_properties INTO ls_row WITH KEY name = iv_property_name.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_med_exception.
    ENDIF.
    ro_property = ls_row-property.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_cmplx_type~get_properties.
    rt_properties = mt_properties.
  ENDMETHOD.

ENDCLASS.
