"! Constants whose VALUE is another object's constant (ANORMALIES
"! intf-const-from-const). The transpiler once read them at load under the
"! wrong member name and with no load order between the interfaces.
INTERFACE zif_osd_iconst_a PUBLIC.
  CONSTANTS own TYPE string VALUE `a`.
  CONSTANTS from_chain TYPE string VALUE zif_osd_iconst_b=>chained.
  CONSTANTS from_class TYPE c LENGTH 1 VALUE zcl_osd_iconst_src=>marker.
  CONSTANTS from_component TYPE string VALUE zif_osd_iconst_c=>gs_parts-second.
  CONSTANTS: BEGIN OF gs_pair,
               base TYPE string VALUE zif_osd_iconst_c=>base,
               own  TYPE string VALUE `pair`,
             END OF gs_pair.
ENDINTERFACE.
