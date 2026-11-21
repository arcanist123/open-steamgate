* The seed of the RAP flight pack: SAP's own data generator, run once.
*
* /DMO/CL_FLIGHT_DATA_GENERATOR is an ADT class run (IF_OO_ADT_CLASSRUN)
* that fills the legacy tables and then, through a BAdI, the managed ones.
* This class gives it the console it asks for and calls it, so that a host
* (tools/rap-flight/seed-capture.mjs) can run it in one dialog step and
* write what it made into data/*.tabu.json -- the seed rows every start
* loads, the way the other packs carry theirs. The generator is random
* with fixed seeds where it matters (cl_abap_random_int seed = 1337 for the
* distances), so a second capture is the same rows where the original is.
*
* The two generator classes this calls are the pack's overlay copies
* (packs/rap-flight/src/#dmo#cl_*), changed only where open-abap-core has
* no number range intervals, no CL_ABAP_RANDOM_INT8 and the transpiler
* does not take four 7.40 constructs (README.md of the pack).
CLASS zcl_osd_rapflight_seed DEFINITION PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    " runs the generator; returns what it wrote to its console, one line each
    CLASS-METHODS run
      RETURNING VALUE(rt_log) TYPE string_table.

    " the row counts after a run, for a capture and for the unit test
    CLASS-METHODS counts
      RETURNING VALUE(rv_counts) TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS fill_currencies.
    CLASS-METHODS fill_countries.

ENDCLASS.

CLASS zcl_osd_rapflight_seed IMPLEMENTATION.

  METHOD run.
    DATA lo_out TYPE REF TO lcl_out.
    DATA lo_generator TYPE REF TO /dmo/cl_flight_data_generator.
    CREATE OBJECT lo_out.
    CREATE OBJECT lo_generator.
    lo_generator->if_oo_adt_classrun~main( lo_out ).
    fill_currencies( ).
    fill_countries( ).
    rt_log = lo_out->mt_lines.
  ENDMETHOD.

  METHOD fill_currencies.
* The stand-in for the released view I_Currency (src/ddic) has no rows of
* its own; on a system it lists every currency. The managed travel's
* validations look a currency up in it (R7), so it gets the currencies the
* generated data uses: those of the flights, supplements and travels, and
* (R11) the carriers', which the carrier singleton's validateCurrencyCode
* looks up when the carriers are activated.
    DATA lt_codes TYPE SORTED TABLE OF i_currency-currency WITH UNIQUE KEY table_line.
    DATA lt_more  TYPE STANDARD TABLE OF i_currency-currency WITH DEFAULT KEY.
    DATA lv_code  TYPE i_currency-currency.
    DATA ls_row   TYPE i_currency.

    SELECT DISTINCT currency_code FROM /dmo/flight INTO TABLE @lt_more.
    INSERT LINES OF lt_more INTO TABLE lt_codes.
    SELECT DISTINCT currency_code FROM /dmo/supplement INTO TABLE @lt_more.
    INSERT LINES OF lt_more INTO TABLE lt_codes.
    SELECT DISTINCT currency_code FROM /dmo/travel INTO TABLE @lt_more.
    INSERT LINES OF lt_more INTO TABLE lt_codes.
    SELECT DISTINCT currency_code FROM /dmo/carrier INTO TABLE @lt_more.
    INSERT LINES OF lt_more INTO TABLE lt_codes.
    DELETE FROM i_currency.
    LOOP AT lt_codes INTO lv_code WHERE table_line IS NOT INITIAL.
      CLEAR ls_row.
      ls_row-currency = lv_code.
      ls_row-decimals = 2.
      INSERT i_currency FROM @ls_row.
    ENDLOOP.
  ENDMETHOD.

  METHOD fill_countries.
* R10: the stand-in for the released view I_Country (src/ddic), which the
* agency's country validation looks a code up in: the countries the
* generated agencies and customers have (on a system it lists them all)
    DATA lt_codes TYPE SORTED TABLE OF i_country-country WITH UNIQUE KEY table_line.
    DATA lt_more  TYPE STANDARD TABLE OF i_country-country WITH DEFAULT KEY.
    DATA lv_code  TYPE i_country-country.
    DATA ls_row   TYPE i_country.

    SELECT DISTINCT country_code FROM /dmo/agency INTO TABLE @lt_more.
    INSERT LINES OF lt_more INTO TABLE lt_codes.
    SELECT DISTINCT country_code FROM /dmo/customer INTO TABLE @lt_more.
    INSERT LINES OF lt_more INTO TABLE lt_codes.
    DELETE FROM i_country.
    LOOP AT lt_codes INTO lv_code WHERE table_line IS NOT INITIAL.
      CLEAR ls_row.
      ls_row-country = lv_code.
      INSERT i_country FROM @ls_row.
    ENDLOOP.
  ENDMETHOD.

  METHOD counts.
    DATA lv_count TYPE i.
    SELECT COUNT( * ) FROM /dmo/travel INTO @lv_count.
    rv_counts = |travel={ lv_count }|.
    SELECT COUNT( * ) FROM /dmo/booking INTO @lv_count.
    rv_counts = |{ rv_counts } booking={ lv_count }|.
    SELECT COUNT( * ) FROM /dmo/travel_m INTO @lv_count.
    rv_counts = |{ rv_counts } travel_m={ lv_count }|.
    SELECT COUNT( * ) FROM /dmo/booking_m INTO @lv_count.
    rv_counts = |{ rv_counts } booking_m={ lv_count }|.
    SELECT COUNT( * ) FROM /dmo/booksuppl_m INTO @lv_count.
    rv_counts = |{ rv_counts } booksuppl_m={ lv_count }|.
    SELECT COUNT( * ) FROM /dmo/customer INTO @lv_count.
    rv_counts = |{ rv_counts } customer={ lv_count }|.
    SELECT COUNT( * ) FROM /dmo/flight INTO @lv_count.
    rv_counts = |{ rv_counts } flight={ lv_count }|.
  ENDMETHOD.

ENDCLASS.
