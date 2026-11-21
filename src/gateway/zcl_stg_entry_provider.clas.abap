CLASS zcl_stg_entry_provider DEFINITION PUBLIC CREATE PUBLIC.
* The io_data_provider a DPC receives on create/update: the request body,
* already parsed, handed over as the entity structure the DPC expects.
* Property names are mapped to ABAP fields through the model; values are
* converted by EDM type (Int32 -> i, Boolean -> abap_bool, DateTime ->
* d or timestamp, the rest as character data).
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_entry_provider.

    METHODS constructor
      IMPORTING
        it_values  TYPE tihttpnvp
        is_set     TYPE zcl_stg_model_info=>ty_entity_set
        it_nested  TYPE tihttpnvp OPTIONAL
        is_service TYPE zcl_stg_model_info=>ty_service OPTIONAL.

* Fill one entity structure from name/value pairs (and, for a deep insert,
* the navigation components from nested JSON).
    METHODS set_base
      IMPORTING
        ir_base TYPE REF TO data.

    METHODS fill
      IMPORTING
        it_values  TYPE tihttpnvp
        it_nested  TYPE tihttpnvp OPTIONAL
        is_set     TYPE zcl_stg_model_info=>ty_entity_set
      CHANGING
        cs_data    TYPE any
      RAISING
        /iwbep/cx_mgw_tech_exception.

* the ABAP field names (upper case) of the properties the request gave:
* what a behavior's field control is checked against (the SADL behavior
* interface of src/sadl/)
    METHODS fields
      RETURNING
        VALUE(rt_fields) TYPE string_table.

* whether the request lays its values over the entity as it is (PATCH,
* MERGE: a base was set) rather than replacing it (PUT, POST)
    METHODS merges
      RETURNING
        VALUE(rv_merges) TYPE abap_bool.

    CLASS-METHODS convert_value
      IMPORTING
        iv_value    TYPE string
        iv_edm_type TYPE string
      CHANGING
        cv_target   TYPE any.
  PRIVATE SECTION.
    DATA mt_values  TYPE tihttpnvp.
* PATCH/MERGE: the entity as it is, the request's values are laid over it
    DATA mr_base    TYPE REF TO data.
    DATA mt_nested  TYPE tihttpnvp.
    DATA ms_set     TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ms_service TYPE zcl_stg_model_info=>ty_service.
ENDCLASS.

CLASS zcl_stg_entry_provider IMPLEMENTATION.

  METHOD constructor.
    mt_values  = it_values.
    mt_nested  = it_nested.
    ms_set     = is_set.
    ms_service = is_service.
  ENDMETHOD.

  METHOD fill.
    DATA ls_value    LIKE LINE OF it_values.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.
    DATA ls_nested   LIKE LINE OF it_nested.
    DATA ls_nav      TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_target   TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lt_elements TYPE string_table.
    DATA lv_element  TYPE string.
    DATA lt_inner    TYPE tihttpnvp.
    DATA lt_inner_nested TYPE tihttpnvp.
    DATA lr_line     TYPE REF TO data.
    DATA lx_error    TYPE REF TO zcx_stg_error.
    FIELD-SYMBOLS <lv_target> TYPE any.
    FIELD-SYMBOLS <lt_table>  TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>   TYPE any.
    FIELD-SYMBOLS <ls_nested> TYPE any.

    LOOP AT it_values INTO ls_value.
      READ TABLE is_set-properties INTO ls_property WITH KEY name = ls_value-name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_property-fieldname OF STRUCTURE cs_data TO <lv_target>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      convert_value( EXPORTING iv_value    = ls_value-value
                               iv_edm_type = ls_property-edm_type
                     CHANGING  cv_target   = <lv_target> ).
    ENDLOOP.

* deep insert: the SEGW deep structure carries one component per navigation
* property, named like it; a table for to-many, a structure for to-one
    LOOP AT it_nested INTO ls_nested.
      READ TABLE is_set-navs INTO ls_nav WITH KEY name = ls_nested-name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_nav-name OF STRUCTURE cs_data TO <lv_target>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      TRY.
          ls_target = zcl_stg_model_info=>find_set( is_service    = ms_service
                                                    iv_entity_set = ls_nav-target_set ).
          IF ls_nested-value CP '[*'.
            ASSIGN <lv_target> TO <lt_table>.
            lt_elements = zcl_stg_json=>parse_array( ls_nested-value ).
            LOOP AT lt_elements INTO lv_element.
              CREATE DATA lr_line LIKE LINE OF <lt_table>.
              ASSIGN lr_line->* TO <ls_line>.
              lt_inner = zcl_stg_json=>parse_object( EXPORTING iv_json   = lv_element
                                                     IMPORTING et_nested = lt_inner_nested ).
              fill( EXPORTING it_values = lt_inner
                              it_nested = lt_inner_nested
                              is_set    = ls_target
                    CHANGING  cs_data   = <ls_line> ).
              APPEND <ls_line> TO <lt_table>.
            ENDLOOP.
          ELSE.
            ASSIGN <lv_target> TO <ls_nested>.
            lt_inner = zcl_stg_json=>parse_object( EXPORTING iv_json   = ls_nested-value
                                                   IMPORTING et_nested = lt_inner_nested ).
            fill( EXPORTING it_values = lt_inner
                            it_nested = lt_inner_nested
                            is_set    = ls_target
                  CHANGING  cs_data   = <ls_nested> ).
          ENDIF.
        CATCH zcx_stg_error INTO lx_error.
          RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
            EXPORTING
              previous = lx_error.
      ENDTRY.
    ENDLOOP.
  ENDMETHOD.

  METHOD convert_value.
    DATA lv_kind TYPE c LENGTH 1.
    DATA lv_ms   TYPE string.
* the milliseconds as a number: an arithmetic expression compared with a
* string does not activate on a system (ANORMALIES arith-compared-with-string)
    DATA lv_msp  TYPE p LENGTH 16 DECIMALS 0.
    DATA lv_days TYPE i.
    DATA lv_secs TYPE i.
    DATA lv_date TYPE d VALUE '19700101'.
    DATA lv_rest TYPE i.
    DATA lv_hh   TYPE i.
    DATA lv_mm   TYPE i.
    DATA lv_time TYPE t.

    DESCRIBE FIELD cv_target TYPE lv_kind.

    CASE iv_edm_type.
      WHEN 'Edm.Boolean'.
        IF iv_value = 'true' OR iv_value = 'X'.
          cv_target = abap_true.
        ELSE.
          cv_target = abap_false.
        ENDIF.
      WHEN 'Edm.DateTime'.
        IF iv_value IS INITIAL OR iv_value = 'null'.
          CLEAR cv_target.
          RETURN.
        ENDIF.
        FIND REGEX 'Date\((-?\d+)\)' IN iv_value SUBMATCHES lv_ms.
        IF sy-subrc = 0.
* /Date(ms)/ -> days since 1970 + seconds
          lv_msp = lv_ms.
          lv_days = lv_msp / 1000 / 86400.
          IF lv_msp < 0 OR lv_days * 86400 * 1000 > lv_msp.
            lv_days = lv_days - 1.
          ENDIF.
          lv_secs = lv_msp / 1000 - lv_days * 86400.
          lv_date = lv_date + lv_days.
          lv_hh = lv_secs DIV 3600.
          lv_rest = lv_secs MOD 3600.
          lv_mm = lv_rest DIV 60.
          lv_rest = lv_rest MOD 60.
          lv_time = |{ lv_hh WIDTH = 2 ALIGN = RIGHT PAD = '0' }{ lv_mm WIDTH = 2 ALIGN = RIGHT PAD = '0' }{ lv_rest WIDTH = 2 ALIGN = RIGHT PAD = '0' }|.
          IF lv_kind = 'D'.
            cv_target = lv_date.
          ELSE.
            cv_target = |{ lv_date }{ lv_time }|.
          ENDIF.
        ELSE.
* ISO 2024-01-02T10:20:30 -> internal
          lv_ms = iv_value.
          REPLACE ALL OCCURRENCES OF '-' IN lv_ms WITH ''.
          REPLACE ALL OCCURRENCES OF ':' IN lv_ms WITH ''.
          REPLACE ALL OCCURRENCES OF 'T' IN lv_ms WITH ''.
          IF lv_kind = 'D'.
            cv_target = lv_ms(8).
          ELSE.
            cv_target = lv_ms.
          ENDIF.
        ENDIF.
      WHEN 'Edm.Time'.
* PT10H20M30S -> 102030
        lv_ms = iv_value.
        REPLACE ALL OCCURRENCES OF 'PT' IN lv_ms WITH ''.
        REPLACE ALL OCCURRENCES OF 'H' IN lv_ms WITH ''.
        REPLACE ALL OCCURRENCES OF 'M' IN lv_ms WITH ''.
        REPLACE ALL OCCURRENCES OF 'S' IN lv_ms WITH ''.
        cv_target = lv_ms.
      WHEN OTHERS.
        IF iv_value = 'null'.
          CLEAR cv_target.
        ELSE.
          cv_target = iv_value.
        ENDIF.
    ENDCASE.
  ENDMETHOD.

  METHOD fields.
    DATA ls_value    LIKE LINE OF mt_values.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.

    LOOP AT mt_values INTO ls_value.
      READ TABLE ms_set-properties INTO ls_property WITH KEY name = ls_value-name.
      IF sy-subrc = 0.
        APPEND to_upper( ls_property-fieldname ) TO rt_fields.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD merges.
    IF mr_base IS BOUND.
      rv_merges = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD set_base.
    mr_base = ir_base.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_entry_provider~read_entry_data.
    FIELD-SYMBOLS <ls_base> TYPE any.

    CLEAR es_data.
    IF mr_base IS BOUND.
      ASSIGN mr_base->* TO <ls_base>.
      MOVE-CORRESPONDING <ls_base> TO es_data.
    ENDIF.
    fill( EXPORTING it_values = mt_values
                    it_nested = mt_nested
                    is_set    = ms_set
          CHANGING  cs_data   = es_data ).
  ENDMETHOD.

ENDCLASS.
