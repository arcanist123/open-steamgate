* OSD overlay of the carrier singleton's pool of the reuse layer (upstream
* reuse/carrier/#dmo#bp_i_carrierslocksingle_s.clas.locals_imp.abap at
* commit 5353cbeb, Apache-2.0): the same handlers and saver, changed where
* this runtime differs. Each change is marked "OSD overlay";
* docs/rap-flight-pack.md lists them: the test classes are not fetched (the
* DEFINITION DEFERRED FOR TESTING lines and the FRIENDS that name them are
* dropped); the EML targets are declared with their derived type; and
* CORRESPONDING ... DISCARDING DUPLICATES MAPPING ... EXCEPT * is a loop.
" OSD overlay: DEFINITION DEFERRED FOR TESTING and the FRIENDS dropped
CLASS lhc_carrier DEFINITION
  INHERITING FROM cl_abap_behavior_handler.

  PRIVATE SECTION.

    METHODS get_instance_features FOR INSTANCE FEATURES
      IMPORTING keys REQUEST requested_features FOR Carrier RESULT result.

    METHODS validatecurrencycode FOR VALIDATE ON SAVE
      IMPORTING keys FOR carrier~validatecurrencycode.

    METHODS validatename FOR VALIDATE ON SAVE
      IMPORTING keys FOR carrier~validatename.

ENDCLASS.

CLASS lhc_carrier IMPLEMENTATION.

  METHOD get_instance_features.

    DATA: airline_ids TYPE SORTED TABLE OF /dmo/i_carrier WITH UNIQUE KEY AirlineID.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_carrierslocksingleton_s\carrier.
    DATA Carrier   TYPE TABLE FOR READ RESULT /dmo/i_carrierslocksingleton_s\carrier.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_CarriersLockSingleton_S IN LOCAL MODE
      ENTITY Carrier
        FIELDS ( AirlineID )
        WITH read_keys
      RESULT Carrier
      FAILED failed.

    " OSD overlay: DISCARDING DUPLICATES MAPPING ... EXCEPT * is a loop
    DATA airline_id TYPE /dmo/i_carrier.
    LOOP AT Carrier INTO DATA(with_id).
      airline_id-AirlineID = with_id-AirlineID.
      INSERT airline_id INTO TABLE airline_ids.
    ENDLOOP.

    IF airline_ids IS NOT INITIAL.
      SELECT DISTINCT AirlineID
      FROM /DMO/I_Connection
        FOR ALL ENTRIES IN @airline_ids
        WHERE AirlineID = @airline_ids-AirlineID
        INTO TABLE @DATA(connections_db).
    ENDIF.

    LOOP AT Carrier ASSIGNING FIELD-SYMBOL(<carrier>).
      " Delete is not allowed if any Connection exists
      IF line_exists( connections_db[ AirlineID = <carrier>-AirlineID ] ).
        APPEND VALUE #( %tky    = <carrier>-%tky
                        %delete = if_abap_behv=>fc-o-disabled ) TO result.
        APPEND VALUE #( %tky                        = <carrier>-%tky
                        %msg                        = NEW /dmo/cx_carriers_s(
                                                       textid        = /dmo/cx_carriers_s=>airline_still_used
                                                       severity      = if_abap_behv_message=>severity-information
                                                       airline_id    = <carrier>-AirlineID )
                        %delete                     = if_abap_behv=>mk-on
                        %path-carrierslocksingleton = CORRESPONDING #( <carrier> )
                      ) TO reported-carrier.
      ELSE.
        APPEND VALUE #( %tky    = <carrier>-%tky
                        %delete = if_abap_behv=>fc-o-enabled ) TO result.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD validateCurrencyCode.

    DATA: currency_codes TYPE SORTED TABLE OF I_Currency WITH UNIQUE KEY Currency.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_carrierslocksingleton_s\carrier.
    DATA Carrier   TYPE TABLE FOR READ RESULT /dmo/i_carrierslocksingleton_s\carrier.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_CarriersLockSingleton_S IN LOCAL MODE
      ENTITY Carrier
        FIELDS ( CarrierSingletonID CurrencyCode )
        WITH read_keys
      RESULT Carrier.

    " OSD overlay: DISCARDING DUPLICATES MAPPING ... EXCEPT * is a loop
    DATA currency_code TYPE i_currency.
    LOOP AT Carrier INTO DATA(with_currency).
      currency_code-Currency = with_currency-CurrencyCode.
      INSERT currency_code INTO TABLE currency_codes.
    ENDLOOP.

    IF currency_codes IS NOT INITIAL.
      SELECT FROM I_Currency FIELDS Currency
        FOR ALL ENTRIES IN @currency_codes
        WHERE Currency = @currency_codes-Currency
        INTO TABLE @DATA(currency_codes_db).
    ENDIF.

    " Raise message for not existing Currency Codes
    LOOP AT Carrier ASSIGNING FIELD-SYMBOL(<carrier>).

      APPEND VALUE #( %tky        = <carrier>-%tky
                      %state_area = 'VALIDATE_CURRENCY_CODE'
                    ) TO reported-carrier.

      IF <carrier>-CurrencyCode IS INITIAL.
        APPEND VALUE #( %tky                             = <carrier>-%tky ) TO failed-carrier.
        APPEND VALUE #( %tky                             = <carrier>-%tky
                        %msg                             = NEW /dmo/cx_carriers_s(
                                                               textid     = /dmo/cx_carriers_s=>currency_code_required
                                                               severity   = if_abap_behv_message=>severity-error
                                                               airline_id = <carrier>-AirlineID )
                        %element-currencycode            = if_abap_behv=>mk-on
                        %state_area                      = 'VALIDATE_CURRENCY_CODE'
                        %path-carrierslocksingleton      = CORRESPONDING #( <carrier> )
                      ) TO reported-carrier.

      ELSEIF NOT line_exists( currency_codes_db[ Currency = <carrier>-CurrencyCode ] ).
        APPEND VALUE #( %tky                             = <carrier>-%tky ) TO failed-carrier.
        APPEND VALUE #( %tky                             = <carrier>-%tky
                        %msg                             = NEW /dmo/cx_carriers_s(
                                                               textid        = /dmo/cx_carriers_s=>invalid_currency_code
                                                               severity      = if_abap_behv_message=>severity-error
                                                               currency_code = <carrier>-CurrencyCode )
                        %element-currencycode            = if_abap_behv=>mk-on
                        %state_area                      = 'VALIDATE_CURRENCY_CODE'
                        %path-carrierslocksingleton      = CORRESPONDING #( <carrier> )
                      ) TO reported-carrier.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD validateName.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_carrierslocksingleton_s\carrier.
    DATA Carrier   TYPE TABLE FOR READ RESULT /dmo/i_carrierslocksingleton_s\carrier.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_CarriersLockSingleton_S IN LOCAL MODE
      ENTITY Carrier
        FIELDS ( CarrierSingletonID Name )
        WITH read_keys
      RESULT Carrier.

    " Raise message for empty Airline Name
    LOOP AT Carrier ASSIGNING FIELD-SYMBOL(<carrier>).

      APPEND VALUE #( %tky        = <carrier>-%tky
                      %state_area = 'VALIDATE_NAME'
                    ) TO reported-carrier.

      IF <carrier>-name IS INITIAL.
        APPEND VALUE #( %tky                        = <carrier>-%tky ) TO failed-carrier.
        APPEND VALUE #( %tky                        = <carrier>-%tky
                        %msg                        = NEW /dmo/cx_carriers_s(
                                                         textid     = /dmo/cx_carriers_s=>name_required
                                                         severity   = if_abap_behv_message=>severity-error
                                                         airline_id = <carrier>-AirlineID )
                        %element-name               = if_abap_behv=>mk-on
                        %state_area                 = 'VALIDATE_NAME'
                        %path-carrierslocksingleton = CORRESPONDING #( <carrier> )
                      ) TO reported-carrier.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

ENDCLASS.

" OSD overlay: DEFINITION DEFERRED FOR TESTING and the FRIENDS dropped
CLASS lsc_I_CARRIERSLOCKSINGLETON_S DEFINITION
  INHERITING FROM cl_abap_behavior_saver.
  PROTECTED SECTION.

    METHODS save_modified REDEFINITION.

    METHODS cleanup_finalize REDEFINITION.

ENDCLASS.

CLASS lsc_I_CARRIERSLOCKSINGLETON_S IMPLEMENTATION.

  METHOD save_modified.
  ENDMETHOD.

  METHOD cleanup_finalize.
  ENDMETHOD.

ENDCLASS.
