CLASS zcl_zstg_demo_mpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_model CREATE PUBLIC.
* Hand-written in the shape SEGW generates. Clean-room: no SAP source.
  PUBLIC SECTION.
    TYPES: BEGIN OF ts_travel,
             travel_id   TYPE c LENGTH 8,
             description TYPE c LENGTH 40,
             status      TYPE c LENGTH 1,
             seats       TYPE i,
             status_text TYPE c LENGTH 40,
             photo_url   TYPE c LENGTH 120,
           END OF ts_travel.
    TYPES tt_travel TYPE STANDARD TABLE OF ts_travel WITH DEFAULT KEY.

* value help for Status: the code and its text
    TYPES: BEGIN OF ts_statusvh,
             status      TYPE c LENGTH 1,
             status_text TYPE c LENGTH 40,
           END OF ts_statusvh.
    TYPES tt_statusvh TYPE STANDARD TABLE OF ts_statusvh WITH DEFAULT KEY.

* the picture of a travel: a media entity, its content read and written as
* a stream at PhotoSet('T0001')/$value; the properties are what is known
* about the picture, not the bytes
    TYPES: BEGIN OF ts_photo,
             travel_id TYPE c LENGTH 8,
             mime_type TYPE c LENGTH 40,
             file_name TYPE c LENGTH 40,
           END OF ts_photo.
    TYPES tt_photo TYPE STANDARD TABLE OF ts_photo WITH DEFAULT KEY.

    TYPES: BEGIN OF ts_booking,
             travel_id   TYPE c LENGTH 8,
             booking_id  TYPE c LENGTH 4,
             customer    TYPE c LENGTH 40,
             flight_date TYPE d,
           END OF ts_booking.
    TYPES tt_booking TYPE STANDARD TABLE OF ts_booking WITH DEFAULT KEY.

* deep structure for a Travel with its bookings, the SEGW convention:

    CONSTANTS gc_travel TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'Travel' ##NO_TEXT.
    CONSTANTS gc_travel_set TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'TravelSet' ##NO_TEXT.
    CONSTANTS gc_booking TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'Booking' ##NO_TEXT.
    CONSTANTS gc_booking_set TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'BookingSet' ##NO_TEXT.
    CONSTANTS gc_photo TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'Photo' ##NO_TEXT.
    CONSTANTS gc_photo_set TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'PhotoSet' ##NO_TEXT.
    CONSTANTS gc_status_vh TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'StatusVH' ##NO_TEXT.
    CONSTANTS gc_status_vh_set TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'StatusVHSet' ##NO_TEXT.

    METHODS define REDEFINITION.
  PROTECTED SECTION.
  PRIVATE SECTION.
    METHODS define_travel
      RAISING
        /iwbep/cx_mgw_med_exception.

    METHODS define_booking
      RAISING
        /iwbep/cx_mgw_med_exception.

    METHODS define_status_vh
      RAISING
        /iwbep/cx_mgw_med_exception.

    METHODS define_photo
      RAISING
        /iwbep/cx_mgw_med_exception.

    METHODS define_associations
      RAISING
        /iwbep/cx_mgw_med_exception.

    METHODS define_actions
      RAISING
        /iwbep/cx_mgw_med_exception.
ENDCLASS.

CLASS zcl_zstg_demo_mpc IMPLEMENTATION.

  METHOD define.
    model->set_schema_namespace( 'ZSTG_DEMO_SRV' ).
    define_travel( ).
    define_booking( ).
    define_status_vh( ).
    define_photo( ).
    define_associations( ).
    define_actions( ).
  ENDMETHOD.

  METHOD define_actions.
    DATA lo_action    TYPE REF TO /iwbep/if_mgw_odata_action.
    DATA lo_parameter TYPE REF TO /iwbep/if_mgw_odata_parameter.

    lo_action = model->create_action( 'CancelTravel' ).
    lo_action->set_return_entity_type( gc_travel ).
    lo_action->set_return_entity_set( gc_travel_set ).
    lo_action->set_return_multiplicity( '1' ).
    lo_action->set_http_method( 'POST' ).
    lo_action->set_action_for( gc_travel ).
    lo_parameter = lo_action->create_input_parameter( iv_parameter_name = 'TravelId'
                                                      iv_abap_fieldname = 'TRAVEL_ID' ).
    lo_parameter->set_type_edm_string( ).
    lo_parameter->set_maxlength( 8 ).

    lo_action = model->create_action( 'TravelCount' ).
    lo_action->set_http_method( 'GET' ).
    lo_parameter = lo_action->create_input_parameter( iv_parameter_name = 'Status'
                                                      iv_abap_fieldname = 'STATUS' ).
    lo_parameter->set_type_edm_string( ).
    lo_parameter->set_maxlength( 1 ).
  ENDMETHOD.

  METHOD define_photo.
    DATA lo_entity_type TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_property    TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_entity_set  TYPE REF TO /iwbep/if_mgw_odata_entity_set.

    lo_entity_type = model->create_entity_type( iv_entity_type_name = gc_photo
                                                iv_def_entity_set   = abap_false ).
* a media entity: $metadata marks it m:HasStream and the content is served
* at PhotoSet('T0001')/$value through the DPC's GET_STREAM
    lo_entity_type->set_is_media( 'X' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'TravelId'
                                                   iv_abap_fieldname = 'TRAVEL_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 8 ).
    lo_property->set_creatable( abap_false ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_false ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      iv_key   = 'label'
      iv_value = 'Travel' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'MimeType'
                                                   iv_abap_fieldname = 'MIME_TYPE' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 40 ).
    lo_property->set_creatable( abap_false ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_false ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_false ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      iv_key   = 'label'
      iv_value = 'MIME type' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'FileName'
                                                   iv_abap_fieldname = 'FILE_NAME' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 40 ).
    lo_property->set_creatable( abap_false ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_false ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_false ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      iv_key   = 'label'
      iv_value = 'File name' ).

    lo_entity_type->bind_structure( iv_structure_name   = 'ZCL_ZSTG_DEMO_MPC=>TS_PHOTO'
                                    iv_bind_conversions = abap_true ).

    lo_entity_set = lo_entity_type->create_entity_set( gc_photo_set ).
    lo_entity_set->set_creatable( abap_false ).
    lo_entity_set->set_updatable( abap_true ).
    lo_entity_set->set_deletable( abap_false ).
    lo_entity_set->set_pageable( abap_false ).
    lo_entity_set->set_addressable( abap_true ).
  ENDMETHOD.

  METHOD define_status_vh.
    DATA lo_entity_type TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_property    TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_entity_set  TYPE REF TO /iwbep/if_mgw_odata_entity_set.

    lo_entity_type = model->create_entity_type( iv_entity_type_name = gc_status_vh
                                                iv_def_entity_set   = abap_false ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'Status'
                                                   iv_abap_fieldname = 'STATUS' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 1 ).
    lo_property->set_creatable( abap_false ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_false ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Status' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'Text'
                                                   iv_abap_fieldname = 'STATUS_TEXT' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 40 ).
    lo_property->set_creatable( abap_false ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Status text' ).

    lo_entity_type->bind_structure( iv_structure_name   = 'ZCL_ZSTG_DEMO_MPC=>TS_STATUS_VH'
                                    iv_bind_conversions = abap_true ).

    lo_entity_set = lo_entity_type->create_entity_set( gc_status_vh_set ).
    lo_entity_set->set_creatable( abap_false ).
    lo_entity_set->set_updatable( abap_false ).
    lo_entity_set->set_deletable( abap_false ).
    lo_entity_set->set_pageable( abap_true ).
    lo_entity_set->set_addressable( abap_true ).
    lo_entity_set->set_has_ftxt_search( abap_true ).
    lo_entity_set->set_subscribable( abap_false ).
    lo_entity_set->set_filter_required( abap_false ).
  ENDMETHOD.

  METHOD define_booking.
    DATA lo_entity_type TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_property    TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_entity_set  TYPE REF TO /iwbep/if_mgw_odata_entity_set.

    lo_entity_type = model->create_entity_type( iv_entity_type_name = gc_booking
                                                iv_def_entity_set   = abap_false ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'TravelId'
                                                   iv_abap_fieldname = 'TRAVEL_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 8 ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_false ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Travel' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'BookingId'
                                                   iv_abap_fieldname = 'BOOKING_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 4 ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_false ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Booking' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'Customer'
                                                   iv_abap_fieldname = 'CUSTOMER' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 40 ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_true ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Customer' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'FlightDate'
                                                   iv_abap_fieldname = 'FLIGHT_DATE' ).
    lo_property->set_type_edm_datetime( ).
    lo_property->set_precison( 0 ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_true ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Flight date' ).

    lo_entity_type->bind_structure( iv_structure_name   = 'ZCL_ZSTG_DEMO_MPC=>TS_BOOKING'
                                    iv_bind_conversions = abap_true ).

    lo_entity_set = lo_entity_type->create_entity_set( gc_booking_set ).
    lo_entity_set->set_creatable( abap_true ).
    lo_entity_set->set_updatable( abap_true ).
    lo_entity_set->set_deletable( abap_true ).
    lo_entity_set->set_pageable( abap_true ).
    lo_entity_set->set_addressable( abap_true ).
    lo_entity_set->set_has_ftxt_search( abap_false ).
    lo_entity_set->set_subscribable( abap_false ).
    lo_entity_set->set_filter_required( abap_false ).
  ENDMETHOD.

  METHOD define_associations.
    DATA lo_association    TYPE REF TO /iwbep/if_mgw_odata_assoc.
    DATA lo_ref_constraint TYPE REF TO /iwbep/if_mgw_odata_ref_constr.
    DATA lo_entity_type    TYPE REF TO /iwbep/if_mgw_odata_entity_typ.

    lo_association = model->create_association( iv_association_name = 'TravelToBookings'
                                                iv_left_type        = gc_travel
                                                iv_right_type       = gc_booking
                                                iv_left_card        = '1'
                                                iv_right_card       = 'N'
                                                iv_def_assoc_set    = abap_false ).
    lo_ref_constraint = lo_association->create_ref_constraint( ).
    lo_ref_constraint->add_property( iv_principal_property = 'TravelId'
                                     iv_dependent_property = 'TravelId' ).

    model->create_association_set( iv_association_set_name  = 'TravelToBookingsSet'
                                   iv_left_entity_set_name  = gc_travel_set
                                   iv_right_entity_set_name = gc_booking_set
                                   iv_association_name      = 'TravelToBookings' ).

    lo_entity_type = model->get_entity_type( gc_travel ).
    lo_entity_type->create_navigation_property( iv_property_name    = 'to_Bookings'
                                                iv_association_name = 'TravelToBookings' ).
    lo_entity_type = model->get_entity_type( gc_booking ).
    lo_entity_type->create_navigation_property( iv_property_name    = 'to_Travel'
                                                iv_association_name = 'TravelToBookings' ).
  ENDMETHOD.

  METHOD define_travel.
    DATA lo_entity_type TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lo_property    TYPE REF TO /iwbep/if_mgw_odata_property.
    DATA lo_entity_set  TYPE REF TO /iwbep/if_mgw_odata_entity_set.

    lo_entity_type = model->create_entity_type( iv_entity_type_name = gc_travel
                                                iv_def_entity_set   = abap_false ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'TravelId'
                                                   iv_abap_fieldname = 'TRAVEL_ID' ).
    lo_property->set_is_key( ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 8 ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_false ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Travel' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'Description'
                                                   iv_abap_fieldname = 'DESCRIPTION' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 40 ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_true ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Description' ).
    lo_property->set_as_etag( ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'Status'
                                                   iv_abap_fieldname = 'STATUS' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 1 ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_true ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Status' ).
    lo_property->set_as_etag( ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'Seats'
                                                   iv_abap_fieldname = 'SEATS' ).
    lo_property->set_type_edm_int32( ).
    lo_property->set_creatable( abap_true ).
    lo_property->set_updatable( abap_true ).
    lo_property->set_sortable( abap_true ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_true ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Seats' ).
    lo_property->set_as_etag( ).

* the status text, read-only, filled by the DPC from the value-help table
    lo_property = lo_entity_type->create_property( iv_property_name  = 'StatusText'
                                                   iv_abap_fieldname = 'STATUS_TEXT' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 40 ).
    lo_property->set_creatable( abap_false ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_false ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_false ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = 'Status text' ).

    lo_property = lo_entity_type->create_property( iv_property_name  = 'PhotoUrl'
                                                   iv_abap_fieldname = 'PHOTO_URL' ).
    lo_property->set_type_edm_string( ).
    lo_property->set_maxlength( 120 ).
    lo_property->set_creatable( abap_false ).
    lo_property->set_updatable( abap_false ).
    lo_property->set_sortable( abap_false ).
    lo_property->set_nullable( abap_true ).
    lo_property->set_filterable( abap_false ).
    lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      iv_key      = 'label'
      iv_value    = 'Photo' ).

    lo_entity_type->bind_structure( iv_structure_name   = 'ZCL_ZSTG_DEMO_MPC=>TS_TRAVEL'
                                    iv_bind_conversions = abap_true ).

    lo_entity_set = lo_entity_type->create_entity_set( gc_travel_set ).
    lo_entity_set->set_creatable( abap_true ).
    lo_entity_set->set_updatable( abap_true ).
    lo_entity_set->set_deletable( abap_true ).
    lo_entity_set->set_pageable( abap_true ).
    lo_entity_set->set_addressable( abap_true ).
    lo_entity_set->set_has_ftxt_search( abap_true ).
    lo_entity_set->set_subscribable( abap_false ).
    lo_entity_set->set_filter_required( abap_false ).
  ENDMETHOD.

ENDCLASS.
