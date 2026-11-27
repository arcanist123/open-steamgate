* The bill demo of R6 (docs/rap-runtime.md, "R6"): the three kinds of
* action the flight reference scenario's managed travel and reuse BOs
* declare beside the instance action, written the way that scenario writes
* them.
*
* - internal action ReCalcTotal: the total is AMOUNT - DISCOUNT. The
*   determination calcTotal executes it IN LOCAL MODE, as the travel's
*   calculateTotalPrice executes ReCalcTotalPrice; nobody else may.
* - factory action copyBill [1]: a new bill with the description, amount
*   and discount of the bill it copies and COPIED_FROM its number, mapped
*   under the %cid of the import row (the travel's copyTravel).
* - determine action check: the validation checkAmount where its triggers
*   hold since the last save, and the determination countCheck always.
*   countCheck counts the checks of a bill; on save it runs when the amount
*   changed.
CLASS lhc_bill DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    METHODS earlynumbering_create FOR NUMBERING
      IMPORTING entities FOR CREATE bill.
    METHODS calc_total FOR DETERMINE ON MODIFY
      IMPORTING keys FOR bill~calctotal.
    METHODS count_check FOR DETERMINE ON SAVE
      IMPORTING keys FOR bill~countcheck.
    METHODS check_amount FOR VALIDATE ON SAVE
      IMPORTING keys FOR bill~checkamount.
    METHODS recalc_total FOR MODIFY
      IMPORTING keys FOR ACTION bill~recalctotal.
    METHODS copy_bill FOR MODIFY
      IMPORTING keys FOR ACTION bill~copybill.
ENDCLASS.

CLASS lhc_bill IMPLEMENTATION.

  METHOD earlynumbering_create.
* the next number after the highest one saved and the ones drawn in this
* call; a create that brings its own number keeps it
    DATA ls_entity LIKE LINE OF entities.
    DATA ls_mapped LIKE LINE OF mapped-bill.
    DATA lv_max    TYPE n LENGTH 8.

    SELECT MAX( bill_id ) FROM zrap_bill INTO lv_max.
    LOOP AT entities INTO ls_entity WHERE bill_id IS NOT INITIAL.
      IF ls_entity-bill_id > lv_max.
        lv_max = ls_entity-bill_id.
      ENDIF.
    ENDLOOP.
    LOOP AT entities INTO ls_entity.
      CLEAR ls_mapped.
      ls_mapped-%cid = ls_entity-%cid.
      IF ls_entity-bill_id IS INITIAL.
        lv_max = lv_max + 1.
        ls_mapped-bill_id = lv_max.
      ELSE.
        ls_mapped-bill_id = ls_entity-bill_id.
      ENDIF.
      APPEND ls_mapped TO mapped-bill.
    ENDLOOP.
  ENDMETHOD.

  METHOD calc_total.
* MODIFY ENTITIES ... IN LOCAL MODE ENTITY bill EXECUTE recalctotal
*   FROM CORRESPONDING #( keys ), written as a loop (ABAP 7.02)
    DATA lt_exec TYPE TABLE FOR ACTION IMPORT zi_rap_bill~recalctotal.
    DATA ls_exec LIKE LINE OF lt_exec.
    DATA ls_key  LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_exec.
      ls_exec-%tky = ls_key-%tky.
      APPEND ls_exec TO lt_exec.
    ENDLOOP.
    MODIFY ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        EXECUTE recalctotal FROM lt_exec
      REPORTED reported.
  ENDMETHOD.

  METHOD recalc_total.
* the total of each bill given
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_bill.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_bills  TYPE TABLE FOR READ RESULT zi_rap_bill.
    DATA ls_bill   LIKE LINE OF lt_bills.
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_bill.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        FIELDS ( amount discount total ) WITH lt_read
      RESULT lt_bills.
    LOOP AT lt_bills INTO ls_bill.
      IF ls_bill-total = ls_bill-amount - ls_bill-discount.
        CONTINUE.
      ENDIF.
      CLEAR ls_update.
      ls_update-%tky = ls_bill-%tky.
      ls_update-total = ls_bill-amount - ls_bill-discount.
      APPEND ls_update TO lt_update.
    ENDLOOP.
    IF lt_update IS INITIAL.
      RETURN.
    ENDIF.
    MODIFY ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        UPDATE FIELDS ( total ) WITH lt_update
      REPORTED reported.
  ENDMETHOD.

  METHOD copy_bill.
* a new bill from each one given, created IN LOCAL MODE under the %cid of
* the import row and answered in MAPPED
    DATA lt_read    TYPE TABLE FOR READ IMPORT zi_rap_bill.
    DATA ls_read    LIKE LINE OF lt_read.
    DATA lt_bills   TYPE TABLE FOR READ RESULT zi_rap_bill.
    DATA ls_bill    LIKE LINE OF lt_bills.
    DATA lt_create  TYPE TABLE FOR CREATE zi_rap_bill.
    DATA ls_create  LIKE LINE OF lt_create.
    DATA ls_key     LIKE LINE OF keys.
    DATA ls_created TYPE RESPONSE FOR MAPPED EARLY zi_rap_bill.
    DATA ls_mline   LIKE LINE OF ls_created-bill.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        ALL FIELDS WITH lt_read
      RESULT lt_bills
      FAILED failed.
    LOOP AT keys INTO ls_key.
      READ TABLE lt_bills INTO ls_bill WITH KEY bill_id = ls_key-bill_id.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      CLEAR ls_create.
      ls_create-%cid = ls_key-%cid.
      ls_create-description = ls_bill-description.
      ls_create-amount = ls_bill-amount.
      ls_create-discount = ls_bill-discount.
      ls_create-copied_from = ls_bill-bill_id.
      APPEND ls_create TO lt_create.
    ENDLOOP.
    IF lt_create IS INITIAL.
      RETURN.
    ENDIF.
    MODIFY ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        CREATE FIELDS ( description amount discount copied_from ) WITH lt_create
      MAPPED ls_created
      FAILED failed
      REPORTED reported.
    LOOP AT ls_created-bill INTO ls_mline.
      APPEND ls_mline TO mapped-bill.
    ENDLOOP.
  ENDMETHOD.

  METHOD count_check.
* one more check of each bill given
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_bill.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_bills  TYPE TABLE FOR READ RESULT zi_rap_bill.
    DATA ls_bill   LIKE LINE OF lt_bills.
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_bill.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        FIELDS ( checks ) WITH lt_read
      RESULT lt_bills.
    LOOP AT lt_bills INTO ls_bill.
      CLEAR ls_update.
      ls_update-%tky = ls_bill-%tky.
      ls_update-checks = ls_bill-checks + 1.
      APPEND ls_update TO lt_update.
    ENDLOOP.
    IF lt_update IS INITIAL.
      RETURN.
    ENDIF.
    MODIFY ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        UPDATE FIELDS ( checks ) WITH lt_update
      REPORTED reported.
  ENDMETHOD.

  METHOD check_amount.
* the discount may not exceed the amount, and the amount is not negative
    DATA lt_read  TYPE TABLE FOR READ IMPORT zi_rap_bill.
    DATA ls_read  LIKE LINE OF lt_read.
    DATA lt_bills TYPE TABLE FOR READ RESULT zi_rap_bill.
    DATA ls_bill  LIKE LINE OF lt_bills.
    DATA ls_fail  LIKE LINE OF failed-bill.
    DATA ls_msg   LIKE LINE OF reported-bill.
    DATA ls_key   LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_bill IN LOCAL MODE
      ENTITY bill
        FIELDS ( amount discount ) WITH lt_read
      RESULT lt_bills.
    LOOP AT lt_bills INTO ls_bill.
      IF ls_bill-amount >= 0 AND ls_bill-discount <= ls_bill-amount.
        CONTINUE.
      ENDIF.
      CLEAR: ls_fail, ls_msg.
      ls_fail-%tky = ls_bill-%tky.
      APPEND ls_fail TO failed-bill.
      ls_msg-%tky = ls_bill-%tky.
      ls_msg-%msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                           text     = |Bill { ls_bill-bill_id }: the discount exceeds the amount| ).
      APPEND ls_msg TO reported-bill.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
