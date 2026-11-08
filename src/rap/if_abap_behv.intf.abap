INTERFACE if_abap_behv PUBLIC.
* The constants of the RAP contract a behavior pool writes against: the
* control flag of %CONTROL and %ELEMENT, and the fail causes of %FAIL.
* Clean-room: the names and values are the public contract (ABAP keyword
* documentation, "RAP BO" components); this subset is what the managed
* runtime of docs/rap-runtime.md reads and writes. A cause is an integer
* here rather than an enumeration.

  TYPES t_xflag TYPE x LENGTH 1.
  TYPES t_fail_cause TYPE i.

  CONSTANTS:
    BEGIN OF mk,
      off TYPE t_xflag VALUE '00',
      on  TYPE t_xflag VALUE '01',
    END OF mk.

  CONSTANTS:
    BEGIN OF cause,
      unspecific   TYPE t_fail_cause VALUE 0,
      unauthorized TYPE t_fail_cause VALUE 401,
      not_found    TYPE t_fail_cause VALUE 404,
      conflict     TYPE t_fail_cause VALUE 409,
      locked       TYPE t_fail_cause VALUE 423,
      dependency   TYPE t_fail_cause VALUE 424,
      disabled     TYPE t_fail_cause VALUE 4221,
      readonly     TYPE t_fail_cause VALUE 4222,
    END OF cause.

ENDINTERFACE.
