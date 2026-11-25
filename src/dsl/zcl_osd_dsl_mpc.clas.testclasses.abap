* DANGEROUS: imported_project writes the project ZUT_DSL through ImportSet.
* The name is this test's own; setup and teardown delete its rows, and any
* ZUT_DSL rows found before the test are lost.
CLASS ltcl_dsl_mpc DEFINITION FOR TESTING RISK LEVEL DANGEROUS DURATION SHORT FINAL.
  PRIVATE SECTION.
    METHODS setup.
    METHODS teardown.
    METHODS clean.
    METHODS seeded_project FOR TESTING RAISING cx_static_check.
    METHODS imported_project FOR TESTING RAISING cx_static_check.
    METHODS mutation_trace FOR TESTING RAISING cx_static_check.
    METHODS compare_project IMPORTING iv_project TYPE string RAISING cx_static_check.
    METHODS fixture RETURNING VALUE(rv_xml) TYPE string.
    METHODS node_of_line
      IMPORTING is_result TYPE zcl_osd_tpl=>ty_result
                io_json TYPE REF TO zif_ajson
                iv_needle TYPE string
      RETURNING VALUE(rv_node) TYPE string
      RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_dsl_mpc IMPLEMENTATION.
  METHOD setup.
    clean( ).
  ENDMETHOD.

  METHOD teardown.
    clean( ).
  ENDMETHOD.

  METHOD clean.
    DELETE FROM zstg_sbd_ga WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbd_pr WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbd_prt WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_et WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_ct WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_pr WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_prt WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_es WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_aso WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_rc WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_at WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_np WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_fi WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_fit WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_fp WHERE project = 'ZUT_DSL'.
    DELETE FROM zstg_sbo_fpt WHERE project = 'ZUT_DSL'.

  ENDMETHOD.

  METHOD fixture.
    DATA lv_nl TYPE string.
    lv_nl = cl_abap_char_utilities=>newline.
    rv_xml = zcl_stg_segw_gen=>bom( )
      && `<?xml version="1.0" encoding="utf-8"?>` && lv_nl
      && `<abapGit version="v1.0.0" serializer="LCL_OBJECT_IWPR" serializer_version="v1.0.0">` && lv_nl
      && ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>` && lv_nl
      && `<_-IWBEP_-I_SBD_GA><_-IWBEP_-I_SBD_GA><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>ga-1</NODE_UUID><NAME>ZCL_ZUT_DSL_MPC</NAME><GEN_ART_TYPE>MPCB</GEN_ART_TYPE></_-IWBEP_-I_SBD_GA></_-IWBEP_-I_SBD_GA>` && lv_nl
      && `<_-IWBEP_-I_SBD_PR><_-IWBEP_-I_SBD_PR><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>pr-1</NODE_UUID><PROJECT_TYPE>1</PROJECT_TYPE></_-IWBEP_-I_SBD_PR></_-IWBEP_-I_SBD_PR>` && lv_nl
      && `<_-IWBEP_-I_SBO_ET>` && lv_nl
      && `<_-IWBEP_-I_SBO_ET><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>et-1</NODE_UUID><NAME>Travel</NAME><ABAP_STRUCT>ZSTG_DEMO</ABAP_STRUCT></_-IWBEP_-I_SBO_ET>` && lv_nl
      && `<_-IWBEP_-I_SBO_ET><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>et-2</NODE_UUID><NAME>Media</NAME><IS_MEDIA>X</IS_MEDIA></_-IWBEP_-I_SBO_ET>` && lv_nl
      && `<_-IWBEP_-I_SBO_ET><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>et-3</NODE_UUID><NAME>Empty</NAME></_-IWBEP_-I_SBO_ET>` && lv_nl
      && `</_-IWBEP_-I_SBO_ET>` && lv_nl
      && `<_-IWBEP_-I_SBO_CT><_-IWBEP_-I_SBO_CT><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>ct-1</NODE_UUID><NAME>Address</NAME></_-IWBEP_-I_SBO_CT></_-IWBEP_-I_SBO_CT>` && lv_nl
      && `<_-IWBEP_-I_SBO_PR>` && lv_nl
      && `<_-IWBEP_-I_SBO_PR><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>pp-1</NODE_UUID><PARENT_UUID>et-1</PARENT_UUID><NAME>TravelId</NAME><IS_KEY>X</IS_KEY><EDM_CORE_TYPE>Edm.String</EDM_CORE_TYPE><PROP_PRECISION>2</PROP_PRECISION><MAX_LENGTH>20</MAX_LENGTH><CREATABLE>X</CREATABLE><UPDATABLE>X</UPDATABLE><SORTABLE>X</SORTABLE><SEMANTICS>url</SEMANTICS><AS_ETAG>X</AS_ETAG></_-IWBEP_-I_SBO_PR>` && lv_nl
      && `<_-IWBEP_-I_SBO_PR><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>pp-2</NODE_UUID><PARENT_UUID>et-1</PARENT_UUID><NAME>Address</NAME><COMPLEX_TYPE>ct-1</COMPLEX_TYPE></_-IWBEP_-I_SBO_PR>` && lv_nl
      && `<_-IWBEP_-I_SBO_PR><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>pp-3</NODE_UUID><PARENT_UUID>ct-1</PARENT_UUID><NAME>Street</NAME><EDM_CORE_TYPE>Edm.String</EDM_CORE_TYPE><MAX_LENGTH>40</MAX_LENGTH><CREATABLE>X</CREATABLE><SEMANTICS>email</SEMANTICS></_-IWBEP_-I_SBO_PR>` && lv_nl
      && `<_-IWBEP_-I_SBO_PR><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>pp-4</NODE_UUID><PARENT_UUID>et-2</PARENT_UUID><NAME>Content</NAME><EDM_CORE_TYPE>Edm.String</EDM_CORE_TYPE><MAX_LENGTH>20</MAX_LENGTH></_-IWBEP_-I_SBO_PR>` && lv_nl
      && `</_-IWBEP_-I_SBO_PR>` && lv_nl
      && `<_-IWBEP_-I_SBO_PRT><_-IWBEP_-I_SBO_PRT><PROJECT>ZUT_DSL</PROJECT><SYLANGU>E</SYLANGU><NODE_UUID>pp-1</NODE_UUID><PROP_LABEL>Travel</PROP_LABEL></_-IWBEP_-I_SBO_PRT></_-IWBEP_-I_SBO_PRT>` && lv_nl
      && `<_-IWBEP_-I_SBO_ES>` && lv_nl
      && `<_-IWBEP_-I_SBO_ES><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>es-1</NODE_UUID><NAME>TravelSet</NAME><ENTITY_TYPE>et-1</ENTITY_TYPE><CREATABLE>X</CREATABLE></_-IWBEP_-I_SBO_ES>` && lv_nl
      && `<_-IWBEP_-I_SBO_ES><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>es-2</NODE_UUID><NAME>TravelAltSet</NAME><ENTITY_TYPE>et-1</ENTITY_TYPE></_-IWBEP_-I_SBO_ES>` && lv_nl
      && `</_-IWBEP_-I_SBO_ES>` && lv_nl
      && `<_-IWBEP_-I_SBO_ASO><_-IWBEP_-I_SBO_ASO><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>aso-1</NODE_UUID><NAME>TravelToMedia</NAME><LEFT_END_GUID>et-1</LEFT_END_GUID><RIGHT_END_GUID>et-2</RIGHT_END_GUID><LEFT_END_CARD>1</LEFT_END_CARD><RIGHT_END_CARD>N</RIGHT_END_CARD></_-IWBEP_-I_SBO_ASO></_-IWBEP_-I_SBO_ASO>` && lv_nl
      && `<_-IWBEP_-I_SBO_RC><_-IWBEP_-I_SBO_RC><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>rc-1</NODE_UUID><NAME>TravelId</NAME><ASSOCIATION_GUID>aso-1</ASSOCIATION_GUID><PRINCIPAL_PROP_R>pp-1</PRINCIPAL_PROP_R><DEPENDENT_PROP_R>pp-1</DEPENDENT_PROP_R></_-IWBEP_-I_SBO_RC></_-IWBEP_-I_SBO_RC>` && lv_nl
      && `<_-IWBEP_-I_SBO_NP><_-IWBEP_-I_SBO_NP><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>np-1</NODE_UUID><NAME>to_Media</NAME><ENTITY_GUID>et-1</ENTITY_GUID><RELATION_GUID>aso-1</RELATION_GUID><TECH_NAME>TO_MEDIA</TECH_NAME></_-IWBEP_-I_SBO_NP></_-IWBEP_-I_SBO_NP>` && lv_nl
      && `<_-IWBEP_-I_SBO_FI><_-IWBEP_-I_SBO_FI><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>fi-1</NODE_UUID><NAME>LookupAddress</NAME><HTTP_METHOD>GET</HTTP_METHOD><RETURN_TYPE_KIND>CTYP</RETURN_TYPE_KIND><RETURN_REF_TYPE>ct-1</RETURN_REF_TYPE><RETURN_CARD>1</RETURN_CARD><ACTION_FOR>et-1</ACTION_FOR></_-IWBEP_-I_SBO_FI></_-IWBEP_-I_SBO_FI>` && lv_nl
      && `<_-IWBEP_-I_SBO_FIT><_-IWBEP_-I_SBO_FIT><PROJECT>ZUT_DSL</PROJECT><SYLANGU>E</SYLANGU><NODE_UUID>fi-1</NODE_UUID><FI_LABEL>Lookup address</FI_LABEL></_-IWBEP_-I_SBO_FIT></_-IWBEP_-I_SBO_FIT>` && lv_nl
      && `<_-IWBEP_-I_SBO_FP><_-IWBEP_-I_SBO_FP><PROJECT>ZUT_DSL</PROJECT><NODE_UUID>fp-1</NODE_UUID><NAME>TravelId</NAME><FUNCTION_IMPORT>fi-1</FUNCTION_IMPORT><ABAP_FIELD>TRAVEL_ID</ABAP_FIELD><EDM_CORE_TYPE>Edm.String</EDM_CORE_TYPE><MAX_LENGTH>8</MAX_LENGTH></_-IWBEP_-I_SBO_FP></_-IWBEP_-I_SBO_FP>` && lv_nl
      && `<_-IWBEP_-I_SBO_FPT><_-IWBEP_-I_SBO_FPT><PROJECT>ZUT_DSL</PROJECT><SYLANGU>E</SYLANGU><NODE_UUID>fp-1</NODE_UUID><FI_PARAM_LABEL>Travel key</FI_PARAM_LABEL></_-IWBEP_-I_SBO_FPT></_-IWBEP_-I_SBO_FPT>` && lv_nl
      && `</asx:values></asx:abap></abapGit>` && lv_nl.
  ENDMETHOD.

  METHOD imported_project.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    zcl_oao_registry=>register( iv_service = 'ZSTG_SEGW_SRV'
                                iv_mpc = 'ZCL_ZSTG_SEGW_MPC_EXT'
                                iv_dpc = 'ZCL_ZSTG_SEGW_DPC_EXT' ).
    zcl_stg_model_info=>clear( ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded(
      iv_method = 'POST'
      iv_path = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/ImportSet'
      iv_body = `{"Content":"` && zcl_stg_json=>escape( fixture( ) ) && `"}` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).
    compare_project( 'ZUT_DSL' ).
  ENDMETHOD.

  METHOD seeded_project.
    DATA ls_model TYPE zcl_stg_segw_gen=>ty_model.
    ls_model = zcl_stg_segw_gen=>build_model( 'ZSTG_MAPPED' ).
    cl_abap_unit_assert=>assert_not_initial( act = ls_model-entity_types msg = `ZSTG_MAPPED is not seeded` ).
    compare_project( 'ZSTG_MAPPED' ).
  ENDMETHOD.

  METHOD compare_project.
    DATA ls_model TYPE zcl_stg_segw_gen=>ty_model.
    DATA ls_type TYPE zcl_stg_segw_gen=>ty_entity_type.
    DATA ls_result TYPE zcl_osd_tpl=>ty_result.
    DATA ls_trace TYPE zcl_osd_tpl=>ty_trace.
    DATA lv_source TYPE string.
    DATA lv_expected TYPE string.
    DATA lv_actual TYPE string.
    DATA lv_start TYPE i.
    DATA lv_end TYPE i.
    DATA lv_length TYPE i.
    DATA lv_count TYPE i.
    DATA lo_json TYPE REF TO zif_ajson.
    DATA lt_methods TYPE string_table.
    DATA lv_method TYPE string.
    ls_model = zcl_stg_segw_gen=>build_model( iv_project ).
    lv_source = zcl_stg_segw_gen=>mpc_source( ls_model ).
    cl_abap_unit_assert=>assert_equals(
      act = lv_source exp = zcl_stg_segw_gen=>mpc_source_legacy( ls_model )
      msg = 'DSL source equals independent legacy generator' ).
    IF iv_project = 'ZUT_DSL'.
      ls_result = zcl_osd_dsl_mpc=>render_class( ls_model ).
      cl_abap_unit_assert=>assert_equals(
        act = zcl_osd_tpl=>to_string( ls_result ) exp = lv_source msg = 'whole MPC class' ).
      lo_json = zcl_osd_dsl_mpc=>project_model( ls_model ).
      cl_abap_unit_assert=>assert_equals(
        exp = `complex/Address/property/Street/type`
        act = lo_json->get( '/complex_types/1/properties/1/@type/@id' ) ).
      READ TABLE ls_model-entity_types INTO ls_type WITH KEY name = 'Travel'.
      cl_abap_unit_assert=>assert_subrc( ).
      CLEAR ls_type-entity_sets.
      lo_json = zcl_osd_dsl_mpc=>entity_model( is_type = ls_type iv_mpc = ls_model-mpc ).
      cl_abap_unit_assert=>assert_equals( exp = 'X' act = lo_json->get( '/has_texts' ) ).
      lo_json = zcl_osd_dsl_mpc=>project_model( ls_model ).
      cl_abap_unit_assert=>assert_equals(
        exp = `complex/Address`
        act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `begin of ADDRESS` ) ).
      cl_abap_unit_assert=>assert_equals(
        exp = `complex/Address/property/Street`
        act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `STREET type` ) ).
      cl_abap_unit_assert=>assert_equals(
        exp = `entity/Media/property/Content`
        act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `CONTENT type` ) ).
      cl_abap_unit_assert=>assert_equals(
        exp = `action/LookupAddress/parameter/TravelId`
        act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `TRAVEL_ID type` ) ).
      cl_abap_unit_assert=>assert_equals(
        exp = `constant/ADDRESS`
        act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `constants GC_ADDRESS` ) ).
      cl_abap_unit_assert=>assert_equals(
        exp = `declaration/DEFINE_COMPLEXTYPES`
        act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `methods DEFINE_COMPLEXTYPES` ) ).
      cl_abap_unit_assert=>assert_equals(
        exp = `entity/Travel/property/TravelId`
        act = node_of_line( is_result = ls_result io_json = lo_json
                            iv_needle = `create_property( iv_property_name = 'TravelId'` ) ).
    ENDIF.
    IF iv_project = 'ZUT_DSL'.
      cl_abap_unit_assert=>assert_equals( act = lines( ls_model-entity_types ) exp = 3 ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_is_media( 'X' )` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `create_complex_property(` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_is_key( )` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_label_from_text_element(` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_precison(` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_maxlength(` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `TravelAltSet` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_semantic( 'url' )` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_sortable( abap_true )` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_as_etag( )` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `create_ref_constraint( )` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `create_navigation_property(` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `set_return_complex_type( 'Address' )` ) ).
      cl_abap_unit_assert=>assert_true( xsdbool( lv_source CS `bind_input_structure(` ) ).
    ENDIF.
    APPEND 'DEFINE' TO lt_methods.
    APPEND 'DEFINE_COMPLEXTYPES' TO lt_methods.
    APPEND 'DEFINE_ASSOCIATIONS' TO lt_methods.
    APPEND 'DEFINE_ACTIONS' TO lt_methods.
    APPEND 'GET_LAST_MODIFIED' TO lt_methods.
    APPEND 'LOAD_TEXT_ELEMENTS' TO lt_methods.
    lo_json = zcl_osd_dsl_mpc=>project_model( ls_model ).
    LOOP AT lt_methods INTO lv_method.
      FIND `  method ` && lv_method && `.` IN lv_source MATCH OFFSET lv_start.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      FIND `  endmethod.` IN SECTION OFFSET lv_start OF lv_source MATCH OFFSET lv_end.
      cl_abap_unit_assert=>assert_subrc( ).
      lv_length = lv_end - lv_start + strlen( `  endmethod.` ) + 1.
      lv_expected = substring( val = lv_source off = lv_start len = lv_length ).
      ls_result = zcl_osd_dsl_mpc=>render_method( is_model = ls_model iv_method = lv_method ).
      lv_actual = zcl_osd_tpl=>to_string( ls_result ).
      cl_abap_unit_assert=>assert_equals( act = lv_actual exp = lv_expected msg = lv_method ).
      cl_abap_unit_assert=>assert_equals( act = lines( ls_result-trace ) exp = lines( ls_result-lines ) ).
      LOOP AT ls_result-trace INTO ls_trace.
        IF ls_trace-path <> `/`.
          cl_abap_unit_assert=>assert_true( act = lo_json->exists( ls_trace-path ) msg = ls_trace-path ).
        ENDIF.
        cl_abap_unit_assert=>assert_not_initial(
          act = zcl_osd_dsl_trace=>node_of( io_model = lo_json iv_path = ls_trace-path )
          msg = lv_method ).
      ENDLOOP.
      IF iv_project = 'ZUT_DSL'.
        CASE lv_method.
          WHEN 'DEFINE'.
            cl_abap_unit_assert=>assert_equals(
              exp = `entity/Travel`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `define_travel( ).` ) ).
          WHEN 'DEFINE_COMPLEXTYPES'.
            cl_abap_unit_assert=>assert_equals(
              exp = `complex/Address/property/Street`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `create_property( iv_property_name  = 'Street'` ) ).
            " the complex property's semantics line is reached and is its own
            cl_abap_unit_assert=>assert_equals(
              exp = `complex/Address/property/Street`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `set_semantic( 'email' )` ) ).
          WHEN 'DEFINE_ASSOCIATIONS'.
            cl_abap_unit_assert=>assert_equals(
              exp = `association/TravelToMedia`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `iv_association_name = 'TravelToMedia'` ) ).
            cl_abap_unit_assert=>assert_equals(
              exp = `navigation/Travel/to_Media`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `iv_property_name  = 'to_Media'` ) ).
          WHEN 'DEFINE_ACTIONS'.
            cl_abap_unit_assert=>assert_equals(
              exp = `action/LookupAddress/parameter/TravelId`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `create_input_parameter(` ) ).
          WHEN 'GET_LAST_MODIFIED'.
            cl_abap_unit_assert=>assert_equals(
              exp = `project/ZUT_DSL`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `lc_gen_date_time` ) ).
          WHEN 'LOAD_TEXT_ELEMENTS'.
            cl_abap_unit_assert=>assert_equals(
              exp = `text/Travel/TravelId`
              act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `artifact_name          = 'TravelId'` ) ).
        ENDCASE.
      ENDIF.
    ENDLOOP.
    LOOP AT ls_model-entity_types INTO ls_type.
      lv_count = lv_count + 1.
      FIND `  method DEFINE_` && ls_type-define_stem && `.` IN lv_source MATCH OFFSET lv_start.
      cl_abap_unit_assert=>assert_subrc( ).
      FIND `  endmethod.` IN SECTION OFFSET lv_start OF lv_source MATCH OFFSET lv_end.
      cl_abap_unit_assert=>assert_subrc( ).
      lv_length = lv_end - lv_start + strlen( `  endmethod.` ) + 1.
      lv_expected = substring( val = lv_source off = lv_start len = lv_length ).
      ls_result = zcl_osd_dsl_mpc=>render_entity( is_type = ls_type iv_mpc = ls_model-mpc ).
      lv_actual = zcl_osd_tpl=>to_string( ls_result ).
      cl_abap_unit_assert=>assert_equals( act = lv_actual exp = lv_expected msg = ls_type-name ).
      cl_abap_unit_assert=>assert_equals( act = lines( ls_result-trace ) exp = lines( ls_result-lines ) ).
      lo_json = zcl_osd_dsl_mpc=>entity_model( is_type = ls_type iv_mpc = ls_model-mpc ).
      LOOP AT ls_result-trace INTO ls_trace.
        IF ls_trace-path <> `/`.
          cl_abap_unit_assert=>assert_true( act = lo_json->exists( ls_trace-path ) msg = ls_trace-path ).
        ENDIF.
        cl_abap_unit_assert=>assert_true( xsdbool( zcl_osd_dsl_trace=>node_of(
          io_model = lo_json iv_path = ls_trace-path ) CP `entity/*` ) ).
      ENDLOOP.
      IF iv_project = 'ZUT_DSL' AND ls_type-name = 'Travel'.
        cl_abap_unit_assert=>assert_equals(
          exp = `entity/Travel/property/TravelId`
          act = node_of_line( is_result = ls_result io_json = lo_json
                              iv_needle = `create_property( iv_property_name = 'TravelId'` ) ).
        cl_abap_unit_assert=>assert_equals(
          exp = `entity/Travel/property/TravelId`
          act = node_of_line( is_result = ls_result io_json = lo_json iv_needle = `set_semantic( 'url' )` ) ).
        cl_abap_unit_assert=>assert_equals(
          exp = `entity/Travel/set/TravelAltSet`
          act = node_of_line( is_result = ls_result io_json = lo_json
                              iv_needle = `create_entity_set( 'TravelAltSet' )` ) ).
      ENDIF.
    ENDLOOP.
    cl_abap_unit_assert=>assert_true( xsdbool( lv_count > 0 ) ).
  ENDMETHOD.
  METHOD node_of_line.
    DATA lv_line TYPE string.
    DATA ls_trace TYPE zcl_osd_tpl=>ty_trace.
    LOOP AT is_result-lines INTO lv_line.
      IF lv_line CS iv_needle.
        READ TABLE is_result-trace INTO ls_trace WITH KEY line = sy-tabix.
        cl_abap_unit_assert=>assert_subrc( msg = iv_needle ).
        rv_node = zcl_osd_dsl_trace=>node_of( io_model = io_json iv_path = ls_trace-path ).
        RETURN.
      ENDIF.
    ENDLOOP.
    cl_abap_unit_assert=>fail( msg = `no line with ` && iv_needle ).
  ENDMETHOD.

  METHOD mutation_trace.
    DATA ls_model TYPE zcl_stg_segw_gen=>ty_model.
    DATA ls_type TYPE zcl_stg_segw_gen=>ty_entity_type.
    DATA lo_json TYPE REF TO zif_ajson.
    DATA ls_before TYPE zcl_osd_tpl=>ty_result.
    DATA ls_after TYPE zcl_osd_tpl=>ty_result.
    DATA ls_trace TYPE zcl_osd_tpl=>ty_trace.
    DATA lv_before TYPE string.
    DATA lv_after TYPE string.
    DATA lv_changed TYPE i.
    DATA lv_line TYPE i.
    DATA lv_node TYPE string.
    ls_model = zcl_stg_segw_gen=>build_model( 'ZSTG_MAPPED' ).
    READ TABLE ls_model-entity_types INDEX 1 INTO ls_type.
    cl_abap_unit_assert=>assert_subrc( ).
    lo_json = zcl_osd_dsl_mpc=>entity_model( is_type = ls_type iv_mpc = ls_model-mpc ).
    cl_abap_unit_assert=>assert_true( lo_json->exists( '/properties/1/@id' ) ).
    ls_before = zcl_osd_tpl=>render( iv_template = zcl_osd_dsl_mpc=>entity_template( )
                                      ii_data = lo_json iv_name = 'mpc_entity' ).
    lv_node = lo_json->get( '/properties/1/@id' ).
    lo_json->set_string( iv_path = '/properties/1/name' iv_val = 'ChangedName' ).
    ls_after = zcl_osd_tpl=>render( iv_template = zcl_osd_dsl_mpc=>entity_template( )
                                     ii_data = lo_json iv_name = 'mpc_entity' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_after-lines ) exp = lines( ls_before-lines ) ).
    " the mapping of lines to model paths does not move with a value change
    cl_abap_unit_assert=>assert_equals( act = ls_after-trace exp = ls_before-trace ).
    LOOP AT ls_before-lines INTO lv_before.
      lv_line = sy-tabix.
      READ TABLE ls_after-lines INDEX lv_line INTO lv_after.
      IF lv_before <> lv_after.
        lv_changed = lv_changed + 1.
        " the line was the property's before the change, and still is
        READ TABLE ls_before-trace INTO ls_trace WITH KEY line = lv_line.
        cl_abap_unit_assert=>assert_subrc( ).
        cl_abap_unit_assert=>assert_equals(
          act = zcl_osd_dsl_trace=>node_of( io_model = lo_json iv_path = ls_trace-path )
          exp = lv_node ).
        READ TABLE ls_after-trace INTO ls_trace WITH KEY line = lv_line.
        cl_abap_unit_assert=>assert_subrc( ).
        cl_abap_unit_assert=>assert_equals(
          act = zcl_osd_dsl_trace=>node_of( io_model = lo_json iv_path = ls_trace-path )
          exp = lv_node ).
      ENDIF.
    ENDLOOP.
    cl_abap_unit_assert=>assert_true( xsdbool( lv_changed > 0 ) ).
  ENDMETHOD.
ENDCLASS.
