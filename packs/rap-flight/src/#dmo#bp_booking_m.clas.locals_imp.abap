* OSD overlay of the booking pool of the managed scenario (upstream
* managed/#dmo#bp_booking_m.clas.locals_imp.abap at commit 5353cbeb,
* Apache-2.0), changed where
* this runtime differs; each change is marked "OSD overlay" (the kinds are
* listed in the travel pool's overlay header and in docs/rap-flight-pack.md).
* The %path of a message is built from the booking's own key, which carries
* its travel's: the link upstream reads by \_Travel gives the same key.
CLASS lhc_booking DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.

    METHODS calculatetotalprice FOR DETERMINE ON MODIFY
       IMPORTING keys FOR booking~calculatetotalprice.
    METHODS validateStatus FOR VALIDATE ON SAVE
       IMPORTING keys FOR booking~validatestatus.
    METHODS validate_customer FOR VALIDATE ON SAVE
      IMPORTING keys FOR booking~validateCustomer.
    METHODS validate_connection FOR VALIDATE ON SAVE
      IMPORTING keys FOR booking~validateConnection.
    METHODS get_features FOR INSTANCE FEATURES
       IMPORTING keys REQUEST requested_features FOR booking RESULT result.
    METHODS validate_currencycode FOR VALIDATE ON SAVE
      IMPORTING keys FOR booking~validatecurrencycode.
    METHODS validate_flight_price FOR VALIDATE ON SAVE
      IMPORTING keys FOR booking~validateFlightPrice.
    METHODS earlynumbering_cba_booksupplem FOR NUMBERING
       IMPORTING entities FOR CREATE booking\_booksupplement.




ENDCLASS.

CLASS lhc_booking IMPLEMENTATION.

  METHOD calculatetotalprice.
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



  METHOD validateStatus.

    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking.
    DATA bookings  TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking.
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /dmo/i_travel_m IN LOCAL MODE
      ENTITY booking
        FIELDS ( booking_status )
        WITH read_keys
      RESULT bookings.

    LOOP AT bookings INTO DATA(booking).
      CASE booking-booking_status.
        WHEN 'N'.  " New
        WHEN 'X'.  " Canceled
        WHEN 'B'.  " Booked

        WHEN OTHERS.
          APPEND VALUE #( %tky = booking-%tky ) TO failed-booking.

          APPEND VALUE #( %tky = booking-%tky
                          %msg = NEW /dmo/cm_flight_messages(
                                     textid = /dmo/cm_flight_messages=>status_invalid
                                     status = booking-booking_status
                                     severity = if_abap_behv_message=>severity-error )
                          %element-booking_status = if_abap_behv=>mk-on
                          %path = VALUE #(  travel-travel_id    = booking-travel_id )
                        ) TO reported-booking.
      ENDCASE.

    ENDLOOP.

  ENDMETHOD.

  METHOD validate_customer.

    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking.
    DATA bookings  TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking.
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY Booking
        FIELDS ( customer_id )
        WITH read_keys
    RESULT bookings.

    " OSD overlay: the LINK read by \_Travel is not made: the %path below
    " takes the travel's key from the booking's key

    DATA customers TYPE SORTED TABLE OF /dmo/customer WITH UNIQUE KEY customer_id.

    " Optimization of DB select: extract distinct non-initial customer IDs
    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    DATA customer TYPE /dmo/customer.
    LOOP AT bookings INTO DATA(with_customer) WHERE customer_id IS NOT INITIAL.
      customer-customer_id = with_customer-customer_id.
      INSERT customer INTO TABLE customers.
    ENDLOOP.

    IF  customers IS NOT INITIAL.
      " Check if customer ID exists
      SELECT FROM /dmo/customer FIELDS customer_id
                                FOR ALL ENTRIES IN @customers
                                WHERE customer_id = @customers-customer_id
      INTO TABLE @DATA(valid_customers).
    ENDIF.

    " Raise message for non existing and initial customer id
    LOOP AT bookings INTO DATA(booking).
      IF booking-customer_id IS  INITIAL.

        APPEND VALUE #( %tky = booking-%tky ) TO failed-booking.
        APPEND VALUE #( %tky                 = booking-%tky
                        %msg                 = NEW /dmo/cm_flight_messages(
                                                                textid = /dmo/cm_flight_messages=>enter_customer_id
                                                                severity = if_abap_behv_message=>severity-error )
                        %path                = VALUE #( travel-travel_id = booking-travel_id ) " OSD overlay: from the key
                        %element-customer_id = if_abap_behv=>mk-on
                       ) TO reported-booking.

      ELSEIF booking-customer_id IS NOT INITIAL AND NOT line_exists( valid_customers[ customer_id = booking-customer_id ] ).

        APPEND VALUE #( %tky = booking-%tky ) TO failed-booking.
        APPEND VALUE #( %tky                 = booking-%tky
                        %msg                 = NEW /dmo/cm_flight_messages(
                                                                textid = /dmo/cm_flight_messages=>customer_unkown
                                                                customer_id = booking-customer_id
                                                                severity = if_abap_behv_message=>severity-error )
                        %path                = VALUE #( travel-travel_id = booking-travel_id ) " OSD overlay: from the key
                        %element-customer_id = if_abap_behv=>mk-on
                       ) TO reported-booking.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.

  METHOD validate_connection.

    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking.
    DATA bookings  TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking.
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY Booking
        FIELDS ( booking_id carrier_id connection_id flight_date )
        WITH read_keys
      RESULT bookings.

    " OSD overlay: the LINK read by \_Travel is not made: the %path below
    " takes the travel's key from the booking's key

    LOOP AT bookings ASSIGNING FIELD-SYMBOL(<booking>).
      " Raise message for non existing airline ID
      IF <booking>-carrier_id IS INITIAL.

        APPEND VALUE #( %tky = <booking>-%tky ) TO failed-booking.
        APPEND VALUE #( %tky                = <booking>-%tky
                        %msg                = NEW /dmo/cm_flight_messages(
                                                                textid = /dmo/cm_flight_messages=>enter_airline_id
                                                                severity = if_abap_behv_message=>severity-error )
                        %path               = VALUE #( travel-travel_id = <booking>-travel_id ) " OSD overlay: from the key
                        %element-carrier_id = if_abap_behv=>mk-on
                       ) TO reported-booking.
      ENDIF.
      " Raise message for non existing connection ID
      IF <booking>-connection_id IS INITIAL.

        APPEND VALUE #( %tky = <booking>-%tky ) TO failed-booking.
        APPEND VALUE #( %tky                   = <booking>-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                                                                textid = /dmo/cm_flight_messages=>enter_connection_id
                                                                severity = if_abap_behv_message=>severity-error )
                        %path                  = VALUE #( travel-travel_id = <booking>-travel_id ) " OSD overlay: from the key
                        %element-connection_id = if_abap_behv=>mk-on
                       ) TO reported-booking.
      ENDIF.
      " Raise message for non existing flight date
      IF <booking>-flight_date IS INITIAL.

        APPEND VALUE #( %tky = <booking>-%tky ) TO failed-booking.
        APPEND VALUE #( %tky                 = <booking>-%tky
                        %msg                 = NEW /dmo/cm_flight_messages(
                                                                textid = /dmo/cm_flight_messages=>enter_flight_date
                                                                severity = if_abap_behv_message=>severity-error )
                        %path                = VALUE #( travel-travel_id = <booking>-travel_id ) " OSD overlay: from the key
                        %element-flight_date = if_abap_behv=>mk-on
                       ) TO reported-booking.
      ENDIF.
      " check if flight connection exists
      IF <booking>-carrier_id IS NOT INITIAL AND
         <booking>-connection_id IS NOT INITIAL AND
         <booking>-flight_date IS NOT INITIAL.

        SELECT SINGLE Carrier_ID, Connection_ID, Flight_Date   FROM /dmo/flight  WHERE  carrier_id    = @<booking>-carrier_id
                                                               AND  connection_id = @<booking>-connection_id
                                                               AND  flight_date   = @<booking>-flight_date
                                                               INTO  @DATA(flight).

        IF sy-subrc <> 0.

          APPEND VALUE #( %tky = <booking>-%tky ) TO failed-booking.
          APPEND VALUE #( %tky                   = <booking>-%tky
                          %msg                   = NEW /dmo/cm_flight_messages(
                                                                textid      = /dmo/cm_flight_messages=>no_flight_exists
                                                                carrier_id  = <booking>-carrier_id
                                                                flight_date = <booking>-flight_date
                                                                severity    = if_abap_behv_message=>severity-error )
                          %path                  = VALUE #( travel-travel_id = <booking>-travel_id ) " OSD overlay: from the key
                          %element-flight_date   = if_abap_behv=>mk-on
                          %element-carrier_id    = if_abap_behv=>mk-on
                          %element-connection_id = if_abap_behv=>mk-on
                        ) TO reported-booking.

        ENDIF.

      ENDIF.

    ENDLOOP.

  ENDMETHOD.

  METHOD get_features.

    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking.
    DATA bookings  TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking.
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /dmo/i_travel_m IN LOCAL MODE
      ENTITY booking
         FIELDS ( booking_id booking_status )
         WITH read_keys
      RESULT bookings
      FAILED failed.

    result = VALUE #( FOR booking IN bookings
                       ( %tky                   = booking-%tky
                         %assoc-_booksupplement = COND #( WHEN booking-booking_status = 'B'
                                                          THEN if_abap_behv=>fc-o-disabled ELSE if_abap_behv=>fc-o-enabled  ) ) ).

  ENDMETHOD.



  METHOD earlynumbering_cba_booksupplem.
    DATA: max_booking_suppl_id TYPE /dmo/booking_supplement_id .
    " OSD overlay: the EML targets and their import declared
    DATA read_keys           TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking\_booksupplement.
    DATA read_rows           TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking\_booksupplement.
    DATA booking_supplements TYPE TABLE FOR READ LINK /dmo/i_travel_m\\booking\_booksupplement.
    DATA read_fail           TYPE RESPONSE FOR FAILED EARLY /dmo/i_travel_m.

    " OSD overlay: READ ENTITIES OF /dmo/i_travel_m IN LOCAL MODE
    "   ENTITY booking BY \_booksupplement FROM CORRESPONDING #( entities )
    "   LINK DATA(booking_supplements).
    read_keys = CORRESPONDING #( entities ).
    zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'BOOKING' iv_assoc = '_BOOKSUPPLEMENT' it_keys = read_keys
                              CHANGING ct_result = read_rows ct_link = booking_supplements cs_failed = read_fail ).

    " Loop over all unique tky (TravelID + BookingID)
    " OSD overlay: LOOP ... GROUP BY and the two REDUCEs over USING KEY entity
    " are written as loops; a booking that comes twice continues its numbers
    LOOP AT entities ASSIGNING FIELD-SYMBOL(<booking>).

      " Get highest bookingsupplement_id from bookings belonging to booking
      max_booking_suppl_id = '0'.
      LOOP AT booking_supplements INTO DATA(booksuppl) WHERE source-travel_id  = <booking>-travel_id
                                                         AND source-booking_id = <booking>-booking_id.
        IF booksuppl-target-booking_supplement_id > max_booking_suppl_id.
          max_booking_suppl_id = booksuppl-target-booking_supplement_id.
        ENDIF.
      ENDLOOP.
      " Get highest assigned bookingsupplement_id from incoming entities, eg internal operations
      LOOP AT entities INTO DATA(entity) WHERE travel_id  = <booking>-travel_id
                                           AND booking_id = <booking>-booking_id.
        LOOP AT entity-%target INTO DATA(target).
          IF target-booking_supplement_id > max_booking_suppl_id.
            max_booking_suppl_id = target-booking_supplement_id.
          ENDIF.
        ENDLOOP.
      ENDLOOP.
      LOOP AT mapped-booksuppl INTO DATA(already) WHERE travel_id  = <booking>-travel_id
                                                    AND booking_id = <booking>-booking_id.
        IF already-booking_supplement_id > max_booking_suppl_id.
          max_booking_suppl_id = already-booking_supplement_id.
        ENDIF.
      ENDLOOP.


        " Assign new booking_supplement-ids
        LOOP AT <booking>-%target ASSIGNING FIELD-SYMBOL(<booksuppl_wo_numbers>).
          APPEND CORRESPONDING #( <booksuppl_wo_numbers> ) TO mapped-booksuppl ASSIGNING FIELD-SYMBOL(<mapped_booksuppl>).
          IF <booksuppl_wo_numbers>-booking_supplement_id IS INITIAL.
            max_booking_suppl_id += 1 .
            <mapped_booksuppl>-booking_supplement_id = max_booking_suppl_id .
          ENDIF.
        ENDLOOP.



    ENDLOOP.
  ENDMETHOD.

  METHOD validate_currencycode.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking.
    DATA bookings  TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking.
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY booking
        FIELDS ( currency_code )
        WITH read_keys
      RESULT bookings.

    DATA: currencies TYPE SORTED TABLE OF I_Currency WITH UNIQUE KEY currency.

    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    DATA currency TYPE i_currency.
    LOOP AT bookings INTO DATA(with_currency) WHERE currency_code IS NOT INITIAL.
      currency-currency = with_currency-currency_code.
      INSERT currency INTO TABLE currencies.
    ENDLOOP.

    IF currencies IS NOT INITIAL.
      SELECT FROM I_Currency FIELDS currency
        FOR ALL ENTRIES IN @currencies
        WHERE currency = @currencies-currency
        INTO TABLE @DATA(currency_db).
    ENDIF.


    LOOP AT bookings INTO DATA(booking).
      IF booking-currency_code IS INITIAL.
        " Raise message for empty Currency
        APPEND VALUE #( %tky                   = booking-%tky ) TO failed-booking.
        APPEND VALUE #( %tky                   = booking-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                                                        textid    = /dmo/cm_flight_messages=>currency_required
                                                        severity  = if_abap_behv_message=>severity-error )
                        %element-currency_code = if_abap_behv=>mk-on
                        %path                  = VALUE #(  travel-travel_id    = booking-travel_id )
                      ) TO reported-booking.
      ELSEIF NOT line_exists( currency_db[ currency = booking-currency_code ] ).
        " Raise message for not existing Currency
        APPEND VALUE #( %tky                   = booking-%tky ) TO failed-booking.
        APPEND VALUE #( %tky                   = booking-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                                                        textid    = /dmo/cm_flight_messages=>currency_not_existing
                                                        severity  = if_abap_behv_message=>severity-error
                                                        currency_code = booking-currency_code )
                        %path                  = VALUE #(  travel-travel_id    = booking-travel_id )
                        %element-currency_code = if_abap_behv=>mk-on
                      ) TO reported-booking.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD validate_flight_price.

    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking.
    DATA bookings  TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking.
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY booking
        FIELDS ( flight_price )
        WITH read_keys
      RESULT bookings.

    " OSD overlay: the LINK read by \_Travel is not made: the %path below
    " takes the travel's key from the booking's key

    LOOP AT bookings INTO DATA(booking) WHERE flight_price < 0.
      " Raise message for flight price < 0
      APPEND VALUE #( %tky                  = booking-%tky ) TO failed-booking.
      APPEND VALUE #( %tky                  = booking-%tky
                      %msg                  = NEW /dmo/cm_flight_messages(
                                                     textid      = /dmo/cm_flight_messages=>flight_price_invalid
                                                     severity    = if_abap_behv_message=>severity-error )
                      %element-flight_price = if_abap_behv=>mk-on
                      %path                 = VALUE #( travel-travel_id = booking-travel_id ) " OSD overlay: from the key
                    ) TO reported-booking.
    ENDLOOP.

  ENDMETHOD.

ENDCLASS.
