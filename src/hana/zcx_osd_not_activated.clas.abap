CLASS zcx_osd_not_activated DEFINITION PUBLIC INHERITING FROM cx_no_check FINAL CREATE PUBLIC.
* Lazy activation (H5c round 3): a class compiles as a whole or not at all,
* so the island's closure had to cover every name a class MENTIONS even in
* methods no request will ever run. The iterator now replaces such a
* method's body with a raise of this class -- the service activates with
* what resolves, and the island grows only on a real miss: the text names
* what the method still waits for, which is the signal to run the iterator
* again. cx_no_check, so the stub carries no RAISING clause: the raise is
* legal in a body whose signature the dump wrote, not this tree's.
  PUBLIC SECTION.
    DATA missing TYPE string READ-ONLY.
    METHODS constructor
      IMPORTING
        textid   LIKE textid OPTIONAL
        previous LIKE previous OPTIONAL
        missing  TYPE string DEFAULT ''.
    METHODS if_message~get_text REDEFINITION.
* The signal alone, without the raise: a stubbed CLASS_CONSTRUCTOR calls
* this. A class constructor runs when its module loads, and a raise there
* would stop the whole generation from loading -- on a system it is a dump
* on first use of the class, never a reason the system does not start.
    CLASS-METHODS signal IMPORTING missing TYPE string.
ENDCLASS.

CLASS zcx_osd_not_activated IMPLEMENTATION.

  METHOD constructor.
    super->constructor( textid = textid previous = previous ).
    me->missing = missing.
* The kernel-side signal (H5c round 5): a raise inside a $batch changeset is
* swallowed by design -- zcl_stg_batch's CATCH cx_root answers an error part
* -- so the signal leaves HERE, in the constructor, before any catch can see
* the exception. A handler the host installed on globalThis.osdNotActivated
* receives the names; without one the console says what is missing. Form 2
* (OSD_LAZY, later) will turn the handler into a JS throw of its own.
    signal( missing ).
  ENDMETHOD.

  METHOD signal.
    WRITE '@KERNEL if (globalThis.osdNotActivated === undefined) { console.error("not activated: " + missing.get()); } else { globalThis.osdNotActivated(missing.get()); }'.
  ENDMETHOD.

  METHOD if_message~get_text.
    result = |not activated here: needs { missing }|.
  ENDMETHOD.

ENDCLASS.
