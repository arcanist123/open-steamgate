CLASS zcl_osd_rap_eml DEFINITION PUBLIC FINAL CREATE PRIVATE.
* The EML statements over the managed runtime (docs/rap-eml.md):
*
*   MODIFY ENTITIES OF bdef ENTITY e CREATE|UPDATE|DELETE FROM t
*     [FIELDS ( f ) WITH t | SET FIELDS WITH t] [AUTO FILL CID]
*     EXECUTE a FROM t [RESULT r] MAPPED m FAILED f REPORTED r   -> modify, execute
*   READ ENTITIES OF bdef ENTITY e FROM|ALL FIELDS WITH|FIELDS ( f ) WITH t
*     RESULT r FAILED f REPORTED r                                 -> read
*   COMMIT ENTITIES [RESPONSE OF bdef FAILED f REPORTED r]        -> commit
*   ROLLBACK ENTITIES                                             -> rollback
*
* One ZCL_OSD_RAP_RUNTIME per behavior definition for the session, created
* on first use and kept until COMMIT or ROLLBACK ENTITIES has run over all
* of them: that is the transactional buffer the statements share. Every
* method here is static, so the transpiler's lowering (KERNEL_RAP_EML) and
* an ABAP caller without EML syntax (the tests) reach the same code.
*
* SY-SUBRC: after COMMIT it is 0 when every save succeeded and 4 when one
* did not (the public contract). After MODIFY and READ it is 0 when the
* statement added nothing to FAILED and 4 when it did: that is an OSG
* convention, not something the public documentation establishes; a caller
* that wants to be portable reads FAILED.

  PUBLIC SECTION.
    CONSTANTS co_all_fields TYPE string VALUE '*'.
* the namespace of the %cid AUTO FILL CID draws; a caller's %cid may not
* use it, so the two cannot collide
    CONSTANTS co_auto_cid TYPE string VALUE '%AUTO-'.

* the session's runtime of a behavior definition (created on first use);
* inside a handler, the runtime that called it (ZCL_OSD_RAP_RUNTIME=>ACTIVE)
    CLASS-METHODS runtime
      IMPORTING
        iv_bdef           TYPE csequence
      RETURNING
        VALUE(ro_runtime) TYPE REF TO zcl_osd_rap_runtime
      RAISING
        zcx_osd_rap.

* CREATE, UPDATE or DELETE (IV_OPERATION: the keyword, or C/U/D). IT_ROWS
* is the FROM or WITH table. IV_FIELDS is the FIELDS ( ... ) list, comma
* separated: %control of every row is set to exactly these. IV_SET_FIELDS
* is SET FIELDS WITH: %control set from the fields that are not initial.
* IV_AUTO_FILL_CID gives a row without a %cid one.
    CLASS-METHODS modify
      IMPORTING
        iv_bdef          TYPE csequence
        iv_entity        TYPE csequence
        iv_operation     TYPE csequence
        it_rows          TYPE ANY TABLE
        iv_fields        TYPE csequence OPTIONAL
        iv_set_fields    TYPE abap_bool DEFAULT abap_false
        iv_auto_fill_cid TYPE abap_bool DEFAULT abap_false
      CHANGING
        cs_mapped        TYPE any
        cs_failed        TYPE any
        cs_reported      TYPE any
      RAISING
        zcx_osd_rap.

* EXECUTE action FROM rows [RESULT result]; CS_MAPPED gets the instances a
* factory action creates (R6)
    CLASS-METHODS execute
      IMPORTING
        iv_bdef     TYPE csequence
        iv_entity   TYPE csequence
        iv_action   TYPE csequence
        it_rows     TYPE STANDARD TABLE
      CHANGING
        ct_result   TYPE STANDARD TABLE
        cs_failed   TYPE any
        cs_reported TYPE any
        cs_mapped   TYPE any OPTIONAL
      RAISING
        zcx_osd_rap.

* READ. IV_FIELDS: the FIELDS ( ... ) list, CO_ALL_FIELDS for ALL FIELDS
* WITH, initial for FROM; fields not read are initial in the result
    CLASS-METHODS read
      IMPORTING
        iv_bdef   TYPE csequence
        iv_entity TYPE csequence
        it_keys   TYPE ANY TABLE
        iv_fields TYPE csequence OPTIONAL
      CHANGING
        ct_result TYPE STANDARD TABLE
        cs_failed TYPE any
      RAISING
        zcx_osd_rap.

* R5: MODIFY ENTITIES ... ENTITY e CREATE BY \_assoc FROM rows (a TABLE FOR
* CREATE e\_assoc); IV_FIELDS / IV_SET_FIELDS / IV_AUTO_FILL_CID act on the
* %target rows, as on a system
    CLASS-METHODS create_by
      IMPORTING
        iv_bdef          TYPE csequence
        iv_entity        TYPE csequence
        iv_assoc         TYPE csequence
        it_rows          TYPE STANDARD TABLE
        iv_fields        TYPE csequence OPTIONAL
        iv_set_fields    TYPE abap_bool DEFAULT abap_false
        iv_auto_fill_cid TYPE abap_bool DEFAULT abap_false
      CHANGING
        cs_mapped        TYPE any
        cs_failed        TYPE any
        cs_reported      TYPE any
      RAISING
        zcx_osd_rap.

* R5: READ ENTITIES ... ENTITY e BY \_assoc FROM keys RESULT result LINK link
    CLASS-METHODS read_by
      IMPORTING
        iv_bdef   TYPE csequence
        iv_entity TYPE csequence
        iv_assoc  TYPE csequence
        it_keys   TYPE ANY TABLE
      CHANGING
        ct_result TYPE STANDARD TABLE
        ct_link   TYPE STANDARD TABLE
        cs_failed TYPE any
      RAISING
        zcx_osd_rap.

* COMMIT ENTITIES: the save sequence of every runtime of the session.
* IV_BDEF names the behavior definition whose FAILED and REPORTED the
* caller wants (RESPONSE OF); EV_SAVED is false when any save failed, and
* then the buffers are kept, as the runtime keeps them.
    CLASS-METHODS commit
      IMPORTING
        iv_bdef     TYPE csequence OPTIONAL
      EXPORTING
        ev_saved    TYPE abap_bool
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* ROLLBACK ENTITIES: every runtime forgets its buffer, and when the
* transaction held modifications the LUW is rolled back with it
* (ROLLBACK WORK), so SQL written beside the RAP changes goes too
    CLASS-METHODS rollback.

* forget the runtimes themselves (a new session)
    CLASS-METHODS reset.

* the behavior definitions that have a runtime, in order of first use
    CLASS-METHODS sessions
      RETURNING
        VALUE(rt_bdefs) TYPE string_table.

* how many rows the tables of a response structure hold
    CLASS-METHODS count_rows
      IMPORTING
        is_response     TYPE any
      RETURNING
        VALUE(rv_count) TYPE i.

  PROTECTED SECTION.
  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_session,
        bdef    TYPE string,
        runtime TYPE REF TO zcl_osd_rap_runtime,
      END OF ty_session.

    CLASS-DATA gt_sessions TYPE STANDARD TABLE OF ty_session WITH DEFAULT KEY.
    CLASS-DATA gv_cid TYPE i.

    CLASS-METHODS operation_of
      IMPORTING
        iv_operation        TYPE csequence
      RETURNING
        VALUE(rv_operation) TYPE zcl_osd_rap_runtime=>ty_operation
      RAISING
        zcx_osd_rap.

    CLASS-METHODS field_list
      IMPORTING
        iv_fields        TYPE csequence
      RETURNING
        VALUE(rt_fields) TYPE string_table.

    CLASS-METHODS prepare_rows
      IMPORTING
        iv_fields        TYPE csequence
        iv_set_fields    TYPE abap_bool
        iv_auto_fill_cid TYPE abap_bool
      CHANGING
        ct_rows          TYPE ANY TABLE
      RAISING
        zcx_osd_rap.

    CLASS-METHODS set_control
      IMPORTING
        it_fields     TYPE string_table
        iv_set_fields TYPE abap_bool
        is_row        TYPE any
      CHANGING
        cs_control    TYPE any
      RAISING
        zcx_osd_rap.

    CLASS-METHODS project
      IMPORTING
        io_runtime TYPE REF TO zcl_osd_rap_runtime
        iv_entity  TYPE csequence
        iv_fields  TYPE csequence
      CHANGING
        ct_result  TYPE STANDARD TABLE
      RAISING
        zcx_osd_rap.

    CLASS-METHODS subrc
      IMPORTING
        is_failed TYPE any
        iv_before TYPE i.

    CLASS-METHODS auto_cid
      RETURNING
        VALUE(rv_cid) TYPE string
      RAISING
        zcx_osd_rap.

    CLASS-METHODS check_fields
      IMPORTING
        io_runtime TYPE REF TO zcl_osd_rap_runtime
        iv_entity  TYPE csequence
        it_fields  TYPE string_table
      RAISING
        zcx_osd_rap.

* R11: a statement over an interface (or projection) BDEF runs on its base
* (docs/rap-runtime.md, "Interface BDEFs"): EV_BDEF and EV_ENTITY are the
* base's, IV_USE (C U D: the operation, A: the action IV_NAME, B: create by
* the association IV_NAME, L: read by it, R: read) must be one the BDEF
* uses. A BDEF with an adapter of its own is returned as it is
    CLASS-METHODS route
      IMPORTING
        iv_bdef   TYPE csequence
        iv_entity TYPE csequence OPTIONAL
        iv_use    TYPE c OPTIONAL
        iv_name   TYPE csequence OPTIONAL
      EXPORTING
        ev_bdef   TYPE string
        ev_entity TYPE string
      RAISING
        zcx_osd_rap.
ENDCLASS.



CLASS zcl_osd_rap_eml IMPLEMENTATION.

  METHOD runtime.
    DATA ls_session TYPE ty_session.
    DATA lv_bdef    TYPE string.

    lv_bdef = to_upper( iv_bdef ).
* EML inside a handler goes to the transaction that called the handler
    ro_runtime = zcl_osd_rap_runtime=>active( lv_bdef ).
    IF ro_runtime IS BOUND.
      RETURN.
    ENDIF.
    READ TABLE gt_sessions INTO ls_session WITH KEY bdef = lv_bdef.
    IF sy-subrc <> 0.
      ls_session-bdef = lv_bdef.
      ls_session-runtime = zcl_osd_rap_runtime=>for_bdef( lv_bdef ).
      APPEND ls_session TO gt_sessions.
    ENDIF.
    ro_runtime = ls_session-runtime.
  ENDMETHOD.

  METHOD sessions.
    DATA ls_session TYPE ty_session.
    LOOP AT gt_sessions INTO ls_session.
      APPEND ls_session-bdef TO rt_bdefs.
    ENDLOOP.
  ENDMETHOD.

  METHOD reset.
    CLEAR: gt_sessions, gv_cid.
  ENDMETHOD.

  METHOD operation_of.
    CASE to_upper( iv_operation ).
      WHEN 'CREATE' OR 'C'.
        rv_operation = zcl_osd_rap_runtime=>co_operation-create.
      WHEN 'UPDATE' OR 'U'.
        rv_operation = zcl_osd_rap_runtime=>co_operation-update.
      WHEN 'DELETE' OR 'D'.
        rv_operation = zcl_osd_rap_runtime=>co_operation-delete.
      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML: no operation { iv_operation }|.
    ENDCASE.
  ENDMETHOD.

  METHOD field_list.
    DATA lv_fields TYPE string.
    lv_fields = to_upper( iv_fields ).
    CONDENSE lv_fields NO-GAPS.
    SPLIT lv_fields AT ',' INTO TABLE rt_fields.
    DELETE rt_fields WHERE table_line IS INITIAL.
  ENDMETHOD.

  METHOD modify.
    DATA lv_bdef    TYPE string.
    DATA lv_entity  TYPE string.
    DATA lo_runtime   TYPE REF TO zcl_osd_rap_runtime.
    DATA lv_operation TYPE zcl_osd_rap_runtime=>ty_operation.
    DATA lr_rows      TYPE REF TO data.
    DATA lv_before    TYPE i.
    FIELD-SYMBOLS <lt_rows> TYPE ANY TABLE.

    route( EXPORTING iv_bdef = iv_bdef iv_entity = iv_entity iv_use = operation_of( iv_operation )
           IMPORTING ev_bdef = lv_bdef ev_entity = lv_entity ).
    lo_runtime = runtime( lv_bdef ).
    lv_operation = operation_of( iv_operation ).
    lv_before = count_rows( cs_failed ).

* the statement's additions change the rows, the caller's table stays
    CREATE DATA lr_rows LIKE it_rows.
    ASSIGN lr_rows->* TO <lt_rows>.
    <lt_rows> = it_rows.
    prepare_rows( EXPORTING iv_fields = iv_fields iv_set_fields = iv_set_fields
                            iv_auto_fill_cid = iv_auto_fill_cid
                  CHANGING ct_rows = <lt_rows> ).

    lo_runtime->modify( EXPORTING iv_entity = lv_entity iv_operation = lv_operation it_rows = <lt_rows>
                        CHANGING cs_mapped = cs_mapped cs_failed = cs_failed cs_reported = cs_reported ).
    subrc( is_failed = cs_failed iv_before = lv_before ).
  ENDMETHOD.

  METHOD create_by.
    DATA lv_bdef    TYPE string.
    DATA lv_entity  TYPE string.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA lr_rows    TYPE REF TO data.
    DATA lv_before  TYPE i.
    FIELD-SYMBOLS <lt_rows>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <lt_target> TYPE STANDARD TABLE.

    route( EXPORTING iv_bdef = iv_bdef iv_entity = iv_entity iv_use = 'B' iv_name = iv_assoc
           IMPORTING ev_bdef = lv_bdef ev_entity = lv_entity ).
    lo_runtime = runtime( lv_bdef ).
    lv_before = count_rows( cs_failed ).
    CREATE DATA lr_rows LIKE it_rows.
    ASSIGN lr_rows->* TO <lt_rows>.
    <lt_rows> = it_rows.
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      ASSIGN COMPONENT '%TARGET' OF STRUCTURE <ls_row> TO <lt_target>.
      IF sy-subrc = 0.
        prepare_rows( EXPORTING iv_fields = iv_fields iv_set_fields = iv_set_fields
                                iv_auto_fill_cid = iv_auto_fill_cid
                      CHANGING ct_rows = <lt_target> ).
      ENDIF.
    ENDLOOP.
    lo_runtime->create_by( EXPORTING iv_entity = lv_entity iv_assoc = iv_assoc it_rows = <lt_rows>
                           CHANGING cs_mapped = cs_mapped cs_failed = cs_failed cs_reported = cs_reported ).
    subrc( is_failed = cs_failed iv_before = lv_before ).
  ENDMETHOD.

  METHOD read_by.
    DATA lv_bdef    TYPE string.
    DATA lv_entity  TYPE string.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA lv_before  TYPE i.

    route( EXPORTING iv_bdef = iv_bdef iv_entity = iv_entity iv_use = 'L' iv_name = iv_assoc
           IMPORTING ev_bdef = lv_bdef ev_entity = lv_entity ).
    lo_runtime = runtime( lv_bdef ).
    lv_before = count_rows( cs_failed ).
    CLEAR: ct_result, ct_link.
    lo_runtime->read_by( EXPORTING iv_entity = lv_entity iv_assoc = iv_assoc it_keys = it_keys
                         CHANGING ct_result = ct_result ct_link = ct_link cs_failed = cs_failed ).
    subrc( is_failed = cs_failed iv_before = lv_before ).
  ENDMETHOD.

  METHOD prepare_rows.
    DATA lt_fields TYPE string_table.
    DATA lv_cid    TYPE string.
    DATA lv_prefix TYPE string.
    FIELD-SYMBOLS <ls_row>     TYPE any.
    FIELD-SYMBOLS <ls_control> TYPE any.
    FIELD-SYMBOLS <lv_cid>     TYPE any.

    lt_fields = field_list( iv_fields ).
    LOOP AT ct_rows ASSIGNING <ls_row>.
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_row> TO <lv_cid>.
      IF sy-subrc = 0.
        lv_cid = <lv_cid>.
        CLEAR lv_prefix.
        IF strlen( lv_cid ) >= 6.
          lv_prefix = lv_cid(6).
        ENDIF.
        IF lv_cid IS INITIAL AND iv_auto_fill_cid = abap_true.
          <lv_cid> = auto_cid( ).
        ELSEIF to_upper( lv_prefix ) = co_auto_cid.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML: %cid { lv_cid } is in the reserved namespace { co_auto_cid }|.
        ENDIF.
      ENDIF.
      IF lines( lt_fields ) > 0 OR iv_set_fields = abap_true.
        ASSIGN COMPONENT '%CONTROL' OF STRUCTURE <ls_row> TO <ls_control>.
        IF sy-subrc = 0.
          set_control( EXPORTING it_fields = lt_fields iv_set_fields = iv_set_fields is_row = <ls_row>
                       CHANGING cs_control = <ls_control> ).
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD auto_cid.
* a UUID under the reserved prefix: unique, and never a caller's
    DATA lv_x16 TYPE x LENGTH 16.
    TRY.
        lv_x16 = cl_system_uuid=>create_uuid_x16_static( ).
      CATCH cx_uuid_error.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML: no UUID for AUTO FILL CID|.
    ENDTRY.
    gv_cid = gv_cid + 1.
    rv_cid = |{ co_auto_cid }{ lv_x16 }|.
  ENDMETHOD.

  METHOD check_fields.
* FIELDS ( ... ) of a READ: every name is a field of the entity
    DATA ls_model  TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_entity TYPE string.
    DATA lv_field  TYPE string.

    ls_model = io_runtime->bo( )->model( ).
    lv_entity = to_upper( iv_entity ).
    LOOP AT ls_model-entities INTO ls_entity.
      CHECK ls_entity-name = lv_entity OR to_upper( ls_entity-alias ) = lv_entity.
      LOOP AT it_fields INTO lv_field.
        READ TABLE ls_entity-fields TRANSPORTING NO FIELDS WITH KEY name = lv_field.
        IF sy-subrc <> 0.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML: FIELDS names no field { lv_field } of { ls_entity-alias }|.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD set_control.
    DATA lo_struct TYPE REF TO cl_abap_structdescr.
    DATA ls_comp   TYPE abap_compdescr.
    DATA lv_field  TYPE string.
    FIELD-SYMBOLS <lv_flag>  TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    CLEAR cs_control.
    LOOP AT it_fields INTO lv_field.
      ASSIGN COMPONENT lv_field OF STRUCTURE cs_control TO <lv_flag>.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML: FIELDS names no field { lv_field }|.
      ENDIF.
      <lv_flag> = if_abap_behv=>mk-on.
    ENDLOOP.

    IF iv_set_fields = abap_true.
* SET FIELDS WITH: a field is to be set when the row gives it a value
      lo_struct ?= cl_abap_typedescr=>describe_by_data( cs_control ).
      LOOP AT lo_struct->components INTO ls_comp.
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE is_row TO <lv_value>.
        CHECK sy-subrc = 0 AND <lv_value> IS NOT INITIAL.
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE cs_control TO <lv_flag>.
        CHECK sy-subrc = 0.
        <lv_flag> = if_abap_behv=>mk-on.
      ENDLOOP.
    ENDIF.
  ENDMETHOD.

  METHOD execute.
    DATA lv_bdef    TYPE string.
    DATA lv_entity  TYPE string.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA lv_before  TYPE i.

    route( EXPORTING iv_bdef = iv_bdef iv_entity = iv_entity iv_use = 'A' iv_name = iv_action
           IMPORTING ev_bdef = lv_bdef ev_entity = lv_entity ).
    lo_runtime = runtime( lv_bdef ).
    lv_before = count_rows( cs_failed ).
    CLEAR ct_result.
    IF cs_mapped IS SUPPLIED.
      lo_runtime->execute( EXPORTING iv_entity = lv_entity iv_action = iv_action it_keys = it_rows
                           CHANGING ct_result = ct_result cs_failed = cs_failed cs_reported = cs_reported
                                    cs_mapped = cs_mapped ).
    ELSE.
      lo_runtime->execute( EXPORTING iv_entity = lv_entity iv_action = iv_action it_keys = it_rows
                           CHANGING ct_result = ct_result cs_failed = cs_failed cs_reported = cs_reported ).
    ENDIF.
    subrc( is_failed = cs_failed iv_before = lv_before ).
  ENDMETHOD.

  METHOD read.
    DATA lv_bdef    TYPE string.
    DATA lv_entity  TYPE string.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA lv_before  TYPE i.

    route( EXPORTING iv_bdef = iv_bdef iv_entity = iv_entity iv_use = 'R'
           IMPORTING ev_bdef = lv_bdef ev_entity = lv_entity ).
    lo_runtime = runtime( lv_bdef ).
    lv_before = count_rows( cs_failed ).
    IF iv_fields IS NOT INITIAL AND iv_fields <> co_all_fields.
      check_fields( io_runtime = lo_runtime iv_entity = lv_entity it_fields = field_list( iv_fields ) ).
    ENDIF.
    CLEAR ct_result.
    lo_runtime->read( EXPORTING iv_entity = lv_entity it_keys = it_keys
                      CHANGING ct_result = ct_result cs_failed = cs_failed ).
    IF iv_fields IS NOT INITIAL AND iv_fields <> co_all_fields.
      project( EXPORTING io_runtime = lo_runtime iv_entity = lv_entity iv_fields = iv_fields
               CHANGING ct_result = ct_result ).
    ENDIF.
    subrc( is_failed = cs_failed iv_before = lv_before ).
  ENDMETHOD.

  METHOD project.
* FIELDS ( ... ): what was not asked for is initial, the keys stay
    DATA ls_model  TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field  TYPE zif_osd_rap_bo=>ty_field.
    DATA lt_keep   TYPE string_table.
    DATA lv_entity TYPE string.
    DATA lo_struct TYPE REF TO cl_abap_structdescr.
    DATA ls_comp   TYPE abap_compdescr.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    lt_keep = field_list( iv_fields ).
    ls_model = io_runtime->bo( )->model( ).
    lv_entity = to_upper( iv_entity ).
    LOOP AT ls_model-entities INTO ls_entity.
      CHECK ls_entity-name = lv_entity OR to_upper( ls_entity-alias ) = lv_entity.
      LOOP AT ls_entity-fields INTO ls_field WHERE key = abap_true.
        APPEND ls_field-name TO lt_keep.
      ENDLOOP.
    ENDLOOP.

    LOOP AT ct_result ASSIGNING <ls_row>.
      IF lo_struct IS INITIAL.
        lo_struct ?= cl_abap_typedescr=>describe_by_data( <ls_row> ).
      ENDIF.
      LOOP AT lo_struct->components INTO ls_comp.
        CHECK ls_comp-name(1) <> '%'.
        READ TABLE lt_keep TRANSPORTING NO FIELDS WITH KEY table_line = ls_comp-name.
        CHECK sy-subrc <> 0.
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE <ls_row> TO <lv_value>.
        CHECK sy-subrc = 0.
        CLEAR <lv_value>.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD commit.
    DATA ls_session TYPE ty_session.
    DATA lv_saved   TYPE abap_bool.
    DATA lv_bdef    TYPE string.
    DATA lr_failed  TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lv_before  TYPE i.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

* R11: RESPONSE OF an interface BDEF is its base's session
    route( EXPORTING iv_bdef = iv_bdef IMPORTING ev_bdef = lv_bdef ).
    lv_before = count_rows( cs_failed ).
    ev_saved = abap_true.
    LOOP AT gt_sessions INTO ls_session.
      IF ls_session-bdef = lv_bdef OR ( lv_bdef IS INITIAL AND lines( gt_sessions ) = 1 ).
* RESPONSE OF this definition, or the only one there is: the caller's
        ASSIGN cs_failed TO <ls_failed>.
        ASSIGN cs_reported TO <ls_reported>.
      ELSE.
        lr_failed = ls_session-runtime->bo( )->new_response( 'FAILED' ).
        lr_reported = ls_session-runtime->bo( )->new_response( 'REPORTED' ).
        ASSIGN lr_failed->* TO <ls_failed>.
        ASSIGN lr_reported->* TO <ls_reported>.
      ENDIF.
      ls_session-runtime->commit( IMPORTING ev_saved = lv_saved
                                  CHANGING cs_failed = <ls_failed> cs_reported = <ls_reported> ).
      IF lv_saved = abap_false.
        ev_saved = abap_false.
      ENDIF.
    ENDLOOP.
    IF ev_saved = abap_true.
      sy-subrc = 0.
    ELSE.
      sy-subrc = 4.
    ENDIF.
  ENDMETHOD.

  METHOD rollback.
    DATA ls_session TYPE ty_session.
    DATA lv_pending TYPE i.
    LOOP AT gt_sessions INTO ls_session.
      lv_pending = lv_pending + ls_session-runtime->pending( ).
      ls_session-runtime->rollback( ).
    ENDLOOP.
* as on a system: a transaction with modifications ends in ROLLBACK WORK,
* which takes what was written to the database beside them
    IF lv_pending > 0.
      ROLLBACK WORK.
    ENDIF.
  ENDMETHOD.

  METHOD count_rows.
    DATA lo_type TYPE REF TO cl_abap_typedescr.
    FIELD-SYMBOLS <lv_comp>  TYPE any.
    FIELD-SYMBOLS <lt_table> TYPE ANY TABLE.

    DO.
      ASSIGN COMPONENT sy-index OF STRUCTURE is_response TO <lv_comp>.
      IF sy-subrc <> 0.
        EXIT.
      ENDIF.
      lo_type = cl_abap_typedescr=>describe_by_data( <lv_comp> ).
      IF lo_type->kind = cl_abap_typedescr=>kind_table.
        ASSIGN <lv_comp> TO <lt_table>.
        rv_count = rv_count + lines( <lt_table> ).
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD subrc.
    IF count_rows( is_failed ) > iv_before.
      sy-subrc = 4.
    ELSE.
      sy-subrc = 0.
    ENDIF.
  ENDMETHOD.

  METHOD route.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    DATA lt_proj     TYPE zif_osd_rap_registry=>tt_projection.
    DATA ls_proj     TYPE zif_osd_rap_registry=>ty_projection.
    DATA ls_map      TYPE zif_osd_rap_registry=>ty_map.
    DATA ls_model    TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_class    TYPE string.
    DATA lv_name     TYPE string.
    DATA lv_found    TYPE abap_bool.
    DATA lv_used     TYPE abap_bool.

    ev_bdef = to_upper( iv_bdef ).
    ev_entity = iv_entity.
    lv_class = 'ZCL_OSD_RAP_REGISTRY'.
    TRY.
        CREATE OBJECT li_registry TYPE (lv_class).
      CATCH cx_sy_create_object_error.
        RETURN.
    ENDTRY.
    IF li_registry->get( ev_bdef ) IS BOUND.
      RETURN.
    ENDIF.
    lt_proj = li_registry->projections( ev_bdef ).
    IF lt_proj IS INITIAL.
* no such definition: RUNTIME( ) says so
      RETURN.
    ENDIF.
    READ TABLE lt_proj INDEX 1 INTO ls_proj.
    ev_bdef = ls_proj-base_bdef.
    IF iv_entity IS INITIAL.
      RETURN.
    ENDIF.

    lv_name = to_upper( iv_entity ).
    LOOP AT lt_proj INTO ls_proj.
      IF ls_proj-entity = lv_name OR to_upper( ls_proj-alias ) = lv_name.
        lv_found = abap_true.
        EXIT.
      ENDIF.
    ENDLOOP.
    IF lv_found = abap_false.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML: { iv_entity } is no entity of { iv_bdef }|.
    ENDIF.
* the rows and the responses go to the base by component name: an element
* the BDEF renames, a response alias that differs from the base's, or an
* augment (its pool's, which EML here does not call) is refused rather than
* mapped wrongly
    LOOP AT ls_proj-fields INTO ls_map.
      IF ls_map-name <> ls_map-base.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML on { iv_bdef }: { ls_proj-alias } renames { ls_map-base } to { ls_map-name } (outside R11)|.
      ENDIF.
    ENDLOOP.
    IF ls_proj-augment IS NOT INITIAL.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML on { iv_bdef }: { ls_proj-alias } has an augment (outside R11)|.
    ENDIF.
    ls_model = runtime( ev_bdef )->bo( )->model( ).
    READ TABLE ls_model-entities INTO ls_entity WITH KEY name = ls_proj-base_entity.
    IF sy-subrc <> 0 OR to_upper( ls_entity-alias ) <> to_upper( ls_proj-alias ).
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |EML on { iv_bdef }: { ls_proj-alias } is { ls_entity-alias } in { ev_bdef } (outside R11)|.
    ENDIF.
    ev_entity = ls_proj-base_entity.

    lv_name = to_upper( iv_name ).
    CASE iv_use.
      WHEN 'C'.
        lv_used = ls_proj-create.
      WHEN 'U'.
        lv_used = ls_proj-update.
      WHEN 'D'.
        lv_used = ls_proj-delete.
      WHEN 'A'.
        READ TABLE ls_proj-actions TRANSPORTING NO FIELDS WITH KEY table_line = lv_name.
        lv_used = boolc( sy-subrc = 0 ).
      WHEN 'B'.
        READ TABLE ls_proj-creates TRANSPORTING NO FIELDS WITH KEY table_line = lv_name.
        lv_used = boolc( sy-subrc = 0 ).
      WHEN 'L'.
        READ TABLE ls_proj-assocs TRANSPORTING NO FIELDS WITH KEY table_line = lv_name.
        lv_used = boolc( sy-subrc = 0 ).
      WHEN OTHERS.
        lv_used = abap_true.
    ENDCASE.
    IF lv_used = abap_false.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ iv_bdef } does not use { iv_use } { iv_name } of { ls_proj-alias }|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
