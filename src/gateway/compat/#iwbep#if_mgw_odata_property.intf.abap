INTERFACE /iwbep/if_mgw_odata_property PUBLIC.
* Overlay (milestone 4): set_unit_property, set_as_title, set_as_updated (a
* second generated service calls them; a system writes sap:unit and the
* feed customization m:FC_TargetPath / m:FC_KeepInContent for them),
* set_disabled through the item.

  INTERFACES /iwbep/if_mgw_odata_annotatabl.
  INTERFACES /iwbep/if_mgw_odata_item.

  ALIASES set_label_from_text_element
    FOR /iwbep/if_mgw_odata_item~set_label_from_text_element.
  ALIASES set_disabled
    FOR /iwbep/if_mgw_odata_item~set_disabled.

* the property that holds this amount's or quantity's unit (sap:unit)
  METHODS set_unit_property
    IMPORTING
      iv_unit_property_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.

* the property is the title of the Atom entry (SyndicationTitle); kept in
* the content as well when iv_keep_in_content is set
  METHODS set_as_title
    IMPORTING
      iv_keep_in_content TYPE abap_bool DEFAULT abap_false.

* the property is the updated stamp of the Atom entry (SyndicationUpdated)
  METHODS set_as_updated
    IMPORTING
      iv_keep_in_content TYPE abap_bool DEFAULT abap_false.

  METHODS set_type_edm_string.
  METHODS set_type_edm_byte.

  METHODS set_maxlength
    IMPORTING
      iv_max_length TYPE i.

  METHODS set_creatable
    IMPORTING
      iv_creatable TYPE abap_bool.

  METHODS set_updatable
    IMPORTING
      iv_updatable TYPE abap_bool.

  METHODS set_sortable
    IMPORTING
      iv_sortable TYPE abap_bool.

  METHODS set_nullable
    IMPORTING
      iv_nullable TYPE abap_bool.

  METHODS set_filterable
    IMPORTING
      iv_filterable TYPE abap_bool.

  METHODS set_is_key
    IMPORTING
      iv_key TYPE abap_bool DEFAULT abap_true.

  METHODS set_type_edm_decimal.

  METHODS set_precison
    IMPORTING
      iv_precision TYPE i.

  METHODS set_conversion_exit
    IMPORTING
      iv_conv_exit TYPE clike.

  METHODS set_type_edm_datetime.

  METHODS set_type_edm_int32.

  METHODS set_type_edm_boolean.

  METHODS set_type_edm_int16.

  METHODS set_type_edm_time.

  METHODS set_type_edm_guid.

  METHODS set_type_edm_binary.

  METHODS set_type_edm_datetimeoffset.

  METHODS set_type_edm_int64.

  METHODS set_type_edm_double.

  METHODS set_type_edm_single.

  METHODS set_type_edm_float.

  METHODS set_type_edm_sbyte.

  METHODS disable_conversion.

  METHODS set_as_content_type.

* sap:semantics of the property (email, tel, bday, currency-code, ...)
  METHODS set_semantic
    IMPORTING
      iv_semantic TYPE clike.

* the property carries the ETag of the entity, ConcurrencyMode="Fixed"
  METHODS set_as_etag.

ENDINTERFACE.