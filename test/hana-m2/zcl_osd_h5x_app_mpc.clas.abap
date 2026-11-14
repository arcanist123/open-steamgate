CLASS zcl_osd_h5x_app_mpc DEFINITION PUBLIC INHERITING FROM zcl_osd_h5x_mpc CREATE PUBLIC.
* What the read-only Fiori Elements app needs of the twin's model, on top of
* the twin and without changing it: a sap:label on the properties the app
* shows, and sort and filter on the two the list report uses. The reads,
* singles and navigations are the twin's own DPC (ZCL_OSD_H5X_DPC). The labels are the model's (SEGW writes them as
* create_annotation( 'sap' )->add( 'label' )), so the app's column headers
* come from $metadata and the app's own annotation file carries none: a
* label missing here is a header the spec cannot find (webapp/h5x).
  PUBLIC SECTION.
    METHODS define REDEFINITION.
  PRIVATE SECTION.
    METHODS label
      IMPORTING
        io_property TYPE REF TO /iwbep/if_mgw_odata_property
        iv_label    TYPE string.
ENDCLASS.

CLASS zcl_osd_h5x_app_mpc IMPLEMENTATION.
  METHOD label.
    DATA lv_value TYPE /iwbep/med_annotation_value.

    lv_value = iv_label.
    io_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      iv_key   = 'label'
      iv_value = lv_value ).
  ENDMETHOD.

  METHOD define.
    DATA lo_type    TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_complex TYPE REF TO /iwbep/if_mgw_odata_cmplx_type.
    DATA lo_prop    TYPE REF TO /iwbep/if_mgw_odata_property.

    super->define( ).

    lo_complex = model->get_complex_type( 'CT_Address' ).
    label( io_property = lo_complex->get_property( 'City' )
           iv_label    = 'Partner city' ).
    label( io_property = lo_complex->get_property( 'Country' )
           iv_label    = 'Partner country' ).

    lo_type = model->get_entity_type( 'Partner' ).
    label( io_property = lo_type->get_property( 'PartnerID' )
           iv_label    = 'Partner number' ).
    label( io_property = lo_type->get_property( 'Name' )
           iv_label    = 'Partner name' ).
* the list report sorts and filters by these two, and a SEGW property is
* neither sortable nor filterable until the model says so
    lo_prop = lo_type->get_property( 'PartnerID' ).
    lo_prop->set_sortable( abap_true ).
    lo_prop->set_filterable( abap_true ).
    lo_prop = lo_type->get_property( 'Name' ).
    lo_prop->set_sortable( abap_true ).
    lo_prop->set_filterable( abap_true ).
    label( io_property = lo_type->get_property( 'ChangedAt' )
           iv_label    = 'Last changed' ).

    lo_type = model->get_entity_type( 'Order' ).
    label( io_property = lo_type->get_property( 'OrderID' )
           iv_label    = 'Order number' ).
    label( io_property = lo_type->get_property( 'BuyerID' )
           iv_label    = 'Ordering partner' ).
  ENDMETHOD.
ENDCLASS.
