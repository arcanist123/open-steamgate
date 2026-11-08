CLASS kernel_rap_eml DEFINITION PUBLIC FINAL CREATE PRIVATE.
* The class the transpiler's EML lowering calls (docs/rap-eml.md), named in
* the convention of the other statement kernels (KERNEL_CALL_TRANSFORMATION,
* KERNEL_AUTHORITY_CHECK, KERNEL_SCAN_ABAP_SOURCE): one call per operation
* of a MODIFY or READ ENTITIES statement, the names as strings, the FROM
* or WITH table and the MAPPED / FAILED / REPORTED / RESULT targets as they
* are. A target the statement does not name is bound to a scratch structure
* of the behavior definition's response type here, so the facade behind,
* ZCL_OSD_RAP_EML, always has one to fill. Nothing here knows a BDEF.

  PUBLIC SECTION.
* MODIFY ENTITIES ... ENTITY entity CREATE|UPDATE|DELETE FROM rows
    CLASS-METHODS modify
      IMPORTING
        bdef          TYPE csequence
        entity        TYPE csequence
        operation     TYPE csequence
        rows          TYPE ANY TABLE
        fields        TYPE csequence OPTIONAL
        set_fields    TYPE abap_bool OPTIONAL
        auto_fill_cid TYPE abap_bool OPTIONAL
      CHANGING
        mapped        TYPE any OPTIONAL
        failed        TYPE any OPTIONAL
        reported      TYPE any OPTIONAL
      RAISING
        zcx_osd_rap.

* MODIFY ENTITIES ... ENTITY entity EXECUTE action FROM rows [RESULT result]
    CLASS-METHODS execute
      IMPORTING
        bdef     TYPE csequence
        entity   TYPE csequence
        action   TYPE csequence
        rows     TYPE STANDARD TABLE
      CHANGING
        result   TYPE STANDARD TABLE OPTIONAL
        mapped   TYPE any OPTIONAL
        failed   TYPE any OPTIONAL
        reported TYPE any OPTIONAL
      RAISING
        zcx_osd_rap.

* READ ENTITIES ... ENTITY entity FROM|ALL FIELDS WITH|FIELDS ( ) WITH keys
* RESULT result; FIELDS is the list comma separated, '*' for ALL FIELDS
    CLASS-METHODS read
      IMPORTING
        bdef     TYPE csequence
        entity   TYPE csequence
        keys     TYPE ANY TABLE
        fields   TYPE csequence OPTIONAL
      CHANGING
        result   TYPE STANDARD TABLE OPTIONAL
        failed   TYPE any OPTIONAL
        reported TYPE any OPTIONAL
      RAISING
        zcx_osd_rap.

* COMMIT ENTITIES [RESPONSE OF bdef FAILED failed REPORTED reported]
    CLASS-METHODS commit
      IMPORTING
        bdef     TYPE csequence OPTIONAL
      CHANGING
        failed   TYPE any OPTIONAL
        reported TYPE any OPTIONAL
      RAISING
        zcx_osd_rap.

* ROLLBACK ENTITIES
    CLASS-METHODS rollback.

  PROTECTED SECTION.
  PRIVATE SECTION.
    CLASS-METHODS response
      IMPORTING
        iv_bdef        TYPE csequence
        iv_kind        TYPE csequence
      RETURNING
        VALUE(rr_data) TYPE REF TO data
      RAISING
        zcx_osd_rap.
ENDCLASS.



CLASS kernel_rap_eml IMPLEMENTATION.

  METHOD response.
    rr_data = zcl_osd_rap_eml=>runtime( iv_bdef )->bo( )->new_response( iv_kind ).
  ENDMETHOD.

  METHOD modify.
    DATA lr_mapped   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    FIELD-SYMBOLS <ls_mapped>   TYPE any.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    IF mapped IS SUPPLIED.
      ASSIGN mapped TO <ls_mapped>.
    ELSE.
      lr_mapped = response( iv_bdef = bdef iv_kind = 'MAPPED' ).
      ASSIGN lr_mapped->* TO <ls_mapped>.
    ENDIF.
    IF failed IS SUPPLIED.
      ASSIGN failed TO <ls_failed>.
    ELSE.
      lr_failed = response( iv_bdef = bdef iv_kind = 'FAILED' ).
      ASSIGN lr_failed->* TO <ls_failed>.
    ENDIF.
    IF reported IS SUPPLIED.
      ASSIGN reported TO <ls_reported>.
    ELSE.
      lr_reported = response( iv_bdef = bdef iv_kind = 'REPORTED' ).
      ASSIGN lr_reported->* TO <ls_reported>.
    ENDIF.

    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = bdef iv_entity = entity iv_operation = operation
                                       it_rows = rows iv_fields = fields iv_set_fields = set_fields
                                       iv_auto_fill_cid = auto_fill_cid
                             CHANGING cs_mapped = <ls_mapped> cs_failed = <ls_failed> cs_reported = <ls_reported> ).
  ENDMETHOD.

  METHOD execute.
    DATA lr_result   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    FIELD-SYMBOLS <lt_result>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    IF result IS SUPPLIED.
      ASSIGN result TO <lt_result>.
    ELSE.
      lr_result = zcl_osd_rap_eml=>runtime( bdef )->bo( )->new_result( iv_entity = entity iv_action = action ).
      IF lr_result IS INITIAL.
* an action without a result: nothing is written to this
        CREATE DATA lr_result TYPE string_table.
      ENDIF.
      ASSIGN lr_result->* TO <lt_result>.
    ENDIF.
    IF failed IS SUPPLIED.
      ASSIGN failed TO <ls_failed>.
    ELSE.
      lr_failed = response( iv_bdef = bdef iv_kind = 'FAILED' ).
      ASSIGN lr_failed->* TO <ls_failed>.
    ENDIF.
    IF reported IS SUPPLIED.
      ASSIGN reported TO <ls_reported>.
    ELSE.
      lr_reported = response( iv_bdef = bdef iv_kind = 'REPORTED' ).
      ASSIGN lr_reported->* TO <ls_reported>.
    ENDIF.

    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = bdef iv_entity = entity iv_action = action it_rows = rows
                              CHANGING ct_result = <lt_result> cs_failed = <ls_failed> cs_reported = <ls_reported> ).
  ENDMETHOD.

  METHOD read.
    DATA lr_result TYPE REF TO data.
    DATA lr_failed TYPE REF TO data.
    FIELD-SYMBOLS <lt_result> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_failed> TYPE any.

    IF result IS SUPPLIED.
      ASSIGN result TO <lt_result>.
    ELSE.
      lr_result = zcl_osd_rap_eml=>runtime( bdef )->bo( )->new_rows( entity ).
      ASSIGN lr_result->* TO <lt_result>.
    ENDIF.
    IF failed IS SUPPLIED.
      ASSIGN failed TO <ls_failed>.
    ELSE.
      lr_failed = response( iv_bdef = bdef iv_kind = 'FAILED' ).
      ASSIGN lr_failed->* TO <ls_failed>.
    ENDIF.

    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = bdef iv_entity = entity it_keys = keys iv_fields = fields
                           CHANGING ct_result = <lt_result> cs_failed = <ls_failed> ).
  ENDMETHOD.

  METHOD commit.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lt_bdefs    TYPE string_table.
    DATA lv_bdef     TYPE string.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    lv_bdef = bdef.
    IF lv_bdef IS INITIAL.
* no RESPONSE OF: the responses go to the first definition of the session
      lt_bdefs = zcl_osd_rap_eml=>sessions( ).
      READ TABLE lt_bdefs INDEX 1 INTO lv_bdef.
      IF sy-subrc <> 0.
* nothing was modified: there is nothing to save, and nothing to fail
        sy-subrc = 0.
        RETURN.
      ENDIF.
    ENDIF.
    IF failed IS SUPPLIED.
      ASSIGN failed TO <ls_failed>.
    ELSE.
      lr_failed = response( iv_bdef = lv_bdef iv_kind = 'FAILED' ).
      ASSIGN lr_failed->* TO <ls_failed>.
    ENDIF.
    IF reported IS SUPPLIED.
      ASSIGN reported TO <ls_reported>.
    ELSE.
      lr_reported = response( iv_bdef = lv_bdef iv_kind = 'REPORTED' ).
      ASSIGN lr_reported->* TO <ls_reported>.
    ENDIF.

    zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = lv_bdef
                             CHANGING cs_failed = <ls_failed> cs_reported = <ls_reported> ).
  ENDMETHOD.

  METHOD rollback.
    zcl_osd_rap_eml=>rollback( ).
  ENDMETHOD.

ENDCLASS.
