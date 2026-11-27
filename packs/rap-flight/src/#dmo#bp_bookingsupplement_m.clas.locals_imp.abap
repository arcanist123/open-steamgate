* OSD overlay of the booking supplement pool of the managed scenario
* (upstream managed/#dmo#bp_bookingsupplement_m.clas.locals_imp.abap at commit 5353cbeb,
* Apache-2.0), changed where this runtime differs; each change is marked
* "OSD overlay" (the kinds are listed in the travel pool's overlay header and
* in docs/rap-flight-pack.md). The %path of a message is built from the
* supplement's own key, which carries its booking's and its travel's: the
* links upstream reads by \_Booking and \_Travel give the same keys.
CLASS lhc_bookingsupplement DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.

    METHODS calculateTotalPrice FOR DETERMINE ON MODIFY IMPORTING keys FOR booksuppl~calculateTotalPrice.
    METHODS validate_currencycode FOR VALIDATE ON SAVE
      IMPORTING keys FOR booksuppl~validateCurrencyCode.
    METHODS validate_supplement FOR VALIDATE ON SAVE
      IMPORTING keys FOR booksuppl~validateSupplement.
    METHODS validate_price FOR VALIDATE ON SAVE
      IMPORTING keys FOR booksuppl~validatePrice.

ENDCLASS.

CLASS lhc_bookingsupplement IMPLEMENTATION.

  METHOD calculateTotalPrice.
    DATA: travel_ids TYPE STANDARD TABLE OF /dmo/i_travel_m WITH UNIQUE HASHED KEY key COMPONENTS travel_id.
    " OSD overlay: the import declared
    DATA executes TYPE TABLE FOR ACTION IMPORT /dmo/i_travel_m\\travel~recalctotalprice.
    DATA travel_id TYPE /dmo/i_travel_m.

    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    LOOP AT keys INTO DATA(key).
      travel_id-travel_id = key-travel_id.
      INSERT travel_id INTO TABLE travel_ids.
    ENDLOOP.

    executes = CORRESPONDING #( travel_ids ).
    MODIFY ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY Travel
        EXECUTE ReCalcTotalPrice
        FROM executes.
  ENDMETHOD.

  METHOD validate_currencycode.
    " OSD overlay: the EML target and its import declared
    DATA read_keys           TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booksuppl.
    DATA booking_supplements TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booksuppl.
    DATA currency            TYPE i_currency.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY booksuppl
        FIELDS ( currency_code )
        WITH read_keys
      RESULT booking_supplements.

    DATA: currencies TYPE SORTED TABLE OF I_Currency WITH UNIQUE KEY currency.

    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    LOOP AT booking_supplements INTO DATA(with_currency) WHERE currency_code IS NOT INITIAL.
      currency-currency = with_currency-currency_code.
      INSERT currency INTO TABLE currencies.
    ENDLOOP.

    IF currencies IS NOT INITIAL.
      SELECT FROM I_Currency FIELDS currency
        FOR ALL ENTRIES IN @currencies
        WHERE currency = @currencies-currency
        INTO TABLE @DATA(currency_db).
    ENDIF.


    LOOP AT booking_supplements INTO DATA(booking_supplement).
      IF booking_supplement-currency_code IS INITIAL.
        " Raise message for empty Currency
        APPEND VALUE #( %tky                   = booking_supplement-%tky ) TO failed-booksuppl.
        APPEND VALUE #( %tky                   = booking_supplement-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                                                        textid    = /dmo/cm_flight_messages=>currency_required
                                                        severity  = if_abap_behv_message=>severity-error )
                        %element-currency_code = if_abap_behv=>mk-on
                        %path                  = VALUE #( travel-travel_id    = booking_supplement-travel_id
                                                          booking-booking_id  = booking_supplement-booking_id )
                      ) TO reported-booksuppl.
      ELSEIF NOT line_exists( currency_db[ currency = booking_supplement-currency_code ] ).
        " Raise message for not existing Currency
        APPEND VALUE #( %tky                   = booking_supplement-%tky ) TO failed-booksuppl.
        APPEND VALUE #( %tky                   = booking_supplement-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                                                        textid        = /dmo/cm_flight_messages=>currency_not_existing
                                                        severity      = if_abap_behv_message=>severity-error
                                                        currency_code = booking_supplement-currency_code )
                        %element-currency_code = if_abap_behv=>mk-on
                      ) TO reported-booksuppl.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD validate_supplement.
    " OSD overlay: the EML targets and their import declared
    DATA read_keys          TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booksuppl.
    DATA bookingsupplements TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booksuppl.
    DATA read_failed        TYPE RESPONSE FOR FAILED EARLY /dmo/i_travel_m.
    DATA supplement         TYPE /dmo/supplement.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY booksuppl
        FIELDS ( supplement_id )
        WITH read_keys
      RESULT bookingsupplements
      FAILED read_failed.

    " OSD overlay: CORRESPONDING #( DEEP ... ) is not transpiled; the two
    " responses have one type, so the assignment is the same move
    failed = read_failed.

    " OSD overlay: the two LINK reads by \_Booking and \_Travel are not made:
    " the %path below takes the ancestors' keys from the supplement's key


    DATA supplements TYPE SORTED TABLE OF /dmo/supplement WITH UNIQUE KEY supplement_id.

    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    LOOP AT bookingsupplements INTO DATA(with_supplement) WHERE supplement_id IS NOT INITIAL.
      supplement-supplement_id = with_supplement-supplement_id.
      INSERT supplement INTO TABLE supplements.
    ENDLOOP.

    IF  supplements IS NOT INITIAL.
      " Check if supplement ID exists
      SELECT FROM /dmo/supplement FIELDS supplement_id
                                  FOR ALL ENTRIES IN @supplements
                                  WHERE supplement_id = @supplements-supplement_id
      INTO TABLE @DATA(valid_supplements).
    ENDIF.

    LOOP AT bookingsupplements ASSIGNING FIELD-SYMBOL(<bookingsupplement>).

      IF <bookingsupplement>-supplement_id IS  INITIAL.

        APPEND VALUE #( %tky = <bookingsupplement>-%tky ) TO failed-booksuppl.
        APPEND VALUE #( %tky                   = <bookingsupplement>-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                                                                textid = /dmo/cm_flight_messages=>enter_supplement_id
                                                                severity = if_abap_behv_message=>severity-error )
                        %path                  = VALUE #( booking-travel_id  = <bookingsupplement>-travel_id " OSD overlay: from the key
                                                          booking-booking_id = <bookingsupplement>-booking_id
                                                          travel-travel_id   = <bookingsupplement>-travel_id )
                        %element-supplement_id = if_abap_behv=>mk-on
                       ) TO reported-booksuppl.


      ELSEIF <bookingsupplement>-supplement_id IS NOT INITIAL AND NOT line_exists( valid_supplements[ supplement_id = <bookingsupplement>-supplement_id ] ).

        APPEND VALUE #(  %tky = <bookingsupplement>-%tky ) TO failed-booksuppl.
        APPEND VALUE #( %tky                   = <bookingsupplement>-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                                                                textid = /dmo/cm_flight_messages=>supplement_unknown
                                                                severity = if_abap_behv_message=>severity-error )
                        %path                  = VALUE #( booking-travel_id  = <bookingsupplement>-travel_id " OSD overlay: from the key
                                                          booking-booking_id = <bookingsupplement>-booking_id
                                                          travel-travel_id   = <bookingsupplement>-travel_id )
                        %element-supplement_id = if_abap_behv=>mk-on
                       ) TO reported-booksuppl.
      ENDIF.

    ENDLOOP.

  ENDMETHOD.

  METHOD validate_price.
    " OSD overlay: the EML target and its import declared
    DATA read_keys           TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booksuppl.
    DATA booking_supplements TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booksuppl.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY booksuppl
        FIELDS ( price )
        WITH read_keys
      RESULT booking_supplements.

    " OSD overlay: the two LINK reads by \_Booking and \_Travel are not made:
    " the %path below takes the ancestors' keys from the supplement's key

    LOOP AT booking_supplements INTO DATA(book_suppl) WHERE price < 0.
      " Raise message for supplement price < 0
      APPEND VALUE #( %tky                  = book_suppl-%tky ) TO failed-booksuppl.
      APPEND VALUE #( %tky                  = book_suppl-%tky
                      %msg                  = NEW /dmo/cm_flight_messages(
                                                     textid      = /dmo/cm_flight_messages=>suppl_price_invalid
                                                     severity    = if_abap_behv_message=>severity-error )
                      %path                  = VALUE #( booking-travel_id  = book_suppl-travel_id " OSD overlay: from the key
                                                        booking-booking_id = book_suppl-booking_id
                                                        travel-travel_id   = book_suppl-travel_id )
                      %element-price = if_abap_behv=>mk-on
                    ) TO reported-booksuppl.
    ENDLOOP.

  ENDMETHOD.

ENDCLASS.
