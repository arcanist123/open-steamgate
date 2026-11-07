CLASS zcl_osd_v4_test_mpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_model CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_row,
             day TYPE d,
             guid TYPE c LENGTH 32,
             amount TYPE p LENGTH 8 DECIMALS 2,
             moment TYPE p LENGTH 8 DECIMALS 0,
             name TYPE string,
           END OF ty_row.
    TYPES tt_rows TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    METHODS define REDEFINITION.
ENDCLASS.
CLASS zcl_osd_v4_test_mpc IMPLEMENTATION.
  METHOD define.
    DATA lo_type TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_prop TYPE REF TO /iwbep/if_mgw_odata_property.
    model->set_schema_namespace( 'V4_TEST' ).
    lo_type = model->create_entity_type( iv_entity_type_name = 'Literal' iv_def_entity_set = abap_false ).
    lo_prop = lo_type->create_property( iv_property_name = 'Day' iv_abap_fieldname = 'DAY' ).
    lo_prop->set_type_edm_datetime( ).
    lo_prop->set_is_key( ).
    lo_prop = lo_type->create_property( iv_property_name = 'Guid' iv_abap_fieldname = 'GUID' ).
    lo_prop->set_type_edm_guid( ).
    lo_prop->set_is_key( ).
    lo_prop = lo_type->create_property( iv_property_name = 'Amount' iv_abap_fieldname = 'AMOUNT' ).
    lo_prop->set_type_edm_decimal( ).
    lo_prop->set_maxlength( 15 ).
    lo_prop->set_precison( 2 ).
    lo_prop = lo_type->create_property( iv_property_name = 'Moment' iv_abap_fieldname = 'MOMENT' ).
    lo_prop->set_type_edm_datetimeoffset( ).
    lo_prop = lo_type->create_property( iv_property_name = 'Name' iv_abap_fieldname = 'NAME' ).
    lo_prop->set_type_edm_string( ).
    lo_type->bind_structure( 'ZCL_OSD_V4_TEST_MPC=>TY_ROW' ).
    lo_type->create_entity_set( 'LiteralSet' ).
    lo_type = model->create_entity_type( iv_entity_type_name = 'Text' iv_def_entity_set = abap_false ).
    lo_prop = lo_type->create_property( iv_property_name = 'Name' iv_abap_fieldname = 'NAME' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_is_key( ).
    lo_type->bind_structure( 'ZCL_OSD_V4_TEST_MPC=>TY_ROW' ).
    lo_type->create_entity_set( 'TextSet' ).
  ENDMETHOD.
ENDCLASS.
