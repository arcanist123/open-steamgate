CLASS zcl_osd_draft_adm_calc DEFINITION PUBLIC CREATE PUBLIC.
* The virtual elements of ZOSD_I_DRAFTADM (docs/rap-runtime.md, R9): the
* user descriptions (this tree has no user master: the description is the
* user name) and whether the request's user (ZCL_OSD_LOGON) created the
* draft, changed it last or has it in process -- what a Fiori Elements draft
* indicator shows. Unmeasured: a system's descriptions are the users' full
* names.
  PUBLIC SECTION.
    INTERFACES if_sadl_exit_calc_element_read.
ENDCLASS.

CLASS zcl_osd_draft_adm_calc IMPLEMENTATION.

  METHOD if_sadl_exit_calc_element_read~get_calculation_info.
    DATA ls_element TYPE if_sadl_exit=>ty_s_element_info.
    ls_element-name = 'CREATEDBYUSER'.
    APPEND ls_element TO ct_requested_orig_elements.
    ls_element-name = 'LASTCHANGEDBYUSER'.
    APPEND ls_element TO ct_requested_orig_elements.
    ls_element-name = 'INPROCESSBYUSER'.
    APPEND ls_element TO ct_requested_orig_elements.
  ENDMETHOD.

  METHOD if_sadl_exit_calc_element_read~calculate.
    DATA lv_me TYPE syuname.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <lv_user>   TYPE any.
    FIELD-SYMBOLS <lv_target> TYPE any.

    lv_me = zcl_osd_logon=>user( ).
    LOOP AT ct_calculated_data ASSIGNING <ls_row>.
      ASSIGN COMPONENT 'CREATEDBYUSER' OF STRUCTURE <ls_row> TO <lv_user>.
      IF sy-subrc = 0.
        ASSIGN COMPONENT 'CREATEDBYUSERDESCRIPTION' OF STRUCTURE <ls_row> TO <lv_target>.
        IF sy-subrc = 0.
          <lv_target> = <lv_user>.
        ENDIF.
        ASSIGN COMPONENT 'DRAFTISCREATEDBYME' OF STRUCTURE <ls_row> TO <lv_target>.
        IF sy-subrc = 0.
          <lv_target> = boolc( <lv_user> = lv_me ).
        ENDIF.
      ENDIF.
      ASSIGN COMPONENT 'LASTCHANGEDBYUSER' OF STRUCTURE <ls_row> TO <lv_user>.
      IF sy-subrc = 0.
        ASSIGN COMPONENT 'LASTCHANGEDBYUSERDESCRIPTION' OF STRUCTURE <ls_row> TO <lv_target>.
        IF sy-subrc = 0.
          <lv_target> = <lv_user>.
        ENDIF.
        ASSIGN COMPONENT 'DRAFTISLASTCHANGEDBYME' OF STRUCTURE <ls_row> TO <lv_target>.
        IF sy-subrc = 0.
          <lv_target> = boolc( <lv_user> = lv_me ).
        ENDIF.
      ENDIF.
      ASSIGN COMPONENT 'INPROCESSBYUSER' OF STRUCTURE <ls_row> TO <lv_user>.
      IF sy-subrc = 0.
        ASSIGN COMPONENT 'INPROCESSBYUSERDESCRIPTION' OF STRUCTURE <ls_row> TO <lv_target>.
        IF sy-subrc = 0.
          <lv_target> = <lv_user>.
        ENDIF.
        ASSIGN COMPONENT 'DRAFTISPROCESSEDBYME' OF STRUCTURE <ls_row> TO <lv_target>.
        IF sy-subrc = 0.
          <lv_target> = boolc( <lv_user> = lv_me ).
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
