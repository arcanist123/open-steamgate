CLASS kernel_rap_eml DEFINITION PUBLIC FINAL CREATE PRIVATE.
* The class the transpiler's EML lowering calls (docs/rap-eml.md), named in
* the convention of the other statement kernels (KERNEL_CALL_TRANSFORMATION,
* KERNEL_AUTHORITY_CHECK, KERNEL_SCAN_ABAP_SOURCE). A MODIFY or READ
* ENTITIES statement becomes BEGIN with the MAPPED / FAILED / REPORTED
* targets it names, then one MODIFY / EXECUTE / READ call per operation:
* BEGIN clears the named targets and binds a scratch structure of the
* behavior definition's response type for each one the statement does not
* name, so the responses are the statement's and nothing earlier, and
* SY-SUBRC after each operation is the statement's so far. A RESULT is the
* operation's own. The facade behind, ZCL_OSD_RAP_EML, holds the
* semantics; nothing here knows a BDEF.
*
* A binding lasts until the next BEGIN, COMMIT or ROLLBACK, or until the
* facade's session is reset; an operation called without one (direct use)
* gets scratch of its own.

  PUBLIC SECTION.
* the start of a MODIFY or READ ENTITIES statement
    CLASS-METHODS begin
      IMPORTING
        bdef     TYPE csequence
      CHANGING
        mapped   TYPE any OPTIONAL
        failed   TYPE any OPTIONAL
        reported TYPE any OPTIONAL
      RAISING
        zcx_osd_rap.

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
      RAISING
        zcx_osd_rap.

* MODIFY ENTITIES ... ENTITY entity EXECUTE action FROM rows [RESULT result]
    CLASS-METHODS execute
      IMPORTING
        bdef   TYPE csequence
        entity TYPE csequence
        action TYPE csequence
        rows   TYPE STANDARD TABLE
      CHANGING
        result TYPE STANDARD TABLE OPTIONAL
      RAISING
        zcx_osd_rap.

* READ ENTITIES ... ENTITY entity FROM|ALL FIELDS WITH|FIELDS ( ) WITH keys
* RESULT result; FIELDS is the list comma separated, '*' for ALL FIELDS
    CLASS-METHODS read
      IMPORTING
        bdef   TYPE csequence
        entity TYPE csequence
        keys   TYPE ANY TABLE
        fields TYPE csequence OPTIONAL
      CHANGING
        result TYPE STANDARD TABLE OPTIONAL
      RAISING
        zcx_osd_rap.

* COMMIT ENTITIES [RESPONSE OF bdef FAILED failed REPORTED reported]; the
* targets are the statement's: cleared first
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
* the open statement: the session's runtime it was begun for, and its
* three response structures (the caller's or scratch)
    CLASS-DATA go_runtime  TYPE REF TO zcl_osd_rap_runtime.
    CLASS-DATA gr_mapped   TYPE REF TO data.
    CLASS-DATA gr_failed   TYPE REF TO data.
    CLASS-DATA gr_reported TYPE REF TO data.

    CLASS-METHODS response
      IMPORTING
        iv_bdef        TYPE csequence
        iv_kind        TYPE csequence
      RETURNING
        VALUE(rr_data) TYPE REF TO data
      RAISING
        zcx_osd_rap.

* the statement's structure of a kind when one is open for this behavior
* definition, else scratch
    CLASS-METHODS target
      IMPORTING
        iv_bdef        TYPE csequence
        iv_kind        TYPE csequence
      RETURNING
        VALUE(rr_data) TYPE REF TO data
      RAISING
        zcx_osd_rap.

    CLASS-METHODS subrc
      IMPORTING
        ir_failed TYPE REF TO data.
ENDCLASS.



CLASS kernel_rap_eml IMPLEMENTATION.

  METHOD response.
    rr_data = zcl_osd_rap_eml=>runtime( iv_bdef )->bo( )->new_response( iv_kind ).
  ENDMETHOD.

  METHOD begin.
    go_runtime = zcl_osd_rap_eml=>runtime( bdef ).
    CLEAR: gr_mapped, gr_failed, gr_reported.
    IF mapped IS SUPPLIED.
      CLEAR mapped.
      GET REFERENCE OF mapped INTO gr_mapped.
    ELSE.
      gr_mapped = response( iv_bdef = bdef iv_kind = 'MAPPED' ).
    ENDIF.
    IF failed IS SUPPLIED.
      CLEAR failed.
      GET REFERENCE OF failed INTO gr_failed.
    ELSE.
      gr_failed = response( iv_bdef = bdef iv_kind = 'FAILED' ).
    ENDIF.
    IF reported IS SUPPLIED.
      CLEAR reported.
      GET REFERENCE OF reported INTO gr_reported.
    ELSE.
      gr_reported = response( iv_bdef = bdef iv_kind = 'REPORTED' ).
    ENDIF.
  ENDMETHOD.

  METHOD target.
    IF go_runtime IS NOT INITIAL AND go_runtime = zcl_osd_rap_eml=>runtime( iv_bdef ).
      CASE iv_kind.
        WHEN 'MAPPED'.
          rr_data = gr_mapped.
        WHEN 'FAILED'.
          rr_data = gr_failed.
        WHEN 'REPORTED'.
          rr_data = gr_reported.
      ENDCASE.
    ENDIF.
    IF rr_data IS INITIAL.
      rr_data = response( iv_bdef = iv_bdef iv_kind = iv_kind ).
    ENDIF.
  ENDMETHOD.

  METHOD subrc.
* the statement's: its FAILED started empty at BEGIN
    FIELD-SYMBOLS <ls_failed> TYPE any.
    ASSIGN ir_failed->* TO <ls_failed>.
    IF zcl_osd_rap_eml=>count_rows( <ls_failed> ) > 0.
      sy-subrc = 4.
    ELSE.
      sy-subrc = 0.
    ENDIF.
  ENDMETHOD.

  METHOD modify.
    DATA lr_mapped   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    FIELD-SYMBOLS <ls_mapped>   TYPE any.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    lr_mapped = target( iv_bdef = bdef iv_kind = 'MAPPED' ).
    lr_failed = target( iv_bdef = bdef iv_kind = 'FAILED' ).
    lr_reported = target( iv_bdef = bdef iv_kind = 'REPORTED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.

    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = bdef iv_entity = entity iv_operation = operation
                                       it_rows = rows iv_fields = fields iv_set_fields = set_fields
                                       iv_auto_fill_cid = auto_fill_cid
                             CHANGING cs_mapped = <ls_mapped> cs_failed = <ls_failed> cs_reported = <ls_reported> ).
    subrc( lr_failed ).
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
    lr_failed = target( iv_bdef = bdef iv_kind = 'FAILED' ).
    lr_reported = target( iv_bdef = bdef iv_kind = 'REPORTED' ).
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.

    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = bdef iv_entity = entity iv_action = action it_rows = rows
                              CHANGING ct_result = <lt_result> cs_failed = <ls_failed> cs_reported = <ls_reported> ).
    subrc( lr_failed ).
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
    lr_failed = target( iv_bdef = bdef iv_kind = 'FAILED' ).
    ASSIGN lr_failed->* TO <ls_failed>.

    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = bdef iv_entity = entity it_keys = keys iv_fields = fields
                           CHANGING ct_result = <lt_result> cs_failed = <ls_failed> ).
    subrc( lr_failed ).
  ENDMETHOD.

  METHOD commit.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lt_bdefs    TYPE string_table.
    DATA lv_bdef     TYPE string.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    CLEAR go_runtime.
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
      CLEAR failed.
      ASSIGN failed TO <ls_failed>.
    ELSE.
      lr_failed = response( iv_bdef = lv_bdef iv_kind = 'FAILED' ).
      ASSIGN lr_failed->* TO <ls_failed>.
    ENDIF.
    IF reported IS SUPPLIED.
      CLEAR reported.
      ASSIGN reported TO <ls_reported>.
    ELSE.
      lr_reported = response( iv_bdef = lv_bdef iv_kind = 'REPORTED' ).
      ASSIGN lr_reported->* TO <ls_reported>.
    ENDIF.

    zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = lv_bdef
                             CHANGING cs_failed = <ls_failed> cs_reported = <ls_reported> ).
  ENDMETHOD.

  METHOD rollback.
    CLEAR go_runtime.
    zcl_osd_rap_eml=>rollback( ).
  ENDMETHOD.

ENDCLASS.
