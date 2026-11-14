CLASS zcl_osd_h5x_mpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_model CREATE PUBLIC.
* The model shape of a SEGW sample's business set, synthetic: an entity
* type whose first property is a complex property (an address), keys and
* texts after it, a DEC 21,7 timestamp as Edm.DateTime. Read by the DPC
* beside it with a join and an INTO list (docs/hana-milestone-2.md).
  PUBLIC SECTION.
    TYPES: BEGIN OF ts_address,
             city    TYPE c LENGTH 40,
             country TYPE c LENGTH 3,
           END OF ts_address.
    TYPES: BEGIN OF ts_partner,
             address    TYPE ts_address,
             partner_id TYPE c LENGTH 10,
             name       TYPE c LENGTH 80,
             changed_at TYPE p LENGTH 11 DECIMALS 7,
           END OF ts_partner.
    TYPES tt_partner TYPE STANDARD TABLE OF ts_partner WITH DEFAULT KEY.
* a value-help type of the class, typed by a data element: RTTI names it
    TYPES: BEGIN OF ts_vh_currency,
             code TYPE zosd_h5x_currency,
             text TYPE c LENGTH 40,
           END OF ts_vh_currency.
    TYPES: BEGIN OF ts_order,
             order_id   TYPE c LENGTH 10,
             partner_id TYPE c LENGTH 10,
           END OF ts_order.
    METHODS define REDEFINITION.
  PRIVATE SECTION.
* the text element container as SEGW names it (the class pool)
    CONSTANTS gc_incl_name TYPE string VALUE 'ZCL_OSD_H5X_MPC===============CP'.
    METHODS define_item.
ENDCLASS.

CLASS zcl_osd_h5x_mpc IMPLEMENTATION.
  METHOD define.
    DATA lo_complex TYPE REF TO /iwbep/if_mgw_odata_cmplx_type.
    DATA lo_type    TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_prop    TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_action  TYPE REF TO /iwbep/if_mgw_odata_action.

    model->set_schema_namespace( 'ZOSD_H5X' ).

    lo_complex = model->create_complex_type( 'CT_Address' ).
    lo_prop = lo_complex->create_property( iv_property_name  = 'City'
                                           iv_abap_fieldname = 'CITY' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 40 ).
    lo_prop = lo_complex->create_property( iv_property_name  = 'Country'
                                           iv_abap_fieldname = 'COUNTRY' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 3 ).
    lo_complex->bind_structure( 'ZCL_OSD_H5X_MPC=>TS_ADDRESS' ).

    lo_type = model->create_entity_type( iv_entity_type_name = 'Partner'
                                         iv_def_entity_set   = abap_false ).
    lo_type->create_complex_property( iv_property_name     = 'Address'
                                      iv_complex_type_name = 'CT_Address'
                                      iv_abap_fieldname    = 'ADDRESS' ).
    lo_prop = lo_type->create_property( iv_property_name  = 'PartnerID'
                                        iv_abap_fieldname = 'PARTNER_ID' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_is_key( ).
    lo_prop->set_maxlength( 10 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Name'
                                        iv_abap_fieldname = 'NAME' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 80 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'ChangedAt'
                                        iv_abap_fieldname = 'CHANGED_AT' ).
    lo_prop->set_type_edm_datetime( ).
    lo_type->bind_structure( 'ZCL_OSD_H5X_MPC=>TS_PARTNER' ).
    lo_type->create_entity_set( 'PartnerSet' ).

* a second type and the association between them as SEGW writes it: no
* association set of its own, the default one asked for; and a function
* import that names only its return type
    lo_type = model->create_entity_type( iv_entity_type_name = 'Order'
                                         iv_def_entity_set   = abap_false ).
    lo_prop = lo_type->create_property( iv_property_name  = 'OrderID'
                                        iv_abap_fieldname = 'ORDER_ID' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_is_key( ).
    lo_prop = lo_type->create_property( iv_property_name  = 'PartnerID'
                                        iv_abap_fieldname = 'PARTNER_ID' ).
    lo_prop->set_type_edm_string( ).
    lo_type->bind_structure( 'ZCL_OSD_H5X_MPC=>TS_ORDER' ).
    lo_type->create_entity_set( 'OrderSet' ).
    model->create_association( iv_association_name = 'Assoc_Partner_Orders_With_A_Long_Name'
                               iv_left_type        = 'Partner'
                               iv_right_type       = 'Order'
                               iv_right_card       = 'M'
                               iv_left_card        = '1'
                               iv_def_assoc_set    = abap_true ).
    lo_action = model->create_action( 'Partner_Touch' ).
    lo_action->set_return_entity_type( 'Partner' ).
    lo_action->set_return_multiplicity( '1' ).
    lo_action->set_http_method( 'POST' ).
    define_item( ).
  ENDMETHOD.

  METHOD define_item.
* a line item bound to a dictionary structure by name, the way the SEGW
* sample binds its types (milestone 3 B4): labels from the class's text
* pool (symbols 001, 002) and from the data elements, sap:unit from the
* reference fields, sap:semantics from the dictionary types, sap:unicode
* only where the model adds it
    DATA lo_type   TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_prop   TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_action TYPE REF TO /iwbep/if_mgw_odata_action.
    DATA lo_param  TYPE REF TO /iwbep/if_mgw_odata_parameter.

    lo_type = model->create_entity_type( iv_entity_type_name = 'Item'
                                         iv_def_entity_set   = abap_false ).
    lo_prop = lo_type->create_property( iv_property_name  = 'ItemNo'
                                        iv_abap_fieldname = 'ITEM_NO' ).
    lo_prop->set_label_from_text_element( iv_text_element_symbol    = '001'
                                          iv_text_element_container = gc_incl_name ).
    lo_prop->set_is_key( ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 10 ).
    lo_prop->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add( iv_key   = 'unicode'
                                                                             iv_value = 'false' ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Note'
                                        iv_abap_fieldname = 'NOTE' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 40 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Amount'
                                        iv_abap_fieldname = 'AMOUNT' ).
    lo_prop->set_type_edm_decimal( ).
    lo_prop->set_precison( 2 ).
    lo_prop->set_maxlength( 16 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Currency'
                                        iv_abap_fieldname = 'CURRENCY' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 5 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Quantity'
                                        iv_abap_fieldname = 'QUANTITY' ).
    lo_prop->set_type_edm_decimal( ).
    lo_prop->set_precison( 3 ).
    lo_prop->set_maxlength( 13 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'QuantityUnit'
                                        iv_abap_fieldname = 'UNIT' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 3 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'DeliveryDate'
                                        iv_abap_fieldname = 'DELIV_DATE' ).
    lo_prop->set_type_edm_datetime( ).
    lo_prop = lo_type->create_property( iv_property_name  = 'ChangedBy'
                                        iv_abap_fieldname = 'CHANGED_BY' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 12 ).
    lo_type->bind_structure( 'ZOSD_H5X_S_ITEM' ).
    lo_type->create_entity_set( 'ItemSet' ).

    lo_type = model->create_entity_type( iv_entity_type_name = 'VH_Currency'
                                         iv_def_entity_set   = abap_false ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Code'
                                        iv_abap_fieldname = 'CODE' ).
    lo_prop->set_is_key( ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 5 ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Text'
                                        iv_abap_fieldname = 'TEXT' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_maxlength( 40 ).
    lo_type->bind_structure( 'ZCL_OSD_H5X_MPC=>TS_VH_CURRENCY' ).
    lo_type->create_entity_set( 'VH_CurrencySet' ).

    lo_action = model->create_action( 'Item_Release' ).
    lo_action->set_return_entity_type( 'Item' ).
    lo_action->set_return_multiplicity( '1' ).
    lo_action->set_http_method( 'POST' ).
    lo_param = lo_action->create_input_parameter( iv_parameter_name = 'ItemNo'
                                                  iv_abap_fieldname = 'ITEM_NO' ).
    lo_param->set_label_from_text_element( iv_text_element_symbol    = '002'
                                           iv_text_element_container = gc_incl_name ).
    lo_param->/iwbep/if_mgw_odata_property~set_type_edm_string( ).
    lo_param->/iwbep/if_mgw_odata_property~set_maxlength( 10 ).
  ENDMETHOD.
ENDCLASS.
