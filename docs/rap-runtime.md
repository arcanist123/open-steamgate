# The managed RAP runtime (R2)

R2 of [the RAP plan](oracle-rap.md): a managed behavior definition runs. Its
behavior pool's determinations, validations and action are called, its
instances live in a transactional buffer until the save sequence writes them
into the persistent table, and the LUW ends in `COMMIT WORK` or
`ROLLBACK WORK`. It is served over OData V2 and V4 (reads and writes; actions over V2) from a
service definition: see [Serving (R2c)](#serving-r2c).

```
node tools/rap/bdef-gen.mjs                  # types, adapter, registry -> gen/rap/
npx mocha test/rap-runtime-gen.mjs           # what is generated and refused
node tools/osd-unit.mjs CLAS ZCL_OSD_RAP_TEST   # after npm run transpile: both pools
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

**R3: handlers in the system's form.** A pool may instead declare its
methods as on a system (`FOR DETERMINE ON MODIFY IMPORTING keys FOR
Note~SetStatus`, [rap-derived-types.md](rap-derived-types.md), "Handler
declarations"). Such a method gets the keys and the response structures and
no instances; it reads and changes them through EML. Three rules make that
work, all in `ZCL_OSD_RAP_RUNTIME`:

- **EML inside a handler reaches the calling transaction.** While a handler
  runs, the runtime is on a stack (`ZCL_OSD_RAP_RUNTIME=>ACTIVE`), and
  `ZCL_OSD_RAP_EML=>RUNTIME`, which the transpiled statements and direct
  callers go through, answers that runtime rather than the session's.
- **It acts as IN LOCAL MODE.** A modification made while a handler of the
  runtime runs may set a read-only field, and it does not start a request of
  its own: the determinations it triggers run in the loop of the request
  that called the handler (on modify) or of the save (on save), each at most
  once per instance. This is an OSG convention: `IN LOCAL MODE` itself is
  still accepted and ignored ([rap-eml.md](rap-eml.md)), so an EML call
  inside a handler is treated as local whether it says so or not.
- **No take-back.** The runtime copies changed rows back only from a handler
  with an `entities` table (`ty_callable-entities`, set by the generator); a
  handler without one has already changed the buffer, and copying its stale
  rows back would undo that.

The pinned transpiler does not lower EML statements yet, so
`src/rap_demo/zbp_rap_note_sf` writes each statement as the
`ZCL_OSD_RAP_EML` call it lowers to, with the statement in a comment above
it. `test/unit/zcl_osd_rap_test` runs the same eleven-test scenario over
both pools (`ltcl_explicit`, `ltcl_system_form`); with the stack routing
removed, nine of the system form's eleven fail.

**The flight sample's determination does not run yet.** The gate set for R3
was one determination of SAP's public flight reference scenario
([abap-platform-refscen-flight](https://github.com/SAP-samples/abap-platform-refscen-flight),
commit `5353cbeb`, managed travel) compiled and run without edits. Its
handler declarations now lower (`calculatetotalprice FOR DETERMINE ON
MODIFY`, the six `FOR VALIDATE ON SAVE`, the `FOR MODIFY ... FOR ACTION`
ones), but the business object never gets that far. What blocks it, in the
order the build meets it:

1. **The BDEF.** `bdef-gen.mjs` refuses `/DMO/I_Travel_M` at its
   composition, `association _Booking { create ( features : instance ); }`
   ("associations/functions/determine actions are outside R1"). Behind it
   in the same definition:
   `early numbering`, `factory action`, `internal action`,
   `features : instance` on actions, `with additional save`, `etag master`.
2. **The pool.** Beside the determination, the same local class declares
   `FOR INSTANCE FEATURES` and `FOR NUMBERING` methods, which the lowering
   refuses by name (no derived request/result types; early numbering).
3. **The determination's body** is one statement, `MODIFY ENTITIES ... IN
   LOCAL MODE ENTITY travel EXECUTE recalctotalprice FROM CORRESPONDING #(
   keys )`: EML, which the pinned transpiler does not lower, executing an
   `internal action` the generator refuses.

So the proof here is the demo twin; the flight determination needs
compositions in R1/R2, the two refused handler forms, and the EML pin.

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

## Serving (R2c)

```
src/rap_demo/zui_rap_note.srvd.srvdsrv     define service ZUI_RAP_NOTE { expose ZI_RAP_NOTE as Note; }
GET    /sap/opu/odata/sap/ZUI_RAP_NOTE/Note                 V2 list, through the CDS view
POST   /sap/opu/odata/sap/ZUI_RAP_NOTE/Note                 {"NoteText":"..."} -> 201, NoteId drawn, Status 'N'
PATCH  /sap/opu/odata/sap/ZUI_RAP_NOTE/Note('<32 hex>')     MERGE and PUT too -> 204
DELETE /sap/opu/odata/sap/ZUI_RAP_NOTE/Note('<32 hex>')     -> 204
POST   /sap/opu/odata/sap/ZUI_RAP_NOTE/Approve?NoteId='<32 hex>'   the action -> 200, the note
GET    /sap/opu/odata4/sap/ZUI_RAP_NOTE/Note                V4 reads of the same instances
POST   /sap/opu/odata4/sap/ZUI_RAP_NOTE/Note                V4 create -> 201, same behavior (PATCH, DELETE too)
npx mocha test/rap-serve.mjs                 # after npm run transpile
```

### Decision: the SRVD itself, read by a generator

The transpiler refuses SRVD objects (ANORMALIES `srvd-not-allowed`), which
is the same position a BDEF is in. So a service definition is treated the
same way: `\.srvd\.` joins the transpile `exclude_filter`, and
`tools/rap/srvd-gen.mjs` (run by `bdef-gen.mjs`) reads it with the BDEF
tokenizer and writes `gen/rap/<srvd>.stg.yaml`, a model `stg-compile --all`
compiles like every other service (`gen/rap` is one of its roots, beside
`gen/cds`). The other option, a YAML `rap:` source written by hand, was not
needed: the object a RAP developer writes is the one read, and the YAML stays
an internal format.

What is read: header annotations (only `@EndUserText.label` is kept, as the
description), `define service <name> { expose <CDS entity> [as <alias>]; ... }`.
Element annotations, `provider contracts`, `with`, extensions and anything
else are refused with the line. There is no service binding (SRVB): the
service is named after the definition, version 0001, and is served on both
endpoints the gateway has, V2 at `/sap/opu/odata/sap/<srvd>/` and V4 at
`/sap/opu/odata4/sap/<srvd>/`.

### The model

Per exposed entity: entity type `<alias>Type`, set `<alias>`, properties
named as the CDS source spells the elements (`NoteId`), bound to the view
through SADL (`source: {cds: ...}`). An entity of a managed BDEF gets the
set flags of its `create` / `update` / `delete`, `readonly` fields as
read-only properties (`readonly : update` as not updatable), and each
instance action a V2 function import named after the action: `POST`, its
parameters the keys, its result the entity, `sap:action-for` the entity type.
An exposed entity without a behavior is a read-only set. Every property is
labelled (the CDS label, else its name), the title a Fiori client shows.
The classes are `ZCL_<service>_MPC/_DPC(_EXT)` for a name of up to 18
characters; a longer one (at most 26) keeps 12 and adds 6 hex characters of
its hash, so two services sharing a prefix get classes of their own.

segw-gen (and its ABAP twin `ZCL_STG_SEGW_GEN`) declared the text element
container `GC_INCL_NAME` only when a property had a label, while a function
import and its parameters always name it: a model with an action and no
labelled property did not compile. Both now declare it for any of the three.

A RAW16 UUID key is served as a 32-character hex `Edm.String`
(`Note('333C0064...')`): the V2 wire has no `Edm.Guid` conversion (hyphenated
JSON, `guid'...'` keys) yet, and V4 follows V2's model.

### The path of a request

Reads are untouched: `ZCL_STG_SADL_DPC` reads the view. Writes and actions
ask first whether the entity has a behavior: `zif_stg_sadl_behavior`
(`src/sadl/`), implemented by `ZCL_OSD_RAP_SADL` (`src/rap/`), which the SADL
provider creates by name so `src/sadl/` does not depend on `src/rap/`. If it
does, the provider hands over the view's row and the names of the fields the
body gave (`zcl_stg_entry_provider->fields( )`), and `ZCL_OSD_RAP_SADL` runs
one RAP transaction:

1. the derived table (`TABLE FOR CREATE/UPDATE/DELETE`, `ACTION IMPORT`) from
   the adapter's `new_table( )`, filled by component name, `%control` set for
   every field the request gave;
2. `modify( )` or `execute( )`; a FAILED row ends here with `rollback( )`;
3. `commit( )`, the save sequence; a validation that fails ends here, and the
   runtime has already rolled the LUW back;
4. the row is read back through the view and answered.

A refusal in 2 or 3 is `/IWBEP/CX_MGW_BUSI_EXCEPTION` with the REPORTED
message texts joined by `; ` (a failure without a message is named by its
cause), which the gateway answers with 400 -- and nothing is written. A
`ZCX_OSD_RAP` (a model error, a refused database write) is a technical
exception, 500.

Two rules a client meets:

- **Read-only fields.** Sent with a value on create, or with a value other
  than the current one on update, the field is flagged and the runtime
  refuses it (`Field STATUS is read-only`, 400). Sent empty on create or
  unchanged on update it is no write and is dropped, so a client that sends
  the whole entity (PUT, or a create carrying the empty managed key) is not
  refused for it.
- **PUT replaces, PATCH and MERGE merge.** On PUT an editable field the body
  does not give is written initial (flagged in `%control`, so the mandatory
  check and the validations see it: a PUT without `NoteText` is 400 and the
  row stays), and a read-only field keeps its value; on PATCH and MERGE only
  the given fields change. `zcl_stg_entry_provider->merges( )` tells the two
  apart, and `zif_stg_sadl_behavior~update` takes `iv_replace`.
- **Keys** come from the URL on update and delete, from the function
  import's parameters for an action, and are drawn by managed numbering on
  create; the created key is taken from MAPPED.

A function import whose return set is not named (SEGW leaves it empty for an
action for an entity type) now gets the first set of its return type in the
request context, with the function's name and parameters
(`zcl_stg_request_context-mv_function_import`, `mt_parameter`): SADL's
`execute_action` is given only the context.

### V4

V4 reads (`$metadata`, the set, by key, `$filter`, `$count`) work as for any
service of the registry ([odata-v4.md](odata-v4.md)), and so do V4 writes
since the V4 write slice (#858): POST, PATCH and DELETE reach the same
provider and so the same behavior (numbering, determination, validation),
which needed no change for it (`test/rap-serve.mjs`, "reads and creates the
same instances over V4"). Bound actions (`POST .../Note('...')/ZUI_RAP_NOTE.Approve`)
are a path the V4 facade parses, but it runs only the draft actions of sticky
editing, so a BDEF action answers 501 naming the action; over V2 they work.

### Not in R2c

Service bindings, `Edm.Guid` for UUID keys, ETags and `If-Match`, V2
`$batch` changesets as one RAP transaction (each operation is its own),
deep insert through compositions, action parameters, static and factory
actions, messages as `sap-message` headers (only the error body), V4 bound
actions, a Fiori Elements app over the service.

## Not in R2

EML; draft; unmanaged save, `with additional save`,
`with unmanaged save`; early/late numbering through the pool and
`adjust_numbers`; associations and compositions (R1 refuses them); static,
factory and internal actions, action parameters and results other than
`$self`; functions; delete triggers; feature and authorization control; locks
and ETags; projections. Each is refused by the generator or ignored as listed
above.
