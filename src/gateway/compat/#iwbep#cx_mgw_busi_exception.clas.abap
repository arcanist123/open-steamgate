CLASS /iwbep/cx_mgw_busi_exception DEFINITION INHERITING FROM /iwbep/cx_mgw_base_exception PUBLIC.
* Overlay (milestone 4) of the library copy: the text ids and constructor
* parameters two more generated services raise this exception with --
* resource_not_found (message 020 of the Gateway runtime's message class,
* its variable the entity type: measured, a system answers
* "/IWBEP/CM_MGW_RT/020" for a resource it does not find), resource_duplicate,
* filter_not_supported (its variable the property the filter named),
* precondition_failed; the entity type, the filter parameter and the HTTP
* status. The message numbers of the last three are NOT measured: they
* carry 000, so an answer that shows one is visibly this runtime's, and a
* measurement replaces them (the PR that brought them lists it).
  PUBLIC SECTION.
    CONSTANTS: BEGIN OF business_error,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '022',
                 attr1 TYPE scx_attrname VALUE 'MESSAGE',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF business_error.

    CONSTANTS: BEGIN OF business_error_unlimited,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '022',
                 attr1 TYPE scx_attrname VALUE 'MESSAGE_UNLIMITED',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF business_error_unlimited.

    CONSTANTS: BEGIN OF resource_not_found,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '020',
                 attr1 TYPE scx_attrname VALUE 'ENTITY_TYPE',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF resource_not_found.

    CONSTANTS: BEGIN OF resource_duplicate,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '000',
                 attr1 TYPE scx_attrname VALUE 'ENTITY_TYPE',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF resource_duplicate.

    CONSTANTS: BEGIN OF filter_not_supported,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '000',
                 attr1 TYPE scx_attrname VALUE 'FILTER_PARAM',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF filter_not_supported.

    CONSTANTS: BEGIN OF precondition_failed,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '000',
                 attr1 TYPE scx_attrname VALUE 'ENTITY_TYPE',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF precondition_failed.

    DATA message           TYPE string READ-ONLY.
    DATA message_unlimited TYPE string READ-ONLY.
    DATA entity_type       TYPE string READ-ONLY.
    DATA filter_param      TYPE string READ-ONLY.

    METHODS constructor
      IMPORTING
        textid            LIKE if_t100_message=>t100key OPTIONAL
        message_unlimited TYPE string OPTIONAL
        message           TYPE clike OPTIONAL
        message_container TYPE REF TO /iwbep/if_message_container OPTIONAL
        previous          LIKE previous OPTIONAL
        http_status_code  TYPE i OPTIONAL
        entity_type       TYPE clike OPTIONAL
        filter_param      TYPE clike OPTIONAL.
ENDCLASS.

CLASS /iwbep/cx_mgw_busi_exception IMPLEMENTATION.

  METHOD constructor.
    IF textid IS INITIAL.
      super->constructor( textid            = business_error
                          previous          = previous
                          message_container = message_container
                          http_status_code  = http_status_code ).
    ELSE.
      super->constructor( textid            = textid
                          previous          = previous
                          message_container = message_container
                          http_status_code  = http_status_code ).
    ENDIF.
    me->message           = message.
    me->message_unlimited = message_unlimited.
    me->entity_type       = entity_type.
    me->filter_param      = filter_param.
  ENDMETHOD.

ENDCLASS.
