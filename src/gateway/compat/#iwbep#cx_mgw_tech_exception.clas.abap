CLASS /iwbep/cx_mgw_tech_exception DEFINITION INHERITING FROM /iwbep/cx_mgw_base_exception PUBLIC.
* Overlay (milestone 4) of the library copy: missing_authorization and the
* constructor parameters a page service raises it with (the entity type, the
* internal service name, the HTTP status). The number of
* missing_authorization is NOT measured: it carries 000 (see the business
* exception).
  PUBLIC SECTION.
    CONSTANTS: BEGIN OF method_not_implemented,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '021',
                 attr1 TYPE scx_attrname VALUE 'METHOD',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF method_not_implemented.

    CONSTANTS: BEGIN OF internal_error,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '032',
                 attr1 TYPE scx_attrname VALUE '',
                 attr2 TYPE scx_attrname VALUE '',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF internal_error.

    CONSTANTS: BEGIN OF missing_authorization,
                 msgid TYPE symsgid VALUE '/IWBEP/CM_MGW_RT',
                 msgno TYPE symsgno VALUE '000',
                 attr1 TYPE scx_attrname VALUE 'ENTITY_TYPE',
                 attr2 TYPE scx_attrname VALUE 'INTERNAL_SERVICE_NAME',
                 attr3 TYPE scx_attrname VALUE '',
                 attr4 TYPE scx_attrname VALUE '',
               END OF missing_authorization.

    DATA method                TYPE string READ-ONLY.
    DATA operation             TYPE string READ-ONLY.
    DATA entity_type           TYPE string READ-ONLY.
    DATA internal_service_name TYPE string READ-ONLY.

    METHODS constructor
      IMPORTING
        textid                LIKE if_t100_message=>t100key OPTIONAL
        method                TYPE clike OPTIONAL
        operation             TYPE clike OPTIONAL
        previous              LIKE previous OPTIONAL
        message_container     TYPE REF TO /iwbep/if_message_container OPTIONAL
        http_status_code      TYPE i OPTIONAL
        entity_type           TYPE clike OPTIONAL
        internal_service_name TYPE clike OPTIONAL.
ENDCLASS.

CLASS /iwbep/cx_mgw_tech_exception IMPLEMENTATION.

  METHOD constructor.
    IF textid IS INITIAL.
      super->constructor( textid            = internal_error
                          previous          = previous
                          message_container = message_container
                          http_status_code  = http_status_code ).
    ELSE.
      super->constructor( textid            = textid
                          previous          = previous
                          message_container = message_container
                          http_status_code  = http_status_code ).
    ENDIF.
    me->method                = method.
    me->operation             = operation.
    me->entity_type           = entity_type.
    me->internal_service_name = internal_service_name.
  ENDMETHOD.

ENDCLASS.
