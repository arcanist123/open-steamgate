* OSD overlay of the travel pool of the managed scenario (upstream
* managed/#dmo#bp_travel_m.clas.locals_imp.abap at commit 5353cbeb,
* Apache-2.0): the same
* handlers and saver, changed where this runtime differs. Each change is
* marked "OSD overlay"; docs/rap-flight-pack.md lists them. The recurring ones:
* - the test classes are not fetched, so the DEFINITION DEFERRED FOR TESTING
*   lines and the FRIENDS that name them are dropped;
* - an EML target declared inline (RESULT DATA(x), LINK DATA(x), MAPPED
*   DATA(x)) is typed void by abaplint, so it is declared with its derived
*   type, and WITH CORRESPONDING #( keys ) becomes a declared import table;
* - READ ENTITIES ... BY \_assoc and MODIFY ENTITIES ... CREATE BY \_assoc
*   are not lowered by the pinned transpiler, so they are written as the
*   ZCL_OSD_RAP_EML calls they lower to, the statement in a comment above;
* - CORRESPONDING ... DISCARDING DUPLICATES is not parsed: a loop;
* - the derived tables have no secondary keys id / entity here, so USING KEY
*   and KEY id read by the key fields.
* The saver (lcl_save) is upstream's, unchanged but for the FRIENDS line.
CLASS lhc_travel DEFINITION INHERITING FROM cl_abap_behavior_handler.

  PRIVATE SECTION.

    TYPES tt_travel_update TYPE TABLE FOR UPDATE /DMO/I_Travel_M.

    METHODS validate_customer FOR VALIDATE ON SAVE
      IMPORTING keys FOR travel~validatecustomer.
    METHODS validate_agency FOR VALIDATE ON SAVE
      IMPORTING keys FOR travel~validateagency.
    METHODS validate_dates  FOR VALIDATE ON SAVE
      IMPORTING keys FOR travel~validatedates.
    METHODS validate_travel_status FOR VALIDATE ON SAVE
      IMPORTING keys FOR travel~validatestatus.
    METHODS validate_currencycode FOR VALIDATE ON SAVE
      IMPORTING keys FOR travel~validatecurrencycode.
    METHODS validate_bookingfee FOR VALIDATE ON SAVE
      IMPORTING keys FOR travel~validatebookingfee.

    METHODS copyTravel FOR MODIFY
      IMPORTING keys FOR ACTION travel~copyTravel.
    METHODS set_status_accepted FOR MODIFY
      IMPORTING keys FOR ACTION travel~accepttravel RESULT result.
    METHODS set_status_rejected FOR MODIFY
      IMPORTING keys FOR ACTION travel~rejecttravel RESULT result.

    METHODS get_features FOR INSTANCE FEATURES
      IMPORTING keys REQUEST requested_features FOR travel RESULT result.

    METHODS recalctotalprice FOR MODIFY
      IMPORTING keys FOR ACTION travel~recalctotalprice.
    METHODS calculatetotalprice FOR DETERMINE ON MODIFY
      IMPORTING keys FOR travel~calculatetotalprice.

    METHODS earlynumbering_cba_booking FOR NUMBERING
      IMPORTING entities FOR CREATE travel\_booking.
    METHODS earlynumbering_create FOR NUMBERING
      IMPORTING entities FOR CREATE travel.

ENDCLASS.

CLASS lhc_travel IMPLEMENTATION.

  METHOD validate_customer.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.
    DATA customer  TYPE /dmo/customer.

    " Read relevant travel instance data
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    ENTITY travel
     FIELDS ( customer_id )
     WITH read_keys
    RESULT travels.

    DATA customers TYPE SORTED TABLE OF /dmo/customer WITH UNIQUE KEY customer_id.

    " Optimization of DB select: extract distinct non-initial customer IDs
    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    LOOP AT travels INTO DATA(with_customer) WHERE customer_id IS NOT INITIAL.
      customer-customer_id = with_customer-customer_id.
      INSERT customer INTO TABLE customers.
    ENDLOOP.
    IF customers IS NOT INITIAL.

      " Check if customer ID exists
      SELECT FROM /dmo/customer FIELDS customer_id
        FOR ALL ENTRIES IN @customers
        WHERE customer_id = @customers-customer_id
        INTO TABLE @DATA(customers_db).
    ENDIF.
    " Raise msg for non existing and initial customer id
    LOOP AT travels INTO DATA(travel).
      IF travel-customer_id IS INITIAL
         OR NOT line_exists( customers_db[ customer_id = travel-customer_id ] ).

        APPEND VALUE #(  %tky = travel-%tky ) TO failed-travel.
        APPEND VALUE #( %tky                 = travel-%tky
                        %msg                 = NEW /dmo/cm_flight_messages(
                        customer_id = travel-customer_id
                        textid      = /dmo/cm_flight_messages=>customer_unkown
                        severity    = if_abap_behv_message=>severity-error )
                        %element-customer_id = if_abap_behv=>mk-on
                      ) TO reported-travel.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.



  METHOD validate_agency.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.
    DATA agency    TYPE /dmo/agency.

    " Read relevant travel instance data
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    ENTITY travel
     FIELDS ( agency_id )
     WITH read_keys
    RESULT travels.

    DATA agencies TYPE SORTED TABLE OF /dmo/agency WITH UNIQUE KEY agency_id.

    " Optimization of DB select: extract distinct non-initial agency IDs
    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    LOOP AT travels INTO DATA(with_agency) WHERE agency_id IS NOT INITIAL.
      agency-agency_id = with_agency-agency_id.
      INSERT agency INTO TABLE agencies.
    ENDLOOP.
    IF  agencies IS NOT INITIAL.

      " check if agency ID exist
      SELECT FROM /dmo/agency FIELDS agency_id
        FOR ALL ENTRIES IN @agencies
        WHERE agency_id = @agencies-agency_id
        INTO TABLE @DATA(agencies_db).
    ENDIF.

    " Raise msg for non existing and initial agency id
    LOOP AT travels INTO DATA(travel).
      IF travel-agency_id IS INITIAL
         OR NOT line_exists( agencies_db[ agency_id = travel-agency_id ] ).

        APPEND VALUE #(  %tky = travel-%tky ) TO failed-travel.
        APPEND VALUE #( %tky               = travel-%tky
                        %msg               = NEW /dmo/cm_flight_messages(
                        textid    = /dmo/cm_flight_messages=>agency_unkown
                        agency_id = travel-agency_id
                        severity  = if_abap_behv_message=>severity-error )
                        %element-agency_id = if_abap_behv=>mk-on
                      ) TO reported-travel.
      ENDIF.
    ENDLOOP.

  ENDMETHOD.


  METHOD validate_dates.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
        FIELDS ( begin_date end_date )
        WITH read_keys
      RESULT travels.

    LOOP AT travels INTO DATA(travel).

      IF travel-end_date < travel-begin_date.  "end_date before begin_date

        APPEND VALUE #( %tky = travel-%tky ) TO failed-travel.

        APPEND VALUE #( %tky                = travel-%tky
                        %msg                = NEW /dmo/cm_flight_messages(
                        textid     = /dmo/cm_flight_messages=>begin_date_bef_end_date
                        severity   = if_abap_behv_message=>severity-error
                        begin_date = travel-begin_date
                        end_date   = travel-end_date
                        travel_id  = travel-travel_id )
                        %element-begin_date = if_abap_behv=>mk-on
                        %element-end_date   = if_abap_behv=>mk-on
        ) TO reported-travel.

      ELSEIF travel-begin_date < cl_abap_context_info=>get_system_date( ).  "begin_date must be in the future

        APPEND VALUE #( %tky        = travel-%tky ) TO failed-travel.

        APPEND VALUE #( %tky                = travel-%tky
                        %msg                = NEW /dmo/cm_flight_messages(
                        textid   = /dmo/cm_flight_messages=>begin_date_on_or_bef_sysdate
                        severity = if_abap_behv_message=>severity-error )
                        %element-begin_date = if_abap_behv=>mk-on
                        %element-end_date   = if_abap_behv=>mk-on
                      ) TO reported-travel.
      ENDIF.

    ENDLOOP.

  ENDMETHOD.

  METHOD validate_travel_status.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
        ENTITY travel
          FIELDS ( overall_status )
          WITH read_keys
        RESULT travels.

    LOOP AT travels INTO DATA(travel).
      CASE travel-overall_status.
        WHEN 'O'.  " Open
        WHEN 'X'.  " Cancelled
        WHEN 'A'.  " Accepted

        WHEN OTHERS.
          APPEND VALUE #( %tky = travel-%tky ) TO failed-travel.

          APPEND VALUE #( %tky                    = travel-%tky
                          %msg                    = NEW /dmo/cm_flight_messages(
                          textid   = /dmo/cm_flight_messages=>status_invalid
                          severity = if_abap_behv_message=>severity-error
                          status   = travel-overall_status )
                          %element-overall_status = if_abap_behv=>mk-on
                        ) TO reported-travel.
      ENDCASE.

    ENDLOOP.

  ENDMETHOD.

  METHOD copyTravel.

    DATA:
      travels       TYPE TABLE FOR CREATE /DMO/I_Travel_M\\travel,
      bookings_cba  TYPE TABLE FOR CREATE /DMO/I_Travel_M\\travel\_booking,
      booksuppl_cba TYPE TABLE FOR CREATE /DMO/I_Travel_M\\booking\_booksupplement.
    " OSD overlay: the EML targets and their imports declared
    DATA read_keys             TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travel_read_result    TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.
    DATA book_keys             TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel\_booking.
    DATA book_read_result      TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel\_booking.
    DATA book_links            TYPE TABLE FOR READ LINK /dmo/i_travel_m\\travel\_booking.
    DATA booksuppl_keys        TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking\_booksupplement.
    DATA booksuppl_read_result TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking\_booksupplement.
    DATA booksuppl_links       TYPE TABLE FOR READ LINK /dmo/i_travel_m\\booking\_booksupplement.
    DATA mapped_create         TYPE RESPONSE FOR MAPPED EARLY /dmo/i_travel_m.
    DATA failed_create         TYPE RESPONSE FOR FAILED EARLY /dmo/i_travel_m.
    DATA reported_create       TYPE RESPONSE FOR REPORTED EARLY /dmo/i_travel_m.
    DATA failed_line           LIKE LINE OF failed-travel.

    READ TABLE keys WITH KEY %cid = '' INTO DATA(key_with_inital_cid).
    ASSERT key_with_inital_cid IS INITIAL.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
       ALL FIELDS WITH read_keys
    RESULT travel_read_result.

    " OSD overlay: READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    "   ENTITY travel BY \_booking ALL FIELDS WITH CORRESPONDING #( travel_read_result )
    "   RESULT DATA(book_read_result).
    book_keys = CORRESPONDING #( travel_read_result ).
    zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'TRAVEL' iv_assoc = '_BOOKING' it_keys = book_keys
                              CHANGING ct_result = book_read_result ct_link = book_links cs_failed = failed_create ).

    " OSD overlay: READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    "   ENTITY booking BY \_booksupplement ALL FIELDS WITH CORRESPONDING #( book_read_result )
    "   RESULT DATA(booksuppl_read_result).
    booksuppl_keys = CORRESPONDING #( book_read_result ).
    zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'BOOKING' iv_assoc = '_BOOKSUPPLEMENT' it_keys = booksuppl_keys
                              CHANGING ct_result = booksuppl_read_result ct_link = booksuppl_links cs_failed = failed_create ).


    LOOP AT keys INTO DATA(key).
      " OSD overlay: WITH KEY id COMPONENTS %tky = key-%tky -> the key field
      READ TABLE travel_read_result ASSIGNING FIELD-SYMBOL(<travel>) WITH KEY travel_id = key-travel_id.
      IF sy-subrc EQ 0.
        "Fill travel container for creating new travel instance
        " OSD overlay: CORRESPONDING #( ... EXCEPT ... ) is not transpiled: the
        " fields are moved and the excepted ones cleared
        APPEND VALUE #( %cid  = key-%cid
                        %data = CORRESPONDING #( <travel> ) )
          TO travels ASSIGNING FIELD-SYMBOL(<new_travel>).
        CLEAR <new_travel>-travel_id.

        "Fill %cid_ref of travel as instance identifier for cba booking
        APPEND VALUE #( %cid_ref = key-%cid )
          TO bookings_cba ASSIGNING FIELD-SYMBOL(<bookings_cba>).

        <new_travel>-begin_date     = cl_abap_context_info=>get_system_date( ).
        <new_travel>-end_date       = cl_abap_context_info=>get_system_date( ) + 30.
        <new_travel>-overall_status = 'O'.  "Set to open to allow an editable instance

        " OSD overlay: USING KEY entity dropped (no secondary key here)
        LOOP AT book_read_result ASSIGNING FIELD-SYMBOL(<booking>) WHERE travel_id EQ <travel>-travel_id.
          "Fill booking container for creating booking with cba
          " OSD overlay: book_read_result[ KEY entity %tky = <booking>-%tky ] is <booking>
          APPEND VALUE #( %cid  = key-%cid && <booking>-booking_id
                          %data = CORRESPONDING #( <booking> ) )
            TO <bookings_cba>-%target ASSIGNING FIELD-SYMBOL(<new_booking>).
          CLEAR <new_booking>-travel_id. " OSD overlay: EXCEPT travel_id

          "Fill %cid_ref of booking as instance identifier for cba booksuppl
          APPEND VALUE #( %cid_ref = key-%cid && <booking>-booking_id )
            TO booksuppl_cba ASSIGNING FIELD-SYMBOL(<booksuppl_cba>).

          <new_booking>-booking_status = 'N'.

          LOOP AT booksuppl_read_result ASSIGNING FIELD-SYMBOL(<booksuppl>) WHERE travel_id  EQ <travel>-travel_id
                                                                              AND   booking_id EQ <booking>-booking_id.
            "Fill booksuppl container for creating supplement with cba
            APPEND VALUE #( %cid  = key-%cid && <booking>-booking_id && <booksuppl>-booking_supplement_id
                            %data = CORRESPONDING #( <booksuppl> ) )
              TO <booksuppl_cba>-%target ASSIGNING FIELD-SYMBOL(<new_booksuppl>).
            CLEAR: <new_booksuppl>-travel_id, <new_booksuppl>-booking_id. " OSD overlay: EXCEPT travel_id booking_id
          ENDLOOP.
        ENDLOOP.
      ELSE.
        " OSD overlay: CORRESPONDING #( key MAPPING %fail = DEFAULT VALUE #( ... ) ) is not parsed
        CLEAR failed_line.
        failed_line-%cid = key-%cid.
        failed_line-travel_id = key-travel_id.
        failed_line-%fail-cause = if_abap_behv=>cause-not_found.
        APPEND failed_line TO failed-travel.
      ENDIF.
    ENDLOOP.

    "create new BO instance
    " OSD overlay: the deep MODIFY is written as the three calls it lowers to:
    " MODIFY ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    "   ENTITY travel
    "     CREATE FIELDS ( agency_id customer_id begin_date end_date booking_fee total_price currency_code overall_status description )
    "       WITH travels
    "     CREATE BY \_Booking FIELDS ( booking_id booking_date customer_id carrier_id connection_id flight_date flight_price currency_code booking_status )
    "       WITH bookings_cba
    "   ENTITY booking
    "     CREATE BY \_BookSupplement FIELDS ( booking_supplement_id supplement_id price currency_code )
    "       WITH booksuppl_cba
    "   MAPPED DATA(mapped_create).
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'TRAVEL' iv_operation = 'CREATE' it_rows = travels
                                       iv_fields = 'AGENCY_ID,CUSTOMER_ID,BEGIN_DATE,END_DATE,BOOKING_FEE,TOTAL_PRICE,CURRENCY_CODE,OVERALL_STATUS,DESCRIPTION'
                             CHANGING cs_mapped = mapped_create cs_failed = failed_create cs_reported = reported_create ).
    zcl_osd_rap_eml=>create_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'TRAVEL' iv_assoc = '_BOOKING' it_rows = bookings_cba
                                          iv_fields = 'BOOKING_ID,BOOKING_DATE,CUSTOMER_ID,CARRIER_ID,CONNECTION_ID,FLIGHT_DATE,FLIGHT_PRICE,CURRENCY_CODE,BOOKING_STATUS'
                                CHANGING cs_mapped = mapped_create cs_failed = failed_create cs_reported = reported_create ).
    zcl_osd_rap_eml=>create_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'BOOKING' iv_assoc = '_BOOKSUPPLEMENT' it_rows = booksuppl_cba
                                          iv_fields = 'BOOKING_SUPPLEMENT_ID,SUPPLEMENT_ID,PRICE,CURRENCY_CODE'
                                CHANGING cs_mapped = mapped_create cs_failed = failed_create cs_reported = reported_create ).

    mapped-travel   =  mapped_create-travel .

  ENDMETHOD.


  METHOD set_status_accepted.
    " OSD overlay: the EML tables declared
    DATA updates   TYPE TABLE FOR UPDATE /dmo/i_travel_m\\travel.
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.

    " Modify in local mode: BO-related updates that are not relevant for authorization checks
    updates = VALUE #( FOR key IN keys ( %tky           = key-%tky
                                         overall_status = 'A' ) ). " Accepted
    MODIFY ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
           ENTITY travel
              UPDATE FIELDS ( overall_status )
                 WITH updates.

    " Read changed data for action result
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
         ALL FIELDS WITH
         read_keys
       RESULT travels.

    " OSD overlay: %param = CORRESPONDING #( travel ): the result's %param is
    " not the read result's type here, and a structure moves by name
    result = VALUE #( FOR travel IN travels ( %tky   = travel-%tky
                                              %param = CORRESPONDING #( travel ) ) ).

  ENDMETHOD.

  METHOD set_status_rejected.
    " OSD overlay: the EML tables declared
    DATA updates   TYPE TABLE FOR UPDATE /dmo/i_travel_m\\travel.
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.

    updates = VALUE #( FOR key IN keys ( %tky           = key-%tky
                                         overall_status = 'X' ) ). " Rejected
    MODIFY ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
           ENTITY travel
              UPDATE FIELDS ( overall_status )
                 WITH updates.


    " read changed data for result
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
         ALL FIELDS WITH
         read_keys
       RESULT travels.

    " OSD overlay: %param = CORRESPONDING #( travel ): the result's %param is
    " not the read result's type here, and a structure moves by name
    result = VALUE #( FOR travel IN travels ( %tky   = travel-%tky
                                              %param = CORRESPONDING #( travel ) ) ).

  ENDMETHOD.

  METHOD get_features.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
         FIELDS (  travel_id overall_status )
         WITH read_keys
       RESULT travels
       FAILED failed.


    result = VALUE #( FOR travel IN travels
                       ( %tky                           = travel-%tky
                         %features-%action-rejecttravel = COND #( WHEN travel-overall_status = 'X'
                                                                  THEN if_abap_behv=>fc-o-disabled ELSE if_abap_behv=>fc-o-enabled  )
                         %features-%action-accepttravel = COND #( WHEN travel-overall_status = 'A'
                                                                  THEN if_abap_behv=>fc-o-disabled ELSE if_abap_behv=>fc-o-enabled   )
                         %assoc-_booking                = COND #( WHEN travel-overall_status = 'X'
                                                                  THEN if_abap_behv=>fc-o-disabled ELSE if_abap_behv=>fc-o-enabled   )
                      ) ).

  ENDMETHOD.


  METHOD recalctotalprice.
    TYPES: BEGIN OF ty_amount_per_currencycode,
             amount        TYPE /dmo/total_price,
             currency_code TYPE /dmo/currency_code,
           END OF ty_amount_per_currencycode.

    DATA: amounts_per_currencycode TYPE STANDARD TABLE OF ty_amount_per_currencycode.
    " OSD overlay: the EML targets and their imports declared
    DATA read_keys          TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels            TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.
    DATA book_keys          TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel\_booking.
    DATA bookings           TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel\_booking.
    DATA book_links         TYPE TABLE FOR READ LINK /dmo/i_travel_m\\travel\_booking.
    DATA suppl_keys         TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\booking\_booksupplement.
    DATA bookingsupplements TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\booking\_booksupplement.
    DATA suppl_links        TYPE TABLE FOR READ LINK /dmo/i_travel_m\\booking\_booksupplement.
    DATA read_failed        TYPE RESPONSE FOR FAILED EARLY /dmo/i_travel_m.
    DATA updates            TYPE TABLE FOR UPDATE /dmo/i_travel_m\\travel.
    DATA total_booking_price_per_curr TYPE /dmo/total_price.

    " Read all relevant travel instances.
    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
         ENTITY travel
            FIELDS ( booking_fee currency_code )
            WITH read_keys
         RESULT travels.

    DELETE travels WHERE currency_code IS INITIAL.

    " Read all associated bookings and add them to the total price.
    " OSD overlay: READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    "   ENTITY travel BY \_booking FIELDS ( flight_price currency_code )
    "   WITH CORRESPONDING #( travels ) RESULT DATA(bookings).
    " (the call reads every field; the two named are the ones used)
    book_keys = CORRESPONDING #( travels ).
    zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'TRAVEL' iv_assoc = '_BOOKING' it_keys = book_keys
                              CHANGING ct_result = bookings ct_link = book_links cs_failed = read_failed ).

    " Read all associated booking supplements and add them to the total price.
    " OSD overlay: READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    "   ENTITY booking BY \_booksupplement FIELDS ( price currency_code )
    "   WITH CORRESPONDING #( bookings ) RESULT DATA(bookingsupplements).
    suppl_keys = CORRESPONDING #( bookings ).
    zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'BOOKING' iv_assoc = '_BOOKSUPPLEMENT' it_keys = suppl_keys
                              CHANGING ct_result = bookingsupplements ct_link = suppl_links cs_failed = read_failed ).

    LOOP AT travels ASSIGNING FIELD-SYMBOL(<travel>).
      " Set the start for the calculation by adding the booking fee.
      amounts_per_currencycode = VALUE #( ( amount        = <travel>-booking_fee
                                            currency_code = <travel>-currency_code ) ).


      " OSD overlay: USING KEY id dropped (no secondary key here)
      LOOP AT bookings INTO DATA(booking) WHERE   travel_id = <travel>-travel_id
                                          AND     currency_code IS NOT INITIAL.
        COLLECT VALUE ty_amount_per_currencycode( amount        = booking-flight_price
                                                  currency_code = booking-currency_code
                                                ) INTO amounts_per_currencycode.
      ENDLOOP.


      LOOP AT bookingsupplements INTO DATA(bookingsupplement) WHERE   travel_id = <travel>-travel_id
                                                              AND     currency_code IS NOT INITIAL.
        COLLECT VALUE ty_amount_per_currencycode( amount        = bookingsupplement-price
                                                  currency_code = bookingsupplement-currency_code
                                                ) INTO amounts_per_currencycode.
      ENDLOOP.

      DELETE amounts_per_currencycode WHERE currency_code IS INITIAL.

      CLEAR <travel>-total_price.
      LOOP AT amounts_per_currencycode INTO DATA(amount_per_currencycode).
        " If needed do a Currency Conversion
        IF amount_per_currencycode-currency_code = <travel>-currency_code.
          <travel>-total_price += amount_per_currencycode-amount.
        ELSE.
          " OSD overlay: /dmo/cl_flight_amdp=>convert_currency is an AMDP over
          " HANA's CONVERT_CURRENCY with error_handling 'set to null'; the
          " class is not fetched (docs/rap-flight-pack.md) and there are no
          " exchange rates here, where a system answers null: nothing is
          " added for an amount in another currency (unmeasured)
          CLEAR total_booking_price_per_curr.
          <travel>-total_price += total_booking_price_per_curr.
        ENDIF.
      ENDLOOP.
    ENDLOOP.

    " write back the modified total_price of travels
    updates = CORRESPONDING #( travels ).
    MODIFY ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
        UPDATE FIELDS ( total_price )
        WITH updates.

  ENDMETHOD.

  METHOD calculatetotalprice.
    " OSD overlay: the import declared
    DATA executes TYPE TABLE FOR ACTION IMPORT /dmo/i_travel_m\\travel~recalctotalprice.

    executes = CORRESPONDING #( keys ).
    MODIFY ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
        EXECUTE recalctotalprice
        FROM executes.

  ENDMETHOD.

  METHOD earlynumbering_create.

    DATA:
      entity        TYPE STRUCTURE FOR CREATE /DMO/I_Travel_M,
      travel_id_max TYPE /dmo/travel_id.

    " Ensure Travel ID is not set yet (idempotent)- must be checked when BO is draft-enabled
    LOOP AT entities INTO entity WHERE travel_id IS NOT INITIAL.
      APPEND CORRESPONDING #( entity ) TO mapped-travel.
    ENDLOOP.

    DATA(entities_wo_travelid) = entities.
    DELETE entities_wo_travelid WHERE travel_id IS NOT INITIAL.

    " Get Numbers
    " OSD overlay: cl_numberrange_runtime=>number_get with QUANTITY and the
    " return codes is not what this runtime's class offers, and the number
    " range object /DMO/TRV_M has no interval here: the numbers follow the
    " highest travel ID saved (unmeasured against a system's interval)
    SELECT MAX( travel_id ) FROM /dmo/travel_m INTO @travel_id_max.

    " Set Travel ID
    LOOP AT entities_wo_travelid INTO entity.
      travel_id_max += 1.
      entity-travel_id = travel_id_max .

      APPEND VALUE #( %cid = entity-%cid
                      %key = entity-%key
                    ) TO mapped-travel.
    ENDLOOP.

  ENDMETHOD.

  METHOD earlynumbering_cba_booking.
    DATA: max_booking_id TYPE /dmo/booking_id.
    " OSD overlay: the EML targets and their import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel\_booking.
    DATA read_rows TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel\_booking.
    DATA bookings  TYPE TABLE FOR READ LINK /dmo/i_travel_m\\travel\_booking.
    DATA read_fail TYPE RESPONSE FOR FAILED EARLY /dmo/i_travel_m.

    " OSD overlay: READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
    "   ENTITY travel BY \_booking FROM CORRESPONDING #( entities ) LINK DATA(bookings).
    read_keys = CORRESPONDING #( entities ).
    zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = '/DMO/I_TRAVEL_M' iv_entity = 'TRAVEL' iv_assoc = '_BOOKING' it_keys = read_keys
                              CHANGING ct_result = read_rows ct_link = bookings cs_failed = read_fail ).

    " Loop over all unique TravelIDs
    " OSD overlay: LOOP ... GROUP BY and the two REDUCEs over USING KEY entity
    " are written as loops; a travel that comes twice continues its numbers
    LOOP AT entities ASSIGNING FIELD-SYMBOL(<travel>).

      " Get highest booking_id from existing bookings belonging to travel
      max_booking_id = '0'.
      LOOP AT bookings INTO DATA(booking) WHERE source-travel_id = <travel>-travel_id.
        IF booking-target-booking_id > max_booking_id.
          max_booking_id = booking-target-booking_id.
        ENDIF.
      ENDLOOP.
      " Get highest assigned booking_id from incoming entities, eg from internal operations
      LOOP AT entities INTO DATA(entity) WHERE travel_id = <travel>-travel_id.
        LOOP AT entity-%target INTO DATA(target).
          IF target-booking_id > max_booking_id.
            max_booking_id = target-booking_id.
          ENDIF.
        ENDLOOP.
      ENDLOOP.
      LOOP AT mapped-booking INTO DATA(already) WHERE travel_id = <travel>-travel_id.
        IF already-booking_id > max_booking_id.
          max_booking_id = already-booking_id.
        ENDIF.
      ENDLOOP.

      " Assign new booking-ids if not already assigned
      LOOP AT <travel>-%target ASSIGNING FIELD-SYMBOL(<booking_wo_numbers>).
        APPEND CORRESPONDING #( <booking_wo_numbers> ) TO mapped-booking ASSIGNING FIELD-SYMBOL(<mapped_booking>).
        IF <booking_wo_numbers>-booking_id IS INITIAL.
          max_booking_id += 10 .
          <mapped_booking>-booking_id = max_booking_id .
        ENDIF.
      ENDLOOP.

    ENDLOOP.
  ENDMETHOD.

  METHOD validate_currencycode.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.
    DATA currency  TYPE i_currency.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
        FIELDS ( currency_code )
        WITH read_keys
      RESULT travels.

    DATA: currencies TYPE SORTED TABLE OF I_Currency WITH UNIQUE KEY currency.

    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    LOOP AT travels INTO DATA(with_currency) WHERE currency_code IS NOT INITIAL.
      currency-currency = with_currency-currency_code.
      INSERT currency INTO TABLE currencies.
    ENDLOOP.

    IF currencies IS NOT INITIAL.
      SELECT FROM I_Currency FIELDS currency
        FOR ALL ENTRIES IN @currencies
        WHERE currency = @currencies-currency
        INTO TABLE @DATA(currency_db).
    ENDIF.


    LOOP AT travels INTO DATA(travel).
      IF travel-currency_code IS INITIAL.
        " Raise message for empty Currency
        APPEND VALUE #( %tky                   = travel-%tky ) TO failed-travel.
        APPEND VALUE #( %tky                   = travel-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                        textid   = /dmo/cm_flight_messages=>currency_required
                        severity = if_abap_behv_message=>severity-error )
                        %element-currency_code = if_abap_behv=>mk-on
                      ) TO reported-travel.
      ELSEIF NOT line_exists( currency_db[ currency = travel-currency_code ] ).
        " Raise message for not existing Currency
        APPEND VALUE #( %tky                   = travel-%tky ) TO failed-travel.
        APPEND VALUE #( %tky                   = travel-%tky
                        %msg                   = NEW /dmo/cm_flight_messages(
                        textid        = /dmo/cm_flight_messages=>currency_not_existing
                        severity      = if_abap_behv_message=>severity-error
                        currency_code = travel-currency_code )
                        %element-currency_code = if_abap_behv=>mk-on
                      ) TO reported-travel.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD validate_BookingFee.
    " OSD overlay: the EML target and its import declared
    DATA read_keys TYPE TABLE FOR READ IMPORT /dmo/i_travel_m\\travel.
    DATA travels   TYPE TABLE FOR READ RESULT /dmo/i_travel_m\\travel.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /DMO/I_Travel_M IN LOCAL MODE
      ENTITY travel
        FIELDS ( booking_fee )
        WITH read_keys
      RESULT travels.

    LOOP AT travels INTO DATA(travel) WHERE booking_fee < 0.
      " Raise message for booking fee < 0
      APPEND VALUE #( %tky                 = travel-%tky ) TO failed-travel.
      APPEND VALUE #( %tky                 = travel-%tky
                      %msg                 = NEW /dmo/cm_flight_messages(
                      textid   = /dmo/cm_flight_messages=>booking_fee_invalid
                      severity = if_abap_behv_message=>severity-error )
                      %element-booking_fee = if_abap_behv=>mk-on
                    ) TO reported-travel.
    ENDLOOP.

  ENDMETHOD.


ENDCLASS.



CLASS lcl_save DEFINITION INHERITING FROM cl_abap_behavior_saver.
  " OSD overlay: FRIENDS ltc_save_not_in_documentation dropped (test class not fetched)

  PROTECTED SECTION.
    METHODS save_modified REDEFINITION.

ENDCLASS.


CLASS lcl_save IMPLEMENTATION.

  METHOD save_modified.


********************************************************************************
*
* Implements additional save
*
********************************************************************************

    DATA travel_log        TYPE STANDARD TABLE OF /dmo/log_travel.
    DATA travel_log_create TYPE STANDARD TABLE OF /dmo/log_travel.
    DATA travel_log_update TYPE STANDARD TABLE OF /dmo/log_travel.

    " (1) Get instance data of all instances that have been created
    IF create-travel IS NOT INITIAL.
      " Creates internal table with instance data
      travel_log = CORRESPONDING #( create-travel ).

      LOOP AT travel_log ASSIGNING FIELD-SYMBOL(<travel_log>).
        <travel_log>-changing_operation = 'CREATE'.

        " Generate time stamp
        GET TIME STAMP FIELD <travel_log>-created_at.

        " Read travel instance data into ls_travel that includes %control structure
        READ TABLE create-travel WITH TABLE KEY entity COMPONENTS travel_id = <travel_log>-travel_id INTO DATA(travel).
        IF sy-subrc = 0.

          " If new value of the booking_fee field created
          IF travel-%control-booking_fee = cl_abap_behv=>flag_changed.
            " Generate uuid as value of the change_id field
            TRY.
                <travel_log>-change_id = cl_system_uuid=>create_uuid_x16_static( ) .
              CATCH cx_uuid_error.
                "handle exception
            ENDTRY.
            <travel_log>-changed_field_name = 'booking_fee'.
            <travel_log>-changed_value = travel-booking_fee.
            APPEND <travel_log> TO travel_log_create.
          ENDIF.

          " If new value of the overall_status field created
          IF travel-%control-overall_status = cl_abap_behv=>flag_changed.
            " Generate uuid as value of the change_id field
            TRY.
                <travel_log>-change_id = cl_system_uuid=>create_uuid_x16_static( ) .
              CATCH cx_uuid_error.
                "handle exception
            ENDTRY.
            <travel_log>-changed_field_name = 'overall_status'.
            <travel_log>-changed_value = travel-overall_status.
            APPEND <travel_log> TO travel_log_create.
          ENDIF.

          " IF  ls_travel-%control-...

        ENDIF.

      ENDLOOP.

      " Inserts rows specified in lt_travel_log_c into the DB table /dmo/log_travel
      INSERT /dmo/log_travel FROM TABLE @travel_log_create.

    ENDIF.


    " (2) Get instance data of all instances that have been updated during the transaction
    IF update-travel IS NOT INITIAL.
      travel_log = CORRESPONDING #( update-travel ).

      LOOP AT update-travel ASSIGNING FIELD-SYMBOL(<travel_log_update>).

        ASSIGN travel_log[ travel_id = <travel_log_update>-travel_id ] TO FIELD-SYMBOL(<travel_log_db>).

        <travel_log_db>-changing_operation = 'UPDATE'.

        " Generate time stamp
        GET TIME STAMP FIELD <travel_log_db>-created_at.


        IF <travel_log_update>-%control-customer_id = if_abap_behv=>mk-on.
          <travel_log_db>-changed_value = <travel_log_update>-customer_id.
          " Generate uuid as value of the change_id field
          TRY.
              <travel_log_db>-change_id = cl_system_uuid=>create_uuid_x16_static( ) .
            CATCH cx_uuid_error.
              "handle exception
          ENDTRY.

          <travel_log_db>-changed_field_name = 'customer_id'.

          APPEND <travel_log_db> TO travel_log_update.

        ENDIF.

        IF <travel_log_update>-%control-description = if_abap_behv=>mk-on.
          <travel_log_db>-changed_value = <travel_log_update>-description.

          " Generate uuid as value of the change_id field
          TRY.
              <travel_log_db>-change_id = cl_system_uuid=>create_uuid_x16_static( ) .
            CATCH cx_uuid_error.
              "handle exception
          ENDTRY.

          <travel_log_db>-changed_field_name = 'description'.

          APPEND <travel_log_db> TO travel_log_update.

        ENDIF.

        "IF <fs_travel_log_u>-%control-...

      ENDLOOP.


      " Inserts rows specified in lt_travel_log_u into the DB table /dmo/log_travel
      INSERT /dmo/log_travel FROM TABLE @travel_log_update.

    ENDIF.

    " (3) Get keys of all travel instances that have been deleted during the transaction
    IF delete-travel IS NOT INITIAL.
      travel_log = CORRESPONDING #( delete-travel ).
      LOOP AT travel_log ASSIGNING FIELD-SYMBOL(<travel_log_delete>).
        <travel_log_delete>-changing_operation = 'DELETE'.
        " Generate time stamp
        GET TIME STAMP FIELD <travel_log_delete>-created_at.
        " Generate uuid as value of the change_id field
        TRY.
            <travel_log_delete>-change_id = cl_system_uuid=>create_uuid_x16_static( ) .
          CATCH cx_uuid_error.
            "handle exception
        ENDTRY.

      ENDLOOP.

      " Inserts rows specified in lt_travel_log into the DB table /dmo/log_travel
      INSERT /dmo/log_travel FROM TABLE @travel_log.

    ENDIF.


********************************************************************************
*
* Implements unmanaged save
*
********************************************************************************
    DATA booksuppls_db TYPE STANDARD TABLE OF /dmo/booksuppl_m.

    " (1) Get instance data of all instances that have been created
    IF create-booksuppl IS NOT INITIAL.
      booksuppls_db = CORRESPONDING #( create-booksuppl MAPPING FROM ENTITY ).

      CALL FUNCTION '/DMO/FLIGHT_BOOKSUPPL_C' EXPORTING values = booksuppls_db.

    ENDIF.

    " (2) Get instance data of all instances that have been updated during the transaction
    booksuppls_db = CORRESPONDING #( update-booksuppl MAPPING FROM ENTITY ).
    IF booksuppls_db IS NOT INITIAL.

      " Read all field values from database
      SELECT * FROM /dmo/booksuppl_m FOR ALL ENTRIES IN @booksuppls_db
               WHERE booking_supplement_id = @booksuppls_db-booking_supplement_id
               INTO TABLE @booksuppls_db .

      " Take over field values that have been changed during the transaction
      LOOP AT update-booksuppl ASSIGNING FIELD-SYMBOL(<unmanaged_booksuppl>).
        ASSIGN booksuppls_db[ travel_id  = <unmanaged_booksuppl>-travel_id
                              booking_id = <unmanaged_booksuppl>-booking_id
                   booking_supplement_id = <unmanaged_booksuppl>-booking_supplement_id
                            ] TO FIELD-SYMBOL(<booksuppl_db>).

        IF <unmanaged_booksuppl>-%control-supplement_id = if_abap_behv=>mk-on.
          <booksuppl_db>-supplement_id = <unmanaged_booksuppl>-supplement_id.
        ENDIF.

        IF <unmanaged_booksuppl>-%control-price = if_abap_behv=>mk-on.
          <booksuppl_db>-price = <unmanaged_booksuppl>-price.
        ENDIF.

        IF <unmanaged_booksuppl>-%control-currency_code = if_abap_behv=>mk-on.
          <booksuppl_db>-currency_code = <unmanaged_booksuppl>-currency_code.
        ENDIF.

      ENDLOOP.

      " Update the complete instance data
      CALL FUNCTION '/DMO/FLIGHT_BOOKSUPPL_U' EXPORTING values = booksuppls_db.

    ENDIF.

    " (3) Get keys of all travel instances that have been deleted during the transaction
    IF delete-booksuppl IS NOT INITIAL.
      booksuppls_db = CORRESPONDING #( delete-booksuppl MAPPING FROM ENTITY ).

      CALL FUNCTION '/DMO/FLIGHT_BOOKSUPPL_D' EXPORTING values = booksuppls_db.

    ENDIF.


  ENDMETHOD.

ENDCLASS.
