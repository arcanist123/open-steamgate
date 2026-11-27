* Overlay copy of src/legacy/#dmo#cl_flight_data_generator.clas.abap from
* SAP-samples/abap-platform-refscen-flight (Apache-2.0), commit
* 5353cbeb013a3a2fbd7f1ba6be89e54f68cfe22c, modified for this runtime
* (every change marked OSD overlay in the source); licence and
* copyright: LICENSE and NOTICE in this folder.

CLASS /dmo/cl_flight_data_generator DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC .

  PUBLIC SECTION.
    INTERFACES: if_oo_adt_classrun.

*   OSD overlay: nr_subobject and nr_nriv_line-nrlevel are not in open-abap-core,
*   so the two parameters are typed by what the callers pass
    TYPES ty_nrlevel TYPE n LENGTH 20.
    CLASS-METHODS:
      reset_numberrange_interval
        IMPORTING
          numberrange_object   TYPE cl_numberrange_runtime=>nr_object
          numberrange_interval TYPE cl_numberrange_runtime=>nr_interval
          subobject            TYPE csequence OPTIONAL
          fromnumber           TYPE cl_numberrange_intervals=>nr_nriv_line-fromnumber
          tonumber             TYPE cl_numberrange_intervals=>nr_nriv_line-tonumber
          nrlevel              TYPE ty_nrlevel DEFAULT 0.

  PROTECTED SECTION.
  PRIVATE SECTION.
    CLASS-METHODS:
      "! Calculation of Price <br/>
      "!  <br/>
      "! Propagation to /dmo/cl_flight_legacy=>calculate_flight_price.<br/>
      "! @parameter iv_seats_occupied_percent | occupied seats
      "! @parameter iv_flight_distance | flight distance in kilometer
      "! @parameter rv_price | calculated flight price
      calculate_flight_price
        IMPORTING
          iv_seats_occupied_percent TYPE /dmo/plane_seats_occupied
          iv_flight_distance        TYPE /dmo/flight_distance
        RETURNING
          VALUE(rv_price)           TYPE /dmo/flight_price.

ENDCLASS.



CLASS /dmo/cl_flight_data_generator IMPLEMENTATION.


  METHOD if_oo_adt_classrun~main.
    out->write( 'Starting Data Generation' ) ##NO_TEXT.

    out->write( 'Generate Data: Airport      /DMO/AIRPORT' ) ##NO_TEXT.
    lcl_airport_data_generator=>lif_data_generator~create( out ).

    out->write( 'Generate Data: Carrier      /DMO/CARRIER' ) ##NO_TEXT.
    lcl_carrier_data_generator=>lif_data_generator~create( out ).
    out->write( 'Generate Data: Connection   /DMO/CONNECTION' ) ##NO_TEXT.
    lcl_connection_data_generator=>lif_data_generator~create( out ).
    out->write( 'Generate Data: Flight       /DMO/FLIGHT' ) ##NO_TEXT.
    lcl_flight_data_generator=>lif_data_generator~create( out ).


    out->write( 'Generate Data: Agency       /DMO/AGENCY' ) ##NO_TEXT.
    lcl_agency_data_generator=>lif_data_generator~create( out ).

    out->write( 'Generate Data: Customer      /DMO/CUSTOMER' ) ##NO_TEXT.
    lcl_customer_data_generator=>lif_data_generator~create( out ).

    out->write( 'Generate Data: Supplement      /DMO/SUPPLEMENT' ) ##NO_TEXT.
    lcl_supplement_data_generator=>lif_data_generator~create( out ).

    out->write( 'Generate Data: Travel      /DMO/TRAVEL' ) ##NO_TEXT.
    out->write( 'Generate Data: Booking      /DMO/BOOKING' ) ##NO_TEXT.
    out->write( 'Generate Data: Booking Supplement      /DMO/BOOK_SUPPL' ) ##NO_TEXT.
    lcl_travel_data_generator=>lif_data_generator~create( out ).

    out->write( 'Generate Data: Status ValueHelps' ) ##NO_TEXT.
    lcl_status_vh_data_generator=>lif_data_generator~create( out ).


    out->write(  'Calling BAdIs' ) ##NO_TEXT.

*   OSD overlay: GET BADI / CALL BADI are not transpiled and the BAdI
*   definition (/DMO/DATA_GENERATION_BADI, an ENHS) is not an object here,
*   so the one implementation this pack carries is called directly.
    DATA lo_badi TYPE REF TO /dmo/if_data_generation_badi.
    CREATE OBJECT lo_badi TYPE /dmo/cl_data_generator_managed.
    lo_badi->data_generation( out = out ).
    out->write(  'Finished Calling BAdIs' ) ##NO_TEXT.

    out->write( 'Finished Data Generation' ) ##NO_TEXT.
  ENDMETHOD.


  METHOD calculate_flight_price.
*   OSD overlay: /dmo/cl_flight_legacy is not in the pack (it needs the AMDP
*   currency conversion); this is its formula, as written there.
    DATA lv_percentage_of_max_price TYPE i.
    lv_percentage_of_max_price = ( 3 * iv_seats_occupied_percent ** 2 DIV 400 ) + 25 ##OPERATOR[**].
    rv_price = lv_percentage_of_max_price * iv_flight_distance DIV 100.
  ENDMETHOD.

  METHOD reset_numberrange_interval.
*   OSD overlay: open-abap-core has no number range intervals (NRIV);
*   cl_numberrange_intervals offers only a no-op create, and the runtime
*   counter (kernel_numberrange) starts every object at 1 per session,
*   which is the interval these generators ask for on a fresh system.
*   The generators draw their blocks from that counter; nothing to reset.
    ASSERT numberrange_object IS NOT INITIAL.
  ENDMETHOD.

ENDCLASS.
