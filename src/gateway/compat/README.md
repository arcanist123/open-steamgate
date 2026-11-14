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
