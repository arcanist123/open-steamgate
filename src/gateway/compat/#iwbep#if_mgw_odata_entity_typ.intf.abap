INTERFACE /iwbep/if_mgw_odata_entity_typ PUBLIC.
* Overlay (milestone 4): set_is_thing_type (sap:is-thing-type="true" on the
* EntityType, as a system writes it for the second generated service),
* get_navigation_property (a redefining model reads the navigation it
* disables), set_disabled through the item.

  INTERFACES /iwbep/if_mgw_odata_item.
  INTERFACES /iwbep/if_mgw_odata_annotatabl.

  ALIASES set_label_from_text_element FOR /iwbep/if_mgw_odata_item~set_label_from_text_element.
  ALIASES set_disabled FOR /iwbep/if_mgw_odata_item~set_disabled.

  METHODS set_is_thing_type
    IMPORTING
      iv_is_thing_type TYPE abap_bool DEFAULT abap_true.

  METHODS get_navigation_property
    IMPORTING
      iv_name                       TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_navigation_property) TYPE REF TO /iwbep/if_mgw_odata_nav_prop
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS create_entity_set
    IMPORTING
      iv_entity_set_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_entity_set) TYPE REF TO /iwbep/if_mgw_odata_entity_set
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS bind_structure
    IMPORTING
      iv_structure_name   TYPE string
      iv_bind_conversions TYPE abap_bool DEFAULT abap_false
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS create_property
    IMPORTING
      iv_property_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_abap_fieldname  TYPE clike OPTIONAL
    RETURNING
      VALUE(ro_property) TYPE REF TO /iwbep/if_mgw_odata_property
    RAISING
      /iwbep/cx_mgw_med_exception.

* the property is typed by a complex type of the model, the complex type is returned
  METHODS create_complex_property
    IMPORTING
      iv_property_name       TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_complex_type_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_abap_fieldname      TYPE clike OPTIONAL
    RETURNING
      VALUE(ro_complex_type) TYPE REF TO /iwbep/if_mgw_odata_cmplx_type
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS get_property
    IMPORTING
      iv_property_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_property) TYPE REF TO /iwbep/if_mgw_odata_property
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS get_properties
    RETURNING
      VALUE(rt_properties) TYPE /iwbep/if_mgw_med_odata_types=>ty_t_mgw_odata_properties.

  METHODS set_is_media
    IMPORTING
      iv_is_media TYPE abap_bool DEFAULT abap_true.

  METHODS create_navigation_property
    IMPORTING
      iv_property_name              TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_association_name           TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_abap_fieldname             TYPE clike OPTIONAL
    RETURNING
      VALUE(ro_navigation_property) TYPE REF TO /iwbep/if_mgw_odata_nav_prop
    RAISING
      /iwbep/cx_mgw_med_exception.

ENDINTERFACE.