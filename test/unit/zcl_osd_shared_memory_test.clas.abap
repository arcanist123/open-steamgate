* EXPORT ... TO SHARED MEMORY / SHARED BUFFER and the IMPORT that reads it
* back (ANORMALIES, ANOMALY-2026-11-18-export-import-shared-memory). A push
* channel keeps the sessions of all its connections this way: one stateful
* handler object per socket, one cluster every handler reads and writes.
* This class is that shape -- a static method writes, another reads -- and
* its test class is the check.
CLASS zcl_osd_shared_memory_test DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_session,
             session_id TYPE c LENGTH 32,
             started_at TYPE timestampl,
           END OF ty_session.
    TYPES ty_sessions TYPE SORTED TABLE OF ty_session WITH UNIQUE KEY session_id.
    CONSTANTS c_memory_id TYPE c LENGTH 32 VALUE 'ZOSD_SHM_TEST_SESSIONS'.
    CLASS-METHODS register IMPORTING iv_session_id TYPE csequence.
    CLASS-METHODS unregister IMPORTING iv_session_id TYPE csequence.
    CLASS-METHODS sessions RETURNING VALUE(rt_sessions) TYPE ty_sessions.
    CLASS-METHODS reset.
ENDCLASS.

CLASS zcl_osd_shared_memory_test IMPLEMENTATION.

  METHOD register.
    DATA lt_sessions TYPE ty_sessions.
    DATA ls_session TYPE ty_session.
    IMPORT sessions = lt_sessions FROM SHARED MEMORY indx(zt) ID c_memory_id.
    ls_session-session_id = iv_session_id.
    GET TIME STAMP FIELD ls_session-started_at.
    INSERT ls_session INTO TABLE lt_sessions.
    EXPORT sessions = lt_sessions TO SHARED MEMORY indx(zt) ID c_memory_id.
  ENDMETHOD.

  METHOD unregister.
    DATA lt_sessions TYPE ty_sessions.
    IMPORT sessions = lt_sessions FROM SHARED MEMORY indx(zt) ID c_memory_id.
    CHECK sy-subrc = 0.
    DELETE lt_sessions WHERE session_id = iv_session_id.
    EXPORT sessions = lt_sessions TO SHARED MEMORY indx(zt) ID c_memory_id.
  ENDMETHOD.

  METHOD sessions.
    IMPORT sessions = rt_sessions FROM SHARED MEMORY indx(zt) ID c_memory_id.
  ENDMETHOD.

  METHOD reset.
    DATA lt_sessions TYPE ty_sessions.
    EXPORT sessions = lt_sessions TO SHARED MEMORY indx(zt) ID c_memory_id.
  ENDMETHOD.

ENDCLASS.
