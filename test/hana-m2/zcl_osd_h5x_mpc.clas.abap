CLASS zcl_osd_h5x_mpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_model CREATE PUBLIC.
* The model shape of a SEGW sample's business set, synthetic: an entity
* type whose first property is a complex property (an address), keys and
* texts after it, a DEC 21,7 timestamp as Edm.DateTime. Read by the DPC
* beside it with a join and an INTO list (docs/hana-milestone-2.md).
* Milestone 3 (B2): an order whose reference to its partner is a field of
* another name (BUYER_ID: the source key must be converted against the
* source), an order item with a two-part key, a contact with an Edm.Guid
* key, and the navigations between them both ways.
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
    TYPES: BEGIN OF ts_order,
             order_id TYPE c LENGTH 10,
             buyer_id TYPE c LENGTH 10,
           END OF ts_order.
    TYPES tt_order TYPE STANDARD TABLE OF ts_order WITH DEFAULT KEY.
    TYPES: BEGIN OF ts_order_item,
             order_id TYPE c LENGTH 10,
             item_pos TYPE c LENGTH 10,
             note     TYPE c LENGTH 40,
           END OF ts_order_item.
    TYPES tt_order_item TYPE STANDARD TABLE OF ts_order_item WITH DEFAULT KEY.
    TYPES: BEGIN OF ts_contact,
             contact_guid TYPE x LENGTH 16,
             partner_id   TYPE c LENGTH 10,
             name         TYPE c LENGTH 40,
           END OF ts_contact.
    TYPES tt_contact TYPE STANDARD TABLE OF ts_contact WITH DEFAULT KEY.
    METHODS define REDEFINITION.
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
    lo_prop = lo_type->create_property( iv_property_name  = 'BuyerID'
                                        iv_abap_fieldname = 'BUYER_ID' ).
    lo_prop->set_type_edm_string( ).
    lo_type->bind_structure( 'ZCL_OSD_H5X_MPC=>TS_ORDER' ).
    lo_type->create_entity_set( 'OrderSet' ).

    lo_type = model->create_entity_type( iv_entity_type_name = 'OrderItem'
                                         iv_def_entity_set   = abap_false ).
    lo_prop = lo_type->create_property( iv_property_name  = 'OrderID'
                                        iv_abap_fieldname = 'ORDER_ID' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_is_key( ).
    lo_prop = lo_type->create_property( iv_property_name  = 'ItemPosition'
                                        iv_abap_fieldname = 'ITEM_POS' ).
    lo_prop->set_type_edm_string( ).
    lo_prop->set_is_key( ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Note'
                                        iv_abap_fieldname = 'NOTE' ).
    lo_prop->set_type_edm_string( ).
    lo_type->bind_structure( 'ZCL_OSD_H5X_MPC=>TS_ORDER_ITEM' ).
    lo_type->create_entity_set( 'OrderItemSet' ).

    lo_type = model->create_entity_type( iv_entity_type_name = 'Contact'
                                         iv_def_entity_set   = abap_false ).
    lo_prop = lo_type->create_property( iv_property_name  = 'ContactGuid'
                                        iv_abap_fieldname = 'CONTACT_GUID' ).
    lo_prop->set_type_edm_guid( ).
    lo_prop->set_is_key( ).
    lo_prop = lo_type->create_property( iv_property_name  = 'PartnerID'
                                        iv_abap_fieldname = 'PARTNER_ID' ).
    lo_prop->set_type_edm_string( ).
    lo_prop = lo_type->create_property( iv_property_name  = 'Name'
                                        iv_abap_fieldname = 'NAME' ).
    lo_prop->set_type_edm_string( ).
    lo_type->bind_structure( 'ZCL_OSD_H5X_MPC=>TS_CONTACT' ).
    lo_type->create_entity_set( 'ContactSet' ).
    model->create_association( iv_association_name = 'Assoc_Partner_Orders_With_A_Long_Name'
                               iv_left_type        = 'Partner'
                               iv_right_type       = 'Order'
                               iv_right_card       = 'M'
                               iv_left_card        = '1'
                               iv_def_assoc_set    = abap_true ).
    model->create_association( iv_association_name = 'Assoc_Order_Items'
                               iv_left_type        = 'Order'
                               iv_right_type       = 'OrderItem'
                               iv_right_card       = 'M'
                               iv_left_card        = '1'
                               iv_def_assoc_set    = abap_true ).
    model->create_association( iv_association_name = 'Assoc_Partner_Contacts'
                               iv_left_type        = 'Partner'
                               iv_right_type       = 'Contact'
                               iv_right_card       = 'M'
                               iv_left_card        = '1'
                               iv_def_assoc_set    = abap_true ).

    lo_type = model->get_entity_type( 'Partner' ).
    lo_type->create_navigation_property( iv_property_name    = 'ToOrders'
                                         iv_association_name = 'Assoc_Partner_Orders_With_A_Long_Name' ).
    lo_type->create_navigation_property( iv_property_name    = 'ToContacts'
                                         iv_association_name = 'Assoc_Partner_Contacts' ).
    lo_type = model->get_entity_type( 'Order' ).
    lo_type->create_navigation_property( iv_property_name    = 'ToPartner'
                                         iv_association_name = 'Assoc_Partner_Orders_With_A_Long_Name' ).
    lo_type->create_navigation_property( iv_property_name    = 'ToItems'
                                         iv_association_name = 'Assoc_Order_Items' ).
    lo_type = model->get_entity_type( 'OrderItem' ).
    lo_type->create_navigation_property( iv_property_name    = 'ToOrder'
                                         iv_association_name = 'Assoc_Order_Items' ).
    lo_type = model->get_entity_type( 'Contact' ).
    lo_type->create_navigation_property( iv_property_name    = 'ToPartner'
                                         iv_association_name = 'Assoc_Partner_Contacts' ).

    lo_action = model->create_action( 'Partner_Touch' ).
    lo_action->set_return_entity_type( 'Partner' ).
    lo_action->set_return_multiplicity( '1' ).
    lo_action->set_http_method( 'POST' ).
  ENDMETHOD.
ENDCLASS.
