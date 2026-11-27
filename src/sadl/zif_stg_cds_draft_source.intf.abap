INTERFACE zif_stg_cds_draft_source PUBLIC.
* A CDS source that serves two versions of each instance: the active one
* and its draft (a draft-enabled RAP entity, docs/rap-runtime.md, R8). Its
* rows carry ISACTIVEENTITY, HASACTIVEENTITY and HASDRAFTENTITY ('X' or
* initial) and DRAFTUUID. The SADL data provider reads it in place of the
* view: IV_WHERE names the CDS elements only (both versions have them as
* columns); IT_FLAGS are the conditions on the three flags (property the
* field name, EQ and NE), applied to the merged rows; IV_LATEST keeps the
* draft of an instance that has one and the active instance otherwise (the
* Fiori Elements list filter IsActiveEntity eq false or
* SiblingEntity/IsActiveEntity eq null). Implemented by classes generated
* in gen/rap/; the SADL package knows only this interface.

  METHODS read_versions
    IMPORTING
      iv_where       TYPE string
      it_orderby     TYPE string_table
      it_flags       TYPE /iwbep/t_mgw_select_option OPTIONAL
      iv_latest      TYPE abap_bool DEFAULT abap_false
    RETURNING
      VALUE(rr_data) TYPE REF TO data.

ENDINTERFACE.
