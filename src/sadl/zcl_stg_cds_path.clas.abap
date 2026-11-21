CLASS zcl_stg_cds_path DEFINITION PUBLIC FINAL CREATE PUBLIC.
* R10 (docs/rap-runtime.md, "Path elements"): what the path classes
* tools/cds2ddic.mjs generates ask about a row. A row of a draft-enabled
* entity's union says which version it is (ISACTIVEENTITY); the first hop of
* a draft's path element reads the draft of its target when the target is an
* entity of a draft-enabled business object, so a draft shows its own text.
* The RAP side is asked by name (ZCL_OSD_RAP_DRAFT), so a tree without the
* RAP runtime still compiles and reads the active rows.
  PUBLIC SECTION.
    CLASS-METHODS is_draft
      IMPORTING
        is_row       TYPE any
      RETURNING
        VALUE(rv_on) TYPE abap_bool.

    CLASS-METHODS draft_table
      IMPORTING
        iv_entity       TYPE csequence
        iv_default      TYPE csequence
      RETURNING
        VALUE(rv_table) TYPE string.
ENDCLASS.

CLASS zcl_stg_cds_path IMPLEMENTATION.

  METHOD is_draft.
    FIELD-SYMBOLS <lv_active> TYPE any.
    ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE is_row TO <lv_active>.
    IF sy-subrc = 0 AND <lv_active> IS INITIAL.
      rv_on = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD draft_table.
    DATA lv_class  TYPE string.
    DATA lv_method TYPE string.
    DATA lv_entity TYPE string.

    rv_table = iv_default.
    lv_class = 'ZCL_OSD_RAP_DRAFT'.
    lv_method = 'DRAFT_TABLE_OF'.
    lv_entity = iv_entity.
    TRY.
        CALL METHOD (lv_class)=>(lv_method)
          EXPORTING
            iv_entity = lv_entity
          RECEIVING
            rv_table  = rv_table.
      CATCH cx_root.
        rv_table = iv_default.
    ENDTRY.
    IF rv_table IS INITIAL.
      rv_table = iv_default.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
