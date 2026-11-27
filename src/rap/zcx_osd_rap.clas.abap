CLASS zcx_osd_rap DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.
* A model or runtime error of the managed RAP runtime: an unknown entity, a
* behavior definition without a generated adapter, a write the database
* refused during the save. Not a failed instance -- those travel in FAILED.
  PUBLIC SECTION.
    DATA reason TYPE string READ-ONLY.
* R7: SAVE set when the save sequence failed after its checks (a database
* write or a saver), and the runtime has already ended the transaction:
* the LUW rolled back (when it owns it), the savers' cleanup called, the
* buffer discarded. A caller has nothing left to roll back.
* BUSINESS set when a saver raised it: its text is the saver's, for the
* client, not a defect of the model.
    DATA save TYPE abap_bool READ-ONLY.
    DATA business TYPE abap_bool READ-ONLY.
    METHODS constructor
      IMPORTING
        iv_reason   TYPE string OPTIONAL
        iv_save     TYPE abap_bool DEFAULT abap_false
        iv_business TYPE abap_bool DEFAULT abap_false.
    METHODS if_message~get_text REDEFINITION.
ENDCLASS.

CLASS zcx_osd_rap IMPLEMENTATION.
  METHOD constructor.
    super->constructor( ).
    reason = iv_reason.
    save = iv_save.
    business = iv_business.
  ENDMETHOD.

  METHOD if_message~get_text.
    result = reason.
  ENDMETHOD.
ENDCLASS.
