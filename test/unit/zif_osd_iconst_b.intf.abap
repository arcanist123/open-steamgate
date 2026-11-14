"! The middle of a chain of three, and a constant read back from the
"! interface that reads this one: no load-time edge either way.
INTERFACE zif_osd_iconst_b PUBLIC.
  CONSTANTS chained TYPE string VALUE zif_osd_iconst_c=>base.
  CONSTANTS back TYPE string VALUE zif_osd_iconst_a=>own.
ENDINTERFACE.
