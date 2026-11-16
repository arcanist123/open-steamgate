CLASS zcl_osd_m4a_mpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_model CREATE PUBLIC.
* Milestone 4, the twin of the Gateway contract members a second generated
* service calls in its model (synthetic, written fresh): a thing type, labels
* from the text pool on the type, a set, an association, a navigation
* property and a function import, a unit property named by the model, a
* title and an updated property of the Atom entry, the model features --
* and, the way a redefining model works, elements read back by name through
* the getters and disabled. Every getter is also asked for a name the model
* lacks; each of those must raise the med exception (gv_absent_raised
* counts them).
  PUBLIC SECTION.
    TYPES: BEGIN OF ts_order,
             order_id   TYPE c LENGTH 10,
             title      TYPE c LENGTH 40,
             changed_at TYPE p LENGTH 11 DECIMALS 7,
             amount     TYPE p LENGTH 8 DECIMALS 2,
             currency   TYPE c LENGTH 5,
             hidden     TYPE c LENGTH 10,
           END OF ts_order.
    TYPES tt_order TYPE STANDARD TABLE OF ts_order WITH DEFAULT KEY.
    TYPES: BEGIN OF ts_item,
             order_id TYPE c LENGTH 10,
             item_pos TYPE c LENGTH 10,
           END OF ts_item.
    TYPES tt_item TYPE STANDARD TABLE OF ts_item WITH DEFAULT KEY.
    TYPES: BEGIN OF ts_stamp,
             changed_by TYPE c LENGTH 12,
           END OF ts_stamp.
    TYPES tt_stamp TYPE STANDARD TABLE OF ts_stamp WITH DEFAULT KEY.

    CONSTANTS gc_incl_name TYPE string VALUE 'ZCL_OSD_M4A_MPC===============CP'.

* how many of the getters, asked for a name the model lacks, raised the med
* exception during the last define (8 getters are asked)
    CLASS-DATA gv_absent_raised TYPE i.

    METHODS define REDEFINITION.
  PRIVATE SECTION.
    METHODS define_types
      RAISING
        /iwbep/cx_mgw_med_exception.
    METHODS define_associations
      RAISING
        /iwbep/cx_mgw_med_exception.
    METHODS define_actions
      RAISING
        /iwbep/cx_mgw_med_exception.
    METHODS disable_elements
      RAISING
        /iwbep/cx_mgw_med_exception.
    METHODS ask_absent_names.
ENDCLASS.

CLASS zcl_osd_m4a_mpc IMPLEMENTATION.

  METHOD define.
    DATA ls_features TYPE /iwbep/if_mgw_odata_model=>ty_s_model_features.

    model->set_schema_namespace( 'ZOSD_M4A_SRV' ).
* the feature service A sets: labels stay medium with it
    ls_features-use_long_label_for_property = abap_true.
    model->set_model_features( ls_features ).

    define_types( ).
    define_associations( ).
    define_actions( ).
    disable_elements( ).
    ask_absent_names( ).
  ENDMETHOD.

  METHOD define_types.
    DATA lo_type     TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_property TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_set      TYPE REF TO /iwbep/if_mgw_odata_entity_set.
    DATA lo_nav      TYPE REF TO /iwbep/if_mgw_odata_nav_prop.

    lo_type = model->create_entity_type( iv_entity_type_name = 'Order'
                                         iv_def_entity_set   = abap_false ).
    lo_type->set_is_thing_type( abap_true ).
    lo_type->set_label_from_text_element( iv_text_element_symbol    = '001'
                                          iv_text_element_container = gc_incl_name ).
    lo_property = lo_type->create_property( iv_property_name  = 'OrderId'
                                            iv_abap_fieldname = 'ORDER_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 10 ).
    lo_property = lo_type->create_property( iv_property_name  = 'Title'
                                            iv_abap_fieldname = 'TITLE' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 40 ).
    lo_property->set_as_title( iv_keep_in_content = abap_true ).
    lo_property = lo_type->create_property( iv_property_name  = 'ChangedAt'
                                            iv_abap_fieldname = 'CHANGED_AT' ).
    lo_property->set_type_edm_datetime( ).
    lo_property->set_precison( 7 ).
    lo_property->set_as_updated( ).
    lo_property = lo_type->create_property( iv_property_name  = 'Amount'
                                            iv_abap_fieldname = 'AMOUNT' ).
    lo_property->set_type_edm_decimal( ).
    lo_property->set_precison( 2 ).
    lo_property->set_maxlength( 15 ).
    lo_property->set_unit_property( 'Currency' ).
    lo_property = lo_type->create_property( iv_property_name  = 'Currency'
                                            iv_abap_fieldname = 'CURRENCY' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 5 ).
    lo_property = lo_type->create_property( iv_property_name  = 'Hidden'
                                            iv_abap_fieldname = 'HIDDEN' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 10 ).
    lo_set = lo_type->create_entity_set( 'Orders' ).
    lo_set->set_label_from_text_element( iv_text_element_symbol    = '002'
                                         iv_text_element_container = gc_incl_name ).
    lo_set = lo_type->create_entity_set( 'OrdersHidden' ).
    lo_nav = lo_type->create_navigation_property( iv_property_name    = 'Items'
                                                  iv_abap_fieldname   = 'ITEMS'
                                                  iv_association_name = 'OrderItems' ).
    lo_nav->set_label_from_text_element( iv_text_element_symbol    = '004'
                                         iv_text_element_container = gc_incl_name ).
    lo_nav = lo_type->create_navigation_property( iv_property_name    = 'ItemsHidden'
                                                  iv_abap_fieldname   = 'ITEMS_HIDDEN'
                                                  iv_association_name = 'OrderItems' ).
* navigations whose other end goes: over an association to a disabled type,
* and over one to a type whose only set is disabled
    lo_nav = lo_type->create_navigation_property( iv_property_name    = 'GoneNav'
                                                  iv_abap_fieldname   = 'GONE_NAV'
                                                  iv_association_name = 'OrderGoneKept' ).
    lo_nav = lo_type->create_navigation_property( iv_property_name    = 'Parts'
                                                  iv_abap_fieldname   = 'PARTS'
                                                  iv_association_name = 'OrderParts' ).

    lo_type = model->create_entity_type( iv_entity_type_name = 'Item'
                                         iv_def_entity_set   = abap_false ).
    lo_property = lo_type->create_property( iv_property_name  = 'OrderId'
                                            iv_abap_fieldname = 'ORDER_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 10 ).
    lo_property = lo_type->create_property( iv_property_name  = 'ItemPos'
                                            iv_abap_fieldname = 'ITEM_POS' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 10 ).
    lo_set = lo_type->create_entity_set( 'Items' ).

    lo_type = model->create_entity_type( iv_entity_type_name = 'Gone'
                                         iv_def_entity_set   = abap_false ).
    lo_property = lo_type->create_property( iv_property_name  = 'GoneId'
                                            iv_abap_fieldname = 'ORDER_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_set = lo_type->create_entity_set( 'GoneSet' ).

    lo_type = model->create_entity_type( iv_entity_type_name = 'Part'
                                         iv_def_entity_set   = abap_false ).
    lo_property = lo_type->create_property( iv_property_name  = 'PartId'
                                            iv_abap_fieldname = 'ORDER_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_set = lo_type->create_entity_set( 'Parts' ).

* bound to a structure whose data element's medium and long labels differ
    lo_type = model->create_entity_type( iv_entity_type_name = 'Stamp'
                                         iv_def_entity_set   = abap_false ).
    lo_property = lo_type->create_property( iv_property_name  = 'ChangedBy'
                                            iv_abap_fieldname = 'CHANGED_BY' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 12 ).
    lo_type->bind_structure( 'ZOSD_H5X_S_STAMP' ).
    lo_set = lo_type->create_entity_set( 'Stamps' ).
  ENDMETHOD.

  METHOD define_associations.
    DATA lo_association TYPE REF TO /iwbep/if_mgw_odata_assoc.
    DATA lo_constraint  TYPE REF TO /iwbep/if_mgw_odata_ref_constr.

    lo_association = model->create_association( iv_association_name = 'OrderItems'
                                                iv_left_type        = 'Order'
                                                iv_right_type       = 'Item'
                                                iv_left_card        = '1'
                                                iv_right_card       = 'M' ).
    lo_association->set_label_from_text_element( iv_text_element_symbol    = '003'
                                                 iv_text_element_container = gc_incl_name ).
    lo_constraint = lo_association->create_ref_constraint( ).
    lo_constraint->add_property( iv_principal_property = 'OrderId'
                                 iv_dependent_property = 'OrderId' ).

* an association whose set the model names itself
    lo_association = model->create_association( iv_association_name = 'OrderItemsNoRc'
                                                iv_left_type        = 'Order'
                                                iv_right_type       = 'Item'
                                                iv_left_card        = '1'
                                                iv_right_card       = 'M'
                                                iv_def_assoc_set    = abap_false ).
    lo_constraint = lo_association->create_ref_constraint( ).
    lo_constraint->add_property( iv_principal_property = 'OrderId'
                                 iv_dependent_property = 'OrderId' ).
    lo_association->create_assoc_set( 'OrderItemsNoRcSet' ).

    model->create_association( iv_association_name = 'OrderGone'
                               iv_left_type        = 'Order'
                               iv_right_type       = 'Gone'
                               iv_left_card        = '1'
                               iv_right_card       = '1' ).
* not disabled itself: its end type is (rule of zcl_oao_model=>type_enabled)
    model->create_association( iv_association_name = 'OrderGoneKept'
                               iv_left_type        = 'Order'
                               iv_right_type       = 'Gone'
                               iv_left_card        = '1'
                               iv_right_card       = 'M' ).
* its end set is disabled, its types are not
    model->create_association( iv_association_name = 'OrderParts'
                               iv_left_type        = 'Order'
                               iv_right_type       = 'Part'
                               iv_left_card        = '1'
                               iv_right_card       = 'M' ).
    model->create_association( iv_association_name = 'OrderStamp'
                               iv_left_type        = 'Order'
                               iv_right_type       = 'Stamp'
                               iv_left_card        = '1'
                               iv_right_card       = '1' ).
  ENDMETHOD.

  METHOD define_actions.
    DATA lo_action    TYPE REF TO /iwbep/if_mgw_odata_action.
    DATA lo_parameter TYPE REF TO /iwbep/if_mgw_odata_parameter.

    lo_action = model->create_action( 'Approve' ).
    lo_action->set_label_from_text_element( iv_text_element_symbol    = '005'
                                            iv_text_element_container = gc_incl_name ).
    lo_action->set_return_entity_type( 'Order' ).
    lo_action->set_http_method( 'POST' ).
    lo_parameter = lo_action->create_input_parameter( iv_parameter_name = 'OrderId'
                                                      iv_abap_fieldname = 'ORDER_ID' ).
    lo_parameter->set_type_edm_string( ).
    lo_parameter->set_maxlength( 10 ).
    lo_parameter = lo_action->create_input_parameter( iv_parameter_name = 'Note'
                                                      iv_abap_fieldname = 'NOTE' ).
    lo_parameter->set_type_edm_string( ).

* answers with a disabled type
    lo_action = model->create_action( 'Archive' ).
    lo_action->set_return_entity_type( 'Gone' ).
    lo_action->set_http_method( 'POST' ).

    lo_action = model->create_action( 'Drop' ).
    lo_action->set_return_entity_type( 'Order' ).
    lo_action->set_http_method( 'POST' ).
  ENDMETHOD.

  METHOD disable_elements.
* the way a redefining model takes elements out: read back by name, then
* disabled -- every getter the contract offers, once
    DATA lo_type     TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_property TYPE REF TO /iwbep/if_mgw_odata_property.

    lo_type = model->get_entity_type( 'Order' ).
    lo_property = lo_type->get_property( 'Hidden' ).
    lo_property->set_disabled( ).
    lo_type->get_navigation_property( 'ItemsHidden' )->set_disabled( ).
    model->get_entity_set( 'OrdersHidden' )->set_disabled( ).
    model->get_entity_set( 'Parts' )->set_disabled( ).
    model->get_entity_type( 'Gone' )->set_disabled( iv_disabled = abap_true ).
    model->get_association( 'OrderGone' )->set_disabled( ).
    model->get_association( 'OrderItemsNoRc' )->get_ref_constraint( )->set_disabled( ).
    model->get_association_set( 'OrderStamp_AssocSet' )->set_disabled( ).
    model->get_action( 'Drop' )->set_disabled( ).
    model->get_action( 'Approve' )->get_input_parameter( 'Note' )->set_disabled( ).
  ENDMETHOD.

  METHOD ask_absent_names.
    DATA lo_type        TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_association TYPE REF TO /iwbep/if_mgw_odata_assoc.

    gv_absent_raised = 0.
    TRY.
        model->get_entity_type( 'NoSuchType' ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
    TRY.
        model->get_entity_set( 'NoSuchSet' ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
    TRY.
        model->get_association( 'NoSuchAssociation' ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
    TRY.
        model->get_association_set( 'NoSuchAssocSet' ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
    TRY.
        model->get_action( 'NoSuchAction' ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
    TRY.
        lo_type = model->get_entity_type( 'Order' ).
        lo_type->get_navigation_property( 'NoSuchNavigation' ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
    TRY.
        model->get_action( 'Approve' )->get_input_parameter( 'NoSuchParameter' ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
* an association without a constraint has none to hand back
    TRY.
        lo_association = model->get_association( 'OrderGone' ).
        lo_association->get_ref_constraint( ).
      CATCH /iwbep/cx_mgw_med_exception.
        gv_absent_raised = gv_absent_raised + 1.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
