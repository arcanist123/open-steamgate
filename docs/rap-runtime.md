# The managed RAP runtime (R2)

R2 of [the RAP plan](oracle-rap.md): a managed behavior definition runs. Its
behavior pool's determinations, validations and action are called, its
instances live in a transactional buffer until the save sequence writes them
into the persistent table, and the LUW ends in `COMMIT WORK` or
`ROLLBACK WORK`. Serving it over OData (R2c) is the next step and not here.

```
node tools/rap/bdef-gen.mjs                  # types, adapter, registry -> gen/rap/
npx mocha test/rap-runtime-gen.mjs           # what is generated and refused
node tools/osd-unit.mjs CLAS ZCL_OSD_RAP_TEST   # after npm run transpile
```

## Decision: handler-direct, no EML

EML (`MODIFY ENTITIES`, `READ ENTITIES`, `COMMIT ENTITIES`) is **not** in R2
and R2 needs no transpiler change. The runtime calls the pool's handler and
saver methods directly. EML comes through a transpiler patch that lowers
the statements onto `KERNEL_RAP_EML` over this runtime, R2a,
[rap-eml.md](rap-eml.md); a managed slice does not need it, because only
the runtime modifies instances.

The price is the handler's contract while there is no EML: a determination or
action cannot `READ ENTITIES` / `MODIFY ENTITIES IN LOCAL MODE`, so it gets the
instances it works on as a table parameter `entities` and changes them in
place. The runtime takes the changed fields back into the buffer, where they
trigger what depends on them. When EML arrives the handlers can be written the
SAP way and this parameter goes.

## The pieces

| Where | What |
| --- | --- |
| `src/rap/zcl_osd_rap_runtime` | the buffer, field control, numbering, triggers, save sequence (generic, by component name) |
| `src/rap/zif_osd_rap_bo` | one BDEF as the runtime sees it: model + typed calls into the pool |
| `gen/rap/zcl_rap_<hash>` | that interface, generated per managed BDEF by `tools/rap/rap-runtime-gen.mjs` |
| `gen/rap/zcl_osd_rap_registry` | BDEF name to adapter; the runtime creates it by name, so a tree without BDEFs still compiles |
| `src/rap/cl_abap_behavior_handler`, `cl_abap_behavior_saver`, `cl_abap_behv`, `if_abap_behv`, `if_abap_behv_message` | clean-room bases a pool inherits |
| `src/luw/zcl_osd_luw` | the delta (create/update/delete collapsed), reused |

The model comes from the R0 JSON (`tools/rap/bdef-parse.mjs`) and the CDS
fields R1 resolves. The adapter is generated because the pool's methods are
typed with the BDEF's derived types and only generated code knows them;
everything that can be generic is in the runtime.

## API

```abap
lo_rap = zcl_osd_rap_runtime=>for_bdef( 'ZI_RAP_NOTE' ).
lo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'C' it_rows = lt_create
                CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
lo_rap->read( EXPORTING iv_entity = 'Note' it_keys = lt_keys CHANGING ct_result = lt_rows cs_failed = ls_failed ).
lo_rap->execute( EXPORTING iv_entity = 'Note' iv_action = 'Approve' it_keys = lt_import
                 CHANGING ct_result = lt_result cs_failed = ls_failed cs_reported = ls_reported ).
lo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
lo_rap->rollback( ).
```

The tables are the BDEF's derived types (`TYPE TABLE FOR CREATE`, `UPDATE`,
`DELETE`, `READ IMPORT`/`RESULT`, `ACTION IMPORT`/`RESULT`), the responses
`TYPE RESPONSE FOR MAPPED|FAILED|REPORTED EARLY`. An entity is named by its CDS
name or its alias. `trace( )` lists what ran; `pending( )` counts the delta.

## Behavior

Following the public RAP documentation (managed implementation type, the
[implementation contract](https://help.sap.com/docs/ABAP_PLATFORM_NEW/fc4c71aa50014fd1b43721701471913d/1040b81372d44ed38b07a409fa0e1769.html),
the save sequence); nothing measured on a system.

- **%cid / %cid_ref.** A create's `%cid` comes back in MAPPED with the key; a
  later update, delete or action in the same transaction (until the next
  successful `commit`) may address the instance by `%cid_ref`. A `%cid`
  already used in the transaction, also within one request, is refused
  (FAILED, cause `conflict`), so a reference is never ambiguous.
- **Keys** are identified by a length-prefixed rendering of the key tuple, so
  a separator inside a key value cannot make two instances one.
- **%control.** A create sets the fields whose `%control` flag is on (and the
  keys); an update changes only those. Key fields are not updated.
- **Field control.** Only `readonly`, `readonly : update`, `mandatory`,
  `mandatory : create`, `numbering : managed` (and `features`, ignored) are
  accepted; any other qualifier is refused by the generator.
  `readonly` (or `readonly : update` on update) refuses a
  flagged field: FAILED with `%fail-cause = if_abap_behv=>cause-readonly`,
  REPORTED with a message and `%element`. `mandatory` (or
  `mandatory : create` on create) must be flagged and not initial on create,
  and not cleared on update. A refused row changes nothing.
- **Numbering.** `field ( numbering : managed )` on a key of type `x LENGTH 16`
  draws a UUID on create (early). An existing key is a conflict (409).
  `early numbering` / `late numbering` through the pool are refused by the
  generator.
- **Determinations on modify** run after each `modify`/`execute` request for
  the instances whose trigger it touched (`create`, `update`, or a field), each
  once per instance per request; changes they make trigger other
  determinations of the same request.
- **Save sequence** (`commit`):
  1. *finalize*: determinations on save (triggers since the last save), then
     the saver's `finalize`;
  2. *check_before_save*: validations on save, then the saver's
     `check_before_save`. A validation fails an instance by adding it to
     FAILED (and REPORTED);
  3. on any new FAILED row: the saver's `cleanup_finalize`, `ROLLBACK WORK`,
     `ev_saved = false`. Nothing is written and the buffer is **kept**, as RAP
     keeps it after a failed save, for a correction or `rollback( )`;
  4. otherwise *save*: the managed save writes the delta (insert, update,
     delete) into the persistent table, each CDS element into its column from
     the BDEF `mapping for` (else the CDS base field), MANDT set from
     `sy-mandt`. An update starts from the row in the database, so a column
     the entity does not expose keeps its value. Then `COMMIT WORK`;
  5. *cleanup*: the saver's `cleanup`; the transactional buffer is reset
     (instances and content IDs), so the next transaction reads the
     database again.
  `adjust_numbers` is not called: late numbering is not supported.
- **LUW.** The runtime ends its own LUW with `COMMIT WORK` / `ROLLBACK WORK`;
  in the gateway that is inside the dialog step's bracket
  ([luw-buffer.md](luw-buffer.md)), and an exception nobody catches is rolled
  back by `tools/osd-dialog-step.mjs` as for any request. A database write
  that fails in the save raises `ZCX_OSD_RAP` after a `ROLLBACK WORK`.
- **Locks, ETags, authorization, features** are parsed and ignored.

## Handler methods

The generator reads the pool with abaplint's parser: local classes inheriting
`CL_ABAP_BEHAVIOR_HANDLER` (one per entity) and `CL_ABAP_BEHAVIOR_SAVER` (at
most one). A handler method belongs to a determination, validation or action
whose name it has, ignoring case and underscores (`SetStatus` = `set_status`).
Its parameters are a subset of:

| Parameter | Type | Direction |
| --- | --- | --- |
| `keys` (required) | `TABLE FOR DETERMINATION` / `VALIDATION` / `ACTION IMPORT ...~Action` | IMPORTING |
| `entities` | `TABLE FOR READ RESULT` (the instances) | CHANGING (IMPORTING for a validation) |
| `result` | `TABLE FOR ACTION RESULT ...~Action` | CHANGING |
| `failed`, `reported` | `RESPONSE FOR FAILED|REPORTED EARLY` | CHANGING |

Methods may be private; the call is dynamic. Anything else is refused at
generation with the method's name. The saver's phases take no parameters in
R2 (see ANORMALIES, "RAP saver phases"): a saver can observe but not fail the
save. Messages are made with `new_message_with_text( )` (`ZCL_OSD_RAP_MESSAGE`,
an `if_abap_behv_message`).

Clean-room: the base classes and constants are reimplemented from the public
documentation; `open-abap-rap` (no licence) was read only as a signature spec.

## Not in R2

EML; serving over OData (R2c); draft; unmanaged save, `with additional save`,
`with unmanaged save`; early/late numbering through the pool and
`adjust_numbers`; associations and compositions (R1 refuses them); static,
factory and internal actions, action parameters and results other than
`$self`; functions; delete triggers; feature and authorization control; locks
and ETags; projections. Each is refused by the generator or ignored as listed
above.
