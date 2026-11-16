The pinned open-abap-odata (libs.lock.json) predates the /IWBEP/ members
the SEGW sample service calls (H5x-3). These contract overlays carry the
extended interfaces and the concrete classes that implement the new
members; the library input excludes exactly these objects while the overlay
is present (abap_transpile.json, the open-abap-odata lib's exclude_filter).
Remove the overlays and the exclusions when the pin carries them.

The same change sits in the `.local/lars/open-abap-odata` working tree
(branch feat/iwbep-members-h5x3) as the upstream PRs to send, one per member
group -- docs/upstream.md has the dossier:

- `#iwbep#if_mgw_req_func_import.intf` -- get_function_import_name,
  get_converted_parameters (the interface the sample's ACTION_SO_ACTIONS
  receives);
- `#iwbep#if_mgw_req_entity.intf`, `#iwbep#if_mgw_req_entityset.intf` --
  get_navigation_path on both facets, returning the technical navigation
  table (`#iwbep#t_mgw_tech_navi.ttyp`, row `#iwbep#s_mgw_tech_navi.tabl`,
  new here -- the pin has neither, so no lib copy is excluded for them),
  with the implementing classes
  (`zcl_oao_request_context`, `/iwbep/cl_mgw_request`,
  `/iwbep/cl_sb_gen_read_aftr_crt`);
- `#iwbep#if_mgw_context.intf` -- get_message_container (the runtime
  context the DPC's mo_context is typed by), served by
  `zcl_oao_context`;
- `#iwbep#if_message_container.intf` -- add_message (type, id, number,
  text, v1-v4, the documented optional parameters, response-header
  switch), implemented by
  `zcl_oao_msg_container`;
- `#iwbep#if_mgw_appl_srv_runtime.intf` -- the changeset request/response
  structures with content_id / content_id_ref, and content_id_ref on the
  operation info -- types only: nothing fills them yet.

The local implementations are this repository's own (MIT), clean-room: the
request context (`zcl_stg_request_context`) serves the getters from the
data the dispatcher fills, the runtime context serves the per-request
container, and the dispatcher resets the container per request and reads it
into the error response. They are local runtime compatibility objects and
do not travel to SAP.
- `zcl_oao_model.clas` -- the default association set: `create_association`
  with `iv_def_assoc_set = abap_true` (the interface's default) gets the set
  the Gateway builds itself, `<association>_AssocSet` cut to 40 characters,
  between the two types' first entity sets, unless the MPC created one
  (H5x-4 B4; the SEGW sample's `$metadata` had no AssociationSet at all).
- `zcl_oao_shlp_ddic.clas` + `zif_oao_shlp_source.intf` -- search helps
  whose selection is a join (milestone 3 B5.2, docs/segw-mapping.md "Text
  tables and help views"): the provider reads through a
  `zif_oao_shlp_source` that `tools/segw-shlp.mjs` generates for a table
  with a text table and for a help view, writes each selection option
  against the joined column, takes a parameter with a list position as a
  list field, and applies a literal default value to a field the request
  leaves open. One small PR to open-abap-odata after a critic pass (the interface
  with it, the generator stays here).
- `zcl_oao_property.clas`, `zcl_oao_entity_typ.clas`,
  `zcl_oao_cmplx_type.clas`, `zcl_oao_http_handler.clas` -- the
  `$metadata` annotations as a system writes them (milestone 3 B4,
  `ANOMALY-2026-11-14-textpool-absent`,
  `ANOMALY-2026-11-14-bind-structure-ddic`, docs/upstream.md items 15-16):
  bind_structure fills the property's data element, dictionary type,
  unit property and derived semantics through `ZCL_OSD_DDIC_INFO` (a
  type of the class through RTTI); the writer takes the label from the
  model's annotation, else the text pool (`ZCL_OSD_TEXTPOOL`, session
  language only), else an explicit label, else the data element's medium
  label -- never the ABAP field name; writes `sap:unicode` only from the
  model's annotation, `sap:unit` from the reference field, the label of a
  function import parameter; and no longer derives
  `sap:display-format="Date"` (the date mark `mv_is_date` stays for the V4
  facade; the SADL exposure sets the display format itself).

Milestone 4, train 1 (the contract members a second generated service and
the launchpad page services call; the names of those services stay in the
private evidence):

- model elements are items: `#iwbep#if_mgw_odata_item.intf` carries
  `set_disabled` beside `set_label_from_text_element`, and the entity set,
  the association, its set, the navigation property and the referential
  constraint include it (`#iwbep#if_mgw_odata_{entity_set,assoc,assoc_set,
  nav_prop,ref_constr}.intf`, implemented by `zcl_oao_{entity_set,
  association,assoc_set,nav_prop,ref_constraint}.clas`). A label from the
  text pool is written as `sap:label` on the EntityType, EntitySet,
  Association (after `sap:content-version`), NavigationProperty and
  FunctionImport; a disabled element is left out of `$metadata` and of the
  model info (the model's and the type's lists skip it; `get_property` and
  the getters still hand it out by name);
- `#iwbep#if_mgw_odata_entity_typ.intf`: `set_is_thing_type`
  (`sap:is-thing-type="true"`), `get_navigation_property`;
- `#iwbep#if_mgw_odata_property.intf`: `set_unit_property` (`sap:unit`; the
  dictionary's reference field no longer overrides it), `set_as_title` /
  `set_as_updated` (`m:FC_TargetPath="SyndicationTitle|SyndicationUpdated"
  m:FC_KeepInContent`, after the facets as a system writes them);
- `#iwbep#if_mgw_odata_model.intf`: `set_model_features` (kept and read
  back; the measured service's property labels stayed medium with
  `use_long_label_for_property` set, so the writer does not change them),
  `get_entity_set`, `get_association`, `get_association_set`, `get_action`;
  every getter, `get_entity_type` included, raises the med exception for a
  name the model lacks (it was an ASSERT). `create_assoc_set` on the
  association adds a set of the model's name between the ends' default
  sets; a derived default set is made once and kept, so disabling it sticks;
- `#iwbep#if_mgw_odata_action.intf`: `get_input_parameter`;
- request context: `get_source_entity_type_name` (entity and entity-set
  facets), `get_search_string`, `get_skiptoken`,
  `get_select_with_mandtry_fields` (`$select` in ABAP field names with the
  set's keys added, empty for none or `*`; type
  `#iwbep#t_mgw_tech_field_names.ttyp`, row type not measured), and
  `get_entity_type_name` on the update facet
  (`#iwbep#if_mgw_req_entity_u.intf`). `get_skiptoken` answers
  `mv_skiptoken`, which the dispatcher does not fill yet;
- exceptions (`#iwbep#cx_mgw_{base,busi,tech}_exception.clas`):
  `gcs_http_status_codes`, `http_status_code`, `message_container` and
  `get_msg_container` (the request's container unless one was given) on the
  base; `resource_not_found` (020, measured), `resource_duplicate`,
  `filter_not_supported`, `precondition_failed` and the `entity_type`,
  `filter_param` parameters on the business exception;
  `missing_authorization`, `entity_type`, `internal_service_name` on the
  technical one. The numbers of the last four text ids are not measured and
  carry 000 until they are; the dispatcher still answers every business
  exception with 400, whatever `http_status_code` says;
- message container: `reset`, `add_message_from_exception`, and the entity
  type, keys and target on `add_message_text_only` /
  `add_messages_from_bapi` (accepted, not kept, as on `add_message`).

The twin is `test/hana-m4` (`ZOSD_M4A_SRV`), the cases
`test/unit/zcl_osd_m4a_test`.
