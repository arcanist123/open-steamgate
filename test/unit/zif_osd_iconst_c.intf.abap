INTERFACE zif_osd_iconst_c PUBLIC.
  CONSTANTS base TYPE string VALUE `c`.
  CONSTANTS: BEGIN OF gs_parts,
               first  TYPE string VALUE `one`,
               second TYPE string VALUE `two`,
             END OF gs_parts.
ENDINTERFACE.
