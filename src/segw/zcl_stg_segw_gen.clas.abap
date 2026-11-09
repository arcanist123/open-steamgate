CLASS zcl_stg_segw_gen DEFINITION PUBLIC CREATE PUBLIC.
* SEGW's generator over the ZSTG_SB* tables, in ABAP: what tools/segw-gen.mjs
* makes of a <project>.iwpr.xml, made of the same rows in the database.
* segw-gen.mjs is the oracle: the output of the two must match byte for
* byte (test/segw-tree.mjs runs both over the fixtures and the corpus).
* Stage 1: the model provider base class (_MPC). The DPC follows.
  PUBLIC SECTION.
*   The byte order mark every SEGW-written XML begins with, in one place.
*   It was in three: the Node writers gained it and two of the three ABAP
*   ones did not, so `export` and `RepoFileSet` came back three bytes short
*   of the file they claim to reproduce and test/segw-tree went red on the
*   published branch for a whole push cycle with nothing to announce it.
*   A rule about what every writer must do does not live in a comment next
*   to one of them.
    CLASS-METHODS bom
      RETURNING
        VALUE(rv_bom) TYPE string.

    TYPES: BEGIN OF ty_property,
             name         TYPE string,
             abap_field   TYPE string,
             is_key       TYPE abap_bool,
             edm_type     TYPE string,
             precision    TYPE string,
             max_length   TYPE string,
             digits       TYPE string,
             scale        TYPE string,
             type_kind    TYPE string,
             length       TYPE string,
             decimals     TYPE string,
             creatable    TYPE abap_bool,
             updatable    TYPE abap_bool,
             sortable     TYPE abap_bool,
             nullable     TYPE abap_bool,
             filterable   TYPE abap_bool,
             semantics    TYPE string,
             as_etag      TYPE abap_bool,
             type_name    TYPE string,
             complex_type TYPE string,
             uuid         TYPE string,
*            The label a person typed, out of SBO_PRT -- the text table, not
*            the property row. It is here because without it there is nothing
*            to give a text symbol, and the JS twin has had it since the
*            evening: byte-identity between the two held only while both were
*            equally ignorant of labels (docs/retro-2026-09-19.md).
             label        TYPE string,
*            The three-digit symbol this label gets in the class's text pool.
*            SEGW never writes a label as an annotation -- in the corpus
*            `set_label_from_text_element(` occurs 1014 times and
*            `iv_key = 'label'` not once -- because Gateway adds its own
*            sap:label from the DDIC and two of them is invalid XML.
             text_element TYPE string,
           END OF ty_property.
    TYPES tt_property TYPE STANDARD TABLE OF ty_property WITH DEFAULT KEY.

* "Map to Data Source" rows of an operation: a property (or a constant) to
* a parameter path of the module / search help (SBD_MP), the HIGH/LOW/
* OPTION/SIGN components of a range table (SBD_MR)
    TYPES: BEGIN OF ty_map_prop,
             uuid         TYPE string,
             property     TYPE string,
             direction    TYPE string,
             ds_att_path  TYPE string,
             constant     TYPE string,
             has_constant TYPE abap_bool,
           END OF ty_map_prop.
    TYPES tt_map_prop TYPE STANDARD TABLE OF ty_map_prop WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_map_range,
             mp_uuid   TYPE string,
             component TYPE string,
             semantics TYPE string,
           END OF ty_map_range.
    TYPES tt_map_range TYPE STANDARD TABLE OF ty_map_range WITH DEFAULT KEY.

* an operation of an entity set: C R U D Q, the method SEGW named for it,
* and what the operation is mapped to (a function module, a search help)
    TYPES: BEGIN OF ty_operation,
             type           TYPE string,
             method         TYPE string,
             mapping_kind   TYPE string,
             function_name  TYPE string,
             function_group TYPE string,
             destination    TYPE string,
             log_attr       TYPE string,
             max_hits_attr  TYPE string,
             props          TYPE tt_map_prop,
             ranges         TYPE tt_map_range,
           END OF ty_operation.

* a generated artifact (SBD_GA): the classes, and the BOP interfaces SEGW
* makes per mapped function module
    TYPES: BEGIN OF ty_artifact,
             name     TYPE string,
             art_type TYPE string,
             rfc_name TYPE string,
           END OF ty_artifact.
    TYPES tt_artifact TYPE STANDARD TABLE OF ty_artifact WITH DEFAULT KEY.
    TYPES tt_operation TYPE STANDARD TABLE OF ty_operation WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_entity_set,
             name            TYPE string,
             creatable       TYPE abap_bool,
             updatable       TYPE abap_bool,
             deletable       TYPE abap_bool,
             pageable        TYPE abap_bool,
             addressable     TYPE abap_bool,
             searchable      TYPE abap_bool,
             subscribable    TYPE abap_bool,
             filter_required TYPE abap_bool,
             uuid            TYPE string,
             operations      TYPE tt_operation,
* "Map to data source" on a DDIC table, a CDS view, an EPM business object
* or (steamgate) another service: SADL serves the set
             sadl_type       TYPE string,
             sadl_binding    TYPE string,
             sadl_service    TYPE string,
             sadl_set        TYPE string,
           END OF ty_entity_set.
    TYPES tt_entity_set TYPE STANDARD TABLE OF ty_entity_set WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_entity_type,
             name        TYPE string,
             tech_name   TYPE string,
             abap_struct TYPE string,
             is_media    TYPE abap_bool,
             type_stem   TYPE string,
             define_stem TYPE string,
             properties  TYPE tt_property,
             entity_sets TYPE tt_entity_set,
             uuid        TYPE string,
           END OF ty_entity_type.
    TYPES tt_entity_type TYPE STANDARD TABLE OF ty_entity_type WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_complex_type,
             name        TYPE string,
             tech_name   TYPE string,
             uuid        TYPE string,
             abap_struct TYPE string,
             properties  TYPE tt_property,
           END OF ty_complex_type.
    TYPES tt_complex_type TYPE STANDARD TABLE OF ty_complex_type WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_constraint,
             principal TYPE string,
             dependent TYPE string,
           END OF ty_constraint.
    TYPES tt_constraint TYPE STANDARD TABLE OF ty_constraint WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_assoc_set,
             name      TYPE string,
             left_set  TYPE string,
             right_set TYPE string,
           END OF ty_assoc_set.
    TYPES tt_assoc_set TYPE STANDARD TABLE OF ty_assoc_set WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_association,
             name        TYPE string,
             left_type   TYPE string,
             right_type  TYPE string,
             left_card   TYPE string,
             right_card  TYPE string,
             uuid        TYPE string,
             constraints TYPE tt_constraint,
             sets        TYPE tt_assoc_set,
           END OF ty_association.
    TYPES tt_association TYPE STANDARD TABLE OF ty_association WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_navigation,
             name        TYPE string,
             abap_field  TYPE string,
             entity      TYPE string,
             association TYPE string,
           END OF ty_navigation.
    TYPES tt_navigation TYPE STANDARD TABLE OF ty_navigation WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_parameter,
             name         TYPE string,
             abap_field   TYPE string,
             edm_type     TYPE string,
             data_element TYPE string,
             max_length   TYPE string,
             label        TYPE string,
             text_element TYPE string,
           END OF ty_parameter.
    TYPES tt_parameter TYPE STANDARD TABLE OF ty_parameter WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_function_import,
             name        TYPE string,
             label       TYPE string,
             http_method TYPE string,
             return_card TYPE string,
             return_kind TYPE string,
             return_type TYPE string,
             return_set  TYPE string,
             action_for  TYPE string,
             parameters  TYPE tt_parameter,
             text_element TYPE string,
           END OF ty_function_import.
    TYPES tt_function_import TYPE STANDARD TABLE OF ty_function_import WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_model,
             project          TYPE string,
             service          TYPE string,
             model            TYPE string,
             project_type     TYPE string,
             description      TYPE string,
             namespace        TYPE string,
             last_changed     TYPE string,
             mpc              TYPE string,
             mpc_ext          TYPE string,
             dpc              TYPE string,
             dpc_ext          TYPE string,
* the generation stamp segw-gen writes: LAST_CHG_TIME as yyyymmddhhmmss and
* as dd.mm.yyyy hh:mm:ss, client 001
             generated_at     TYPE string,
             generated_on     TYPE string,
             client           TYPE string,
             artifacts        TYPE tt_artifact,
             entity_types     TYPE tt_entity_type,
             associations     TYPE tt_association,
             navigation       TYPE tt_navigation,
             function_imports TYPE tt_function_import,
             complex_types    TYPE tt_complex_type,
           END OF ty_model.

    TYPES: BEGIN OF ty_file,
             name    TYPE string,
             content TYPE string,
           END OF ty_file.
    TYPES tt_file TYPE STANDARD TABLE OF ty_file WITH DEFAULT KEY.

* the model of a project, from the tables
    CLASS-METHODS ab
      IMPORTING
        iv_bool        TYPE abap_bool
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS edm_setter
      IMPORTING
        iv_edm_type    TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS action_type
      IMPORTING is_function TYPE ty_function_import
      RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS inline_type
      IMPORTING is_property TYPE ty_property
      RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS action_parameter_type
      IMPORTING is_parameter TYPE ty_parameter
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS banner
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS build_model
      IMPORTING
        iv_project      TYPE string
      RETURNING
        VALUE(rs_model) TYPE ty_model
      RAISING
        /iwbep/cx_mgw_busi_exception.

* the generated files of a project: the _MPC and _DPC pair with their
* abapGit XML, and the _EXT pair
    CLASS-METHODS generate
      IMPORTING
        iv_project      TYPE string
      RETURNING
        VALUE(rt_files) TYPE tt_file
      RAISING
        /iwbep/cx_mgw_busi_exception.

    CLASS-METHODS mpc_source
      IMPORTING
        is_model         TYPE ty_model
      RETURNING
        VALUE(rv_source) TYPE string
      RAISING cx_static_check.

    CLASS-METHODS warnings_json
      IMPORTING
        it_findings    TYPE zcl_osd_dsl_profile=>tt_finding
      RETURNING
        VALUE(rv_json) TYPE string.

    CLASS-METHODS mpc_source_legacy
      IMPORTING
        is_model         TYPE ty_model
      RETURNING
        VALUE(rv_source) TYPE string.

* JavaScript's slice: out of range gives what is there, not an exception
* (a project without LAST_CHG_TIME has an empty stamp)
    CLASS-METHODS slice
      IMPORTING
        iv_text        TYPE string
        iv_from        TYPE i
        iv_to          TYPE i
      RETURNING
        VALUE(rv_text) TYPE string.

* the part after the last backslash of a parameter path (IT_RANGE\HIGH -> HIGH)
    CLASS-METHODS last_segment
      IMPORTING
        iv_path        TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS file_name
      IMPORTING
        iv_class       TYPE string
        iv_ext         TYPE string
      RETURNING
        VALUE(rv_name) TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_row,
             uuid   TYPE string,
             name   TYPE string,
             line   TYPE REF TO data,
           END OF ty_row.
    TYPES tt_row TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.

    CONSTANTS gc_class TYPE string VALUE 'ZCL_STG_TAB_ZSTG_'.
    CONSTANTS gc_stars TYPE string VALUE '***********************************************************************************************************************************'.

    CLASS-DATA gt_by_uuid TYPE tt_row.

    CLASS-METHODS rows
      IMPORTING
        iv_tag         TYPE string
        iv_project     TYPE string
      RETURNING
        VALUE(rt_rows) TYPE tt_row
      RAISING
        /iwbep/cx_mgw_busi_exception.

* a field of a row as text; '' when the table has no such column
    CLASS-METHODS val
      IMPORTING
        is_row          TYPE ty_row
        iv_field        TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.

    CLASS-METHODS flag
      IMPORTING
        is_row         TYPE ty_row
        iv_field       TYPE string
      RETURNING
        VALUE(rv_flag) TYPE abap_bool.

    CLASS-METHODS type_name
      IMPORTING
        iv_uuid        TYPE string
      RETURNING
        VALUE(rv_name) TYPE string.

*   every labelled property gets a text symbol, in tree order
    CLASS-METHODS assign_text_elements
      CHANGING
        cs_model TYPE ty_model.

    CLASS-METHODS property_of
      IMPORTING
        is_row             TYPE ty_row
        it_complex         TYPE tt_row
        it_text            TYPE tt_row
        iv_with_key        TYPE abap_bool
      RETURNING
        VALUE(rs_property) TYPE ty_property.

* the operations of an entity set (the design set node under it, SBD_SE,
* its operations SBD_OP with their mappings SBD_MH -> SBD_DS) and whether
* SADL serves the set
    CLASS-METHODS set_operations
      IMPORTING
        it_se  TYPE tt_row
        it_op  TYPE tt_row
        it_mh  TYPE tt_row
        it_ds  TYPE tt_row
        it_mp  TYPE tt_row
        it_mr  TYPE tt_row
      CHANGING
        cs_set TYPE ty_entity_set.

* a stable sort of properties by SORT_ORDER: equal orders keep the file's order
    CLASS-METHODS sort_properties
      IMPORTING
        it_order      TYPE string_table
      CHANGING
        ct_properties TYPE tt_property.

    CLASS-METHODS packed_length
      IMPORTING
        iv_digits        TYPE string
      RETURNING
        VALUE(rv_length) TYPE i.

    CLASS-METHODS property_code
      IMPORTING
        is_property    TYPE ty_property
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS define_entity_method
      IMPORTING
        is_type        TYPE ty_entity_type
        iv_mpc         TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS define_complex_types_method
      IMPORTING
        is_model       TYPE ty_model
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS define_associations_method
      IMPORTING
        is_model       TYPE ty_model
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS define_actions_method
      IMPORTING
        is_model       TYPE ty_model
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_stg_segw_gen IMPLEMENTATION.

  METHOD bom.
    rv_bom = cl_abap_conv_in_ce=>uccp( 'FEFF' ).
  ENDMETHOD.


  METHOD rows.
* ------------------------------------------------------------- the model
    DATA lo_source  TYPE REF TO zif_stg_cds_source.
    DATA lv_class   TYPE string.
    DATA lt_orderby TYPE string_table.
    DATA lr_data    TYPE REF TO data.
    DATA ls_row     TYPE ty_row.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_data> TYPE any.
    FIELD-SYMBOLS <ls_line> TYPE any.

    lv_class = gc_class && iv_tag.
    TRY.
        CREATE OBJECT lo_source TYPE (lv_class).
      CATCH cx_sy_create_object_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            message = |{ iv_tag }: no table ZSTG_{ iv_tag }|.
    ENDTRY.
    APPEND 'STG_SEQ ASCENDING' TO lt_orderby.
    lr_data = lo_source->read( iv_where   = |PROJECT = '{ replace( val = iv_project sub = `'` with = `''` occ = 0 ) }'|
                               it_orderby = lt_orderby ).
    ASSIGN lr_data->* TO <lt_data>.
    LOOP AT <lt_data> ASSIGNING <ls_data>.
      CLEAR ls_row.
      ls_row-line = lo_source->create_line( ).
      ASSIGN ls_row-line->* TO <ls_line>.
      <ls_line> = <ls_data>.
      ls_row-uuid = val( is_row = ls_row iv_field = 'NODE_UUID' ).
      ls_row-name = val( is_row = ls_row iv_field = 'NAME' ).
      APPEND ls_row TO rt_rows.
    ENDLOOP.
  ENDMETHOD.

  METHOD val.
    FIELD-SYMBOLS <ls_line>  TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    ASSIGN is_row-line->* TO <ls_line>.
    ASSIGN COMPONENT iv_field OF STRUCTURE <ls_line> TO <lv_value>.
    IF sy-subrc = 0.
      rv_value = <lv_value>.
    ENDIF.
  ENDMETHOD.

  METHOD flag.
    rv_flag = xsdbool( val( is_row = is_row iv_field = iv_field ) = 'X' ).
  ENDMETHOD.

  METHOD type_name.
    DATA ls_row TYPE ty_row.

    READ TABLE gt_by_uuid INTO ls_row WITH KEY uuid = iv_uuid.
    IF sy-subrc = 0.
      rv_name = ls_row-name.
    ENDIF.
  ENDMETHOD.

  METHOD property_of.
* what the tree stores for a property's size and what SEGW writes for it:
* a string has MAX_LENGTH; a decimal has PROP_PRECISION (digits) and SCALE;
* a DateTime with a precision has PROP_PRECISION, and when the tree also
* carries SCALE the digits go to the max length
    DATA lv_decimal TYPE abap_bool.
    DATA ls_complex TYPE ty_row.
    DATA ls_text    TYPE ty_row.

    rs_property-name       = val( is_row = is_row iv_field = 'NAME' ).
    rs_property-abap_field = val( is_row = is_row iv_field = 'ABAP_FIELD' ).
    IF rs_property-abap_field IS INITIAL.
      rs_property-abap_field = to_upper( rs_property-name ).
    ENDIF.
    IF iv_with_key = abap_true.
      rs_property-is_key = flag( is_row = is_row iv_field = 'IS_KEY' ).
    ENDIF.
    rs_property-edm_type  = val( is_row = is_row iv_field = 'EDM_CORE_TYPE' ).
    rs_property-digits    = val( is_row = is_row iv_field = 'PROP_PRECISION' ).
    rs_property-scale     = val( is_row = is_row iv_field = 'SCALE' ).
    rs_property-type_kind = val( is_row = is_row iv_field = 'TYPE_KIND' ).
    rs_property-length    = val( is_row = is_row iv_field = 'LENGTH' ).
    rs_property-decimals  = val( is_row = is_row iv_field = 'DECIMALS' ).
    lv_decimal = xsdbool( rs_property-edm_type = 'Edm.Decimal' ).
    IF rs_property-scale IS NOT INITIAL.
      rs_property-precision = rs_property-scale.
    ELSEIF lv_decimal = abap_false.
      rs_property-precision = rs_property-digits.
    ENDIF.
    IF lv_decimal = abap_true OR rs_property-scale IS NOT INITIAL.
      rs_property-max_length = rs_property-digits.
    ELSE.
      rs_property-max_length = val( is_row = is_row iv_field = 'MAX_LENGTH' ).
    ENDIF.
    rs_property-creatable  = flag( is_row = is_row iv_field = 'CREATABLE' ).
    rs_property-updatable  = flag( is_row = is_row iv_field = 'UPDATABLE' ).
    rs_property-sortable   = flag( is_row = is_row iv_field = 'SORTABLE' ).
    rs_property-nullable   = flag( is_row = is_row iv_field = 'IS_NULLABLE' ).
    rs_property-filterable = flag( is_row = is_row iv_field = 'FILTERABLE' ).
    rs_property-semantics  = val( is_row = is_row iv_field = 'SEMANTICS' ).
    IF iv_with_key = abap_true.
      rs_property-as_etag = flag( is_row = is_row iv_field = 'AS_ETAG' ).
    ENDIF.
    rs_property-type_name = val( is_row = is_row iv_field = 'TYPE_NAME' ).
    rs_property-uuid      = is_row-uuid.
*   The label lives one table over, keyed by the property's own node: SEGW
*   keeps language-dependent text apart from the row, the way it keeps every
*   *T table apart. A property with no row there has no label, and none is
*   invented for it -- an invented label would put a text in the model that
*   nobody wrote.
    READ TABLE it_text INTO ls_text WITH KEY uuid = is_row-uuid.
    IF sy-subrc = 0.
      rs_property-label = val( is_row = ls_text iv_field = 'PROP_LABEL' ).
    ENDIF.
    IF iv_with_key = abap_true.
      rs_property-complex_type = val( is_row = is_row iv_field = 'COMPLEX_TYPE' ).
      IF rs_property-complex_type IS NOT INITIAL.
        READ TABLE it_complex INTO ls_complex WITH KEY uuid = rs_property-complex_type.
        IF sy-subrc = 0.
          rs_property-complex_type = ls_complex-name.
        ELSE.
          CLEAR rs_property-complex_type.
        ENDIF.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD build_model.
    DATA lt_pr   TYPE tt_row.
    DATA lt_prt  TYPE tt_row.
    DATA lt_md   TYPE tt_row.
    DATA lt_sv   TYPE tt_row.
    DATA lt_ga   TYPE tt_row.
    DATA lt_et   TYPE tt_row.
    DATA lt_prop TYPE tt_row.
    DATA lt_prtx TYPE tt_row.
    DATA lt_fitx TYPE tt_row.
    DATA lt_fptx TYPE tt_row.
    DATA ls_labl TYPE ty_row.
    DATA lt_es   TYPE tt_row.
    DATA lt_aso  TYPE tt_row.
    DATA lt_at   TYPE tt_row.
    DATA lt_np   TYPE tt_row.
    DATA lt_rc   TYPE tt_row.
    DATA lt_fi   TYPE tt_row.
    DATA lt_fp   TYPE tt_row.
    DATA lt_ct   TYPE tt_row.
    DATA lt_se   TYPE tt_row.
    DATA lt_op   TYPE tt_row.
    DATA lt_mh   TYPE tt_row.
    DATA lt_ds   TYPE tt_row.
    DATA lt_mp   TYPE tt_row.
    DATA lt_mr   TYPE tt_row.
    DATA ls_art  TYPE ty_artifact.
    DATA ls_row  TYPE ty_row.
    DATA ls_sub  TYPE ty_row.
    DATA ls_type TYPE ty_entity_type.
    DATA ls_set  TYPE ty_entity_set.
    DATA ls_ct   TYPE ty_complex_type.
    DATA ls_aso  TYPE ty_association.
    DATA ls_rc   TYPE ty_constraint.
    DATA ls_as   TYPE ty_assoc_set.
    DATA ls_nav  TYPE ty_navigation.
    DATA ls_fi   TYPE ty_function_import.
    DATA ls_fp   TYPE ty_parameter.
    DATA lv_kind TYPE string.
    DATA lv_stem TYPE string.
    DATA lt_taken TYPE string_table.
    DATA lt_order TYPE string_table.
    DATA lt_index TYPE STANDARD TABLE OF i.
    DATA ls_swap_type TYPE ty_entity_type.
    DATA lv_swap TYPE i.
    DATA lv_i    TYPE i.
    DATA lv_j    TYPE i.
    DATA lv_len  TYPE i.
    FIELD-SYMBOLS <ls_type> TYPE ty_entity_type.

    lt_pr   = rows( iv_tag = 'SBD_PR'  iv_project = iv_project ).
    IF lt_pr IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |no project { iv_project }|.
    ENDIF.
    lt_prt  = rows( iv_tag = 'SBD_PRT' iv_project = iv_project ).
    lt_md   = rows( iv_tag = 'SBD_MD'  iv_project = iv_project ).
    lt_sv   = rows( iv_tag = 'SBD_SV'  iv_project = iv_project ).
    lt_ga   = rows( iv_tag = 'SBD_GA'  iv_project = iv_project ).
    lt_et   = rows( iv_tag = 'SBO_ET'  iv_project = iv_project ).
    lt_prop = rows( iv_tag = 'SBO_PR'  iv_project = iv_project ).
    lt_prtx = rows( iv_tag = 'SBO_PRT' iv_project = iv_project ).
    lt_es   = rows( iv_tag = 'SBO_ES'  iv_project = iv_project ).
    lt_aso  = rows( iv_tag = 'SBO_ASO' iv_project = iv_project ).
    lt_at   = rows( iv_tag = 'SBO_AT'  iv_project = iv_project ).
    lt_np   = rows( iv_tag = 'SBO_NP'  iv_project = iv_project ).
    lt_rc   = rows( iv_tag = 'SBO_RC'  iv_project = iv_project ).
    lt_fi   = rows( iv_tag = 'SBO_FI'  iv_project = iv_project ).
*   The text tables of the actions and their parameters, read for the same
*   reason SBO_PRT is: a label is what a person typed and the name is what
*   the tool made. They were not read here, and the omission was recorded as
*   a gap with a wrong reason beside it -- "ty_function_import carries no
*   node uuid to look one up by". The type does not need one: the row does,
*   and this loop has the row. What has no uuid is the model AFTER it is
*   assembled, which is where assign_text_elements runs.
    lt_fitx = rows( iv_tag = 'SBO_FIT' iv_project = iv_project ).
    lt_fptx = rows( iv_tag = 'SBO_FPT' iv_project = iv_project ).
    lt_fp   = rows( iv_tag = 'SBO_FP'  iv_project = iv_project ).
    lt_ct   = rows( iv_tag = 'SBO_CT'  iv_project = iv_project ).
    lt_se   = rows( iv_tag = 'SBD_SE'  iv_project = iv_project ).
    lt_op   = rows( iv_tag = 'SBD_OP'  iv_project = iv_project ).
    lt_mh   = rows( iv_tag = 'SBD_MH'  iv_project = iv_project ).
    lt_ds   = rows( iv_tag = 'SBD_DS'  iv_project = iv_project ).
    lt_mp   = rows( iv_tag = 'SBD_MP'  iv_project = iv_project ).
    lt_mr   = rows( iv_tag = 'SBD_MR'  iv_project = iv_project ).

    CLEAR gt_by_uuid.
    APPEND LINES OF lt_et TO gt_by_uuid.
    APPEND LINES OF lt_es TO gt_by_uuid.
    APPEND LINES OF lt_aso TO gt_by_uuid.
    APPEND LINES OF lt_prop TO gt_by_uuid.
    APPEND LINES OF lt_fi TO gt_by_uuid.
    APPEND LINES OF lt_ct TO gt_by_uuid.

    READ TABLE lt_pr INDEX 1 INTO ls_row.
    rs_model-project      = val( is_row = ls_row iv_field = 'PROJECT' ).
    rs_model-project_type = val( is_row = ls_row iv_field = 'PROJECT_TYPE' ).
    IF rs_model-project_type IS INITIAL.
      rs_model-project_type = '1'.
    ENDIF.
    rs_model-last_changed = val( is_row = ls_row iv_field = 'LAST_CHG_TIME' ).
    rs_model-generated_at = rs_model-last_changed.
    IF strlen( rs_model-generated_at ) > 14.
      rs_model-generated_at = substring( val = rs_model-generated_at len = 14 ).
    ENDIF.
    rs_model-generated_on = |{ slice( iv_text = rs_model-generated_at iv_from = 6 iv_to = 8 ) }.{ slice( iv_text = rs_model-generated_at iv_from = 4 iv_to = 6 ) }.{ slice( iv_text = rs_model-generated_at iv_from = 0 iv_to = 4 ) }|
      && | { slice( iv_text = rs_model-generated_at iv_from = 8 iv_to = 10 ) }:{ slice( iv_text = rs_model-generated_at iv_from = 10 iv_to = 12 ) }:{ slice( iv_text = rs_model-generated_at iv_from = 12 iv_to = 14 ) }|.
    rs_model-client = '001'.
    READ TABLE lt_prt INDEX 1 INTO ls_row.
    IF sy-subrc = 0.
      rs_model-description = val( is_row = ls_row iv_field = 'DESCRIPTION' ).
    ENDIF.
    READ TABLE lt_md INDEX 1 INTO ls_row.
    IF sy-subrc = 0.
      rs_model-namespace = val( is_row = ls_row iv_field = 'VALUE_NS' ).
      rs_model-model     = val( is_row = ls_row iv_field = 'TECHNICAL_NAME' ).
    ENDIF.
    READ TABLE lt_sv INDEX 1 INTO ls_row.
    IF sy-subrc = 0.
      rs_model-service = val( is_row = ls_row iv_field = 'TECHNICAL_NAME' ).
    ENDIF.
    LOOP AT lt_ga INTO ls_row.
      lv_kind = val( is_row = ls_row iv_field = 'GEN_ART_TYPE' ).
      ls_art-name     = ls_row-name.
      ls_art-art_type = lv_kind.
      ls_art-rfc_name = val( is_row = ls_row iv_field = 'RFC_NAME' ).
      APPEND ls_art TO rs_model-artifacts.
      CASE lv_kind.
        WHEN 'MPCB'.
          IF rs_model-mpc IS INITIAL.
            rs_model-mpc = ls_row-name.
          ENDIF.
        WHEN 'MPCS'.
          IF rs_model-mpc_ext IS INITIAL.
            rs_model-mpc_ext = ls_row-name.
          ENDIF.
        WHEN 'DPCB'.
          IF rs_model-dpc IS INITIAL.
            rs_model-dpc = ls_row-name.
          ENDIF.
        WHEN 'DPCS'.
          IF rs_model-dpc_ext IS INITIAL.
            rs_model-dpc_ext = ls_row-name.
          ENDIF.
      ENDCASE.
    ENDLOOP.

* entity types with their properties (by SORT_ORDER) and entity sets
    LOOP AT lt_et INTO ls_row.
      CLEAR ls_type.
      ls_type-name = ls_row-name.
      IF ls_type-name IS INITIAL.
        ls_type-name = val( is_row = ls_row iv_field = 'TECH_NAME' ).
      ENDIF.
      ls_type-tech_name   = to_upper( ls_type-name ).
      ls_type-abap_struct = val( is_row = ls_row iv_field = 'ABAP_STRUCT' ).
      ls_type-is_media    = flag( is_row = ls_row iv_field = 'IS_MEDIA' ).
* ABAP names stop at 30 characters: TS_/TT_/GC_ + 27, DEFINE_ + 23
      ls_type-type_stem   = ls_type-tech_name.
      IF strlen( ls_type-type_stem ) > 27.
        ls_type-type_stem = substring( val = ls_type-type_stem len = 27 ).
      ENDIF.
      ls_type-define_stem = ls_type-tech_name.
      IF strlen( ls_type-define_stem ) > 23.
        ls_type-define_stem = substring( val = ls_type-define_stem len = 23 ).
      ENDIF.
      ls_type-uuid        = ls_row-uuid.
      CLEAR lt_order.
      LOOP AT lt_prop INTO ls_sub.
        IF val( is_row = ls_sub iv_field = 'PARENT_UUID' ) <> ls_row-uuid.
          CONTINUE.
        ENDIF.
        APPEND property_of( is_row = ls_sub it_complex = lt_ct it_text = lt_prtx iv_with_key = abap_true ) TO ls_type-properties.
        APPEND val( is_row = ls_sub iv_field = 'SORT_ORDER' ) TO lt_order.
      ENDLOOP.
      sort_properties( EXPORTING it_order      = lt_order
                       CHANGING  ct_properties = ls_type-properties ).
      LOOP AT lt_es INTO ls_sub.
        IF val( is_row = ls_sub iv_field = 'ENTITY_TYPE' ) <> ls_row-uuid.
          CONTINUE.
        ENDIF.
        CLEAR ls_set.
        ls_set-name            = ls_sub-name.
        ls_set-creatable       = flag( is_row = ls_sub iv_field = 'CREATABLE' ).
        ls_set-updatable       = flag( is_row = ls_sub iv_field = 'UPDATABLE' ).
        ls_set-deletable       = flag( is_row = ls_sub iv_field = 'DELETABLE' ).
        ls_set-pageable        = flag( is_row = ls_sub iv_field = 'PAGEABLE' ).
        ls_set-addressable     = flag( is_row = ls_sub iv_field = 'ADDRESSABLE' ).
        ls_set-searchable      = flag( is_row = ls_sub iv_field = 'SEARCHABLE' ).
        ls_set-subscribable    = flag( is_row = ls_sub iv_field = 'SUBSCRIBABLE' ).
        ls_set-filter_required = flag( is_row = ls_sub iv_field = 'REQUIRES_FILTER' ).
        ls_set-uuid            = ls_sub-uuid.
        set_operations( EXPORTING it_se = lt_se it_op = lt_op it_mh = lt_mh it_ds = lt_ds it_mp = lt_mp it_mr = lt_mr
                        CHANGING  cs_set = ls_set ).
        APPEND ls_set TO ls_type-entity_sets.
      ENDLOOP.
      APPEND ls_type TO rs_model-entity_types.
    ENDLOOP.

* two entities that agree on the first 23 characters: the one whose name
* fits keeps DEFINE_<name>, the other loses one more character; shortest
* names first, equal lengths in the file's order (a stable insertion sort)
    CLEAR lt_index.
    LOOP AT rs_model-entity_types INTO ls_type.
      lv_i = sy-tabix.
      lv_len = strlen( ls_type-tech_name ).
      lv_j = 0.
      LOOP AT lt_index INTO lv_swap.
        READ TABLE rs_model-entity_types INDEX lv_swap INTO ls_swap_type.
        IF strlen( ls_swap_type-tech_name ) > lv_len.
          lv_j = sy-tabix.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_j = 0.
        APPEND lv_i TO lt_index.
      ELSE.
        INSERT lv_i INTO lt_index INDEX lv_j.
      ENDIF.
    ENDLOOP.
    LOOP AT lt_index INTO lv_i.
      READ TABLE rs_model-entity_types INDEX lv_i ASSIGNING <ls_type>.
      lv_stem = <ls_type>-define_stem.
      DO.
        READ TABLE lt_taken WITH KEY table_line = lv_stem TRANSPORTING NO FIELDS.
        IF sy-subrc <> 0 OR strlen( lv_stem ) <= 1.
          EXIT.
        ENDIF.
        lv_stem = substring( val = lv_stem len = strlen( lv_stem ) - 1 ).
      ENDDO.
      APPEND lv_stem TO lt_taken.
      <ls_type>-define_stem = lv_stem.
    ENDLOOP.

* complex types
    LOOP AT lt_ct INTO ls_row.
      CLEAR ls_ct.
      ls_ct-name      = ls_row-name.
      ls_ct-tech_name = val( is_row = ls_row iv_field = 'TECH_NAME' ).
      IF ls_ct-tech_name IS INITIAL.
        ls_ct-tech_name = ls_ct-name.
      ENDIF.
      ls_ct-tech_name   = to_upper( ls_ct-tech_name ).
      ls_ct-uuid        = ls_row-uuid.
      ls_ct-abap_struct = val( is_row = ls_row iv_field = 'ABAP_STRUCT' ).
      CLEAR lt_order.
      LOOP AT lt_prop INTO ls_sub.
        IF val( is_row = ls_sub iv_field = 'PARENT_UUID' ) <> ls_row-uuid.
          CONTINUE.
        ENDIF.
        APPEND property_of( is_row = ls_sub it_complex = lt_ct it_text = lt_prtx iv_with_key = abap_false ) TO ls_ct-properties.
        APPEND val( is_row = ls_sub iv_field = 'SORT_ORDER' ) TO lt_order.
      ENDLOOP.
      sort_properties( EXPORTING it_order      = lt_order
                       CHANGING  ct_properties = ls_ct-properties ).
      APPEND ls_ct TO rs_model-complex_types.
    ENDLOOP.

* associations with their referential constraints and association sets
    LOOP AT lt_aso INTO ls_row.
      CLEAR ls_aso.
      ls_aso-name       = ls_row-name.
      ls_aso-left_type  = type_name( val( is_row = ls_row iv_field = 'LEFT_END_GUID' ) ).
      ls_aso-right_type = type_name( val( is_row = ls_row iv_field = 'RIGHT_END_GUID' ) ).
      ls_aso-left_card  = val( is_row = ls_row iv_field = 'LEFT_END_CARD' ).
      ls_aso-right_card = val( is_row = ls_row iv_field = 'RIGHT_END_CARD' ).
      ls_aso-uuid       = ls_row-uuid.
      LOOP AT lt_rc INTO ls_sub.
        IF val( is_row = ls_sub iv_field = 'ASSOCIATION_GUID' ) <> ls_row-uuid.
          CONTINUE.
        ENDIF.
        ls_rc-principal = type_name( val( is_row = ls_sub iv_field = 'PRINCIPAL_PROP_R' ) ).
        IF ls_rc-principal IS INITIAL.
          ls_rc-principal = ls_sub-name.
        ENDIF.
        ls_rc-dependent = type_name( val( is_row = ls_sub iv_field = 'DEPENDENT_PROP_R' ) ).
        IF ls_rc-dependent IS INITIAL.
          ls_rc-dependent = ls_sub-name.
        ENDIF.
        APPEND ls_rc TO ls_aso-constraints.
      ENDLOOP.
      LOOP AT lt_at INTO ls_sub.
        IF val( is_row = ls_sub iv_field = 'ASSOCIATION_GUID' ) <> ls_row-uuid.
          CONTINUE.
        ENDIF.
        ls_as-name      = ls_sub-name.
        ls_as-left_set  = type_name( val( is_row = ls_sub iv_field = 'LEFT_END_GUID' ) ).
        ls_as-right_set = type_name( val( is_row = ls_sub iv_field = 'RIGHT_END_GUID' ) ).
        APPEND ls_as TO ls_aso-sets.
      ENDLOOP.
      APPEND ls_aso TO rs_model-associations.
    ENDLOOP.

    LOOP AT lt_np INTO ls_row.
      ls_nav-name       = ls_row-name.
      ls_nav-abap_field = val( is_row = ls_row iv_field = 'TECH_NAME' ).
      IF ls_nav-abap_field IS INITIAL.
        ls_nav-abap_field = to_upper( ls_nav-name ).
      ENDIF.
      ls_nav-entity      = type_name( val( is_row = ls_row iv_field = 'ENTITY_GUID' ) ).
      ls_nav-association = type_name( val( is_row = ls_row iv_field = 'RELATION_GUID' ) ).
      APPEND ls_nav TO rs_model-navigation.
    ENDLOOP.

    LOOP AT lt_fi INTO ls_row.
      CLEAR ls_fi.
      ls_fi-name        = ls_row-name.
      CLEAR ls_labl.
      READ TABLE lt_fitx INTO ls_labl WITH KEY uuid = ls_row-uuid.
      IF sy-subrc = 0.
        ls_fi-label = val( is_row = ls_labl iv_field = 'FI_LABEL' ).
      ENDIF.
      ls_fi-http_method = val( is_row = ls_row iv_field = 'HTTP_METHOD' ).
      ls_fi-return_card = val( is_row = ls_row iv_field = 'RETURN_CARD' ).
      ls_fi-return_kind = val( is_row = ls_row iv_field = 'RETURN_TYPE_KIND' ).
      ls_fi-return_type = type_name( val( is_row = ls_row iv_field = 'RETURN_REF_TYPE' ) ).
      ls_fi-return_set  = type_name( val( is_row = ls_row iv_field = 'RETURN_ENTITYSET' ) ).
      IF val( is_row = ls_row iv_field = 'ACTION_FOR' ) IS NOT INITIAL.
        ls_fi-action_for = type_name( val( is_row = ls_row iv_field = 'ACTION_FOR' ) ).
      ENDIF.
      LOOP AT lt_fp INTO ls_sub.
        IF val( is_row = ls_sub iv_field = 'FUNCTION_IMPORT' ) <> ls_row-uuid.
          CONTINUE.
        ENDIF.
        CLEAR ls_fp.
        ls_fp-name       = ls_sub-name.
        CLEAR ls_labl.
        READ TABLE lt_fptx INTO ls_labl WITH KEY uuid = ls_sub-uuid.
        IF sy-subrc = 0.
          ls_fp-label = val( is_row = ls_labl iv_field = 'FI_PARAM_LABEL' ).
        ENDIF.
        ls_fp-abap_field = val( is_row = ls_sub iv_field = 'ABAP_FIELD' ).
        IF ls_fp-abap_field IS INITIAL.
          ls_fp-abap_field = to_upper( ls_fp-name ).
        ENDIF.
        ls_fp-edm_type     = val( is_row = ls_sub iv_field = 'EDM_CORE_TYPE' ).
        ls_fp-data_element = val( is_row = ls_sub iv_field = 'DATA_ELEMENT' ).
        ls_fp-max_length   = val( is_row = ls_sub iv_field = 'MAX_LENGTH' ).
        APPEND ls_fp TO ls_fi-parameters.
      ENDLOOP.
      APPEND ls_fi TO rs_model-function_imports.
    ENDLOOP.

*   Symbols last, when everything is assembled and in its final order: the
*   numbering follows the order the class prints, and actions are numbered
*   after properties because that is where they appear.
    assign_text_elements( CHANGING cs_model = rs_model ).

  ENDMETHOD.

  METHOD generate.
    DATA ls_model TYPE ty_model.
    DATA ls_mpc_meta TYPE ty_file.
    DATA ls_dpc_meta TYPE ty_file.
    DATA ls_file  TYPE ty_file.
    DATA ls_result TYPE zcl_osd_tpl=>ty_result.
    DATA lo_json TYPE REF TO zif_ajson.
    DATA lv_model_json TYPE string.
    DATA lt_findings TYPE zcl_osd_dsl_profile=>tt_finding.
    DATA ls_finding TYPE zcl_osd_dsl_profile=>ty_finding.
    DATA lx_error TYPE REF TO cx_static_check.
    DATA ls_trace TYPE ty_file.

    ls_model = build_model( iv_project ).
    IF ls_model-mpc IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |{ iv_project }: no MPC class in the generated artifacts (SBD_GA)|.
    ENDIF.
    TRY.
        " one model, built once: rendered, checked and traced from the same tree
        lv_model_json = zcl_osd_dsl_mpc=>project_model_json( ls_model ).
        lo_json = zcl_ajson=>parse( lv_model_json ).
        ls_result = zcl_osd_dsl_mpc=>render_model( lo_json ).
        lt_findings = zcl_osd_dsl_profile=>check(
          iv_profile = 'abap' iv_strict = abap_false
          is_result = ls_result io_model = lo_json ).
        ls_file-name = file_name( iv_class = ls_model-mpc iv_ext = '.clas.trace.json' ).
        ls_file-content = zcl_osd_dsl_trace=>sidecar(
          iv_generator = 'dsl-mpc' iv_template = 'mpc_class'
          io_model = lo_json is_result = ls_result iv_model_json = lv_model_json ).
        ls_mpc_meta-name = file_name( iv_class = ls_model-mpc iv_ext = '.clas.trace.meta.json' ).
        ls_mpc_meta-content = zcl_osd_dsl_trace=>metadata(
          iv_generator = 'dsl-mpc' iv_template = 'mpc_class'
          io_model = lo_json is_result = ls_result iv_model_json = lv_model_json ).
        APPEND ls_mpc_meta TO rt_files.
      CATCH cx_static_check INTO lx_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING message = |{ ls_model-mpc }: { lx_error->get_text( ) }|.
    ENDTRY.
    LOOP AT lt_findings INTO ls_finding WHERE severity = 'E'.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING message = |{ ls_model-mpc }: { ls_finding-rule } at line { ls_finding-line }, template line { ls_finding-template_line }, node { ls_finding-node }: { ls_finding-text }|.
    ENDLOOP.
    APPEND ls_file TO rt_files.
    ls_file-name = file_name( iv_class = ls_model-mpc iv_ext = '.clas.abap' ).
    ls_file-content = zcl_osd_tpl=>to_string( ls_result ).
    INSERT ls_file INTO rt_files INDEX 1.
*   Warnings travel beside the class; ordinary projects gain only the trace.
    ls_file-content = warnings_json( lt_findings ).
    IF ls_file-content IS NOT INITIAL.
      ls_file-name = file_name( iv_class = ls_model-mpc iv_ext = '.clas.warnings.json' ).
      APPEND ls_file TO rt_files.
    ENDIF.
    ls_file-name    = file_name( iv_class = ls_model-mpc iv_ext = '.clas.xml' ).
    ls_file-content = zcl_stg_segw_gen_dpc=>mpc_xml( ls_model ).
    APPEND ls_file TO rt_files.
    IF ls_model-dpc IS NOT INITIAL.
      TRY.
          lv_model_json = zcl_osd_dsl_dpc=>project_model_json( ls_model ).
          lo_json = zcl_ajson=>parse( lv_model_json ).
          ls_result = zcl_osd_dsl_dpc=>render_model( lo_json ).
          lt_findings = zcl_osd_dsl_profile=>check(
            iv_profile = 'abap' iv_strict = abap_false
            is_result = ls_result io_model = lo_json ).
          ls_trace-name = file_name( iv_class = ls_model-dpc iv_ext = '.clas.trace.json' ).
          ls_trace-content = zcl_osd_dsl_trace=>sidecar(
            iv_generator = 'dsl-dpc' iv_template = 'dpc_class'
            io_model = lo_json is_result = ls_result iv_model_json = lv_model_json ).
          ls_dpc_meta-name = file_name( iv_class = ls_model-dpc iv_ext = '.clas.trace.meta.json' ).
          ls_dpc_meta-content = zcl_osd_dsl_trace=>metadata(
            iv_generator = 'dsl-dpc' iv_template = 'dpc_class'
            io_model = lo_json is_result = ls_result iv_model_json = lv_model_json ).
          APPEND ls_dpc_meta TO rt_files.
        CATCH cx_static_check INTO lx_error.
          RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
            EXPORTING message = |{ ls_model-dpc }: { lx_error->get_text( ) }|.
      ENDTRY.
      LOOP AT lt_findings INTO ls_finding WHERE severity = 'E'.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING message = |{ ls_model-dpc }: { ls_finding-rule } at line { ls_finding-line }, template line { ls_finding-template_line }, node { ls_finding-node }: { ls_finding-text }|.
      ENDLOOP.
      ls_file-name    = file_name( iv_class = ls_model-dpc iv_ext = '.clas.abap' ).
      ls_file-content = zcl_osd_tpl=>to_string( ls_result ).
      APPEND ls_file TO rt_files.
      APPEND ls_trace TO rt_files.
      ls_file-content = warnings_json( lt_findings ).
      IF ls_file-content IS NOT INITIAL.
        ls_file-name = file_name( iv_class = ls_model-dpc iv_ext = '.clas.warnings.json' ).
        APPEND ls_file TO rt_files.
      ENDIF.
      ls_file-name    = file_name( iv_class = ls_model-dpc iv_ext = '.clas.xml' ).
      ls_file-content = zcl_stg_segw_gen_dpc=>dpc_xml( ls_model ).
      APPEND ls_file TO rt_files.
    ENDIF.
    APPEND LINES OF zcl_stg_segw_gen_dpc=>ext_sources( ls_model ) TO rt_files.
  ENDMETHOD.

  METHOD warnings_json.
    DATA ls_finding TYPE zcl_osd_dsl_profile=>ty_finding.
    DATA lv_first TYPE abap_bool.

    lv_first = abap_true.
    LOOP AT it_findings INTO ls_finding WHERE severity = 'W'.
      IF lv_first = abap_false.
        rv_json = rv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      rv_json = rv_json && `{"line":` && |{ ls_finding-line }|
        && `,"template_line":` && |{ ls_finding-template_line }|
        && `,"node":"` && zcl_stg_json=>escape( ls_finding-node )
        && `","rule":"` && zcl_stg_json=>escape( ls_finding-rule )
        && `","text":"` && zcl_stg_json=>escape( ls_finding-text ) && `"}`.
    ENDLOOP.
    IF lv_first = abap_false.
      rv_json = `{"warnings":[` && rv_json && `]}`.
    ENDIF.
  ENDMETHOD.

  METHOD slice.
    DATA lv_len TYPE i.
    DATA lv_to  TYPE i.

    lv_len = strlen( iv_text ).
    lv_to = iv_to.
    IF lv_to > lv_len.
      lv_to = lv_len.
    ENDIF.
    IF iv_from >= lv_to.
      RETURN.
    ENDIF.
    rv_text = substring( val = iv_text off = iv_from len = lv_to - iv_from ).
  ENDMETHOD.

  METHOD last_segment.
    DATA lv_at   TYPE i.
    DATA lv_next TYPE i.

    rv_text = iv_path.
    lv_at = 0.
    DO.
      lv_next = find( val = iv_path sub = '\' off = lv_at ).
      IF lv_next < 0.
        EXIT.
      ENDIF.
      lv_at = lv_next + 1.
      rv_text = substring( val = iv_path off = lv_at ).
    ENDDO.
  ENDMETHOD.

  METHOD file_name.
* abapGit writes /NS/CL_X as #ns#cl_x
    rv_name = to_lower( replace( val = iv_class sub = '/' with = '#' occ = 0 ) ) && iv_ext.
  ENDMETHOD.

  METHOD set_operations.
* --------------------------------------------------------- MPC source
    DATA ls_se     TYPE ty_row.
    DATA ls_op_row TYPE ty_row.
    DATA ls_mh     TYPE ty_row.
    DATA ls_ds     TYPE ty_row.
    DATA ls_op     TYPE ty_operation.
    DATA ls_mp     TYPE ty_row.
    DATA ls_mr     TYPE ty_row.
    DATA ls_prop   TYPE ty_map_prop.
    DATA ls_range  TYPE ty_map_range.
    DATA lt_nodes  TYPE string_table.
    DATA lv_node   TYPE string.
    DATA lv_group  TYPE string.
    DATA lv_kind   TYPE string.
    DATA lv_at     TYPE i.
    DATA lv_path   TYPE string.

    LOOP AT it_se INTO ls_se.
      IF val( is_row = ls_se iv_field = 'ENTITY_SET_UUID' ) = cs_set-uuid.
        EXIT.
      ENDIF.
      CLEAR ls_se.
    ENDLOOP.
    IF ls_se-uuid IS INITIAL.
      RETURN.
    ENDIF.
    APPEND ls_se-uuid TO lt_nodes.
    LOOP AT it_op INTO ls_op_row.
      IF val( is_row = ls_op_row iv_field = 'PARENT_UUID' ) <> ls_se-uuid.
        CONTINUE.
      ENDIF.
      APPEND ls_op_row-uuid TO lt_nodes.
      CLEAR ls_op.
      ls_op-type   = val( is_row = ls_op_row iv_field = 'OPERATION_TYPE' ).
      ls_op-method = val( is_row = ls_op_row iv_field = 'IMP_METHOD' ).
* "Map to Data Source" on the operation: its mapping header points at a
* function module (DS_TYPE 2) or a search help (6)
      LOOP AT it_mh INTO ls_mh.
        IF val( is_row = ls_mh iv_field = 'PARENT_UUID' ) <> ls_op_row-uuid.
          CONTINUE.
        ENDIF.
        lv_node = val( is_row = ls_mh iv_field = 'DS_UUID' ).
        READ TABLE it_ds INTO ls_ds WITH KEY uuid = lv_node.
        IF sy-subrc <> 0.
          EXIT.
        ENDIF.
        CASE val( is_row = ls_ds iv_field = 'DS_TYPE' ).
          WHEN '2'.
            ls_op-mapping_kind  = 'RFC'.
            ls_op-function_name = val( is_row = ls_ds iv_field = 'FUNCTION_NAME' ).
            IF ls_op-function_name IS INITIAL.
              ls_op-function_name = ls_ds-name.
            ENDIF.
            ls_op-function_group = val( is_row = ls_ds iv_field = 'DS_GROUP' ).
            ls_op-destination    = val( is_row = ls_ds iv_field = 'RFC_DEST' ).
            ls_op-log_attr       = val( is_row = ls_ds iv_field = 'LOG_DS_ATTR' ).
          WHEN '6'.
            ls_op-mapping_kind  = 'SHLP'.
            ls_op-function_name = ls_ds-name.
            ls_op-max_hits_attr = val( is_row = ls_ds iv_field = 'MAX_HITS_DS_ATTR' ).
          WHEN OTHERS.
            EXIT.
        ENDCASE.
* the property rows under the mapping header, then the range components
* of those rows
        LOOP AT it_mp INTO ls_mp.
          IF val( is_row = ls_mp iv_field = 'PARENT_UUID' ) <> ls_mh-uuid.
            CONTINUE.
          ENDIF.
          CLEAR ls_prop.
          ls_prop-uuid        = ls_mp-uuid.
          ls_prop-property    = val( is_row = ls_mp iv_field = 'PROPERTY_PATH' ).
          ls_prop-direction   = val( is_row = ls_mp iv_field = 'DIRECTION' ).
          ls_prop-ds_att_path = val( is_row = ls_mp iv_field = 'DS_ATT_PATH' ).
          ls_prop-constant    = val( is_row = ls_mp iv_field = 'CONSTANT_VAL' ).
          ls_prop-has_constant = xsdbool( ls_prop-constant IS NOT INITIAL ).
          APPEND ls_prop TO ls_op-props.
        ENDLOOP.
        LOOP AT it_mr INTO ls_mr.
          READ TABLE ls_op-props WITH KEY uuid = ls_mr-uuid TRANSPORTING NO FIELDS.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          CLEAR ls_range.
          ls_range-mp_uuid   = ls_mr-uuid.
          lv_path = val( is_row = ls_mr iv_field = 'DS_ATT_PATH' ).
          ls_range-component = last_segment( lv_path ).
          ls_range-semantics = val( is_row = ls_mr iv_field = 'SEMANTICS' ).
          APPEND ls_range TO ls_op-ranges.
        ENDLOOP.
        EXIT.
      ENDLOOP.
      APPEND ls_op TO cs_set-operations.
    ENDLOOP.
* SADL: a mapping under the design set node or one of its operations to a
* data source of type 4 whose group is DDIC~, CDS~, EPM~ or ODC~
    LOOP AT it_mh INTO ls_mh.
      lv_node = val( is_row = ls_mh iv_field = 'PARENT_UUID' ).
      READ TABLE lt_nodes WITH KEY table_line = lv_node TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      lv_node = val( is_row = ls_mh iv_field = 'DS_UUID' ).
      READ TABLE it_ds INTO ls_ds WITH KEY uuid = lv_node.
      IF sy-subrc <> 0 OR val( is_row = ls_ds iv_field = 'DS_TYPE' ) <> '4'.
        CONTINUE.
      ENDIF.
      lv_group = val( is_row = ls_ds iv_field = 'DS_GROUP' ).
      lv_at = find( val = lv_group sub = '~' ).
      IF lv_at < 0.
        CONTINUE.
      ENDIF.
      lv_kind = substring( val = lv_group len = lv_at ).
      IF lv_kind <> 'DDIC' AND lv_kind <> 'CDS' AND lv_kind <> 'EPM' AND lv_kind <> 'ODC'.
        CONTINUE.
      ENDIF.
      cs_set-sadl_type    = lv_kind.
      cs_set-sadl_binding = substring( val = lv_group off = lv_at + 1 ).
      IF lv_kind = 'ODC'.
        lv_at = find( val = cs_set-sadl_binding sub = '~' ).
        IF lv_at >= 0.
          cs_set-sadl_service = substring( val = cs_set-sadl_binding len = lv_at ).
          cs_set-sadl_set     = substring( val = cs_set-sadl_binding off = lv_at + 1 ).
        ELSE.
          cs_set-sadl_service = cs_set-sadl_binding.
        ENDIF.
      ENDIF.
      RETURN.
    ENDLOOP.
  ENDMETHOD.

  METHOD sort_properties.
    DATA lt_sorted TYPE tt_property.
    DATA lt_keys   TYPE STANDARD TABLE OF i.
    DATA ls_prop   TYPE ty_property.
    DATA lv_order  TYPE string.
    DATA lv_key    TYPE i.
    DATA lv_other  TYPE i.
    DATA lv_at     TYPE i.

    LOOP AT ct_properties INTO ls_prop.
      READ TABLE it_order INDEX sy-tabix INTO lv_order.
      IF lv_order IS INITIAL.
        lv_key = 0.
      ELSE.
        lv_key = lv_order.
      ENDIF.
      lv_at = 0.
      LOOP AT lt_keys INTO lv_other.
        IF lv_other > lv_key.
          lv_at = sy-tabix.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_at = 0.
        APPEND lv_key TO lt_keys.
        APPEND ls_prop TO lt_sorted.
      ELSE.
        INSERT lv_key INTO lt_keys INDEX lv_at.
        INSERT ls_prop INTO lt_sorted INDEX lv_at.
      ENDIF.
    ENDLOOP.
    ct_properties = lt_sorted.
  ENDMETHOD.

  METHOD ab.
    IF iv_bool = abap_true.
      rv_text = 'abap_true'.
    ELSE.
      rv_text = 'abap_false'.
    ENDIF.
  ENDMETHOD.

  METHOD edm_setter.
    CASE iv_edm_type.
      WHEN 'Edm.String'.
        rv_text = 'string'.
      WHEN 'Edm.DateTime'.
        rv_text = 'datetime'.
      WHEN 'Edm.Guid'.
        rv_text = 'guid'.
      WHEN 'Edm.Int16'.
        rv_text = 'int16'.
      WHEN 'Edm.Int32'.
        rv_text = 'int32'.
      WHEN 'Edm.Int64'.
        rv_text = 'int64'.
      WHEN 'Edm.Decimal'.
        rv_text = 'decimal'.
      WHEN 'Edm.Boolean'.
        rv_text = 'boolean'.
      WHEN 'Edm.Time'.
        rv_text = 'time'.
      WHEN 'Edm.Byte'.
        rv_text = 'byte'.
      WHEN 'Edm.SByte'.
        rv_text = 'sbyte'.
      WHEN 'Edm.Binary'.
        rv_text = 'binary'.
      WHEN 'Edm.Double'.
        rv_text = 'double'.
      WHEN 'Edm.Float'.
        rv_text = 'float'.
      WHEN 'Edm.Single'.
        rv_text = 'single'.
      WHEN 'Edm.DateTimeOffset'.
        rv_text = 'datetimeoffset'.
      WHEN OTHERS.
        rv_text = 'string'.
    ENDCASE.
  ENDMETHOD.

  METHOD packed_length.
    DATA lv_digits TYPE i.
    lv_digits = iv_digits.
    rv_length = lv_digits DIV 2 + 1.
  ENDMETHOD.

  METHOD inline_type.
* what SEGW declares for a property without a DDIC type; a TYPE_NAME in
* the tree wins
    DATA lv_decimals TYPE string.
    DATA lv_digits   TYPE string.

    IF is_property-type_name IS NOT INITIAL.
      rv_text = is_property-type_name.
      RETURN.
    ENDIF.
    IF is_property-type_kind = 'P' AND is_property-length IS NOT INITIAL.
      lv_decimals = is_property-decimals.
      IF lv_decimals IS INITIAL.
        lv_decimals = '0'.
      ENDIF.
      rv_text = |p length { packed_length( is_property-length ) } decimals { lv_decimals }|.
      RETURN.
    ENDIF.
    CASE is_property-edm_type.
      WHEN 'Edm.String'.
        IF is_property-max_length IS NOT INITIAL.
          rv_text = |c length { is_property-max_length }|.
        ELSE.
          rv_text = 'string'.
        ENDIF.
      WHEN 'Edm.Decimal'.
        lv_digits = is_property-digits.
        IF lv_digits IS INITIAL.
          lv_digits = '31'.
        ENDIF.
        lv_decimals = is_property-scale.
        IF lv_decimals IS INITIAL.
          lv_decimals = '0'.
        ENDIF.
        rv_text = |p length { packed_length( lv_digits ) } decimals { lv_decimals }|.
      WHEN 'Edm.Double'.
        rv_text = 'f'.
      WHEN 'Edm.Guid'.
        rv_text = 'SYSUUID_X'.
      WHEN 'Edm.Int32'.
        rv_text = 'i'.
      WHEN 'Edm.Int16'.
        rv_text = '/IWBEP/SB_ODATA_TY_INT2'.
      WHEN 'Edm.Boolean'.
        rv_text = 'FLAG'.
      WHEN 'Edm.DateTime'.
        rv_text = 'TIMESTAMP'.
      WHEN 'Edm.Time'.
        rv_text = 'TIMS'.
      WHEN 'Edm.Byte'.
        rv_text = 'INT1'.
      WHEN OTHERS.
        rv_text = 'string'.
    ENDCASE.
  ENDMETHOD.

  METHOD action_type.
* ABAP type names stop at 30 characters
    rv_text = 'TS_' && to_upper( is_function-name ).
    IF strlen( rv_text ) > 30.
      rv_text = substring( val = rv_text len = 30 ).
    ENDIF.
  ENDMETHOD.

  METHOD action_parameter_type.
    IF is_parameter-data_element IS NOT INITIAL.
      rv_text = is_parameter-data_element.
      RETURN.
    ENDIF.
    CASE is_parameter-edm_type.
      WHEN 'Edm.String'.
        rv_text = 'STRING'.
      WHEN 'Edm.Guid'.
        rv_text = 'SYSUUID_X'.
      WHEN 'Edm.Int32' OR 'Edm.Int16'.
        rv_text = 'I'.
      WHEN 'Edm.Boolean'.
        rv_text = 'XSDBOOLEAN'.
      WHEN 'Edm.DateTime'.
        rv_text = 'TIMESTAMP'.
      WHEN 'Edm.Decimal'.
        rv_text = 'P LENGTH 16 DECIMALS 3'.
      WHEN 'Edm.Time'.
        rv_text = 'TIMS'.
      WHEN OTHERS.
        rv_text = 'STRING'.
    ENDCASE.
  ENDMETHOD.

  METHOD banner.
    rv_text = |*&---------------------------------------------------------------------*\n|
      && |*&           Generated code for the MODEL PROVIDER BASE CLASS         &*\n|
      && |*&                                                                     &*\n|
      && |*&  !!!NEVER MODIFY THIS CLASS. IN CASE YOU WANT TO CHANGE THE MODEL  &*\n|
      && |*&        DO THIS IN THE MODEL PROVIDER SUBCLASS!!!                   &*\n|
      && |*&                                                                     &*\n|
      && |*&---------------------------------------------------------------------*\n|.
  ENDMETHOD.

  METHOD assign_text_elements.
* Numbering starts **above whatever the tree already carries**, not at 001.
* A project read from a real IWPR arrives with SEGW's own symbols, and
* renumbering them points the generated calls at somebody else's text -- the
* difference between reproducing a corpus file and rewriting it.
*
* Properties first, then actions and their parameters, because that is the
* order the class prints them in.
*
* **Two rules, not one.** A property with no label gets no symbol: inventing
* one would put a text in the model the author never wrote. An action and a
* parameter take their **own name** when nothing else is given, because that
* is what a system shows -- `sap:label="CancelTravel"`, `sap:label="Status"`.
* The first version of this had one rule and was written for the defect that
* had been seen rather than for the rule behind it.
*
* **The second rule is an open question, with a measurement on each side
* (2026-09-20).** For it: SEGW regenerated this MPC from our tree on A4H and
* wrote the label call after create_action, and test/stg-compile.mjs pins
* those bytes -- but our tree carries FI_LABEL, because stg-compile writes
* one. Against it: the one real SEGW-generated MPC in the corpus that has
* actions has 39 property labels, symbols 001-039 with no gaps, a pool of
* exactly 39, and two actions with four parameters carrying no symbol at
* all; under this rule that pool would hold 45. Both hold if SEGW emits the
* call when the TREE carries a label and not otherwise, in which case this
* rule gives the measured bytes for the wrong reason and would give wrong
* ones for a project imported from a real IWPR. Not changed on that
* inference: one A4H run settles it -- an action with no label typed,
* regenerated, read. See tools/segw-gen.mjs for the same note.
* A second opinion was asked and agreed (2026-09-20).
*
* The labels of actions and parameters ARE read now, out of SBO_FIT and
* SBO_FPT, and the note that stood here said they were not, for a reason that
* was wrong: `ty_function_import` carries no node uuid, but it does not need
* one -- the ROW does, and build_model reads the label while it still has it.
* What has no uuid is the model after it is assembled, which is where this
* method runs, and the two were confused.
*
* It survived because all three implementations were blind in the same place:
* `stg-compile` wrote FI_LABEL equal to the name, and neither generator read
* the text tables, so the byte comparison between them was green and correct
* -- it asks whether the two agree, not whether either is right. Not one of
* the fixtures had a function import at all, so no tree in the suite could
* express the thing they both ignored. `test/fixtures/segw/zstg_label` is
* that tree, and the pool is asserted against a label a person typed.
    DATA lv_next TYPE i.
    DATA lv_max  TYPE i.
    DATA lv_num  TYPE i.
    FIELD-SYMBOLS <ls_type>  TYPE ty_entity_type.
    FIELD-SYMBOLS <ls_prop>  TYPE ty_property.
    FIELD-SYMBOLS <ls_fi>    TYPE ty_function_import.
    FIELD-SYMBOLS <ls_param> TYPE ty_parameter.

    LOOP AT cs_model-entity_types ASSIGNING <ls_type>.
      LOOP AT <ls_type>-properties ASSIGNING <ls_prop>.
        IF <ls_prop>-text_element IS NOT INITIAL.
          lv_num = <ls_prop>-text_element.
          IF lv_num > lv_max.
            lv_max = lv_num.
          ENDIF.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
    lv_next = lv_max + 1.

    LOOP AT cs_model-entity_types ASSIGNING <ls_type>.
      LOOP AT <ls_type>-properties ASSIGNING <ls_prop>.
        IF <ls_prop>-text_element IS NOT INITIAL OR <ls_prop>-label IS INITIAL.
          CONTINUE.
        ENDIF.
        <ls_prop>-text_element = |{ lv_next WIDTH = 3 PAD = '0' ALIGN = RIGHT }|.
        lv_next = lv_next + 1.
      ENDLOOP.
    ENDLOOP.

    LOOP AT cs_model-function_imports ASSIGNING <ls_fi>.
      IF <ls_fi>-text_element IS INITIAL.
        <ls_fi>-text_element = |{ lv_next WIDTH = 3 PAD = '0' ALIGN = RIGHT }|.
        lv_next = lv_next + 1.
      ENDIF.
      LOOP AT <ls_fi>-parameters ASSIGNING <ls_param>.
        IF <ls_param>-text_element IS INITIAL.
          <ls_param>-text_element = |{ lv_next WIDTH = 3 PAD = '0' ALIGN = RIGHT }|.
          lv_next = lv_next + 1.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD property_code.
    IF is_property-complex_type IS NOT INITIAL.
      rv_text = |lo_complex_type = lo_entity_type->create_complex_property( iv_property_name = '{ is_property-name }'\n|
        && |                                                           iv_complex_type_name = '{ is_property-complex_type }'\n|
        && |                                                           iv_abap_fieldname    = '{ is_property-abap_field }' ). "#EC NOTEXT\n|.
      RETURN.
    ENDIF.
    rv_text = |lo_property = lo_entity_type->create_property( iv_property_name = '{ is_property-name }' iv_abap_fieldname = '{ is_property-abap_field }' ). "#EC NOTEXT\n|.
    IF is_property-is_key = abap_true.
      rv_text = rv_text && |lo_property->set_is_key( ).\n|.
    ENDIF.
*   The label goes after the key and **before** the type, and it carries two
*   spaces before the comment where a parameter's carries one. Neither is a
*   choice: both are what SEGW writes, and a byte comparison is the only
*   reader that can tell.
    IF is_property-text_element IS NOT INITIAL.
      rv_text = rv_text
        && |lo_property->set_label_from_text_element( iv_text_element_symbol = '{ is_property-text_element }' |
        && |iv_text_element_container = gc_incl_name ).  "#EC NOTEXT\n|.
    ENDIF.
    rv_text = rv_text && |lo_property->set_type_edm_{ edm_setter( is_property-edm_type ) }( ).\n|.
    IF is_property-precision IS NOT INITIAL.
      rv_text = rv_text && |lo_property->set_precison( iv_precision = { is_property-precision } ). "#EC NOTEXT\n|.
    ENDIF.
    IF is_property-max_length IS NOT INITIAL.
      rv_text = rv_text && |lo_property->set_maxlength( iv_max_length = { is_property-max_length } ). "#EC NOTEXT\n|.
    ENDIF.
    IF is_property-semantics IS NOT INITIAL.
      rv_text = rv_text && |lo_property->set_semantic( '{ is_property-semantics }' ). "#EC NOTEXT\n|.
    ENDIF.
    rv_text = rv_text
      && |lo_property->set_creatable( { ab( is_property-creatable ) } ).\n|
      && |lo_property->set_updatable( { ab( is_property-updatable ) } ).\n|
      && |lo_property->set_sortable( { ab( is_property-sortable ) } ).\n|
      && |lo_property->set_nullable( { ab( is_property-nullable ) } ).\n|
      && |lo_property->set_filterable( { ab( is_property-filterable ) } ).\n|
      && |lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(\n|
      && |      EXPORTING\n|
      && |        iv_key      = 'unicode'\n|
      && |        iv_value    = 'false' ).\n|.
    IF is_property-as_etag = abap_true.
      rv_text = rv_text && |lo_property->set_as_etag( ).\n|.
    ENDIF.
  ENDMETHOD.

  METHOD define_entity_method.
    DATA ls_property TYPE ty_property.
    DATA ls_set      TYPE ty_entity_set.

    rv_text = |  method DEFINE_{ is_type-define_stem }.\n{ banner( ) }\n\n  data:\n|
      && |        lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,                "#EC NEEDED\n|
      && |        lo_entity_type    type ref to /iwbep/if_mgw_odata_entity_typ,                "#EC NEEDED\n|
      && |        lo_complex_type   type ref to /iwbep/if_mgw_odata_cmplx_type,                "#EC NEEDED\n|
      && |        lo_property       type ref to /iwbep/if_mgw_odata_property,                  "#EC NEEDED\n|
      && |        lo_entity_set     type ref to /iwbep/if_mgw_odata_entity_set.                "#EC NEEDED\n|
      && |\n{ gc_stars }\n*   ENTITY - { is_type-name }\n{ gc_stars }\n\n|
      && |lo_entity_type = model->create_entity_type( iv_entity_type_name = '{ is_type-name }' iv_def_entity_set = abap_false ). "#EC NOTEXT\n|.
* a media entity: the type carries a stream, $metadata says m:HasStream
    IF is_type-is_media = abap_true.
      rv_text = rv_text && |lo_entity_type->set_is_media( 'X' ).  "#EC NOTEXT\n|.
    ENDIF.
    rv_text = rv_text && |\n{ gc_stars }\n*Properties\n{ gc_stars }\n\n|.
    LOOP AT is_type-properties INTO ls_property.
      rv_text = rv_text && property_code( ls_property ).
    ENDLOOP.
    IF is_type-properties IS INITIAL.
      rv_text = rv_text && |\n|.
    ENDIF.
    IF is_type-abap_struct IS NOT INITIAL.
      rv_text = rv_text && |\nlo_entity_type->bind_structure( iv_structure_name   = '{ is_type-abap_struct }'\n|
        && |                                iv_bind_conversions = 'X' ). "#EC NOTEXT\n\n|.
    ELSE.
      rv_text = rv_text && |\nlo_entity_type->bind_structure( iv_structure_name  = '{ iv_mpc }=>TS_{ is_type-type_stem }' ). "#EC NOTEXT\n\n|.
    ENDIF.
    rv_text = rv_text && |\n{ gc_stars }\n*   ENTITY SETS\n{ gc_stars }\n|.
    LOOP AT is_type-entity_sets INTO ls_set.
      rv_text = rv_text
        && |lo_entity_set = lo_entity_type->create_entity_set( '{ ls_set-name }' ). "#EC NOTEXT\n\n|
        && |lo_entity_set->set_creatable( { ab( ls_set-creatable ) } ).\n|
        && |lo_entity_set->set_updatable( { ab( ls_set-updatable ) } ).\n|
        && |lo_entity_set->set_deletable( { ab( ls_set-deletable ) } ).\n\n|
        && |lo_entity_set->set_pageable( { ab( ls_set-pageable ) } ).\n|
        && |lo_entity_set->set_addressable( { ab( ls_set-addressable ) } ).\n|
        && |lo_entity_set->set_has_ftxt_search( { ab( ls_set-searchable ) } ).\n|
        && |lo_entity_set->set_subscribable( { ab( ls_set-subscribable ) } ).\n|
        && |lo_entity_set->set_filter_required( { ab( ls_set-filter_required ) } ).\n|.
    ENDLOOP.
    rv_text = rv_text && |  endmethod.\n|.
  ENDMETHOD.

  METHOD define_complex_types_method.
    DATA ls_ct       TYPE ty_complex_type.
    DATA ls_property TYPE ty_property.

    rv_text = |  method DEFINE_COMPLEXTYPES.\n{ banner( ) }\n\n data:\n|
      && |       lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,             "#EC NEEDED\n|
      && |       lo_complex_type   type ref to /iwbep/if_mgw_odata_cmplx_type,             "#EC NEEDED\n|
      && |       lo_property       type ref to /iwbep/if_mgw_odata_property.                "#EC NEEDED\n|.
    LOOP AT is_model-complex_types INTO ls_ct.
      rv_text = rv_text && |\n{ gc_stars }\n*   COMPLEX TYPE - { ls_ct-name }\n{ gc_stars }\n\n|
        && |lo_complex_type = model->create_complex_type( '{ ls_ct-name }' ). "#EC NOTEXT\n|
        && |\n{ gc_stars }\n*Properties\n{ gc_stars }\n\n|.
      LOOP AT ls_ct-properties INTO ls_property.
        rv_text = rv_text
          && |lo_property = lo_complex_type->create_property( iv_property_name  = '{ ls_property-name }' iv_abap_fieldname = '{ ls_property-abap_field }' ). "#EC NOTEXT\n|
          && |lo_property->set_type_edm_{ edm_setter( ls_property-edm_type ) }( ).\n|.
        IF ls_property-precision IS NOT INITIAL.
          rv_text = rv_text && |lo_property->set_precison( iv_precision = { ls_property-precision } ). "#EC NOTEXT\n|.
        ENDIF.
        IF ls_property-max_length IS NOT INITIAL.
          rv_text = rv_text && |lo_property->set_maxlength( iv_max_length = { ls_property-max_length } ).\n|.
        ENDIF.
        IF ls_property-semantics IS NOT INITIAL.
          rv_text = rv_text && |lo_property->set_semantic( '{ ls_property-semantics }' ). "#EC NOTEXT\n|.
        ENDIF.
        rv_text = rv_text
          && |lo_property->set_creatable( { ab( ls_property-creatable ) } ).\n|
          && |lo_property->set_updatable( { ab( ls_property-updatable ) } ).\n|
          && |lo_property->set_sortable( { ab( ls_property-sortable ) } ).\n|
          && |lo_property->set_nullable( { ab( ls_property-nullable ) } ).\n|
          && |lo_property->set_filterable( { ab( ls_property-filterable ) } ).\n|.
      ENDLOOP.
      IF ls_ct-abap_struct IS NOT INITIAL.
        rv_text = rv_text && |lo_complex_type->bind_structure( iv_structure_name   = '{ ls_ct-abap_struct }'\n|
          && |                                 iv_bind_conversions = 'X' ). "#EC NOTEXT\n|.
      ELSE.
        rv_text = rv_text && |lo_complex_type->bind_structure( iv_structure_name = '{ is_model-mpc }=>{ to_upper( ls_ct-name ) }' ). "#EC NOTEXT\n|.
      ENDIF.
    ENDLOOP.
    rv_text = rv_text && |  endmethod.\n|.
  ENDMETHOD.

  METHOD define_associations_method.
    DATA ls_aso  TYPE ty_association.
    DATA ls_rc   TYPE ty_constraint.
    DATA ls_as   TYPE ty_assoc_set.
    DATA ls_type TYPE ty_entity_type.
    DATA ls_nav  TYPE ty_navigation.
    DATA lv_any  TYPE abap_bool.

    rv_text = |  method DEFINE_ASSOCIATIONS.\n{ banner( ) }\n\n\n\ndata:\n|
      && |lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,                   "#EC NEEDED\n|
      && |lo_entity_type    type ref to /iwbep/if_mgw_odata_entity_typ,                   "#EC NEEDED\n|
      && |lo_association    type ref to /iwbep/if_mgw_odata_assoc,                        "#EC NEEDED\n|
      && |lo_ref_constraint type ref to /iwbep/if_mgw_odata_ref_constr,                   "#EC NEEDED\n|
      && |lo_assoc_set      type ref to /iwbep/if_mgw_odata_assoc_set,                    "#EC NEEDED\n|
      && |lo_nav_property   type ref to /iwbep/if_mgw_odata_nav_prop.                     "#EC NEEDED\n|
      && |\n{ gc_stars }\n*   ASSOCIATIONS\n{ gc_stars }\n\n|.
    LOOP AT is_model-associations INTO ls_aso.
      rv_text = rv_text
        && | lo_association = model->create_association(\n|
        && |                            iv_association_name = '{ ls_aso-name }' "#EC NOTEXT\n|
        && |                            iv_left_type        = '{ ls_aso-left_type }' "#EC NOTEXT\n|
        && |                            iv_right_type       = '{ ls_aso-right_type }' "#EC NOTEXT\n|
        && |                            iv_right_card       = '{ ls_aso-right_card }' "#EC NOTEXT\n|
        && |                            iv_left_card        = '{ ls_aso-left_card }'  "#EC NOTEXT\n|
        && |                            iv_def_assoc_set    = { ab( xsdbool( ls_aso-sets IS INITIAL ) ) } ). "#EC NOTEXT\n|.
      IF ls_aso-constraints IS NOT INITIAL.
        rv_text = rv_text && |* Referential constraint for association - { ls_aso-name }\nlo_ref_constraint = lo_association->create_ref_constraint( ).\n|.
        LOOP AT ls_aso-constraints INTO ls_rc.
          rv_text = rv_text && |lo_ref_constraint->add_property( iv_principal_property = '{ ls_rc-principal }'   iv_dependent_property = '{ ls_rc-dependent }' ). "#EC NOTEXT\n|.
        ENDLOOP.
      ENDIF.
      LOOP AT ls_aso-sets INTO ls_as.
        rv_text = rv_text
          && |lo_assoc_set = model->create_association_set( iv_association_set_name  = '{ ls_as-name }'                         "#EC NOTEXT\n|
          && |                                              iv_left_entity_set_name  = '{ ls_as-left_set }'              "#EC NOTEXT\n|
          && |                                              iv_right_entity_set_name = '{ ls_as-right_set }'             "#EC NOTEXT\n|
          && |                                              iv_association_name      = '{ ls_aso-name }' ).                                 "#EC NOTEXT\n|.
      ENDLOOP.
      rv_text = rv_text && |\n|.
    ENDLOOP.
    rv_text = rv_text && |\n{ gc_stars }\n*   NAVIGATION PROPERTIES\n{ gc_stars }\n|.
    LOOP AT is_model-entity_types INTO ls_type.
      lv_any = abap_false.
      LOOP AT is_model-navigation INTO ls_nav.
        IF ls_nav-entity <> ls_type-name.
          CONTINUE.
        ENDIF.
        IF lv_any = abap_false.
          lv_any = abap_true.
          rv_text = rv_text && |\n* Navigation Properties for entity - { ls_type-name }\nlo_entity_type = model->get_entity_type( iv_entity_name = '{ ls_type-name }' ). "#EC NOTEXT\n|.
        ENDIF.
        rv_text = rv_text
          && |lo_nav_property = lo_entity_type->create_navigation_property( iv_property_name  = '{ ls_nav-name }' "#EC NOTEXT\n|
          && |                                                              iv_abap_fieldname = '{ ls_nav-abap_field }' "#EC NOTEXT\n|
          && |                                                              iv_association_name = '{ ls_nav-association }' ). "#EC NOTEXT\n|.
      ENDLOOP.
    ENDLOOP.
    rv_text = rv_text && |  endmethod.\n|.
  ENDMETHOD.

  METHOD define_actions_method.
    DATA ls_fi TYPE ty_function_import.
    DATA ls_fp TYPE ty_parameter.

    rv_text = |  method DEFINE_ACTIONS.\n{ banner( ) }\n\n\ndata:\n|
      && |lo_action         type ref to /iwbep/if_mgw_odata_action,                 "#EC NEEDED\n|
      && |lo_parameter      type ref to /iwbep/if_mgw_odata_parameter.              "#EC NEEDED\n|.
    LOOP AT is_model-function_imports INTO ls_fi.
      rv_text = rv_text && |\n{ gc_stars }\n*   ACTION - { ls_fi-name }\n{ gc_stars }\n\n|
        && |lo_action = model->create_action( '{ ls_fi-name }' ).  "#EC NOTEXT\n|.
      IF ls_fi-text_element IS NOT INITIAL.
        rv_text = rv_text
          && |lo_action->set_label_from_text_element( iv_text_element_symbol = '{ ls_fi-text_element }' |
          && |iv_text_element_container = gc_incl_name ).  "#EC NOTEXT\n|.
      ENDIF.
      IF ls_fi-return_kind = 'ETYP'.
        rv_text = rv_text && |*Set return entity type\nlo_action->set_return_entity_type( '{ ls_fi-return_type }' ). "#EC NOTEXT\n|.
      ELSEIF ls_fi-return_kind = 'CTYP'.
        rv_text = rv_text && |*Set return complex type\nlo_action->set_return_complex_type( '{ ls_fi-return_type }' ). "#EC NOTEXT\n|.
      ENDIF.
      IF ls_fi-http_method IS NOT INITIAL.
        rv_text = rv_text && |*Set HTTP method GET or POST\nlo_action->set_http_method( '{ ls_fi-http_method }' ). "#EC NOTEXT\n|.
      ENDIF.
*     SEGW writes the action-for before the multiplicity, and the order is
*     the generator's own rather than a reading of the calls: swapping them
*     changes nothing a system does and everything a byte comparison says.
      IF ls_fi-action_for IS NOT INITIAL.
        rv_text = rv_text && |*Set the action for entity\nlo_action->set_action_for( '{ ls_fi-action_for }' ). "#EC NOTEXT\n|.
      ENDIF.
      rv_text = rv_text && |* Set return type multiplicity\nlo_action->set_return_multiplicity( '{ ls_fi-return_card }' ). "#EC NOTEXT\n|.
      IF ls_fi-parameters IS NOT INITIAL.
        rv_text = rv_text && |{ gc_stars }\n* Parameters\n{ gc_stars }\n\n|.
        LOOP AT ls_fi-parameters INTO ls_fp.
          rv_text = rv_text
            && |lo_parameter = lo_action->create_input_parameter( iv_parameter_name = '{ ls_fp-name }'    iv_abap_fieldname = '{ ls_fp-abap_field }' ). "#EC NOTEXT\n|.
*         The label goes between the parameter and its type, where SEGW
*         puts it. Emitted after the type instead, the file compares equal
*         for one line more and then does not -- the order of two calls
*         that a system does not care about is the whole of the difference.
          IF ls_fp-text_element IS NOT INITIAL.
            rv_text = rv_text
              && |lo_parameter->set_label_from_text_element( iv_text_element_symbol = '{ ls_fp-text_element }' |
              && |iv_text_element_container = gc_incl_name ). "#EC NOTEXT\n|.
          ENDIF.
          rv_text = rv_text
            && |lo_parameter->/iwbep/if_mgw_odata_property~set_type_edm_{ edm_setter( ls_fp-edm_type ) }( ).\n|.
          IF ls_fp-max_length IS NOT INITIAL AND ls_fp-edm_type = 'Edm.String'.
            rv_text = rv_text && |lo_parameter->/iwbep/if_mgw_odata_property~set_maxlength( iv_max_length = { ls_fp-max_length } ). "#EC NOTEXT\n|.
          ENDIF.
        ENDLOOP.
        rv_text = rv_text && |lo_action->bind_input_structure( iv_structure_name  = '{ is_model-mpc }=>{ action_type( ls_fi ) }' ). "#EC NOTEXT\n|.
      ENDIF.
    ENDLOOP.
    rv_text = rv_text && |  endmethod.\n|.
  ENDMETHOD.

  METHOD mpc_source.
    rv_source = zcl_osd_tpl=>to_string( zcl_osd_dsl_mpc=>render_class( is_model ) ).
  ENDMETHOD.

  METHOD mpc_source_legacy.
    DATA lv_cls       TYPE string.
    DATA lv_has_assoc TYPE abap_bool.
    DATA lv_has_act   TYPE abap_bool.
    DATA lv_has_cplx  TYPE abap_bool.
    DATA lt_blocks    TYPE string_table.
    DATA lv_block     TYPE string.
    DATA ls_ct        TYPE ty_complex_type.
    DATA ls_fi        TYPE ty_function_import.
    DATA ls_fp        TYPE ty_parameter.
    DATA ls_type      TYPE ty_entity_type.
    DATA ls_property  TYPE ty_property.
    DATA lv_types     TYPE string.
    DATA lv_i         TYPE i.
    DATA lt_named     TYPE STANDARD TABLE OF ty_file.
    DATA ls_named     TYPE ty_file.
*   every labelled property, flattened: the text pool is written in the order
*   the properties are printed, and it needs the entity each one came from
    TYPES: BEGIN OF ty_text_el,
             name   TYPE string,
             entity TYPE string,
             symbol TYPE string,
           END OF ty_text_el.
    DATA lt_text      TYPE STANDARD TABLE OF ty_text_el.
    DATA ls_text_el   TYPE ty_text_el.
    DATA lv_incl      TYPE abap_bool.
    DATA lt_methods   TYPE string_table.
    DATA lv_method    TYPE string.
    DATA lt_impls     TYPE STANDARD TABLE OF ty_file.
    DATA ls_impl      TYPE ty_file.
    DATA lv_stamp     TYPE string.

    lv_cls = is_model-mpc.
    lv_has_assoc = xsdbool( is_model-associations IS NOT INITIAL OR is_model-navigation IS NOT INITIAL ).
    lv_has_act   = xsdbool( is_model-function_imports IS NOT INITIAL ).
    lv_has_cplx  = xsdbool( is_model-complex_types IS NOT INITIAL ).

* types: the first block, then the text element types, then the rest
    LOOP AT is_model-complex_types INTO ls_ct.
      IF ls_ct-abap_struct IS NOT INITIAL.
        lv_block = |  types:\n     { to_upper( ls_ct-name ) } type { ls_ct-abap_struct } .\n|.
      ELSE.
        lv_block = |  types:\n        begin of { to_upper( ls_ct-name ) },\n|.
        LOOP AT ls_ct-properties INTO ls_property.
          lv_block = lv_block && |        { ls_property-abap_field } type { inline_type( ls_property ) },\n|.
        ENDLOOP.
        lv_block = lv_block && |    end of { to_upper( ls_ct-name ) } .\n|.
      ENDIF.
      APPEND lv_block TO lt_blocks.
    ENDLOOP.
    LOOP AT is_model-function_imports INTO ls_fi.
      IF ls_fi-parameters IS INITIAL.
        CONTINUE.
      ENDIF.
      lv_block = |  types:\n    begin of { action_type( ls_fi ) },\n|.
      LOOP AT ls_fi-parameters INTO ls_fp.
        lv_block = lv_block && |        { ls_fp-abap_field } type { action_parameter_type( ls_fp ) },\n|.
      ENDLOOP.
      lv_block = lv_block && |    end of { action_type( ls_fi ) } .\n|.
      APPEND lv_block TO lt_blocks.
    ENDLOOP.
    LOOP AT is_model-entity_types INTO ls_type.
      IF ls_type-abap_struct IS NOT INITIAL.
        lv_block = |  types:\n     TS_{ ls_type-type_stem } type { ls_type-abap_struct } .\n  types:\nTT_{ ls_type-type_stem } type standard table of TS_{ ls_type-type_stem } .\n|.
      ELSE.
        lv_block = |  types:\n      begin of TS_{ ls_type-type_stem },\n|.
        LOOP AT ls_type-properties INTO ls_property.
          IF ls_property-complex_type IS NOT INITIAL.
            lv_block = lv_block && |     { ls_property-abap_field } type { to_upper( ls_property-complex_type ) },\n|.
          ELSE.
            lv_block = lv_block && |     { ls_property-abap_field } type { inline_type( ls_property ) },\n|.
          ENDIF.
        ENDLOOP.
        lv_block = lv_block && |  end of TS_{ ls_type-type_stem } .\n  types:\n    TT_{ ls_type-type_stem } type standard table of TS_{ ls_type-type_stem } .\n|.
      ENDIF.
      APPEND lv_block TO lt_blocks.
    ENDLOOP.
    READ TABLE lt_blocks INDEX 1 INTO lv_types.
    lv_types = lv_types
      && |  types:\n|
      && |   begin of ts_text_element,\n|
      && |      artifact_name  type c length 40,       " technical name\n|
      && |      artifact_type  type c length 4,\n|
      && |      parent_artifact_name type c length 40, " technical name\n|
      && |      parent_artifact_type type c length 4,\n|
      && |      text_symbol    type textpoolky,\n|
      && |   end of ts_text_element .\n|
      && |  types:\n|
      && |         tt_text_elements type standard table of ts_text_element with key text_symbol .\n|.
    lv_i = 0.
    LOOP AT lt_blocks INTO lv_block.
      lv_i = lv_i + 1.
      IF lv_i > 1.
        lv_types = lv_types && lv_block.
      ENDIF.
    ENDLOOP.

    LOOP AT is_model-entity_types INTO ls_type.
      LOOP AT ls_type-properties INTO ls_property.
        IF ls_property-text_element IS INITIAL.
          CONTINUE.
        ENDIF.
        CLEAR ls_text_el.
        ls_text_el-name   = ls_property-name.
        ls_text_el-entity = ls_type-name.
        ls_text_el-symbol = ls_property-text_element.
        APPEND ls_text_el TO lt_text.
      ENDLOOP.
    ENDLOOP.

    rv_source = |class { lv_cls } definition\n|
      && |  public\n|
      && |  inheriting from /IWBEP/CL_MGW_PUSH_ABS_MODEL\n|
      && |  create public .\n|
      && |\n|
      && |public section.\n|
      && |\n|
      && lv_types
      && |\n|.

* one constant per entity and complex type, in alphabetical order
    LOOP AT is_model-entity_types INTO ls_type.
      ls_named-name    = ls_type-type_stem.
      ls_named-content = ls_type-name.
      APPEND ls_named TO lt_named.
    ENDLOOP.
    LOOP AT is_model-complex_types INTO ls_ct.
      ls_named-name = to_upper( ls_ct-name ).
      IF strlen( ls_named-name ) > 27.
        ls_named-name = substring( val = ls_named-name len = 27 ).
      ENDIF.
      ls_named-content = ls_ct-name.
      APPEND ls_named TO lt_named.
    ENDLOOP.
    SORT lt_named BY name.
    LOOP AT lt_named INTO ls_named.
      rv_source = rv_source && |  constants GC_{ ls_named-name } type /IWBEP/IF_MGW_MED_ODATA_TYPES=>TY_E_MED_ENTITY_NAME value '{ ls_named-content }' ##NO_TEXT.\n|.
    ENDLOOP.
    rv_source = rv_source
      && |\n|
      && |  methods LOAD_TEXT_ELEMENTS\n|
      && |  final\n|
      && |    returning\n|
      && |      value(RT_TEXT_ELEMENTS) type TT_TEXT_ELEMENTS\n|
      && |    raising\n|
      && |      /IWBEP/CX_MGW_MED_EXCEPTION .\n|
      && |\n|
      && |  methods DEFINE\n|
      && |    redefinition .\n|
      && |  methods GET_LAST_MODIFIED\n|
      && |    redefinition .\n|
      && |protected section.\n|
      && |private section.\n|
      && |\n|.

*   The text pool lives in the class's own include, and SEGW names it by
*   padding the class to thirty characters with '=' and adding CP. It goes in
*   the **private** section, after the redefinitions and before the DEFINE_*
*   methods -- where SEGW puts it, which is not where a reader would guess:
*   the first attempt put it beside the entity constants in the public
*   section and moved the first difference from line 81 to line 67 instead of
*   removing it.
*   A function import and its parameters name the container too, so a
*   model whose only text elements are theirs needs it declared as well.
    lv_incl = xsdbool( lt_text IS NOT INITIAL ).
    LOOP AT is_model-function_imports INTO ls_fi.
      IF ls_fi-text_element IS NOT INITIAL.
        lv_incl = abap_true.
      ENDIF.
      LOOP AT ls_fi-parameters INTO ls_fp WHERE text_element IS NOT INITIAL.
        lv_incl = abap_true.
      ENDLOOP.
    ENDLOOP.
    IF lv_incl = abap_true.
      rv_source = rv_source
        && |  constants GC_INCL_NAME type STRING value '{ lv_cls WIDTH = 30 PAD = '=' }CP' ##NO_TEXT.\n\n|.
    ENDIF.

    IF lv_has_cplx = abap_true.
      APPEND 'DEFINE_COMPLEXTYPES' TO lt_methods.
    ENDIF.
    LOOP AT is_model-entity_types INTO ls_type.
      APPEND |DEFINE_{ ls_type-define_stem }| TO lt_methods.
    ENDLOOP.
    IF lv_has_assoc = abap_true.
      APPEND 'DEFINE_ASSOCIATIONS' TO lt_methods.
    ENDIF.
    IF lv_has_act = abap_true.
      APPEND 'DEFINE_ACTIONS' TO lt_methods.
    ENDIF.
    LOOP AT lt_methods INTO lv_method.
      rv_source = rv_source && |  methods { lv_method }\n    raising\n      /IWBEP/CX_MGW_MED_EXCEPTION .\n|.
    ENDLOOP.

    rv_source = rv_source
      && |ENDCLASS.\n|
      && |\n\n\n|
      && |CLASS { lv_cls } IMPLEMENTATION.\n|
      && |\n\n|
      && |  method DEFINE.\n{ banner( ) }\n|
      && |model->set_schema_namespace( '{ is_model-namespace }' ).\n|
      && |\n|.
    IF lv_has_cplx = abap_true.
      rv_source = rv_source && |define_complextypes( ).\n|.
    ENDIF.
    LOOP AT is_model-entity_types INTO ls_type.
      rv_source = rv_source && |define_{ to_lower( ls_type-define_stem ) }( ).\n|.
    ENDLOOP.
    IF lv_has_assoc = abap_true.
      rv_source = rv_source && |define_associations( ).\n|.
    ENDIF.
    IF lv_has_act = abap_true.
      rv_source = rv_source && |define_actions( ).\n|.
    ENDIF.
    rv_source = rv_source && |  endmethod.\n|.

* method implementations in alphabetical order, as the class editor keeps them
    IF lv_has_act = abap_true.
      ls_impl-name    = 'DEFINE_ACTIONS'.
      ls_impl-content = define_actions_method( is_model ).
      APPEND ls_impl TO lt_impls.
    ENDIF.
    IF lv_has_assoc = abap_true.
      ls_impl-name    = 'DEFINE_ASSOCIATIONS'.
      ls_impl-content = define_associations_method( is_model ).
      APPEND ls_impl TO lt_impls.
    ENDIF.
    IF lv_has_cplx = abap_true.
      ls_impl-name    = 'DEFINE_COMPLEXTYPES'.
      ls_impl-content = define_complex_types_method( is_model ).
      APPEND ls_impl TO lt_impls.
    ENDIF.
    LOOP AT is_model-entity_types INTO ls_type.
      ls_impl-name    = |DEFINE_{ ls_type-define_stem }|.
      ls_impl-content = define_entity_method( is_type = ls_type iv_mpc = lv_cls ).
      APPEND ls_impl TO lt_impls.
    ENDLOOP.
    lv_stamp = is_model-last_changed.
    IF strlen( lv_stamp ) > 14.
      lv_stamp = substring( val = lv_stamp len = 14 ).
    ENDIF.
    ls_impl-name    = 'GET_LAST_MODIFIED'.
    ls_impl-content = |  method GET_LAST_MODIFIED.\n{ banner( ) }\n\n|
      && |  CONSTANTS: lc_gen_date_time TYPE timestamp VALUE '{ lv_stamp }'.                  "#EC NOTEXT\n|
      && |  rv_last_modified = super->get_last_modified( ).\n|
      && |  IF rv_last_modified LT lc_gen_date_time.\n|
      && |    rv_last_modified = lc_gen_date_time.\n|
      && |  ENDIF.\n|
      && |  endmethod.\n|.
    APPEND ls_impl TO lt_impls.
    ls_impl-name    = 'LOAD_TEXT_ELEMENTS'.
    ls_impl-content = |  method LOAD_TEXT_ELEMENTS.\n{ banner( ) }\n\nDATA:\n|
      && |     ls_text_element TYPE ts_text_element.                                 "#EC NEEDED\n|.
*   A class with no labelled property keeps the empty body SEGW writes for
*   it; one with labels gets a block per symbol, in the order the properties
*   are printed. The spacing is the generator's own and is reproduced rather
*   than tidied: this file is compared to SEGW's output byte for byte, and a
*   neater column is a difference.
    IF lt_text IS INITIAL.
      ls_impl-content = ls_impl-content && |CLEAR ls_text_element.\n|.
    ELSE.
      ls_impl-content = ls_impl-content && |\n\n|.
      LOOP AT lt_text INTO ls_text_el.
        ls_impl-content = ls_impl-content
          && |clear ls_text_element.\n|
          && |ls_text_element-artifact_name          = '{ ls_text_el-name }'.                 "#EC NOTEXT\n|
          && |ls_text_element-artifact_type          = 'PROP'.                                       "#EC NOTEXT\n|
          && |ls_text_element-parent_artifact_name   = '{ ls_text_el-entity }'.                            "#EC NOTEXT\n|
          && |ls_text_element-parent_artifact_type   = 'ETYP'.                                       "#EC NOTEXT\n|
          && |ls_text_element-text_symbol            = '{ ls_text_el-symbol }'.              "#EC NOTEXT\n|
          && |APPEND ls_text_element TO rt_text_elements.\n|.
      ENDLOOP.
    ENDIF.
    ls_impl-content = ls_impl-content && |  endmethod.\n|.
    APPEND ls_impl TO lt_impls.
    SORT lt_impls BY name.
    LOOP AT lt_impls INTO ls_impl.
      rv_source = rv_source && |\n\n| && ls_impl-content.
    ENDLOOP.
    rv_source = rv_source && |ENDCLASS.\n|.
  ENDMETHOD.

ENDCLASS.
