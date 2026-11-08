# Managed RAP runtime (R2)

Runs a managed behavior definition handler-direct, without EML:
`ZCL_OSD_RAP_RUNTIME` holds the transactional buffer (%cid, %control, field
control, managed UUID numbering, determinations on modify) and runs the save
sequence (finalize, check_before_save, save into the persistent table through
the BDEF mapping, cleanup) inside one LUW.

- `zcl_osd_rap_runtime` - the runtime; `for_bdef( 'ZI_...' )` to start
- `zif_osd_rap_bo` - one BDEF: model and typed calls; implemented by the
  class `tools/rap/rap-runtime-gen.mjs` generates into `gen/rap/`
- `zif_osd_rap_registry` - implemented by the generated `zcl_osd_rap_registry`
- `zcx_osd_rap`, `zcl_osd_rap_message`
- `cl_abap_behv`, `cl_abap_behavior_handler`, `cl_abap_behavior_saver`,
  `if_abap_behv`, `if_abap_behv_message` - clean-room bases and constants a
  behavior pool writes against

Uses `src/luw/` (the delta) and the generated table classes of `gen/cds/`.
Tests: `test/unit/zcl_osd_rap_test` (ABAP Unit, over `src/rap_demo/`),
`test/rap-runtime-gen.mjs`. Contract and limits:
[docs/rap-runtime.md](../../docs/rap-runtime.md).
