CLASS zcl_osd_status DEFINITION PUBLIC CREATE PUBLIC.
* The writer of the system-status tables.
*
* ABAP owns the five tables and the service over them (ZOSD_STATUS_SRV);
* the facade owns the facts, because only it can see the pool's children,
* the listeners it opened and the generation it built. So the facade sends
* one JSON snapshot (tools/osd-status.mjs) and this replaces the contents
* of the five tables with it. The shape of that JSON is the contract:
*
*   {"system":{"sid":..,"host_kind":..,"gen_live":..,"gen_serving":..,
*              "synced":true,"workers":4,"started_at":..,"snap_at":..,
*              "root_hint":..,"pid":..},
*    "processes":[{"pid":..,"role":..,"port":..,"generation":..,"epoch":..,
*                  "since":..,"sockets":..,"rss_mb":..,"alive":true}],
*    "ports":[{"port":..,"protocol":..,"purpose":..,"state":..,"note":..}],
*    "services":[{"path":..,"kind":..,"handler":..,"text":..,"pack":..}],
*    "packs":[{"name":..,"order":..,"objects":..,"folders":..,
*              "description":..}],
*    "database":[{"section":..,"name":..,"value":..,"note":..}],
*    "amdp":{"db":..,"driver":true,"configured":false,"session":..,
*            "methods":[{"clsname":..,"mtdname":..,"kind":..,
*                        "portable":true,"refusal":..}]}}
*
* The JSON keys "handler" and "section" land in ZOSD_SVC-HANDLER_NAME and
* ZOSD_DB-CATEGORY: a system reserves HANDLER and SECTION as field names.
*
* SNAPSHOT gives the same JSON back out of the tables, so the round trip is
* testable without the facade.
*
* Nothing is written until the whole snapshot has been parsed and the
* system row has a SID: a body that is not this JSON leaves the tables as
* they were, because a status service that empties itself when the facade
* hiccups is worse than one that is a few seconds stale.
  PUBLIC SECTION.

    TYPES: BEGIN OF ty_system,
             sid         TYPE string,
             host_kind   TYPE string,
             gen_live    TYPE string,
             gen_serving TYPE string,
             synced      TYPE abap_bool,
             workers     TYPE i,
             started_at  TYPE string,
             snap_at     TYPE string,
             root_hint   TYPE string,
* the process these tables were written in, which is the process that
* answers the read: SAP Easy Access prints it where SAP GUI prints the
* session number (src/webgui/, backlog G.1b)
             pid         TYPE i,
           END OF ty_system.

    TYPES: BEGIN OF ty_process,
             pid        TYPE i,
             role       TYPE string,
             port       TYPE i,
             generation TYPE string,
             epoch      TYPE i,
             since      TYPE string,
             sockets    TYPE i,
             rss_mb     TYPE i,
             alive      TYPE abap_bool,
           END OF ty_process.
    TYPES tt_process TYPE STANDARD TABLE OF ty_process WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_port,
             port     TYPE i,
             protocol TYPE string,
             purpose  TYPE string,
             state    TYPE string,
             note     TYPE string,
           END OF ty_port.
    TYPES tt_port TYPE STANDARD TABLE OF ty_port WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_service,
             path    TYPE string,
             kind    TYPE string,
             handler TYPE string,
             text    TYPE string,
             pack    TYPE string,
           END OF ty_service.
    TYPES tt_service TYPE STANDARD TABLE OF ty_service WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_pack,
             name        TYPE string,
             order       TYPE i,
             objects     TYPE i,
             folders     TYPE string,
             description TYPE string,
           END OF ty_pack.
    TYPES tt_pack TYPE STANDARD TABLE OF ty_pack WITH DEFAULT KEY.

*   What the database is, as facts rather than as a shape. The rows are
*   name/value on purpose: a SQLite file, a DuckDB file and a HANA server have
*   almost nothing in common to put in fixed columns, and the one thing a
*   person wants -- "what am I actually talking to" -- is a list.
    TYPES: BEGIN OF ty_dbfact,
             section TYPE string,
             name    TYPE string,
             value   TYPE string,
             note    TYPE string,
           END OF ty_dbfact.
    TYPES tt_dbfact TYPE STANDARD TABLE OF ty_dbfact WITH DEFAULT KEY.

*   The AMDP methods of the tree, and the facts that say where a body runs
*   (tools/amdp-status.mjs): the system database, whether this build has a
*   HANA driver, whether a HANA is configured, the state of the session the
*   AMDP destination holds right now (none / connected / closed), and per
*   method whether tools/amdp-gen.mjs compiled it into the portable subset.
*   ENGINE turns these into the label a person sees; the facts stay raw in
*   the JSON so that the classification is in one place and testable.
    TYPES: BEGIN OF ty_amdp_method,
             clsname  TYPE string,
             mtdname  TYPE string,
             kind     TYPE string,
             portable TYPE abap_bool,
             refusal  TYPE string,
             engine   TYPE string,
             reason   TYPE string,
           END OF ty_amdp_method.
    TYPES tt_amdp_method TYPE STANDARD TABLE OF ty_amdp_method WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_amdp,
             db         TYPE string,
             driver     TYPE abap_bool,
             configured TYPE abap_bool,
             session    TYPE string,
             methods    TYPE tt_amdp_method,
*            set when the process holding the destination did not answer:
*            nothing was observed, and REFRESH keeps the rows it has
             unknown    TYPE abap_bool,
           END OF ty_amdp.

    TYPES: BEGIN OF ty_snapshot,
             system    TYPE ty_system,
             processes TYPE tt_process,
             ports     TYPE tt_port,
             services  TYPE tt_service,
             packs     TYPE tt_pack,
             database  TYPE tt_dbfact,
             amdp      TYPE ty_amdp,
           END OF ty_snapshot.

* the snapshot as JSON, into the tables; the number of rows written, or
* zero when the body is not a snapshot (and then nothing was touched)
    CLASS-METHODS refresh
      IMPORTING
        iv_json       TYPE string
      RETURNING
        VALUE(rv_rows) TYPE i.

* what the tables hold, as the same JSON
    CLASS-METHODS snapshot
      RETURNING
        VALUE(rv_json) TYPE string.

* Where one AMDP body runs, read off the facts of this moment and never off
* configuration alone. The destination (tools/amdp-destination.mjs) routes a
* call to the compiled portable IR when the system database is DuckDB and
* the method is in the subset, with no HANA fallback there; on every other
* database it goes natively to HANA over the destination's own session.
*   portable-duckdb  pAMDP on the system DuckDB connection
*   portable-refused compiled into the IR, but DuckDB refuses the call
*                    (a construct with no measured rendering; EV_REASON names it)
*   hdb              eAMDP, the destination session is connected
*   hdb-stale        eAMDP, the session is closed; the next call reconnects once
*   hdb-idle         eAMDP, HANA configured, no session opened yet
*   unavailable      nothing would run; EV_REASON says why
    CLASS-METHODS engine
      IMPORTING
        iv_db         TYPE string
        iv_driver     TYPE abap_bool
        iv_configured TYPE abap_bool
        iv_session    TYPE string
        iv_portable   TYPE abap_bool
        iv_refusal    TYPE string
      EXPORTING
        ev_engine     TYPE string
        ev_reason     TYPE string.

  PRIVATE SECTION.

    CLASS-METHODS parse
      IMPORTING
        iv_json        TYPE string
      RETURNING
        VALUE(rs_snap) TYPE ty_snapshot.

ENDCLASS.


CLASS zcl_osd_status IMPLEMENTATION.

  METHOD parse.
* a body that is not an object is not a snapshot, and is refused before the
* parser is asked to make sense of it
    DATA lv_text TYPE string.

    lv_text = iv_json.
    CONDENSE lv_text.
    IF lv_text IS INITIAL OR lv_text(1) <> '{'.
      RETURN.
    ENDIF.

    TRY.
        /ui2/cl_json=>deserialize( EXPORTING json = iv_json
                                   CHANGING  data = rs_snap ).
      CATCH cx_root.
        CLEAR rs_snap.
    ENDTRY.
  ENDMETHOD.

  METHOD engine.
    CLEAR ev_engine.
    CLEAR ev_reason.

    IF iv_db = 'duckdb'.
*     the destination hands a DuckDB system the compiled IR, and nothing
*     else: a method outside the subset is refused there, not sent to HANA
*     a compiled body can still carry a refusal: tools/amdp-gen.mjs lowers
*     it for DuckDB at build time and writes down what the call will refuse
*     (a function with no measured rendering, FLOOR or LEFT among them)
      IF iv_portable = abap_true AND iv_refusal IS INITIAL.
        ev_engine = 'portable-duckdb'.
        ev_reason = 'pAMDP: the compiled SQLScript IR runs on the system DuckDB connection'.
      ELSEIF iv_portable = abap_true.
        ev_engine = 'portable-refused'.
        ev_reason = 'pAMDP: compiled, but DuckDB refuses the call, and has no HANA fallback: ' && iv_refusal.
      ELSE.
        ev_engine = 'unavailable'.
        ev_reason = 'not in the portable SQLScript subset, and DuckDB has no HANA fallback'.
        IF iv_refusal IS NOT INITIAL.
          ev_reason = ev_reason && ': ' && iv_refusal.
        ENDIF.
      ENDIF.
      RETURN.
    ENDIF.

*   every other database: eAMDP, natively on HANA over the destination's
*   own session, which is not the system connection even when that is HANA
    IF iv_driver = abap_false.
      ev_engine = 'unavailable'.
      ev_reason = 'this build has no HANA driver (the browser preview)'.
    ELSEIF iv_configured = abap_false.
      ev_engine = 'unavailable'.
      ev_reason = 'no HANA configured (HXE_HOST / HXE_PASSWORD or ~/.osd/hxe-password)'.
    ELSEIF iv_session = 'connected'.
      ev_engine = 'hdb'.
      ev_reason = 'eAMDP: the body runs natively on HANA over the live destination session'.
    ELSEIF iv_session = 'closed'.
      ev_engine = 'hdb-stale'.
      ev_reason = 'eAMDP: the destination session is closed; the next call reconnects once'.
    ELSE.
      ev_engine = 'hdb-idle'.
      ev_reason = 'eAMDP: HANA configured, no session opened yet; the first call connects'.
    ENDIF.

    IF iv_portable = abap_true AND iv_refusal IS INITIAL.
      ev_reason = ev_reason && '; portable subset: yes, used only when the system database is DuckDB'.
    ELSEIF iv_portable = abap_true.
      ev_reason = ev_reason && '; portable IR compiled, but DuckDB would refuse the call: ' && iv_refusal.
    ENDIF.
  ENDMETHOD.

  METHOD refresh.
    DATA ls_snap    TYPE ty_snapshot.
    DATA ls_proc_in TYPE ty_process.
    DATA ls_port_in TYPE ty_port.
    DATA ls_svc_in  TYPE ty_service.
    DATA ls_pack_in TYPE ty_pack.
    DATA ls_sys     TYPE zosd_sys.
    DATA ls_proc    TYPE zosd_proc.
    DATA ls_port    TYPE zosd_port.
    DATA ls_svc     TYPE zosd_svc.
    DATA ls_pack    TYPE zosd_pack.
    DATA ls_db_in   TYPE ty_dbfact.
    DATA ls_db      TYPE zosd_db.
    DATA lt_db      TYPE STANDARD TABLE OF zosd_db WITH DEFAULT KEY.
    DATA lv_seq     TYPE i.
    DATA lt_proc    TYPE STANDARD TABLE OF zosd_proc WITH DEFAULT KEY.
    DATA lt_port    TYPE STANDARD TABLE OF zosd_port WITH DEFAULT KEY.
    DATA lt_svc     TYPE STANDARD TABLE OF zosd_svc WITH DEFAULT KEY.
    DATA lt_pack    TYPE STANDARD TABLE OF zosd_pack WITH DEFAULT KEY.
    DATA ls_amdp_in TYPE ty_amdp_method.
    DATA ls_amdp    TYPE zosd_amdp.
    DATA lt_amdp    TYPE STANDARD TABLE OF zosd_amdp WITH DEFAULT KEY.
    DATA lv_engine  TYPE string.
    DATA lv_reason  TYPE string.

    ls_snap = parse( iv_json ).
    IF ls_snap-system-sid IS INITIAL.
* not a snapshot: the tables keep what they had
      RETURN.
    ENDIF.

    ls_sys-sid         = ls_snap-system-sid.
    ls_sys-host_kind   = ls_snap-system-host_kind.
    ls_sys-gen_live    = ls_snap-system-gen_live.
    ls_sys-gen_serving = ls_snap-system-gen_serving.
    ls_sys-synced      = ls_snap-system-synced.
    ls_sys-workers     = ls_snap-system-workers.
    ls_sys-started_at  = ls_snap-system-started_at.
    ls_sys-snap_at     = ls_snap-system-snap_at.
    ls_sys-root_hint   = ls_snap-system-root_hint.
    ls_sys-pid         = ls_snap-system-pid.

    LOOP AT ls_snap-processes INTO ls_proc_in.
      CLEAR ls_proc.
      ls_proc-pid        = ls_proc_in-pid.
      ls_proc-role       = ls_proc_in-role.
      ls_proc-port       = ls_proc_in-port.
      ls_proc-generation = ls_proc_in-generation.
      ls_proc-epoch      = ls_proc_in-epoch.
      ls_proc-since      = ls_proc_in-since.
      ls_proc-sockets    = ls_proc_in-sockets.
      ls_proc-rss_mb     = ls_proc_in-rss_mb.
      ls_proc-alive      = ls_proc_in-alive.
      READ TABLE lt_proc WITH KEY pid = ls_proc-pid TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND ls_proc TO lt_proc.
      ENDIF.
    ENDLOOP.

    LOOP AT ls_snap-ports INTO ls_port_in.
      CLEAR ls_port.
      ls_port-port     = ls_port_in-port.
      ls_port-protocol = ls_port_in-protocol.
      ls_port-purpose  = ls_port_in-purpose.
      ls_port-state    = ls_port_in-state.
      ls_port-note     = ls_port_in-note.
      READ TABLE lt_port WITH KEY port = ls_port-port TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND ls_port TO lt_port.
      ENDIF.
    ENDLOOP.

    LOOP AT ls_snap-services INTO ls_svc_in.
      CLEAR ls_svc.
      ls_svc-path         = ls_svc_in-path.
      ls_svc-kind         = ls_svc_in-kind.
      ls_svc-handler_name = ls_svc_in-handler.
      ls_svc-text         = ls_svc_in-text.
      ls_svc-pack         = ls_svc_in-pack.
      READ TABLE lt_svc WITH KEY path = ls_svc-path TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND ls_svc TO lt_svc.
      ENDIF.
    ENDLOOP.

    LOOP AT ls_snap-packs INTO ls_pack_in.
      CLEAR ls_pack.
      ls_pack-name        = ls_pack_in-name.
      ls_pack-pack_order  = ls_pack_in-order.
      ls_pack-objects     = ls_pack_in-objects.
      ls_pack-folders     = ls_pack_in-folders.
      ls_pack-description = ls_pack_in-description.
      READ TABLE lt_pack WITH KEY name = ls_pack-name TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND ls_pack TO lt_pack.
      ENDIF.
    ENDLOOP.

    lv_seq = 0.
    LOOP AT ls_snap-database INTO ls_db_in.
      CLEAR ls_db.
      lv_seq       = lv_seq + 1.
      ls_db-seq    = lv_seq.
      ls_db-category = ls_db_in-section.
      ls_db-name   = ls_db_in-name.
      ls_db-value  = ls_db_in-value.
      ls_db-note   = ls_db_in-note.
      READ TABLE lt_db WITH KEY category = ls_db-category name = ls_db-name TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND ls_db TO lt_db.
      ENDIF.
    ENDLOOP.

    LOOP AT ls_snap-amdp-methods INTO ls_amdp_in.
      CLEAR ls_amdp.
      ls_amdp-class_name  = ls_amdp_in-clsname.
      ls_amdp-method_name = ls_amdp_in-mtdname.
      ls_amdp-kind        = ls_amdp_in-kind.
      ls_amdp-portable    = ls_amdp_in-portable.
      ls_amdp-refusal     = ls_amdp_in-refusal.
      engine( EXPORTING iv_db         = ls_snap-amdp-db
                        iv_driver     = ls_snap-amdp-driver
                        iv_configured = ls_snap-amdp-configured
                        iv_session    = ls_snap-amdp-session
                        iv_portable   = ls_amdp_in-portable
                        iv_refusal    = ls_amdp_in-refusal
              IMPORTING ev_engine     = lv_engine
                        ev_reason     = lv_reason ).
      ls_amdp-engine = lv_engine.
      ls_amdp-reason = lv_reason.
      IF ls_amdp-class_name IS INITIAL OR ls_amdp-method_name IS INITIAL.
        CONTINUE.
      ENDIF.
      READ TABLE lt_amdp WITH KEY class_name = ls_amdp-class_name method_name = ls_amdp-method_name TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND ls_amdp TO lt_amdp.
      ENDIF.
    ENDLOOP.

* replace, rather than merge: a process that is gone must not linger, and
* the snapshot is the whole truth about this instance
    DELETE FROM zosd_sys WHERE sid <> ''.
    DELETE FROM zosd_proc WHERE pid >= 0.
    DELETE FROM zosd_port WHERE port >= 0.
    DELETE FROM zosd_svc WHERE path <> ''.
    DELETE FROM zosd_pack WHERE name <> ''.
    DELETE FROM zosd_db WHERE name <> ''.
*   AMDP facts nobody observed are not a snapshot of the AMDP rows
    IF ls_snap-amdp-unknown = abap_false.
      DELETE FROM zosd_amdp WHERE class_name <> ''.
    ELSE.
      CLEAR lt_amdp.
    ENDIF.

    INSERT zosd_sys FROM ls_sys.
    rv_rows = 1.
    IF lt_proc IS NOT INITIAL.
      INSERT zosd_proc FROM TABLE lt_proc.
      rv_rows = rv_rows + lines( lt_proc ).
    ENDIF.
    IF lt_port IS NOT INITIAL.
      INSERT zosd_port FROM TABLE lt_port.
      rv_rows = rv_rows + lines( lt_port ).
    ENDIF.
    IF lt_svc IS NOT INITIAL.
      INSERT zosd_svc FROM TABLE lt_svc.
      rv_rows = rv_rows + lines( lt_svc ).
    ENDIF.
    IF lt_pack IS NOT INITIAL.
      INSERT zosd_pack FROM TABLE lt_pack.
      rv_rows = rv_rows + lines( lt_pack ).
    ENDIF.
    IF lt_db IS NOT INITIAL.
      INSERT zosd_db FROM TABLE lt_db.
      rv_rows = rv_rows + lines( lt_db ).
    ENDIF.
    IF lt_amdp IS NOT INITIAL.
      INSERT zosd_amdp FROM TABLE lt_amdp.
      rv_rows = rv_rows + lines( lt_amdp ).
    ENDIF.
  ENDMETHOD.

  METHOD snapshot.
    DATA ls_snap    TYPE ty_snapshot.
    DATA ls_proc_out TYPE ty_process.
    DATA ls_port_out TYPE ty_port.
    DATA ls_svc_out  TYPE ty_service.
    DATA ls_pack_out TYPE ty_pack.
    DATA ls_db_out   TYPE ty_dbfact.
    DATA ls_sys     TYPE zosd_sys.
    DATA ls_proc    TYPE zosd_proc.
    DATA ls_port    TYPE zosd_port.
    DATA ls_svc     TYPE zosd_svc.
    DATA ls_pack    TYPE zosd_pack.
    DATA ls_db      TYPE zosd_db.
    DATA ls_amdp_out TYPE ty_amdp_method.
    DATA ls_amdp    TYPE zosd_amdp.

    SELECT SINGLE * FROM zosd_sys INTO ls_sys.
    IF sy-subrc = 0.
      ls_snap-system-sid         = ls_sys-sid.
      ls_snap-system-host_kind   = ls_sys-host_kind.
      ls_snap-system-gen_live    = ls_sys-gen_live.
      ls_snap-system-gen_serving = ls_sys-gen_serving.
      ls_snap-system-synced      = boolc( ls_sys-synced = 'X' ).
      ls_snap-system-workers     = ls_sys-workers.
      ls_snap-system-started_at  = ls_sys-started_at.
      ls_snap-system-snap_at     = ls_sys-snap_at.
      ls_snap-system-root_hint   = ls_sys-root_hint.
      ls_snap-system-pid         = ls_sys-pid.
    ENDIF.

    SELECT * FROM zosd_proc INTO ls_proc ORDER BY pid.
      CLEAR ls_proc_out.
      ls_proc_out-pid        = ls_proc-pid.
      ls_proc_out-role       = ls_proc-role.
      ls_proc_out-port       = ls_proc-port.
      ls_proc_out-generation = ls_proc-generation.
      ls_proc_out-epoch      = ls_proc-epoch.
      ls_proc_out-since      = ls_proc-since.
      ls_proc_out-sockets    = ls_proc-sockets.
      ls_proc_out-rss_mb     = ls_proc-rss_mb.
      ls_proc_out-alive      = boolc( ls_proc-alive = 'X' ).
      APPEND ls_proc_out TO ls_snap-processes.
    ENDSELECT.

    SELECT * FROM zosd_port INTO ls_port ORDER BY port.
      CLEAR ls_port_out.
      ls_port_out-port     = ls_port-port.
      ls_port_out-protocol = ls_port-protocol.
      ls_port_out-purpose  = ls_port-purpose.
      ls_port_out-state    = ls_port-state.
      ls_port_out-note     = ls_port-note.
      APPEND ls_port_out TO ls_snap-ports.
    ENDSELECT.

    SELECT * FROM zosd_svc INTO ls_svc ORDER BY path.
      CLEAR ls_svc_out.
      ls_svc_out-path    = ls_svc-path.
      ls_svc_out-kind    = ls_svc-kind.
      ls_svc_out-handler = ls_svc-handler_name.
      ls_svc_out-text    = ls_svc-text.
      ls_svc_out-pack    = ls_svc-pack.
      APPEND ls_svc_out TO ls_snap-services.
    ENDSELECT.

    SELECT * FROM zosd_pack INTO ls_pack ORDER BY pack_order name.
      CLEAR ls_pack_out.
      ls_pack_out-name        = ls_pack-name.
      ls_pack_out-order       = ls_pack-pack_order.
      ls_pack_out-objects     = ls_pack-objects.
      ls_pack_out-folders     = ls_pack-folders.
      ls_pack_out-description = ls_pack-description.
      APPEND ls_pack_out TO ls_snap-packs.
    ENDSELECT.

    SELECT * FROM zosd_db INTO ls_db ORDER BY seq.
      CLEAR ls_db_out.
      ls_db_out-section = ls_db-category.
      ls_db_out-name    = ls_db-name.
      ls_db_out-value   = ls_db-value.
      ls_db_out-note    = ls_db-note.
      APPEND ls_db_out TO ls_snap-database.
    ENDSELECT.

*   the classification travels back with each method; the four facts it was
*   made from are not stored, so they are not pretended here
    SELECT * FROM zosd_amdp INTO ls_amdp ORDER BY class_name method_name.
      CLEAR ls_amdp_out.
      ls_amdp_out-clsname  = ls_amdp-class_name.
      ls_amdp_out-mtdname  = ls_amdp-method_name.
      ls_amdp_out-kind     = ls_amdp-kind.
      ls_amdp_out-portable = boolc( ls_amdp-portable = 'X' ).
      ls_amdp_out-refusal  = ls_amdp-refusal.
      ls_amdp_out-engine   = ls_amdp-engine.
      ls_amdp_out-reason   = ls_amdp-reason.
      APPEND ls_amdp_out TO ls_snap-amdp-methods.
    ENDSELECT.

    rv_json = /ui2/cl_json=>serialize( data = ls_snap ).
  ENDMETHOD.

ENDCLASS.
