* The order demo of R5 (docs/rap-runtime.md, "R5"): a root with its items
* as a composition, written the way the flight reference scenario writes
* its travel and bookings -- early numbering of the root through FOR
* NUMBERING ... FOR CREATE order, of the items through FOR NUMBERING ...
* FOR CREATE order\_items (the create by association), each item under
* the lock and the change stamp of its order.
*
* A new order is open (O). An item needs a positive quantity.
CLASS lhc_order DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    METHODS earlynumbering_create FOR NUMBERING
      IMPORTING entities FOR CREATE order.
    METHODS earlynumbering_cba_items FOR NUMBERING
      IMPORTING entities FOR CREATE order\_items.
    METHODS set_status FOR DETERMINE ON MODIFY
      IMPORTING keys FOR order~setstatus.
ENDCLASS.

CLASS lhc_order IMPLEMENTATION.

  METHOD earlynumbering_create.
* the next number after the highest one saved and the ones drawn in this
* call; a create that brings its own number keeps it
    DATA ls_entity LIKE LINE OF entities.
    DATA ls_mapped LIKE LINE OF mapped-order.
    DATA lv_max    TYPE n LENGTH 8.

    SELECT MAX( order_id ) FROM zrap_order INTO lv_max.
    LOOP AT entities INTO ls_entity WHERE order_id IS NOT INITIAL.
      IF ls_entity-order_id > lv_max.
        lv_max = ls_entity-order_id.
      ENDIF.
    ENDLOOP.
    LOOP AT entities INTO ls_entity.
      CLEAR ls_mapped.
      ls_mapped-%cid = ls_entity-%cid.
      IF ls_entity-order_id IS INITIAL.
        lv_max = lv_max + 1.
        ls_mapped-order_id = lv_max.
      ELSE.
        ls_mapped-order_id = ls_entity-order_id.
      ENDIF.
      APPEND ls_mapped TO mapped-order.
    ENDLOOP.
  ENDMETHOD.

  METHOD earlynumbering_cba_items.
* the items of an order are numbered 10, 20, 30 ... after the highest item
* the order has, saved or in this transaction (read by association)
    DATA ls_entity LIKE LINE OF entities.
    DATA ls_target LIKE LINE OF ls_entity-%target.
    DATA ls_mapped LIKE LINE OF mapped-item.
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_order\_items.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_items  TYPE TABLE FOR READ RESULT zi_rap_order\_items.
    DATA lt_link   TYPE TABLE FOR READ LINK zi_rap_order\_items.
    DATA ls_item   LIKE LINE OF lt_items.
    DATA ls_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_order.
    DATA lv_max    TYPE n LENGTH 4.

    LOOP AT entities INTO ls_entity.
      CLEAR: lt_read, lt_items, lt_link, lv_max.
      ls_read-%tky = ls_entity-%tky.
      APPEND ls_read TO lt_read.
* READ ENTITIES OF zi_rap_order IN LOCAL MODE
*   ENTITY order BY \_items FROM lt_read
*   RESULT lt_items LINK lt_link.
* (the pinned transpiler does not lower BY \_assoc yet, docs/rap-runtime.md)
      zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef   = 'ZI_RAP_ORDER'
                                          iv_entity = 'ORDER'
                                          iv_assoc  = '_ITEMS'
                                          it_keys   = lt_read
                                CHANGING  ct_result = lt_items
                                          ct_link   = lt_link
                                          cs_failed = ls_failed ).
      LOOP AT lt_items INTO ls_item.
        IF ls_item-item_no > lv_max.
          lv_max = ls_item-item_no.
        ENDIF.
      ENDLOOP.
      LOOP AT ls_entity-%target INTO ls_target.
        CLEAR ls_mapped.
        ls_mapped-%cid = ls_target-%cid.
        ls_mapped-order_id = ls_entity-order_id.
        IF ls_target-item_no IS INITIAL.
          lv_max = lv_max + 10.
          ls_mapped-item_no = lv_max.
        ELSE.
          ls_mapped-item_no = ls_target-item_no.
        ENDIF.
        APPEND ls_mapped TO mapped-item.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD set_status.
* a new order is open
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_order.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_update.
      ls_update-%tky = ls_key-%tky.
      ls_update-status = 'O'.
      APPEND ls_update TO lt_update.
    ENDLOOP.
    MODIFY ENTITIES OF zi_rap_order IN LOCAL MODE
      ENTITY order
        UPDATE FIELDS ( status ) WITH lt_update
      REPORTED reported.
  ENDMETHOD.

ENDCLASS.

CLASS lhc_item DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    METHODS check_quantity FOR VALIDATE ON SAVE
      IMPORTING keys FOR item~checkquantity.
ENDCLASS.

CLASS lhc_item IMPLEMENTATION.

  METHOD check_quantity.
* an item needs a positive quantity
    DATA lt_read  TYPE TABLE FOR READ IMPORT zi_rap_orditem.
    DATA ls_read  LIKE LINE OF lt_read.
    DATA lt_items TYPE TABLE FOR READ RESULT zi_rap_orditem.
    DATA ls_item  LIKE LINE OF lt_items.
    DATA ls_fail  LIKE LINE OF failed-item.
    DATA ls_msg   LIKE LINE OF reported-item.
    DATA ls_key   LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_order IN LOCAL MODE
      ENTITY item
        FIELDS ( quantity ) WITH lt_read
      RESULT lt_items.
    LOOP AT lt_items INTO ls_item WHERE quantity <= 0.
      CLEAR: ls_fail, ls_msg.
      ls_fail-%tky = ls_item-%tky.
      APPEND ls_fail TO failed-item.
      ls_msg-%tky = ls_item-%tky.
      ls_msg-%msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                           text     = |Item { ls_item-item_no }: the quantity must be positive| ).
      APPEND ls_msg TO reported-item.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
