# Managed RAP runtime (R2, R2a, R3, R4, R5, R6, R8, R9, R10, R11)

Runs a managed behavior definition handler-direct, and the EML statements
over it:
`ZCL_OSD_RAP_RUNTIME` holds the transactional buffer (%cid, %control, field
control, managed UUID numbering, determinations on modify) and runs the save
sequence (finalize, check_before_save, save into the persistent table through
the BDEF mapping, cleanup) inside one LUW. R5: the business object as a tree
-- create and read by association, the delete that takes the children, the
root's lock (`ezosd_rap_lock` over `zosd_rap_lock`) and total change stamp
on a child write -- and projection BDEFs as a thin layer in
`zcl_osd_rap_sadl` over the registry's `projection( )`. R6: internal actions
(executed only IN LOCAL MODE by the BO's own handlers), determine actions
(their determinations on save and validations, run by the runtime) and
factory actions (the new instance in MAPPED, answered over OData).
R8: draft -- `%is_draft` in the instance identity, drafts in the draft
tables with their admin columns and `zosd_draft_adm`, the draft actions
Edit, Activate, Discard, Resume (and Prepare as a determine action), and
`zcl_osd_rap_draft`, the union of active and draft rows a draft entity
serves (through the generated `zif_stg_cds_draft_source` classes).
R9: the owner of a draft -- `INPROCESSBYUSER` is the request's user
(`src/logon`), another user's change, Activate, Discard, Resume, Prepare or
Edit of it is refused (FAILED `locked`) and the union serves a user only
their own drafts; the draft administrative data is served as an entity
by `src/rap_draftadm`.
R10: late numbering (a preliminary key and `%pid` while drafting, the
saver's `adjust_numbers` with MAPPED LATE in the save, `final_key( )` for
the answer), a projection's `use draft` (a union of its own, the base's
draft table) and its augment (`zif_osd_rap_augment`, run by `augment( )`
with the base's transaction active), on the flight's supplement and agency
BOs (`packs/rap-flight`).
R11: an interface BDEF is run on its base (`zcl_osd_rap_eml=>route`,
the registry's `projections`); a constant element (a CDS literal) is a
field every instance has (`ty_field-constant`, filled on read, a pair to it
holds for all saved instances); an entity without a table reads through
its CDS view; a root's determine action runs members of the entities below
it -- the flight's agency interface and carrier singleton.

- `zcl_osd_rap_runtime` - the runtime; `for_bdef( 'ZI_...' )` to start;
  `active( )` names the runtime whose handler runs, where EML inside a
  handler goes (R3, handlers in the system's form)
- `zcl_osd_rap_eml` - the EML statements' semantics over the session's
  runtimes (MODIFY / READ / COMMIT / ROLLBACK ENTITIES), static
- `kernel_rap_eml` - the entry the transpiler's EML lowering calls
  ([docs/rap-eml.md](../../docs/rap-eml.md)), binds what a statement
  leaves out and forwards to `zcl_osd_rap_eml`
- `zif_osd_rap_bo` - one BDEF: model and typed calls; implemented by the
  class `tools/rap/rap-runtime-gen.mjs` generates into `gen/rap/`
- `zif_osd_rap_registry` - implemented by the generated `zcl_osd_rap_registry`
- `zif_osd_rap_augment` - R10: a projection's augment, implemented by a
  class `tools/rap/rap-runtime-gen.mjs` generates per projection BDEF
- `zcl_osd_rap_sadl` - the runtime behind the SADL data provider: OData
  create, update, delete and actions of a RAP entity (R2c,
  `zif_stg_sadl_behavior` of `src/sadl/`)
- `zcl_osd_rap_draft` - R8: active and draft rows merged with their flags
- `zosd_draft_adm` - R8: the draft administrative data, one row per draft of a root
- `zcx_osd_rap`, `zcl_osd_rap_message`
- `cl_abap_behv`, `cl_abap_behavior_handler`, `cl_abap_behavior_saver`,
  `if_abap_behv`, `if_abap_behv_message` - clean-room bases and constants a
  behavior pool writes against

Uses `src/logon/` (the request's user, R9), `src/luw/` (the delta, and `ZCL_OSD_LUW_HOLD`: whether a batch holds the LUW) and the generated table classes of `gen/cds/`.
Tests: `test/unit/zcl_osd_rap_test` (ABAP Unit, over `src/rap_demo/`),
`test/unit/zcl_osd_rap_r5_test` (the tree, over `src/rap_r5/`), `test/rap-r5.mjs`,
`test/unit/zcl_osd_rap_r6_test` (the actions, over `src/rap_r6/`), `test/rap-r6.mjs`,
`test/unit/zcl_osd_rap_r8_test` (draft, over `src/rap_r8/`), `test/rap-r8.mjs`,
`test/unit/zcl_osd_rap_r9_test` (the owner), `test/rap-r9.mjs`, `test/e2e/trip4.spec.mjs`,
`packs/rap-flight` `zcl_osd_rapflight_r10_test` and `test/rap-r10.mjs` (the flight draft BOs, R10),
`zcl_osd_rapflight_r11_test` and `test/rap-r11.mjs` (the interface BDEF and the carrier singleton, R11),
`test/unit/zcl_osd_rap_eml_test` (the EML facade), `test/rap-runtime-gen.mjs`, `test/rap-serve.mjs` (the OData wire). Contract and limits:
[docs/rap-runtime.md](../../docs/rap-runtime.md).
