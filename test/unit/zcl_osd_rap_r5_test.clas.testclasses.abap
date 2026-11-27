CLASS lcl_fk DEFINITION FINAL.
* The order BO with the item's ORDER_ID no key of the item: the parent's
* key is then a plain foreign key of the child (as a UUID child carries its
* parent's UUID). Everything else is the generated adapter.
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_bo.
    METHODS constructor RAISING cx_static_check.
  PRIVATE SECTION.
    DATA mi_bo TYPE REF TO zif_osd_rap_bo.
ENDCLASS.

CLASS lcl_fk IMPLEMENTATION.

  METHOD constructor.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    CREATE OBJECT li_registry TYPE ('ZCL_OSD_RAP_REGISTRY').
    mi_bo = li_registry->get( 'ZI_RAP_ORDER' ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~model.
    FIELD-SYMBOLS <ls_entity> TYPE zif_osd_rap_bo=>ty_entity.
    FIELD-SYMBOLS <ls_field>  TYPE zif_osd_rap_bo=>ty_field.
    rs_model = mi_bo->model( ).
    LOOP AT rs_model-entities ASSIGNING <ls_entity> WHERE name = 'ZI_RAP_ORDITEM'.
      LOOP AT <ls_entity>-fields ASSIGNING <ls_field> WHERE name = 'ORDER_ID'.
        <ls_field>-key = abap_false.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_rows.
    rr_rows = mi_bo->new_rows( iv_entity ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_table.
    rr_table = mi_bo->new_table( iv_entity = iv_entity iv_kind = iv_kind iv_action = iv_action ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_response.
    rr_response = mi_bo->new_response( iv_kind ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_result.
    rr_result = mi_bo->new_result( iv_entity = iv_entity iv_action = iv_action ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_request.
    rr_request = mi_bo->new_request( iv_kind ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~save_modified.
    mi_bo->save_modified( io_saver = io_saver ir_create = ir_create ir_update = ir_update
                          ir_delete = ir_delete ir_reported = ir_reported ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~adjust_numbers.
    RETURN.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~call.
    mi_bo->call( io_handler = io_handler iv_entity = iv_entity iv_name = iv_name
                 ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result
                 ir_failed = ir_failed ir_reported = ir_reported ir_mapped = ir_mapped ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_tree DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    TYPES tt_create   TYPE TABLE FOR CREATE zi_rap_order.
    TYPES tt_cba      TYPE TABLE FOR CREATE zi_rap_order\_items.
    TYPES tt_rimport  TYPE TABLE FOR READ IMPORT zi_rap_order\_items.
    TYPES tt_items    TYPE TABLE FOR READ RESULT zi_rap_order\_items.
    TYPES tt_link     TYPE TABLE FOR READ LINK zi_rap_order\_items.
    TYPES tt_up_imp   TYPE TABLE FOR READ IMPORT zi_rap_orditem\_order.
    TYPES tt_up_res   TYPE TABLE FOR READ RESULT zi_rap_orditem\_order.
    TYPES tt_up_link  TYPE TABLE FOR READ LINK zi_rap_orditem\_order.
    TYPES tt_upd_item TYPE TABLE FOR UPDATE zi_rap_orditem.
    TYPES tt_del      TYPE TABLE FOR DELETE zi_rap_order.
    TYPES tt_read     TYPE TABLE FOR READ IMPORT zi_rap_order.
    TYPES tt_orders   TYPE TABLE FOR READ RESULT zi_rap_order.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY zi_rap_order.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY zi_rap_order.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_order.
    DATA mo_rap TYPE REF TO zcl_osd_rap_runtime.
    METHODS setup.
    METHODS teardown.
* a saved order with items of the given quantities; its id
    METHODS order_with_items
      IMPORTING
        it_quantities  TYPE int4_table
      RETURNING
        VALUE(rv_order) TYPE zrap_order-order_id
      RAISING
        cx_static_check.
    METHODS stamp_of
      IMPORTING
        iv_order        TYPE zrap_order-order_id
      RETURNING
        VALUE(rv_stamp) TYPE zrap_order-last_changed_at.
    METHODS creates_items_below_the_order FOR TESTING RAISING cx_static_check.
    METHODS reads_by_association FOR TESTING RAISING cx_static_check.
    METHODS a_child_needs_its_parent FOR TESTING RAISING cx_static_check.
    METHODS delete_takes_the_items FOR TESTING RAISING cx_static_check.
    METHODS child_write_moves_root_stamp FOR TESTING RAISING cx_static_check.
    METHODS child_write_locks_the_root FOR TESTING RAISING cx_static_check.
    METHODS child_validation_in_the_save FOR TESTING RAISING cx_static_check.
    METHODS keeps_caller_cids_in_numbering FOR TESTING RAISING cx_static_check.
    METHODS keeps_a_non_key_parent_field FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_tree IMPLEMENTATION.

  METHOD setup.
    DELETE FROM zrap_orditem.
    DELETE FROM zrap_order.
    COMMIT WORK.
    mo_rap = zcl_osd_rap_runtime=>for_bdef( 'ZI_RAP_ORDER' ).
  ENDMETHOD.

  METHOD teardown.
    mo_rap->rollback( ).
    DELETE FROM zrap_orditem.
    DELETE FROM zrap_order.
    COMMIT WORK.
  ENDMETHOD.

  METHOD order_with_items.
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA lt_cba      TYPE tt_cba.
    DATA ls_cba      LIKE LINE OF lt_cba.
    DATA ls_target   LIKE LINE OF ls_cba-%target.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_order    LIKE LINE OF ls_mapped-order.
    DATA lv_quantity TYPE i.
    DATA lv_saved    TYPE abap_bool.

    ls_create-%cid = 'O1'.
    ls_create-description = 'order'.
    ls_create-%control-description = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'order' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    ls_cba-%cid_ref = 'O1'.
    LOOP AT it_quantities INTO lv_quantity.
      CLEAR ls_target.
      ls_target-%cid = |I{ sy-tabix }|.
      ls_target-product = |product { sy-tabix }|.
      ls_target-quantity = lv_quantity.
      ls_target-%control-product = if_abap_behv=>mk-on.
      ls_target-%control-quantity = if_abap_behv=>mk-on.
      APPEND ls_target TO ls_cba-%target.
    ENDLOOP.
    APPEND ls_cba TO lt_cba.
    mo_rap->create_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_rows = lt_cba
                       CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
    READ TABLE ls_mapped-order INDEX 1 INTO ls_order.
    rv_order = ls_order-order_id.
  ENDMETHOD.

  METHOD stamp_of.
    SELECT SINGLE last_changed_at FROM zrap_order INTO rv_stamp WHERE order_id = iv_order.
  ENDMETHOD.

  METHOD creates_items_below_the_order.
    DATA lt_quantities TYPE int4_table.
    DATA lv_order      TYPE zrap_order-order_id.
    DATA lt_rows       TYPE STANDARD TABLE OF zrap_orditem WITH DEFAULT KEY.
    DATA ls_row        TYPE zrap_orditem.
    DATA ls_order      TYPE zrap_order.

    APPEND 1 TO lt_quantities.
    APPEND 2 TO lt_quantities.
    lv_order = order_with_items( lt_quantities ).
    cl_abap_unit_assert=>assert_not_initial( lv_order ).
    SELECT * FROM zrap_orditem INTO TABLE lt_rows WHERE order_id = lv_order ORDER BY item_no.
    cl_abap_unit_assert=>assert_equals( act = lines( lt_rows ) exp = 2 ).
* the cba numbering of the pool: 10, 20 below the order
    READ TABLE lt_rows INDEX 1 INTO ls_row.
    cl_abap_unit_assert=>assert_equals( act = ls_row-item_no exp = '0010' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-quantity exp = 1 ).
    cl_abap_unit_assert=>assert_not_initial( ls_row-item_changed_at ).
    READ TABLE lt_rows INDEX 2 INTO ls_row.
    cl_abap_unit_assert=>assert_equals( act = ls_row-item_no exp = '0020' ).
* the determination of the root ran on its create
    SELECT SINGLE * FROM zrap_order INTO ls_order WHERE order_id = lv_order.
    cl_abap_unit_assert=>assert_equals( act = ls_order-status exp = 'O' ).
  ENDMETHOD.

  METHOD reads_by_association.
    DATA lt_quantities TYPE int4_table.
    DATA lv_order      TYPE zrap_order-order_id.
    DATA lt_keys       TYPE tt_rimport.
    DATA ls_key        LIKE LINE OF lt_keys.
    DATA lt_items      TYPE tt_items.
    DATA ls_item       LIKE LINE OF lt_items.
    DATA lt_link       TYPE tt_link.
    DATA ls_link       LIKE LINE OF lt_link.
    DATA lt_up         TYPE tt_up_imp.
    DATA ls_up         LIKE LINE OF lt_up.
    DATA lt_parents    TYPE tt_up_res.
    DATA ls_parent     LIKE LINE OF lt_parents.
    DATA lt_up_link    TYPE tt_up_link.
    DATA ls_failed     TYPE ty_failed.

    APPEND 5 TO lt_quantities.
    APPEND 6 TO lt_quantities.
    APPEND 7 TO lt_quantities.
    lv_order = order_with_items( lt_quantities ).
    ls_key-order_id = lv_order.
    APPEND ls_key TO lt_keys.
    mo_rap->read_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_keys = lt_keys
                     CHANGING ct_result = lt_items ct_link = lt_link cs_failed = ls_failed ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_items ) exp = 3 ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_link ) exp = 3 ).
    READ TABLE lt_items INDEX 3 INTO ls_item.
    cl_abap_unit_assert=>assert_equals( act = ls_item-item_no exp = '0030' ).
    cl_abap_unit_assert=>assert_equals( act = ls_item-quantity exp = 7 ).
    READ TABLE lt_link INDEX 2 INTO ls_link.
    cl_abap_unit_assert=>assert_equals( act = ls_link-source-order_id exp = lv_order ).
    cl_abap_unit_assert=>assert_equals( act = ls_link-target-item_no exp = '0020' ).
* and back up, to the parent
    ls_up-order_id = lv_order.
    ls_up-item_no = '0020'.
    APPEND ls_up TO lt_up.
    mo_rap->read_by( EXPORTING iv_entity = 'item' iv_assoc = '_order' it_keys = lt_up
                     CHANGING ct_result = lt_parents ct_link = lt_up_link cs_failed = ls_failed ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_parents ) exp = 1 ).
    READ TABLE lt_parents INDEX 1 INTO ls_parent.
    cl_abap_unit_assert=>assert_equals( act = ls_parent-description exp = 'order' ).
* an order nobody has: FAILED, nothing read
    CLEAR: lt_keys, lt_items, lt_link.
    ls_key-order_id = '99999999'.
    APPEND ls_key TO lt_keys.
    mo_rap->read_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_keys = lt_keys
                     CHANGING ct_result = lt_items ct_link = lt_link cs_failed = ls_failed ).
    cl_abap_unit_assert=>assert_initial( lt_items ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_failed-order ) exp = 1 ).
  ENDMETHOD.

  METHOD a_child_needs_its_parent.
    DATA lt_cba      TYPE tt_cba.
    DATA ls_cba      LIKE LINE OF lt_cba.
    DATA ls_target   LIKE LINE OF ls_cba-%target.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.

    ls_cba-order_id = '99999999'.
    ls_target-%cid = 'I1'.
    ls_target-product = 'orphan'.
    ls_target-quantity = 1.
    ls_target-%control-product = if_abap_behv=>mk-on.
    ls_target-%control-quantity = if_abap_behv=>mk-on.
    APPEND ls_target TO ls_cba-%target.
    APPEND ls_cba TO lt_cba.
    mo_rap->create_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_rows = lt_cba
                       CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_failed-order ) exp = 1 ).
    cl_abap_unit_assert=>assert_initial( ls_mapped-item ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 0 ).
  ENDMETHOD.

  METHOD delete_takes_the_items.
    DATA lt_quantities TYPE int4_table.
    DATA lv_order      TYPE zrap_order-order_id.
    DATA lt_del        TYPE tt_del.
    DATA ls_del        LIKE LINE OF lt_del.
    DATA ls_mapped     TYPE ty_mapped.
    DATA ls_failed     TYPE ty_failed.
    DATA ls_reported   TYPE ty_reported.
    DATA lv_saved      TYPE abap_bool.
    DATA lv_count      TYPE i.

    APPEND 1 TO lt_quantities.
    APPEND 1 TO lt_quantities.
    lv_order = order_with_items( lt_quantities ).
    ls_del-order_id = lv_order.
    APPEND ls_del TO lt_del.
    mo_rap->modify( EXPORTING iv_entity = 'order' iv_operation = zcl_osd_rap_runtime=>co_operation-delete it_rows = lt_del
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed-order ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
    SELECT COUNT(*) FROM zrap_orditem INTO lv_count WHERE order_id = lv_order.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT COUNT(*) FROM zrap_order INTO lv_count WHERE order_id = lv_order.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
  ENDMETHOD.

  METHOD child_write_moves_root_stamp.
    DATA lt_quantities TYPE int4_table.
    DATA lv_order      TYPE zrap_order-order_id.
    DATA lv_before     TYPE zrap_order-last_changed_at.
    DATA lt_update     TYPE tt_upd_item.
    DATA ls_update     LIKE LINE OF lt_update.
    DATA ls_mapped     TYPE ty_mapped.
    DATA ls_failed     TYPE ty_failed.
    DATA ls_reported   TYPE ty_reported.
    DATA lv_saved      TYPE abap_bool.

    APPEND 1 TO lt_quantities.
    lv_order = order_with_items( lt_quantities ).
    lv_before = stamp_of( lv_order ).
    cl_abap_unit_assert=>assert_not_initial( lv_before ).
    ls_update-order_id = lv_order.
    ls_update-item_no = '0010'.
    ls_update-quantity = 3.
    ls_update-%control-quantity = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    mo_rap->modify( EXPORTING iv_entity = 'item' iv_operation = zcl_osd_rap_runtime=>co_operation-update it_rows = lt_update
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed-item ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
* the root's lastChangedAt is the business object's total stamp
    cl_abap_unit_assert=>assert_true( boolc( stamp_of( lv_order ) > lv_before ) ).
  ENDMETHOD.

  METHOD child_write_locks_the_root.
    DATA lt_quantities TYPE int4_table.
    DATA lv_order      TYPE zrap_order-order_id.
    DATA lt_update     TYPE tt_upd_item.
    DATA ls_update     LIKE LINE OF lt_update.
    DATA ls_mapped     TYPE ty_mapped.
    DATA ls_failed     TYPE ty_failed.
    DATA ls_reported   TYPE ty_reported.
    DATA lv_number     TYPE i.

    APPEND 1 TO lt_quantities.
    lv_order = order_with_items( lt_quantities ).
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING gname = 'ZOSD_RAP_LOCK' guname = space
      IMPORTING number = lv_number.
    cl_abap_unit_assert=>assert_equals( act = lv_number exp = 0 ).
    ls_update-order_id = lv_order.
    ls_update-item_no = '0010'.
    ls_update-quantity = 4.
    ls_update-%control-quantity = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    mo_rap->modify( EXPORTING iv_entity = 'item' iv_operation = zcl_osd_rap_runtime=>co_operation-update it_rows = lt_update
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
* one lock, on the order, until the LUW ends
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING gname = 'ZOSD_RAP_LOCK' guname = space
      IMPORTING number = lv_number.
    cl_abap_unit_assert=>assert_equals( act = lv_number exp = 1 ).
    mo_rap->rollback( ).
    ROLLBACK WORK.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING gname = 'ZOSD_RAP_LOCK' guname = space
      IMPORTING number = lv_number.
    cl_abap_unit_assert=>assert_equals( act = lv_number exp = 0 ).
  ENDMETHOD.

  METHOD child_validation_in_the_save.
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA lt_cba      TYPE tt_cba.
    DATA ls_cba      LIKE LINE OF lt_cba.
    DATA ls_target   LIKE LINE OF ls_cba-%target.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lv_saved    TYPE abap_bool.
    DATA lv_count    TYPE i.

    ls_create-%cid = 'O1'.
    ls_create-description = 'order'.
    ls_create-%control-description = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'order' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    ls_cba-%cid_ref = 'O1'.
    ls_target-%cid = 'I1'.
    ls_target-product = 'nothing'.
    ls_target-quantity = 0.
    ls_target-%control-product = if_abap_behv=>mk-on.
    ls_target-%control-quantity = if_abap_behv=>mk-on.
    APPEND ls_target TO ls_cba-%target.
    APPEND ls_cba TO lt_cba.
    mo_rap->create_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_rows = lt_cba
                       CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_mapped-item ) exp = 1 ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_false( lv_saved ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_failed-item ) exp = 1 ).
    SELECT COUNT(*) FROM zrap_order INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
  ENDMETHOD.

  METHOD keeps_caller_cids_in_numbering.
* a caller's %cid that looks like the runtime's temporary ones, beside a
* blank one: both created, the caller's comes back in MAPPED
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA lt_cba      TYPE tt_cba.
    DATA ls_cba      LIKE LINE OF lt_cba.
    DATA ls_target   LIKE LINE OF ls_cba-%target.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_item     LIKE LINE OF ls_mapped-item.

    ls_create-%cid = 'O1'.
    ls_create-description = 'order'.
    ls_create-%control-description = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'order' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    ls_cba-%cid_ref = 'O1'.
    ls_target-%cid = '%OSD-CBA-1-0'.
    ls_target-product = 'tricky'.
    ls_target-quantity = 1.
    ls_target-%control-product = if_abap_behv=>mk-on.
    ls_target-%control-quantity = if_abap_behv=>mk-on.
    APPEND ls_target TO ls_cba-%target.
    CLEAR ls_target-%cid.
    ls_target-product = 'blank'.
    APPEND ls_target TO ls_cba-%target.
    APPEND ls_cba TO lt_cba.
    mo_rap->create_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_rows = lt_cba
                       CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed-item ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_mapped-item ) exp = 2 ).
    READ TABLE ls_mapped-item INTO ls_item INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_item-%cid exp = '%OSD-CBA-1-0' ).
    cl_abap_unit_assert=>assert_equals( act = ls_item-item_no exp = '0010' ).
    READ TABLE ls_mapped-item INTO ls_item INDEX 2.
    cl_abap_unit_assert=>assert_initial( ls_item-%cid ).
    cl_abap_unit_assert=>assert_equals( act = ls_item-item_no exp = '0020' ).
  ENDMETHOD.

  METHOD keeps_a_non_key_parent_field.
* the parent's key is the framework's to set, also where it is no key of
* the child: the item keeps its order
    DATA li_bo       TYPE REF TO zif_osd_rap_bo.
    DATA lo_rap      TYPE REF TO zcl_osd_rap_runtime.
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA lt_cba      TYPE tt_cba.
    DATA ls_cba      LIKE LINE OF lt_cba.
    DATA ls_target   LIKE LINE OF ls_cba-%target.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_order    LIKE LINE OF ls_mapped-order.
    DATA lt_keys     TYPE tt_rimport.
    DATA ls_key      LIKE LINE OF lt_keys.
    DATA lt_items    TYPE tt_items.
    DATA ls_item     LIKE LINE OF lt_items.
    DATA lt_link     TYPE tt_link.

    CREATE OBJECT li_bo TYPE lcl_fk.
    lo_rap = zcl_osd_rap_runtime=>for_bo( li_bo ).
    ls_create-%cid = 'O1'.
    ls_create-description = 'order'.
    ls_create-%control-description = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    lo_rap->modify( EXPORTING iv_entity = 'order' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    READ TABLE ls_mapped-order INDEX 1 INTO ls_order.
    ls_cba-%cid_ref = 'O1'.
    ls_target-%cid = 'I1'.
    ls_target-product = 'fk'.
    ls_target-quantity = 1.
    ls_target-%control-product = if_abap_behv=>mk-on.
    ls_target-%control-quantity = if_abap_behv=>mk-on.
    APPEND ls_target TO ls_cba-%target.
    APPEND ls_cba TO lt_cba.
    lo_rap->create_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_rows = lt_cba
                       CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed-item ).
    ls_key-order_id = ls_order-order_id.
    APPEND ls_key TO lt_keys.
    lo_rap->read_by( EXPORTING iv_entity = 'order' iv_assoc = '_items' it_keys = lt_keys
                     CHANGING ct_result = lt_items ct_link = lt_link cs_failed = ls_failed ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_items ) exp = 1 ).
    READ TABLE lt_items INDEX 1 INTO ls_item.
    cl_abap_unit_assert=>assert_equals( act = ls_item-order_id exp = ls_order-order_id ).
    lo_rap->rollback( ).
  ENDMETHOD.

ENDCLASS.
