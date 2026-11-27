* OSD overlay of the agency pool of the reuse layer (upstream
* reuse/agency/#dmo#bp_r_agencytp.clas.locals_imp.abap at commit 5353cbeb,
* Apache-2.0): the same handlers and saver, changed where this runtime
* differs. Each change is marked "OSD overlay"; docs/rap-flight-pack.md lists
* them: the test classes are not fetched (the DEFINITION DEFERRED FOR
* TESTING lines and the FRIENDS that name them are dropped); the EML targets
* are declared with their derived type; CORRESPONDING ... DISCARDING
* DUPLICATES is a loop; and adjust_numbers takes the highest saved agency ID
* + 1 in place of cl_numberrange_runtime=>number_get.
" OSD overlay: DEFINITION DEFERRED FOR TESTING and the FRIENDS dropped
CLASS lhc_agency DEFINITION
  INHERITING FROM cl_abap_behavior_handler.

  PUBLIC SECTION.
    CONSTANTS state_area_validate_attachment TYPE string VALUE 'VALIDATE_ATTACHMENT' ##NO_TEXT.
    CONSTANTS state_area_validate_name       TYPE string VALUE 'VALIDATE_NAME'       ##NO_TEXT.
    CONSTANTS state_area_validate_email      TYPE string VALUE 'VALIDATE_EMAIL'      ##NO_TEXT.
    CONSTANTS state_area_validate_country    TYPE string VALUE 'VALIDATE_COUNTRY'    ##NO_TEXT.
    CONSTANTS state_area_validate_lob        TYPE string VALUE 'VALIDATE_LOB'     ##NO_TEXT.

    TYPES: BEGIN OF t_mimetypes,
             file_extension TYPE string,
             mimetype       TYPE string,
           END OF t_mimetypes.

    CLASS-DATA allowed_mimetypes TYPE STANDARD TABLE OF t_mimetypes WITH KEY mimetype.

    CLASS-METHODS class_constructor.

  PRIVATE SECTION.
*    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION IMPORTING REQUEST requested_authorizations FOR /dmo/agency RESULT result.

    METHODS validatecountrycode FOR VALIDATE ON SAVE IMPORTING keys FOR /dmo/agency~/dmo/validatecountrycode.

    METHODS validateemailaddress FOR VALIDATE ON SAVE IMPORTING keys FOR /dmo/agency~/dmo/validateemailaddress.

    METHODS validatename FOR VALIDATE ON SAVE IMPORTING keys FOR /dmo/agency~/dmo/validatename.

    METHODS validatelargeobject FOR VALIDATE ON SAVE IMPORTING keys FOR /dmo/agency~/dmo/validatelargeobject.

ENDCLASS.



CLASS lhc_agency IMPLEMENTATION.

  METHOD class_constructor.
    allowed_mimetypes = VALUE #( ( file_extension = '.txt' mimetype = 'text/plain' )
                                 ( file_extension = '.jpg' mimetype = 'image/jpeg' )
                                 ( file_extension = '.png' mimetype = 'image/png' )
                                 ( file_extension = '.bmp' mimetype = 'image/bmp' ) ).

  ENDMETHOD.


*  METHOD get_global_authorizations.
*  ENDMETHOD.


  METHOD validatecountrycode.
    DATA countries TYPE SORTED TABLE OF i_country WITH UNIQUE KEY country.

    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/r_agencytp\\/dmo/agency.
    DATA agencies  TYPE TABLE FOR READ RESULT /dmo/r_agencytp\\/dmo/agency.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /dmo/r_agencytp IN LOCAL MODE
         ENTITY /dmo/agency
         FIELDS ( countrycode )
         WITH read_keys
         RESULT agencies.


    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    DATA country TYPE i_country.
    LOOP AT agencies INTO DATA(with_country).
      country-country = with_country-countrycode.
      INSERT country INTO TABLE countries.
    ENDLOOP.
    DELETE countries WHERE country IS INITIAL.

    IF countries IS NOT INITIAL.
      SELECT FROM i_country FIELDS country
        FOR ALL ENTRIES IN @countries
        WHERE country = @countries-country
        INTO TABLE @DATA(countries_db).
    ENDIF.

    LOOP AT agencies INTO DATA(agency).
      APPEND VALUE #( %tky        = agency-%tky
                      %state_area = state_area_validate_country )
             TO reported-/dmo/agency.

      IF        agency-countrycode IS INITIAL
         OR NOT line_exists( countries_db[ country = agency-countrycode ] ).

        APPEND VALUE #(  %tky = agency-%tky ) TO failed-/dmo/agency.
        APPEND VALUE #( %tky                 = agency-%tky
                        %state_area          = state_area_validate_country
                        %msg                 = NEW /dmo/cx_agency( textid      = /dmo/cx_agency=>country_code_invalid
                                                                   countrycode = agency-countrycode )
                        %element-countrycode = if_abap_behv=>mk-on )
               TO reported-/dmo/agency.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD validateemailaddress.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/r_agencytp\\/dmo/agency.
    DATA agencies  TYPE TABLE FOR READ RESULT /dmo/r_agencytp\\/dmo/agency.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /dmo/r_agencytp IN LOCAL MODE
         ENTITY /dmo/agency
         FIELDS ( emailaddress )
         WITH read_keys
         RESULT agencies.

    LOOP AT agencies INTO DATA(agency).

      APPEND VALUE #( %tky        = agency-%tky
                      %state_area = state_area_validate_email )
             TO reported-/dmo/agency.

      " Conversion to string to truncate trailing spaces, so + doesn't match space.
      IF CONV string( agency-emailaddress ) NP '+*@+*.+*' ##OPERATOR[STRING].

        APPEND VALUE #( %tky = agency-%tky ) TO failed-/dmo/agency.

        APPEND VALUE #( %tky                  = agency-%tky
                        %state_area           = state_area_validate_email
                        %msg                  = NEW /dmo/cx_agency( /dmo/cx_agency=>email_invalid_format )
                        %element-emailaddress = if_abap_behv=>mk-on )
               TO reported-/dmo/agency.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD validatename.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/r_agencytp\\/dmo/agency.
    DATA agencies  TYPE TABLE FOR READ RESULT /dmo/r_agencytp\\/dmo/agency.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /dmo/r_agencytp IN LOCAL MODE
         ENTITY /dmo/agency
         FIELDS ( name )
         WITH read_keys
         RESULT agencies.

    LOOP AT agencies INTO DATA(agency).
      APPEND VALUE #( %tky        = agency-%tky
                      %state_area = state_area_validate_name )
             TO reported-/dmo/agency.

      IF agency-name IS INITIAL.
        APPEND VALUE #( %tky = agency-%tky ) TO failed-/dmo/agency.

        APPEND VALUE #( %tky          = agency-%tky
                        %state_area   = state_area_validate_name
                        %msg          = NEW /dmo/cx_agency( /dmo/cx_agency=>name_required )
                        %element-name = if_abap_behv=>mk-on )
               TO reported-/dmo/agency.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.


  METHOD validatelargeobject.

    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/r_agencytp\\/dmo/agency.
    DATA agencies  TYPE TABLE FOR READ RESULT /dmo/r_agencytp\\/dmo/agency.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /dmo/r_agencytp IN LOCAL MODE
         ENTITY /dmo/agency
         FIELDS ( attachment mimetype filename )
         WITH read_keys
         RESULT agencies.

    LOOP AT agencies INTO DATA(agency).

      APPEND VALUE #( %tky        = agency-%tky
                      %state_area = state_area_validate_lob ) TO reported-/dmo/agency.

      " No mimetype for attachment
      IF agency-attachment IS NOT INITIAL AND agency-mimetype IS INITIAL.
        APPEND VALUE #( %tky = agency-%tky ) TO failed-/dmo/agency.
        APPEND VALUE #( %tky              = agency-%tky
                        %state_area       = state_area_validate_lob
                        %msg              = NEW /dmo/cx_agency( textid     = /dmo/cx_agency=>mimetype_missing
                                                                attachment = agency-attachment )
                        %element-mimetype = if_abap_behv=>mk-on )
               TO reported-/dmo/agency.

      ENDIF.

      IF agency-mimetype IS NOT INITIAL.

        " No (empty) attachment for mimetype
        IF agency-attachment IS INITIAL.
          APPEND VALUE #( %tky = agency-%tky ) TO failed-/dmo/agency.
          APPEND VALUE #(
              %tky                = agency-%tky
              %state_area         = state_area_validate_lob
              %msg                = NEW /dmo/cx_agency( textid     = /dmo/cx_agency=>attachment_empty_missing
                                                        attachment = agency-attachment )
              %element-attachment = if_abap_behv=>mk-on )
                 TO reported-/dmo/agency.
        ENDIF.

        " Mimetype is not supported
        IF NOT line_exists( allowed_mimetypes[ mimetype = agency-mimetype ] ).
          APPEND VALUE #( %tky = agency-%tky ) TO failed-/dmo/agency.
          APPEND VALUE #( %tky              = agency-%tky
                          %state_area       = state_area_validate_lob
                          %msg              = NEW /dmo/cx_agency( textid   = /dmo/cx_agency=>mimetype_not_supported
                                                                  mimetype = agency-mimetype )
                          %element-mimetype = if_abap_behv=>mk-on )
                 TO reported-/dmo/agency.
        ELSE.

          IF agency-filename IS NOT INITIAL.
            DATA(file_extension) = substring_from( val = agency-filename pcre = '(.[^.]*)$' ).

            " File extension does not match mimetype
            IF file_extension <> allowed_mimetypes[ mimetype = agency-mimetype ]-file_extension.
              APPEND VALUE #( %tky = agency-%tky ) TO failed-/dmo/agency.
              APPEND VALUE #(
                  %tky              = agency-%tky
                  %state_area       = state_area_validate_lob
                  %msg              = NEW /dmo/cx_agency( textid   = /dmo/cx_agency=>extension_mimetype_mismatch
                                                          mimetype = agency-mimetype )
                  %element-mimetype = if_abap_behv=>mk-on
                  %element-filename = if_abap_behv=>mk-on )
                     TO reported-/dmo/agency.
            ENDIF.

          ENDIF.

        ENDIF.

      ELSEIF agency-attachment IS INITIAL AND agency-filename IS NOT INITIAL.
        APPEND VALUE #( %tky = agency-%tky ) TO failed-/dmo/agency.
        APPEND VALUE #( %tky                = agency-%tky
                        %state_area         = state_area_validate_lob
                        %msg                = NEW /dmo/cx_agency( textid   = /dmo/cx_agency=>only_filename
                                                                  filename = agency-filename )
                        %element-attachment = if_abap_behv=>mk-on
                        %element-mimetype   = if_abap_behv=>mk-on )
               TO reported-/dmo/agency.

      ENDIF.

    ENDLOOP.

  ENDMETHOD.

ENDCLASS.

" OSD overlay: DEFINITION DEFERRED FOR TESTING and the FRIENDS dropped
CLASS lsc_agency DEFINITION
  INHERITING FROM cl_abap_behavior_saver.

  PROTECTED SECTION.
    METHODS adjust_numbers REDEFINITION.
ENDCLASS.



CLASS lsc_agency IMPLEMENTATION.

  METHOD adjust_numbers.
    DATA agency_id_max TYPE /dmo/agency_id.
    DATA entity        TYPE STRUCTURE FOR MAPPED LATE /dmo/r_agencytp.

    DATA(entities_wo_agencyid) = mapped-/dmo/agency.
    DELETE entities_wo_agencyid WHERE agencyid IS NOT INITIAL.

    IF entities_wo_agencyid IS INITIAL.
      EXIT.
    ENDIF.

    " OSD overlay: cl_numberrange_runtime=>number_get with QUANTITY and the
    " return codes is not what this runtime's class offers, and /DMO/AGNCY has
    " no interval here: the numbers follow the highest agency ID saved below
    " the runtime's preliminary keys (the top 1000 of the range, 999000 and
    " up), skipping any ID an agency or a draft already has (unmeasured
    " against a system's interval). An exhausted range leaves the ID initial,
    " and the runtime refuses the save (in place of RAISE SHORTDUMP)
    CONSTANTS preliminary_floor TYPE /dmo/agency_id VALUE '999000'.
    DATA in_use TYPE i.
    SELECT MAX( agency_id ) FROM /dmo/agency WHERE agency_id < @preliminary_floor INTO @agency_id_max.

    " Set Agency ID
    LOOP AT mapped-/dmo/agency ASSIGNING FIELD-SYMBOL(<agency>). " USING KEY entity" WHERE agencyid IS INITIAL.
      IF <agency>-agencyid IS INITIAL. " If condition necessary?
        DO.
          agency_id_max += 1.
          IF agency_id_max >= preliminary_floor.
            EXIT.
          ENDIF.
          SELECT COUNT(*) FROM /dmo/agency WHERE agency_id = @agency_id_max INTO @in_use.
          IF in_use = 0.
            SELECT COUNT(*) FROM /dmo/agency_d WHERE agencyid = @agency_id_max INTO @in_use.
          ENDIF.
          IF in_use = 0.
            EXIT.
          ENDIF.
        ENDDO.
        IF agency_id_max < preliminary_floor.
          <agency>-agencyid = agency_id_max.
        ENDIF.

        " Read table mapped assign
      ENDIF.
    ENDLOOP.

    " OSD overlay: ASSERT agency_id_max = number_range_key -- no number range here

  ENDMETHOD.

ENDCLASS.
