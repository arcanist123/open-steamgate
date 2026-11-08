CLASS zcx_osd_rap DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.
* A model or runtime error of the managed RAP runtime: an unknown entity, a
* behavior definition without a generated adapter, a write the database
* refused during the save. Not a failed instance -- those travel in FAILED.
  PUBLIC SECTION.
    DATA reason TYPE string READ-ONLY.
    METHODS constructor IMPORTING iv_reason TYPE string OPTIONAL.
    METHODS if_message~get_text REDEFINITION.
ENDCLASS.

CLASS zcx_osd_rap IMPLEMENTATION.
  METHOD constructor.
    super->constructor( ).
    reason = iv_reason.
  ENDMETHOD.

  METHOD if_message~get_text.
    result = reason.
  ENDMETHOD.
ENDCLASS.
