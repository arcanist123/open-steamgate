INTERFACE zif_oao_shlp_source PUBLIC.
* The selection of a search help whose selection method is not one table:
* a table with its text table, or a help view (a join with no database
* object). A generated class answers the rows of the join, one component
* per search help field, and the column each field is read from, so the
* selection options of a request can be written against the join.
  METHODS select
    IMPORTING
      iv_where       TYPE string
      iv_langu       TYPE sy-langu
    RETURNING
      VALUE(rr_rows) TYPE REF TO data.

  METHODS column
    IMPORTING
      iv_field         TYPE csequence
    RETURNING
      VALUE(rv_column) TYPE string.
ENDINTERFACE.
