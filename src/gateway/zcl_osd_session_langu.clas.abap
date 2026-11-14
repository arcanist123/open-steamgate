CLASS zcl_osd_session_langu DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The session language of a request (sap-language): the system field set
* for the request and given back after it. SET LOCALE LANGUAGE is a no-op
* in the transpiler's runtime (ANORMALIES.md, set-locale-noop), so the
* field is set itself. Its own class so that the dispatcher touches no
* system field on a request that names no language: the Go host's
* compiler does not carry sy-langu yet, and only such a request reaches it.
  PUBLIC SECTION.
* switch to the language, returning the one in force before
    CLASS-METHODS switch
      IMPORTING
        iv_langu           TYPE sy-langu
      RETURNING
        VALUE(rv_previous) TYPE sy-langu.
ENDCLASS.

CLASS zcl_osd_session_langu IMPLEMENTATION.

  METHOD switch.
    rv_previous = sy-langu.
    sy-langu = iv_langu.
  ENDMETHOD.

ENDCLASS.
