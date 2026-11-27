* OSD overlay of the supplement projection's pool (upstream
* reuse/supplement/#dmo#bp_c_supplement.clas.locals_imp.abap at commit
* 5353cbeb, Apache-2.0): the same augment, changed where this runtime
* differs. Each change is marked "OSD overlay"; docs/rap-flight-pack.md lists
* them: MODIFY AUGMENTING ENTITIES and READ ENTITIES ... BY \_assoc ... LINK
* are not lowered by the pinned transpiler, so they are written as the
* ZCL_OSD_RAP_EML calls they stand for (the statement in a comment above;
* the augment runs with the base's transaction active, so they land in it);
* RELATING TO, which maps the messages of an augmenting request to the
* original request's rows, is not run (the relating tables are dropped);
* the derived tables have no secondary keys draft / cid here, so KEY draft
* and KEY cid read by the key fields.
CLASS lhc_supplement DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.

    METHODS augment FOR MODIFY
      IMPORTING entities_create FOR CREATE Supplement
                entities_update FOR UPDATE Supplement.

ENDCLASS.

CLASS lhc_Supplement IMPLEMENTATION.

  METHOD augment.

    DATA: suppltext_for_new_suppl      TYPE TABLE FOR CREATE /DMO/I_Supplement\_SupplementText,
          suppltext_for_existing_suppl TYPE TABLE FOR CREATE /DMO/I_Supplement\_SupplementText,
          supplementtext_update        TYPE TABLE FOR UPDATE /DMO/I_SupplementText.
    " OSD overlay: the relating tables (abp_behv_relating_tab) are dropped,
    " RELATING TO is not run
    DATA: suppl_text_tky_link TYPE STRUCTURE FOR READ LINK /DMO/I_Supplement\\Supplement\_SupplementText,
          suppl_text_tky      LIKE suppl_text_tky_link-target-%tky.
    " OSD overlay: the EML targets and responses declared
    DATA link_keys    TYPE TABLE FOR READ IMPORT /DMO/I_Supplement\\Supplement\_SupplementText.
    DATA link_result  TYPE TABLE FOR READ RESULT /DMO/I_Supplement\\Supplement\_SupplementText.
    DATA link         TYPE TABLE FOR READ LINK /DMO/I_Supplement\\Supplement\_SupplementText.
    DATA link_failed  TYPE RESPONSE FOR FAILED EARLY /DMO/I_Supplement.
    DATA aug_mapped   TYPE RESPONSE FOR MAPPED EARLY /DMO/I_Supplement.
    DATA aug_failed   TYPE RESPONSE FOR FAILED EARLY /DMO/I_Supplement.
    DATA aug_reported TYPE RESPONSE FOR REPORTED EARLY /DMO/I_Supplement.
    DATA new_text     LIKE LINE OF suppltext_for_new_suppl.
    DATA new_target   LIKE LINE OF new_text-%target.
    DATA link_line    LIKE LINE OF link.
    DATA failed_link  TYPE abap_bool.
    DATA has_link     TYPE abap_bool.
    DATA created_here TYPE abap_bool.

    "Handle create requests including SupplementDescription
    LOOP AT entities_create INTO DATA(supplement_create).
      "Direct the Supplement Create to the corresponding SupplementText Create-By-Association using the current language
      APPEND VALUE #( %cid_ref           = supplement_create-%cid
                      %is_draft          = supplement_create-%is_draft
                      %key-supplementid  = supplement_create-%key-SupplementID
                      %target            = VALUE #( ( %cid              = |CREATETEXTCID{ sy-tabix }|
                                                      %is_draft         = supplement_create-%is_draft
                                                      languagecode      = sy-langu
                                                      description       = supplement_create-SupplementDescription
                                                      %control          = VALUE #( languagecode = if_abap_behv=>mk-on
                                                                                   description  = supplement_create-%control-SupplementDescription )
                                                   ) )
                     ) TO suppltext_for_new_suppl.

    ENDLOOP.

    " OSD overlay: MODIFY AUGMENTING ENTITIES OF /DMO/I_Supplement
    "   ENTITY Supplement CREATE BY \_SupplementText FROM suppltext_for_new_suppl
    "   RELATING TO entities_create BY relates_create.
    IF suppltext_for_new_suppl IS NOT INITIAL.
      zcl_osd_rap_eml=>create_by( EXPORTING iv_bdef = '/DMO/I_SUPPLEMENT' iv_entity = 'SUPPLEMENT' iv_assoc = '_SUPPLEMENTTEXT'
                                            it_rows = suppltext_for_new_suppl
                                  CHANGING  cs_mapped = aug_mapped cs_failed = aug_failed cs_reported = aug_reported ).
    ENDIF.

    IF entities_update IS NOT INITIAL.

      " OSD overlay: READ ENTITIES OF /DMO/I_Supplement
      "   ENTITY Supplement BY \_SupplementText FROM CORRESPONDING #( entities_update )
      "   LINK DATA(link) FAILED DATA(link_failed).
      link_keys = CORRESPONDING #( entities_update ).
      zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = '/DMO/I_SUPPLEMENT' iv_entity = 'SUPPLEMENT' iv_assoc = '_SUPPLEMENTTEXT'
                                          it_keys = link_keys
                                CHANGING  ct_result = link_result ct_link = link cs_failed = link_failed ).

      "To prevent empty updates, we check if something has changed for the text node.
      LOOP AT entities_update INTO DATA(supplement_update) WHERE %control-SupplementDescription = if_abap_behv=>mk-on.
        " OSD overlay: the loop's index first (the READs below set sy-tabix)
        DATA(tabix) = sy-tabix.

        "To prevent an update on a text node for a non-existing supplement, we check against the failed-supplement table
        "but we also need to ensure that this instance could have been created in this request as well.
        " OSD overlay: KEY draft and KEY cid read by the key fields
        READ TABLE link_failed-supplement TRANSPORTING NO FIELDS
          WITH KEY supplementid = supplement_update-supplementid %is_draft = supplement_update-%is_draft.
        failed_link = boolc( sy-subrc = 0 ).
        READ TABLE suppltext_for_new_suppl TRANSPORTING NO FIELDS
          WITH KEY %cid_ref = supplement_update-%cid_ref %is_draft = supplement_update-%is_draft.
        created_here = boolc( sy-subrc = 0 AND supplement_update-%cid_ref IS NOT INITIAL ).
        CHECK failed_link = abap_false OR created_here = abap_true.

        "Create variable for %tky for target entity instances
        suppl_text_tky = CORRESPONDING #( supplement_update-%tky )  .
        suppl_text_tky-LanguageCode = sy-langu.

        " OSD overlay: line_exists( link[ KEY draft source-%tky = ... target-%tky = ... ] )
        has_link = abap_false.
        LOOP AT link INTO link_line.
          IF link_line-source-supplementid = supplement_update-supplementid
              AND link_line-source-%is_draft = supplement_update-%is_draft
              AND link_line-target-supplementid = suppl_text_tky-supplementid
              AND link_line-target-languagecode = suppl_text_tky-languagecode
              AND link_line-target-%is_draft = suppl_text_tky-%is_draft.
            has_link = abap_true.
          ENDIF.
        ENDLOOP.

        "If a suppl_text with sy-langu already exists, perform an update. Else perform a create-by-association.
        IF has_link = abap_true.

          APPEND VALUE #( %tky             = suppl_text_tky
                          %cid_ref         = supplement_update-%cid_ref
                          description      = supplement_update-SupplementDescription
                          %control         = VALUE #( description = supplement_update-%control-SupplementDescription )
                        ) TO supplementtext_update.

          "If suppl_text was created in the current modify-statement, perform an update based on %cid
        ELSEIF created_here = abap_true.
          " OSD overlay: suppltext_for_new_suppl[ ... ]-%target[ 1 ]-%cid read in two steps
          READ TABLE suppltext_for_new_suppl INTO new_text
            WITH KEY %cid_ref = supplement_update-%cid_ref %is_draft = supplement_update-%is_draft.
          READ TABLE new_text-%target INDEX 1 INTO new_target.

          APPEND VALUE #( %tky             = suppl_text_tky
                          %cid_ref         = new_target-%cid
                          description      = supplement_update-SupplementDescription
                          %control         = VALUE #( description = supplement_update-%control-SupplementDescription )
                        ) TO supplementtext_update.

          "If suppl_text with sy-langu does not exist yet for corresponding supplement
        ELSE.

          "Direct the Supplement Update to the corresponding SupplementText Create-By-Association using the current language
          APPEND VALUE #( %tky     = CORRESPONDING #( supplement_update-%tky )
                          %cid_ref = supplement_update-%cid_ref
                          %target  = VALUE #( ( %cid          = |UPDATETEXTCID{ tabix }|
                                                %is_draft     = suppl_text_tky-%is_draft
                                                languagecode  = suppl_text_tky-LanguageCode
                                                description   = supplement_update-SupplementDescription
                                                %control      = VALUE #( languagecode = if_abap_behv=>mk-on
                                                                         description  = supplement_update-%control-SupplementDescription )
                                             ) )
                         ) TO suppltext_for_existing_suppl.
        ENDIF.

      ENDLOOP.
    ENDIF.

    " OSD overlay: MODIFY AUGMENTING ENTITIES OF /DMO/I_Supplement
    "   ENTITY SupplementText UPDATE FROM supplementtext_update
    "   RELATING TO entities_update BY relates_update
    "   ENTITY Supplement CREATE BY \_SupplementText FROM suppltext_for_existing_suppl
    "   RELATING TO entities_update BY relates_cba.
    IF supplementtext_update IS NOT INITIAL.
      zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = '/DMO/I_SUPPLEMENT' iv_entity = 'SUPPLEMENTTEXT' iv_operation = 'UPDATE'
                                         it_rows = supplementtext_update
                               CHANGING  cs_mapped = aug_mapped cs_failed = aug_failed cs_reported = aug_reported ).
    ENDIF.
    IF suppltext_for_existing_suppl IS NOT INITIAL.
      zcl_osd_rap_eml=>create_by( EXPORTING iv_bdef = '/DMO/I_SUPPLEMENT' iv_entity = 'SUPPLEMENT' iv_assoc = '_SUPPLEMENTTEXT'
                                            it_rows = suppltext_for_existing_suppl
                                  CHANGING  cs_mapped = aug_mapped cs_failed = aug_failed cs_reported = aug_reported ).
    ENDIF.

    " OSD overlay: what failed in the augmenting requests fails the request
    LOOP AT aug_failed-supplement INTO DATA(failed_supplement).
      APPEND VALUE #( %tky = CORRESPONDING #( failed_supplement-%tky ) ) TO failed-supplement.
    ENDLOOP.
    IF aug_failed-supplementtext IS NOT INITIAL AND failed-supplement IS INITIAL.
      LOOP AT entities_create INTO supplement_create.
        APPEND VALUE #( %cid = supplement_create-%cid ) TO failed-supplement.
      ENDLOOP.
      LOOP AT entities_update INTO supplement_update.
        APPEND VALUE #( %tky = supplement_update-%tky ) TO failed-supplement.
      ENDLOOP.
    ENDIF.

  ENDMETHOD.

ENDCLASS.
