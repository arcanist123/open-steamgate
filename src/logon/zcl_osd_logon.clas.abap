CLASS zcl_osd_logon DEFINITION
  PUBLIC
  FINAL
  CREATE PRIVATE.
* Who sends the request. On a system that is SY-UNAME, the user the logon
* authenticated. This tree has no logon: SY-UNAME is one constant for the
* process (tools/osd-identity.mjs), so every request is the same user and a
* draft would have no owner to tell apart (docs/rap-runtime.md, R9).
*
* The HTTP fronts (ZCL_STG_HTTP_HANDLER, ZCL_OSD_V4_HTTP) call ENTER with the
* request's Authorization header at entry: the user name of a Basic
* credential is the request's user. The password is not checked -- this is
* identification, not authentication, like the rest of this tree's HTTP
* (no authentication yet; do not put it on a public address). Without the
* header the user is SY-UNAME, as before. The RAP draft runtime asks USER
* for the draft's owner (ZOSD_DRAFT_ADM-INPROCESSBYUSER).
*
* A class static outlives the request here, so ENTER sets it on every
* request, with or without a credential, and LEAVE clears it when the
* request is answered: a call outside a request is SY-UNAME again (a request
* that dumps skips LEAVE; the next request's ENTER resets it).

  PUBLIC SECTION.
    CLASS-METHODS enter
      IMPORTING
        iv_authorization TYPE string.

    CLASS-METHODS leave.

    CLASS-METHODS user
      RETURNING
        VALUE(rv_user) TYPE syuname.

* for a test: run as this user (initial: SY-UNAME again)
    CLASS-METHODS set
      IMPORTING
        iv_user TYPE clike.

  PROTECTED SECTION.
  PRIVATE SECTION.
    CLASS-DATA gv_user TYPE syuname.
ENDCLASS.

CLASS zcl_osd_logon IMPLEMENTATION.

  METHOD enter.
    DATA lv_scheme TYPE string.
    DATA lv_token  TYPE string.
    DATA lv_plain  TYPE string.
    DATA lv_name   TYPE string.
    DATA lv_secret TYPE string.

    CLEAR gv_user.
    SPLIT condense( iv_authorization ) AT space INTO lv_scheme lv_token.
    IF to_lower( lv_scheme ) <> 'basic' OR lv_token IS INITIAL.
      RETURN.
    ENDIF.
    lv_plain = cl_http_utility=>decode_base64( lv_token ).
    SPLIT lv_plain AT ':' INTO lv_name lv_secret.
    gv_user = to_upper( condense( lv_name ) ).
  ENDMETHOD.

  METHOD leave.
    CLEAR gv_user.
  ENDMETHOD.

  METHOD user.
    rv_user = gv_user.
    IF rv_user IS INITIAL.
      rv_user = sy-uname.
    ENDIF.
  ENDMETHOD.

  METHOD set.
    gv_user = to_upper( iv_user ).
  ENDMETHOD.

ENDCLASS.
