CLASS zcl_osd_rapflight_r11_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL DANGEROUS.
* RAP R11 on the flight BOs (docs/rap-runtime.md, "R11"): the agency's
* interface BDEF /DMO/I_AgencyTP used through EML -- it runs on its base
* /DMO/R_AgencyTP, in the same transaction -- and the carrier singleton
* /DMO/I_CarriersLockSingleton_S edited as one draft, its carriers changed,
* created and deleted below it and activated together. The V4 service of
* the singleton is the wire's (test/rap-r11.mjs).
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_rapflight_r11_test IMPLEMENTATION.
ENDCLASS.
