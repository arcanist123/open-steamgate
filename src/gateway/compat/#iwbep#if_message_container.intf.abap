INTERFACE /iwbep/if_message_container PUBLIC.

  METHODS add_message_from_bapi
    IMPORTING
      is_bapi_message   TYPE bapiret2
      iv_message_target TYPE string.

* Overlay (milestone 4): the entity type, keys and target a page service
* passes with each message (accepted, as on add_message), reset, and
* add_message_from_exception.
  METHODS add_message_text_only
    IMPORTING
      iv_msg_type               TYPE symsgty
      iv_msg_text               TYPE bapi_msg
      iv_error_category         TYPE csequence OPTIONAL
      iv_is_leading_message     TYPE abap_bool DEFAULT abap_false
      iv_entity_type            TYPE csequence OPTIONAL
      it_key_tab                TYPE /iwbep/t_mgw_name_value_pair OPTIONAL
      iv_add_to_response_header TYPE abap_bool DEFAULT abap_false
      iv_message_target         TYPE csequence OPTIONAL.

  METHODS add_messages_from_bapi
    IMPORTING
      it_bapi_messages          TYPE any
      iv_error_category         TYPE csequence OPTIONAL
      iv_determine_leading_msg  TYPE abap_bool DEFAULT abap_false
      iv_entity_type            TYPE csequence OPTIONAL
      it_key_tab                TYPE /iwbep/t_mgw_name_value_pair OPTIONAL
      iv_add_to_response_header TYPE abap_bool DEFAULT abap_false.

* the message an exception carries: its T100 key and variables when it has
* one, else its text; then the exceptions it wraps (previous), each one
* message, unless iv_add_previous says no
  METHODS add_message_from_exception
    IMPORTING
      io_exception              TYPE REF TO cx_root
      iv_error_category         TYPE csequence OPTIONAL
      iv_is_leading_message     TYPE abap_bool DEFAULT abap_false
      iv_entity_type            TYPE csequence OPTIONAL
      it_key_tab                TYPE /iwbep/t_mgw_name_value_pair OPTIONAL
      iv_add_to_response_header TYPE abap_bool DEFAULT abap_false
      iv_message_target         TYPE csequence OPTIONAL
      iv_add_previous           TYPE abap_bool DEFAULT abap_true.

* every message added so far is gone
  METHODS reset.

* Overlay (H5x-3): the member the SEGW sample calls per EPM message it
* forwards from its business objects (framework-gaps.json of bed run 18 --
* private evidence). Parameter list per the SAP Help Portal page of this
* interface, Method ADD_MESSAGE:
* https://help.sap.com/saphelp_gateway20sp12/helpdata/en/25/21aecce9db435daaea433071ff7d94/content.htm
* (iv_msg_type .. iv_msg_v4, iv_msg_text, iv_error_category,
* iv_is_leading_message, iv_entity_type, it_key_tab,
* iv_add_to_response_header) plus iv_message_target, the target its sibling
* add_message_from_bapi carries. The types of the generic ones are this
* runtime's: the page names the parameters, not their types.
  METHODS add_message
    IMPORTING
      iv_msg_type               TYPE symsgty
      iv_msg_id                 TYPE symsgid OPTIONAL
      iv_msg_number             TYPE symsgno OPTIONAL
      iv_msg_text               TYPE bapi_msg OPTIONAL
      iv_msg_v1                 TYPE symsgv OPTIONAL
      iv_msg_v2                 TYPE symsgv OPTIONAL
      iv_msg_v3                 TYPE symsgv OPTIONAL
      iv_msg_v4                 TYPE symsgv OPTIONAL
      iv_error_category         TYPE csequence OPTIONAL
      iv_is_leading_message     TYPE abap_bool DEFAULT abap_false
      iv_entity_type            TYPE csequence OPTIONAL
      it_key_tab                TYPE /iwbep/t_mgw_name_value_pair OPTIONAL
      iv_add_to_response_header TYPE abap_bool DEFAULT abap_false
      iv_message_target         TYPE csequence OPTIONAL.
ENDINTERFACE.
