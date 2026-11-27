CLASS zcx_osd_conv_table DEFINITION PUBLIC INHERITING FROM cx_no_check FINAL CREATE PUBLIC.
* A conversion exit's table is not in this system: the exit cannot convert
* anything, and answering the value unconverted would be a silently wrong
* answer (an internal unit key where the system writes the external one).
* On a system the table always exists; here it is missing when the island
* or the tree did not bring it (tools/hana-closure-convexit.mjs asks for
* it). The dispatcher answers it as a 500 naming the exit and the table.
* cx_no_check: it leaves the conversion function module, whose interface
* knows only its classic exceptions, and every writer between it and the
* dispatcher.
  PUBLIC SECTION.
    DATA exit  TYPE string READ-ONLY.
    DATA table TYPE string READ-ONLY.
    METHODS constructor
      IMPORTING
        textid   LIKE textid OPTIONAL
        previous LIKE previous OPTIONAL
        exit     TYPE string DEFAULT ''
        table    TYPE string DEFAULT ''.
    METHODS if_message~get_text REDEFINITION.
ENDCLASS.

CLASS zcx_osd_conv_table IMPLEMENTATION.

  METHOD constructor.
    super->constructor( textid = textid previous = previous ).
    me->exit = exit.
    me->table = table.
  ENDMETHOD.

  METHOD if_message~get_text.
    result = |Conversion exit { exit }: its table { table } is not in this system|.
  ENDMETHOD.

ENDCLASS.
