* OSD overlay of the supplement pool of the reuse layer (upstream
* reuse/supplement/#dmo#bp_i_supplement.clas.locals_imp.abap at commit
* 5353cbeb, Apache-2.0): the same handlers, changed where this runtime
* differs. Each change is marked "OSD overlay"; docs/rap-flight-pack.md lists
* them: the test class is not fetched (the DEFINITION DEFERRED FOR TESTING
* line and the FRIENDS that names it are dropped); the EML target of the
* validation is declared with its derived type; CORRESPONDING ...
* DISCARDING DUPLICATES is a loop; and cl_numberrange_runtime=>number_get
* is replaced by the highest saved supplement ID of the category (active
* or draft) + 1, LOOP ... GROUP BY by a loop over the categories.
CLASS lhc_supplement DEFINITION
  INHERITING FROM cl_abap_behavior_handler
  .

  PRIVATE SECTION.

    METHODS validateprice  FOR VALIDATE ON SAVE
      IMPORTING keys FOR supplement~validateprice.

    METHODS earlynumbering_create FOR NUMBERING
      IMPORTING entities FOR CREATE supplement.

*    METHODS get_global_authorizations FOR GLOBAL AUTHORIZATION
*      IMPORTING REQUEST requested_authorizations FOR supplement RESULT result.



ENDCLASS.

CLASS lhc_supplement IMPLEMENTATION.

  METHOD validateprice.
    " OSD overlay: the EML target and its import declared
    DATA read_keys   TYPE TABLE FOR READ IMPORT /dmo/i_supplement\\supplement.
    DATA supplements TYPE TABLE FOR READ RESULT /dmo/i_supplement\\supplement.
    DATA currency    TYPE i_currency.

    read_keys = CORRESPONDING #( keys ).
    READ ENTITIES OF /dmo/i_supplement IN LOCAL MODE
      ENTITY supplement
        FIELDS ( price currencycode )
        WITH read_keys
        RESULT supplements.


    DATA: currencies TYPE SORTED TABLE OF i_currency WITH UNIQUE KEY currency.

    " OSD overlay: DISCARDING DUPLICATES is not parsed here, a loop
    LOOP AT supplements INTO DATA(with_currency) WHERE currencycode IS NOT INITIAL.
      currency-currency = with_currency-currencycode.
      INSERT currency INTO TABLE currencies.
    ENDLOOP.
    DELETE currencies WHERE currency IS INITIAL.

    IF currencies IS NOT INITIAL.
      SELECT FROM i_currency FIELDS currency
        FOR ALL ENTRIES IN @currencies
        WHERE currency = @currencies-currency
        INTO TABLE @DATA(currency_db).
    ENDIF.


    LOOP AT supplements INTO DATA(supplement).

      APPEND VALUE #(  %tky          = supplement-%tky
                       %state_area   = 'VALIDATE_PRICE' )  TO reported-supplement.

      IF supplement-price IS INITIAL.
        " Raise message for empty Price
        APPEND VALUE #( %tky           = supplement-%tky ) TO failed-supplement.
        APPEND VALUE #( %tky           = supplement-%tky
                        %state_area    = 'VALIDATE_PRICE'
                        %msg           = NEW /dmo/cx_supplement(
                                             textid    = /dmo/cx_supplement=>price_required
                                             severity  = if_abap_behv_message=>severity-error )
                        %element-price = if_abap_behv=>mk-on
                      ) TO reported-supplement.
      ENDIF.

      IF supplement-currencycode IS INITIAL.
        " Raise message for empty Currency
        APPEND VALUE #( %tky                 = supplement-%tky ) TO failed-supplement.
        APPEND VALUE #( %tky                 = supplement-%tky
                        %state_area          = 'VALIDATE_PRICE'
                        %msg                 = NEW /dmo/cx_supplement(
                                                      textid    = /dmo/cx_supplement=>currency_required
                                                      severity  = if_abap_behv_message=>severity-error )
                        %element-currencycode = if_abap_behv=>mk-on
                      ) TO reported-supplement.
      ELSEIF NOT line_exists( currency_db[ currency = supplement-currencycode ] ).
        " Raise message for not existing Currency
        APPEND VALUE #( %tky                 = supplement-%tky ) TO failed-supplement.
        APPEND VALUE #( %tky                 = supplement-%tky
                        %state_area          = 'VALIDATE_PRICE'
                        %msg                 = NEW /dmo/cx_supplement(
                                                      textid    = /dmo/cx_supplement=>currency_not_existing
                                                      severity  = if_abap_behv_message=>severity-error )
                        %element-currencycode = if_abap_behv=>mk-on
                      ) TO reported-supplement.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD earlynumbering_create.
    DATA: entities_wo_supplementid     TYPE TABLE FOR CREATE /dmo/i_supplement,
          entities_wo_supplid_filtered TYPE TABLE FOR CREATE /dmo/i_supplement,
          entity                       TYPE STRUCTURE FOR CREATE /dmo/i_supplement.
    " OSD overlay: the categories of the request, in place of GROUP BY
    DATA categories         TYPE SORTED TABLE OF /dmo/supplement_category WITH UNIQUE KEY table_line.
    DATA supplementcategory TYPE /dmo/supplement_category.
    DATA pattern            TYPE string.
    DATA id_active          TYPE /dmo/supplement_id.
    DATA id_draft           TYPE /dmo/supplement_id.
    DATA supplement_id_max  TYPE i.

    " Ensure Supplement ID is not set yet
    LOOP AT entities INTO entity WHERE supplementid IS NOT INITIAL.
      APPEND CORRESPONDING #( entity ) TO mapped-supplement.
    ENDLOOP.

    entities_wo_supplementid = entities.
    DELETE entities_wo_supplementid WHERE supplementid IS NOT INITIAL.
    IF entities_wo_supplementid IS INITIAL.
      EXIT.
    ENDIF.


    " OSD overlay: LOOP AT ... GROUP BY supplement-supplementcategory is a
    " loop over the categories the request names
    LOOP AT entities_wo_supplementid INTO DATA(supplement).
      INSERT supplement-supplementcategory INTO TABLE categories.
    ENDLOOP.
    LOOP AT categories INTO supplementcategory.
      entities_wo_supplid_filtered = entities_wo_supplementid.
      DELETE entities_wo_supplid_filtered WHERE supplementcategory <> supplementcategory.

      " OSD overlay: cl_numberrange_runtime=>number_get with QUANTITY,
      " SUBOBJECT and the return codes is not what this runtime's class
      " offers, and /DMO/SUPPL has no interval here: the numbers follow the
      " highest supplement ID of the category saved, active or draft (a
      " system's interval is shared by both; unmeasured against one). The
      " warning and the exhausted range (return codes 1 to 3) do not occur
      pattern = |{ supplementcategory }-%|.
      SELECT MAX( supplement_id ) FROM /dmo/supplement WHERE supplement_id LIKE @pattern INTO @id_active.
      SELECT MAX( supplementid ) FROM /dmo/suppl_d WHERE supplementid LIKE @pattern INTO @id_draft.
      IF id_draft > id_active.
        id_active = id_draft.
      ENDIF.
      IF id_active IS INITIAL.
        supplement_id_max = 0.
      ELSE.
        supplement_id_max = CONV i( substring_after( val = id_active sub = '-' ) ).
      ENDIF.

      " Draw numbers and map them
      LOOP AT entities_wo_supplid_filtered INTO entity.
        supplement_id_max += 1.

        APPEND VALUE #(
           %cid          = entity-%cid
           %is_draft     = entity-%is_draft
           supplementid  = |{ supplementcategory }-{ supplement_id_max  ALIGN = RIGHT  PAD = `0`  WIDTH = 4 }|
           ) TO mapped-supplement.
      ENDLOOP.
    ENDLOOP.

  ENDMETHOD.



*  METHOD get_global_authorizations.
*  ENDMETHOD.

ENDCLASS.
