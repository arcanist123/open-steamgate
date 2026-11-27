# The managed RAP runtime (R2 .. R11)

R2 of [the RAP plan](oracle-rap.md): a managed behavior definition runs. Its
behavior pool's determinations, validations and action are called, its
instances live in a transactional buffer until the save sequence writes them
into the persistent table, and the LUW ends in `COMMIT WORK` or
`ROLLBACK WORK`. It is served over OData V2 and V4 (reads, writes and actions) from a
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
| `src/luw/zcl_osd_luw_hold` | whether an enclosing changeset or V4 group holds the LUW (set by both batches, read by the SADL bridge) |

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
  `early numbering` draws the key in the pool's `FOR NUMBERING` method (R4,
  below); `late numbering` is refused by the generator.
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
  `commit( iv_end_luw = abap_false )` saves without ending the LUW: inside
  a `$batch` changeset (V2) or atomicity group / change set (V4) the batch
  holds the LUW (`ZCL_OSD_LUW_HOLD=>HELD`), `ZCL_OSD_RAP_SADL` passes that
  on, and the batch commits or rolls back the RAP save with the group, so
  a later failing member undoes a create, update, delete or action that
  had already run (`test/rap-serve.mjs`). Each operation is still its own
  save sequence (validations run per operation, not once at the end).
- **Authorization** is parsed and ignored; ETags, instance features and
  early numbering are R4, locks (`lock master` / `lock dependent`) R5
  (below).

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
its hash, so two services sharing a prefix get classes of their own. A
namespaced service keeps its namespace in front of the classes
(`/DMO/CL_<name>_MPC`, the shape stg-compile's own `cls` gives a project
that names no classes): the namespace and `CL_` cost 8 of the 30
characters instead of `ZCL_`'s 4, so 14 of the name, or 8 plus the hash.
The file the generator reads is abapGit's `#ns#name.srvd.srvdsrv`; the
stem is decoded before it is compared with the service the text defines.

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
same instances over V4"). A BDEF action is a V4 bound action
(`<Action Name="Approve" IsBound="true" EntitySetPath="_it">`):
`POST .../Note('<32 hex>')/ZUI_RAP_NOTE.Approve` with `{}` (or no body) runs
it through the behavior as the V2 function import does -- `ZCL_OSD_V4_ACTION`
hands SADL's `execute_action` the context of a function import
(`mv_function_import`, `mt_parameter`, the set of the action's type), and
`ZCL_OSD_RAP_SADL` runs one RAP transaction with the action's `FOR MODIFY
... FOR ACTION` handler -- and answers 200 with the entity
(`$metadata#Note/$entity`). The V4 rules of a bound action apply
([odata-v4.md](odata-v4.md)): a key nobody has is 404 before the behavior
runs, the key and body parameters go through the MaxLength check (400), the
entity lock is taken (409), and `If-Match` is checked as for a PATCH: 412 on
a mismatch, 428 without it when the entity type has an ETag. `NoteType` has
none (its BDEF declares no `etag master`), so the demo needs no
`If-Match` and a tag it sends is 412; the trip demo of R4 has one. An action the BDEF does not declare is
no operation of the service (404, `Unknown operation`); a refusal of the
behavior (FAILED, a validation) is 400 as over V2 (`test/rap-serve.mjs`).

### R10: the flight's draft BOs -- use draft, augment, late numbering

After R9 the supplement and agency business objects of the flight reference
scenario (`/DMO/I_SUPPLEMENT` with its projection `/DMO/C_SUPPLEMENT`,
`/DMO/R_AGENCYTP` with `/DMO/C_AGENCYTP`) stop at four walls
(`node tools/rap-flight/constructs.mjs`): a projection's `use draft` and its
`use action Edit` ... `Prepare`; a projection's `field ( modify )` and its
own pool (`use create ( augment )`); response aliases that are namespaced
(`/DMO/Agency`, `reported-/dmo/agency`); and `late numbering`
(`adjust_numbers`, `%pid`). Behind those: path elements in the projection
views (`_SupplementText.Description as SupplementDescription : localized`),
`draft table ... query`, `extensible`. R10 is the design of all of them and
their slice, proven on the flight BOs themselves: create a draft, edit it,
activate it, discard it, with their determinations, validations and early
or late numbering, over OData V4 (and V2 data requests).

Nothing in this section was measured on a system. Where the public RAP
documentation (the BDEF reference's "use draft", "augment", "field (
modify )", "late numbering", the ABAP keyword documentation of `%pid`,
`%tmp`, `%pre` and `adjust_numbers`) states a rule, the runtime follows it;
where it does not, the choice is named and marked **unmeasured**.

### Path elements

A CDS element `_A._B.Element as X [: localized]` reads `Element` of the
view at the end of the to-one path. No column of the view's table holds it,
so `tools/cds2ddic.mjs` makes it a **calculated element**: a component of the
row (`ty_row`) that a generated class, `ZCL_STG_CDS_<view>_P`
(`if_sadl_exit_calc_element_read`), fills after the read, exactly the way a
virtual element is filled. `tools/cds-tree.mjs` (`resolvePaths`) walks the
hops once every view is parsed: per hop the association (the view's own, or
for a hop the view does not expose, the association of the view it projects
or selects from, its pair sources renamed through the view), the target
view, the pairs; `localized` -- and a filter `[1: Language =
$session.system_language]` -- adds the target's language key
(`@Semantics.language`) compared with the logon language. The element it
ends in gives the type. A path that does not resolve (a hop into a released
view this tree has only as a table stand-in, `I_Country`, `I_Currency`) is
not served and the build says which hop broke -- what happened to every
path element before R10, silently.

A draft row (`ISACTIVEENTITY` initial) reads the first hop of its path from
the target's **draft table** when the target is an entity of a
draft-enabled BO (`ZCL_STG_CDS_PATH`, asking `ZCL_OSD_RAP_DRAFT`): the
supplement draft's `SupplementDescription` is its draft text.

### `use draft` and the draft actions of a projection

A projection BDEF with `use draft` serves its base's drafts: the base must
be draft-enabled, and a projection of a draft-enabled base must say `use
draft` (both refused otherwise). `use action Edit` ... `Prepare` expose the
base's draft actions, which run on the base as every used action does (R5).
The projection entity gets a **union class of its own**
(`zcl_rap_<projection>_d<n>`): the active rows from its view and the drafts
from its **base's** draft table, whose columns are the base's element names;
a projection that renames an element is therefore refused for draft (no
flight projection does). Its calculated elements are components of the
union's row, filled by the path class after the read. Over OData the
projection's entity type gets `IsActiveEntity`, the flags, `SiblingEntity`
and `DraftAdministrativeData` exactly as a base's (R8, R9), and its root set
is the `Common.DraftRoot`. The SADL bridge maps a projection row onto its
base's union row, so `IsActiveEntity` reaches the base's methods and
answers come back with it.

### `field ( modify )` and augment

`field ( modify ) SupplementDescription` makes a calculated element of the
projection changeable: the base cannot write it (it is the text child's
`Description`), so the projection's own pool does, through `use create (
augment )` / `use update ( augment )`. Rules here:

- `field ( modify )` names a calculated element of the projection (one with
  no base element); on a base element it is refused (it is changed through
  the base). Without an augment it is refused.
- The projection's pool may contain an augment only (`precheck` stays
  refused). Its FOR MODIFY method takes `FOR CREATE` / `FOR UPDATE` of the
  projection entity, typed by the projection's derived types; a generated
  class (`ZIF_OSD_RAP_AUGMENT`) calls it.
- Order -- **a deviation**: on a system the augment's requests are merged
  into the request before the base handler runs, and an instance the
  augment fails is taken out before the base processes it; `RELATING TO`
  maps later failures of the augmenting requests back to the original rows
  (SAP's documentation of operation augmentation). Here the base operation
  runs first (the created instance is in the buffer under its `%cid`), then
  the augment with the original rows -- `%cid`, `%is_draft`, the
  projection's fields and `%control` -- while the base's transaction is
  active (`ZCL_OSD_RAP_RUNTIME=>AUGMENT`), so its `MODIFY AUGMENTING
  ENTITIES` (lowered by hand to the `ZCL_OSD_RAP_EML` calls in the overlay)
  lands in the same transaction and is saved with it. A `%cid_ref` to the
  created supplement resolves. Consequences: a create whose mandatory field
  only the augment would supply is refused before the augment runs; a
  failed augment fails the whole request (all or nothing), and its REPORTED
  messages are the answer's text, not mapped to rows.

### Namespaced aliases

`define behavior for /DMO/R_AgencyTP alias /DMO/Agency`: the response
components are `mapped-/dmo/agency`, `failed-/dmo/agency`,
`reported-/dmo/agency`, the entity is `ENTITY /dmo/agency` in EML and the
validations are `/DMO/validateName`. A namespaced name is an ABAP
identifier (the transpiler writes such a component as `["/dmo/agency"]`,
measured with a probe), so the generators accept it wherever they accepted
an alias.

### Late numbering

`late numbering` draws the key in the save, in the saver's
`adjust_numbers`, after every check has passed -- no gaps in a number range
for a request that fails. The public contract: in the interaction phase an
instance is identified by `%pid` (and `%tmp`, a preliminary key) in `%pky`;
`adjust_numbers` gets `MAPPED LATE`, per instance `%pre` (`%pid`, `%tmp`)
and `%key`, and fills `%key`.

- **Types.** `%pid` (RAW 16) is part of `%pky` of a late-numbered entity
  (R1 already). `TYPE STRUCTURE / TABLE FOR MAPPED LATE` of such an entity
  is `%pre` (`%pid`, `%tmp` -- the key structure) and `%key`; `RESPONSE FOR
  MAPPED LATE` of the BDEF has that row type for its late entities.
- **The saver.** `METHODS adjust_numbers REDEFINITION.` is lowered like
  `save_modified` (R7) to `CHANGING mapped TYPE RESPONSE FOR MAPPED LATE
  reported TYPE RESPONSE FOR REPORTED LATE`; the clean-room base declares it
  for the static check only. The runtime calls each saver that redefines it.
- **The preliminary key (unmeasured).** A created instance of a
  late-numbered entity gets a `%pid` (a UUID) and a **preliminary key**
  from a reserved range, the top 1000 values of the key's type counting
  down (`999999`, `999998`, ... `999000` for the agency's NUMC 6), skipping
  every key an active instance, a draft or the buffer has. On a system the key fields may stay initial and
  `%pid` alone names the instance in the interaction phase; here a key is
  what the buffer and OData address, so one is given. It is what
  `adjust_numbers` sees in `%tmp`; `%key` arrives initial.
- **The final key is checked** (the #917 critic's collision: two drafts at
  the top of a range, a final key landing on a live preliminary one and an
  Activate silently replacing another agency). A row of MAPPED LATE is the
  instance its `%pid` names, in any order; a missing, extra or duplicated
  row, a final key in the reserved range, or one an active instance already
  has (saved or in this transaction) fails the save -- it writes nothing.
  The overlay's `adjust_numbers` draws below the reserved range and skips
  any ID an agency or a draft has; an exhausted range leaves the key initial
  and the save fails (a system's `RAISE SHORTDUMP`).
- **Draft vs active.** A draft of a late-numbered entity keeps its
  preliminary key for its whole life (on a system: the draft table's key is
  the key plus `DRAFTUUID`, the draft's `%pid`). Activate creates the
  active instance under that key, and the save's `adjust_numbers` draws the
  final one; the draft is deleted with it. An Edit of an existing active
  instance makes a draft under the final key (it has one), and its
  Activate updates -- no numbering.
- **After the save.** The runtime writes the final key into the instance
  before the managed write and keeps the pairs (preliminary, final) of the
  last save (`ZCL_OSD_RAP_RUNTIME=>FINAL_KEY`); the SADL bridge answers a
  create and an Activate with the final key, so sap.fe navigates to the
  saved agency. EML `CONVERT KEY` is not built: an EML caller reads the
  final key from the database after `COMMIT ENTITIES`.
- Late numbering of an entity with composition children (whose foreign
  keys would have to move with it) or of a child, and of a key of more than
  one field, is refused (no flight BO has one).

### Smaller walls

- `draft table t query v`: the query view (`/DMO/R_AgencyDraft`) reads the
  draft table with extension fields; this runtime reads the draft table
  itself, so the query is accepted and not used.
- `extensible` (header block, entity, mapping, determine action): the BO
  is open to extensions; nothing here extends it, so it changes nothing.
- `mapping for t corresponding`: the elements not listed map by name (R7
  already); `with additional save` inside the `extensible { }` block is an
  extension point, not the BO's save.
- A RAWSTRING element (`Attachment`) is `Edm.Binary` in the service.

### The overlay

The flight pack fetches the four BDEFs, the two service definitions
(`/DMO/UI_SUPPLEMENT`, `/DMO/UI_AGENCY`) and the two projection views, and
carries the three pools in its overlay (each change marked `OSD overlay`,
listed in [rap-flight-pack.md](rap-flight-pack.md)): the number ranges
(`cl_numberrange_runtime`) replaced by the highest saved ID + 1, the EML
the pinned transpiler does not lower written as the calls it stands for,
`DISCARDING DUPLICATES` and the secondary keys `draft` / `cid` spelled out,
and an `I_Country` stand-in table the agency's validation reads, filled by
the seed class from the generated agencies and customers.

### Built and proven

- **Generators.** `tools/cds-path.mjs` (path elements, their class),
  `bdef-gen.mjs` (namespaced identifiers, `use draft`, `field ( modify )`,
  augment, `draft table ... query`, MAPPED LATE / `%pre` / `%tmp`),
  `rap-runtime-gen.mjs` (late numbering, `extensible`, a projection's union
  and augment class, the registry's `modify` / `union` / `augment`),
  `lower-derived.mjs` (`adjust_numbers REDEFINITION`), `srvd-gen.mjs` (a
  draft projection's service, `Edm.Binary`).
- **Runtime.** `ZCL_OSD_RAP_RUNTIME`: `late_key`, `late_numbers` (the
  savers' `adjust_numbers` between check_before_save and save), `final_key`,
  `augment`; `ZCL_OSD_RAP_SADL`: a projection over a draft base (its union,
  the version carried to the base), the augment of create and update, the
  final key in a create's and an Activate's answer; `ZCL_STG_CDS_PATH`.
- **One runtime defect met on the way** (ANORMALIES
  `ANOMALY-2026-11-11-update-include-group`): the runtime's `UPDATE dbtab
  FROM TABLE` of a table with a named include (every flight draft table)
  answers 4; the generated table class writes `UPDATE ... SET` over its
  columns, each named, instead (a real UPDATE: triggers and foreign keys see
  one).
- **Tests.** `ZCL_OSD_RAPFLIGHT_R10_TEST` (8, on the flight BOs): the
  supplement's numbering by category, Prepare and Activate, a validation
  stopping Activate with the draft kept, Edit + change + Discard; the
  agency's preliminary key, Activate drawing the final key, a refused
  Activate numbering nothing, an active create numbered late.
  `test/rap-r10.mjs` (12): the generated types, lowering, model, union,
  augment and service; over V4 the supplement draft created with its
  description through the augment, changed, prepared and activated (the
  text activated with it), a refused Activate and Discard, Edit + change +
  Discard with the list filter, V2 reads, an agency draft activated to its
  final key, a refused agency. `test/cds-path.mjs` (3).

### The measurement: the flight BDEFs before and after

`node tools/rap-flight/constructs.mjs`, first wall per behavior definition:

| BDEF | after R9 | after R10 |
| --- | --- | --- |
| `/DMO/I_SUPPLEMENT` | accepted (not built or served) | **runs** (built, served through its projection) |
| `/DMO/C_SUPPLEMENT` | a projection's `field ( modify )`, then `use draft` | **runs**, served as `/DMO/UI_SUPPLEMENT` |
| `/DMO/R_AGENCYTP` | namespaced response aliases, then late numbering | **runs** |
| `/DMO/C_AGENCYTP` | the base's wall | **runs**, served as `/DMO/UI_AGENCY` |
| `/DMO/I_AGENCYTP` | interface BDEF | unchanged |
| carrier singleton x2 | unparsed singleton grammar | unchanged |
| `/DMO/I_TRAVEL_M` and its 2 projections | accepted | accepted |

Constructs whose verdict changed: `use draft` (3), `late numbering`,
`saver adjust_numbers`: refused -> runs; new in the table: `use action
(draft)`, `field ( modify )`, `use create/update ( augment )`, `FOR MODIFY
augment`, `namespaced alias` (runs), `draft table query`, `extensible`
(ignored). Refusals over the ten BDEFs: 12 rows before, 4 after (the
singleton grammar and the interface BDEF).

### Unmeasured

Nothing of R10 was checked on a system. In particular: the preliminary
key of a late-numbered draft (a system may keep the key initial and name
the draft by `%pid` / `DRAFTUUID`; what its V4 key then is); the order of
an augment and the base operation, and the messages of a failing augment
(`RELATING TO` is not run); what a supplement's or agency's V4 `$metadata`
on a system says (`Core.Computed`, value helps, the text and the
attachment); the number ranges (here the highest saved ID + 1).

### Not in R10

- `I_Country` / `I_Currency` are table stand-ins, so `CountryName` and the
  value helps' texts through them are not served; value helps of the
  projections (`@Consumption.valueHelpDefinition`) and metadata extensions
  (`.ddlx`) are not read.
- The interface BDEF `/DMO/I_AGENCYTP`, the carrier singleton, `with
  collaborative draft`, precheck, EML `CONVERT KEY`.
- Late numbering of a child or of an entity with children; a projection of
  a draft BO that renames an element.
- A Fiori Elements app over the two services (sap.fe's requests are the
  ones R9 serves; not run against these services).

### R11: the carrier singleton and the agency's interface BDEF -- all ten flight BDEFs run

After R10 two of the ten behavior definitions of the flight reference
scenario still stop (`node tools/rap-flight/constructs.mjs`): the carrier
singleton -- `/DMO/I_CarriersLockSingleton_S` and its projection
`/DMO/C_CarriersLockSingleton_S`, the "multi-inline edit" a business
configuration maintenance object is generated as -- at unparsed grammar,
and `/DMO/I_AgencyTP`, an interface BDEF. R11 is the design of both and of
what stands behind their first walls, proven on the flight BOs themselves:
the singleton edited as one draft over OData V4, its carriers changed,
created and deleted below it and activated together; the interface BO used
through EML.

Measured first, by building each BDEF as far as it goes, wall after wall:

| BDEF | what stops it, in the order the build meets it |
| --- | --- |
| `/DMO/I_AgencyTP` | `interface;` refused by name |
| carrier singleton | the pragma `##DRAFT_OP_NOT_REQUIRED` in the root's header (the "unparsed grammar"); then the root view, a `left outer join` on `0 = 0` with `max( )` and the literal key `1` (no generated view: joins refused); `1 as CarrierSingletonID` in the carrier view, dropped silently (no column); the root's Prepare naming `Carrier~validateName` (another entity's validation); an unmanaged save with neither table nor mapping; the pool's EML |

Nothing in this section was measured on a system; where the public RAP and
CDS documentation states a rule the runtime follows it, and a choice it
does not state is named **unmeasured**.

### Interface BDEFs

`interface; use draft; define behavior for /DMO/I_AgencyTP alias
/DMO/Agency { use create; use update; use delete; use action Edit; ... }`
over a view `provider contract transactional_interface as projection on
/DMO/R_AgencyTP` is the stable layer of a BO that other BOs and consumers
use: no behavior of its own, no service. Here it is **a projection without
a service**: `bdef-gen.mjs` checks and types it exactly as a projection BDEF
(R5, R10: every `use` must be declared by the base, `use draft` over a
draft base, no pool of its own -- refused if it names one) and the registry
answers its entities as projection entities. Its derived types are its
own (`TYPE TABLE FOR CREATE /dmo/i_agencytp`), with one change that holds
for every projection: an entity whose base is late-numbered carries `%pid`
in `%pky`, so a consumer of the interface gets the instance's `%pid` in
MAPPED.

**EML over it runs on the base.** `MODIFY ENTITIES OF /dmo/i_agencytp`,
`READ ENTITIES OF`, `COMMIT ENTITIES RESPONSE OF` go through
`ZCL_OSD_RAP_EML=>ROUTE`: a BDEF with an adapter of its own is used as it
is; one the registry knows as a projection (`ZIF_OSD_RAP_REGISTRY=>
PROJECTIONS`) runs in its **base's** session -- the same transactional
buffer, one save -- with the base entity, after the statement is checked
against the interface's `use`s (an operation, action or association it does
not use is refused by name). The rows and responses pass by component
name, so routing is refused rather than mapped wrongly where names differ:
a projection that renames an element (the managed travel's processor
projection), whose response alias is not its base's, or that has an augment
(the supplement's projection; EML here does not call a projection's pool).
`/DMO/I_AgencyTP` renames nothing and keeps `/DMO/Agency`, so it routes.
**Unmeasured**: what a system answers for EML on a projection that
renames, and whether the interface's own (empty) authorization layer would
change a message.

### The singleton root

```
define root view entity /DMO/I_CarriersLockSingleton_S
  as select from I_Language
    left outer join /dmo/carrier as carr on 0 = 0
  composition [0..*] of /DMO/I_Carrier_S as _Airline
{ key 1 as CarrierSingletonID, max (carr.last_changed_at) as LastChangedAtMax, _Airline }
where I_Language.Language = $session.system_language
```

One row: the logon language's row of `I_Language` (a system has one for
every logon language), joined to every carrier on a condition that always
holds, aggregated without GROUP BY. Its key is a literal; its other
element is the latest change of any carrier, which is the BO's `total
etag`. No SQL view of this runtime can carry it (no join with an
aggregate, no literal column), and none is generated: `tools/cds-computed.mjs`
recognises **this shape and only this one** -- one `left outer join T as t
on <n> = <n>`, a WHERE (if any) `<source>.<f> = $session.system_language`,
no GROUP BY, elements that are literals, `max | min | sum | count` over a
column of `T`, and associations -- and writes its source class
(`ZIF_STG_CDS_SOURCE`) as a **computed view**: each read answers the one
row, the literals and one Open SQL `SELECT MAX( last_changed_at ) FROM
/dmo/carrier`. `I_Language` itself is not read (it is a released view this
tree does not have); the row exists for the logon language by definition.
A condition on the root is decided before the read (below); one on the
aggregate is refused. A projection of it (`/DMO/C_CarriersLockSingleton_S`)
is computed the same way under its own element names.

The root has no table: `with unmanaged save`, no `persistent table`, no
`mapping for`. R7 refused that ("reading through the CDS view is outside
R7"); since R11 such an entity **reads its saved instance through its CDS
view's source class**, columns named as the elements, and writes nothing
(its saver's `save_modified` is empty upstream). Its draft table
`/dmo/d_carr_lock` holds the root's draft.

### Constant elements

`1 as CarrierSingletonID` in `/DMO/I_Carrier_S` (and the key of the root)
is a **constant element**: every row has it, no column holds it. Before R11
`cds2ddic.mjs` dropped such an element without a word (a literal is no
column name). Now:

- **Its type is the system's**: an integer literal is the smallest integer
  type that holds it (`1` is INT1 -- the flight's draft tables say so,
  `CARRIERSINGLETONID INT1`), a string literal CHAR of its length. Over
  OData INT1 is `Edm.Byte`.
- **The generated SQL view leaves it out**; the view's source class fills it
  into every row after the read, and decides a condition on it before the
  SELECT (`ZCL_STG_CDS_CONST=>DECIDE`): a conjunct `NAME = <literal>` at the
  top level is dropped when it holds and makes the answer empty when it does
  not; a constant named in any other way (inside OR, another operator) is
  refused, not sent to a SELECT whose view has no such column. That is what
  a navigation from the root to its carriers writes (`CARRIERSINGLETONID =
  '1'`), and what the RAP runtime writes for the root's key.
- **The RAP model knows it** (`ZIF_OSD_RAP_BO=>TY_FIELD-CONSTANT`): an
  active instance read from its table gets it; a pair of an association
  whose target is a constant holds for all saved instances or for none, so
  the root's `_Airline` reaches every carrier; a draft row has it in its
  draft table's column like any element.
- **A draft entity's union reads its active rows through the source class**
  when its view has a constant or is computed, so both rules apply there
  too; a projection of a view with a constant inherits the constant.

### A root's Prepare runs the validations of the entities below it

`draft determine action Prepare { validation Carrier~validateName;
validation Carrier~validateCurrencyCode; }` on the root names the
validations of the child entity. R6 refused a member of another entity;
since R11 a determine action **of a root** may name a validation or
determination of any entity of the BDEF (`ty_member-entity`), and it runs
for that entity's instances in the tree below each instance the action is
executed for (the draft tree R8 builds for Activate). A child's determine
action naming another entity's member stays refused. The singleton's
Prepare therefore checks every carrier draft; Activate runs the carriers'
validations on save as before (they are triggered by the changed fields).

### Edit, Activate and Discard of the singleton

Nothing new in the draft protocol (R8, R9): Edit on the active root drafts
the root and, through the composition, every carrier (the constant pair
holds for all of them); a carrier draft is changed with PATCH, created
through `_Airline` of the root's draft, deleted with DELETE (its `delete (
features : instance )` asks the pool, which disables it for a carrier with
a connection); Activate writes the changed, created and deleted carriers to
`/dmo/carrier` through the managed save and calls the root's empty
`save_modified`; Discard removes the root's draft and every carrier draft.
The root's lock is the BO's lock: one editor of all carriers at a time,
which is what the singleton is for. **Unmeasured**: the root's `total etag`
after an Activate (here the root's next read computes the new maximum; a
system's ETag handling of a computed root may differ), and
`Activate optimized`, which is accepted and runs as Activate.

### One defect met on the way: a handler's keys had no `%is_draft`

The generated adapter built the keys it hands a validation, determination
or `FOR INSTANCE FEATURES` method from the instances' key fields only, so a
handler's `READ ENTITIES ... WITH CORRESPONDING #( keys )` of a **draft**
read the active instance (or nothing, for a new draft). The flight's draft
validations in Prepare (R8, R10) therefore checked the wrong version and
passed; the carrier singleton's tests showed it (a draft carrier without a
name passed Prepare, the delete of a carrier in use was enabled). The keys
carry `%is_draft` (and `%pid` of a late-numbered entity) now; R8, R9 and
R10's tests stay green.

### Two wire defects met on the way

- **A namespaced service's navigation and `$expand` over V4** answered
  "Not a V4 service path": the provider builds a path of its own for the
  source of a navigation and for each expanded target, and wrote the
  service name unescaped (`/sap/opu/odata4/sap//DMO/UI_CARRIERS_S/...`),
  whose slashes end the name at `/DMO`. It is escaped as it came in now
  (`ZCL_OSD_V4_HTTP`); the R10 services had never been navigated.
- **Discard of a draft root without `delete`**: sap.fe discards a draft
  with DELETE on it, and the singleton's root has no delete. A draft
  root's entity set takes DELETE (`srvd-gen.mjs`), the SADL bridge lets a
  projection's draft DELETE through as the used Discard, and the active
  root's DELETE is still refused by the runtime ("has no delete", 4xx).
  **Not in R11**: `Capabilities.DeleteRestrictions` saying so in
  `$metadata`, which sap.fe would read to hide Delete on the active root.

### The pragma

`##DRAFT_OP_NOT_REQUIRED` after the root's header silences the system's
syntax check message that a draft root without `create`, `update` and
`delete` lacks the draft operations; `bdef-parse.mjs` keeps an entity
header's pragmas (`pragmas`) and they change nothing.

### Built and proven

- **Generators.** `tools/cds-computed.mjs` (new: constant elements, the
  singleton root and its source class), `cds2ddic.mjs` (uses it; a
  projection of a constant or of a computed view), `bdef-parse.mjs` (header
  pragmas), `bdef-gen.mjs` (interface BDEFs as projections, `%pid` in a late
  base's projection types, a root's determine action over the entities
  below it), `rap-runtime-gen.mjs` (an unmanaged save read through its view,
  `ls_field-constant`, `ls_member-entity`, a union read through the source
  class, the registry's `projections`, the handler keys' `%is_draft` and
  `%pid`), `srvd-gen.mjs` (`Edm.Byte`, `Edm.Int16`, association names cut
  to 40 characters); `tools/cds-table.mjs` holds the table classes,
  moved out of `cds2ddic.mjs` as they were (its size budget).
- **Runtime.** `ZCL_STG_CDS_CONST` (new, with its unit test);
  `ZCL_OSD_RAP_RUNTIME` (`fill_constants`, the constant pair, members of
  another entity in `determine_action`); `ZCL_OSD_RAP_EML=>ROUTE`;
  `ZIF_OSD_RAP_REGISTRY=>PROJECTIONS`; the SADL data provider leaves a
  constant element to the read (no calculating class, not refused in a
  condition).
- **Pack.** The four BDEFs, the four views and `/DMO/UI_CARRIERS_S` are
  fetched; the singleton's pool `/dmo/bp_i_carrierslocksingle_s` is in the
  overlay (EML targets declared, `DISCARDING DUPLICATES MAPPING ... EXCEPT
  *` a loop, the test classes dropped; [rap-flight-pack.md](rap-flight-pack.md)).
- **Tests.** `ZCL_OSD_RAPFLIGHT_R11_TEST` -- the interface (4): a draft
  through the interface activated to its final key, update and delete, one
  transaction with the base, the routing refusals; the singleton (6): the
  computed root, Edit drafting every carrier, a change activated, a carrier
  created and deleted below the draft, Prepare running `Carrier~validateName`
  and the refused Activate, the disabled delete of a carrier in use.
  `test/rap-r11.mjs`: the pragma and the literal types, the generated
  interface and singleton, and over V4 the root and its carriers, Edit +
  change + create + Prepare + Activate (and back), a refused Activate and
  Discard. `ZCL_STG_CDS_CONST`'s own unit test.

### The measurement: the flight BDEFs before and after

`node tools/rap-flight/constructs.mjs`, first wall per behavior definition:

| BDEF | after R10 | after R11 |
| --- | --- | --- |
| `/DMO/I_AgencyTP` | interface BDEF | **runs** (on its base, through EML) |
| `/DMO/I_CarriersLockSingleton_S` | unparsed grammar | **runs** |
| `/DMO/C_CarriersLockSingleton_S` | its base's grammar | **runs**, served as `/DMO/UI_CARRIERS_S` |
| the other seven | runs / accepted | unchanged |

All ten BDEFs of the scenario run. Constructs whose verdict changed:
`interface` refused -> runs, `unparsed grammar` (the pragma) gone; new in
the table: `pragma` (ignored), `root determine action over a child`
(runs), `use draft` of the interface. Refused construct rows over the ten
BDEFs: 4 before, 0 after.

### Unmeasured

The root's ETag after Activate; EML on a projection that renames; whether
a system keeps the literal's INT1 in a service's `$metadata` (`Edm.Byte`
here, from the draft tables' INT1); the order in which a root's Prepare
runs the members of different entities (here: the action's entity, then
each other entity, in the order declared).

### Not in R11

- Joins in general: only the singleton root's shape is computed; any other
  join stays refused.
- EML on a projection that renames an element or has an augment.
- A Fiori Elements app over `/DMO/UI_CARRIERS_S` (its requests are the
  ones R9 serves; not run against this service).
- `I_Language`, `I_Currency` and `I_CurrencyStdVH` as views (the currency
  value help of the carrier projection is not served).

## Not in R2c

Service bindings, `Edm.Guid` for UUID keys, a
`$batch` changeset as one RAP transaction (each operation is its own save
sequence, committed or rolled back with the changeset),
deep insert through compositions, action parameters, static and factory
actions, messages as `sap-message` headers (only the error body), a Fiori
Elements app over the service.

## R4: the flight constructs that need no composition

R4's goal was the managed business objects of the flight reference
scenario (`packs/rap-flight`) served end to end like the note demo. It is
not reached, and the measurement says why before anything was built:
`node tools/rap-flight/constructs.mjs` lists, per behavior definition of
the scenario, every construct it and its pools use and what this tree does
with it (runs, ignored, refused), and the first refusal of the generators.
Every one of the ten BDEFs of the managed scenario and the reuse layer is
still refused at its first wall after R4 -- projection `use` (5),
compositions / associations (`/DMO/I_TRAVEL_M`, `/DMO/I_SUPPLEMENT`,
`/DMO/R_AGENCYTP` at a determine action), an interface BDEF, unparsed
singleton grammar -- and behind those walls draft (7 of 10).

What R4 makes run are the constructs those BDEFs use that need no
composition, in the order of how many BDEFs each unblocks, on the trip
demo of [`src/rap_r4`](../src/rap_r4/README.md) (`ZI_RAP_TRIP`, service
`ZUI_RAP_TRIP`, `test/rap-r4.mjs`):

| construct | flight BDEFs | before | after |
| --- | ---: | --- | --- |
| `etag master <field>` | 4 | parsed, ignored | the entity type's ETag (`etag: true` on the property, `set_as_etag`): V2 and V4 answer it, a PATCH, PUT, DELETE or V4 bound action without `If-Match` is 428, with a stale one 412 |
| `@Semantics` administrative fields | (all 4 above) | not filled | stamped by the runtime: `createdAt` / `createdBy` on create, `lastChangedAt` / `localInstanceLastChangedAt` / `lastChangedBy` / `localInstanceLastChangedBy` on create and change |
| `FOR INSTANCE FEATURES` with `update / delete / action ( features : instance )` | 2 | the method refused, the options ignored | an update, delete or action asks the method for the instance and is refused when it answers `if_abap_behv=>fc-o-disabled` |
| `early numbering` with `FOR NUMBERING ... FOR CREATE ent` | 2 | refused | the method draws the keys of a create before the instances enter the buffer |
| `association _x { create ( features : instance ); }` | 1 | refused | refused: it controls a create by association, which needs compositions (below) |

**ETag.** `srvd-gen.mjs` marks the `etag master` element `etag: true`, so
the generated MPC calls `set_as_etag` and the gateway's existing ETag path
(V2 dispatcher, V4 facade, the bound-action check of #901) does the rest:
`W/"<value>"`, 428 without `If-Match`, 412 on a mismatch. A RAP action
served as a V2 function import is guarded the same way, alone or as a
changeset member: the SADL provider says the import is an action of a
behavior (`ZIF_STG_ACTION_GUARD`), and the dispatcher checks `If-Match`
against the instance its key parameters name before the action runs. A
function import of any other provider is not checked, as before (a V2
function import is not ETag-checked by the Gateway on a system). A field nobody
writes would make a constant ETag, so the runtime fills the administrative
fields itself, as the managed framework does on a system: the element's
`@Semantics` annotation names the field, the time is `GET TIME STAMP`, and
a new stamp is always later than the field's current value and the last
one given in the process, also where the clock has not moved. The stamp
is set when the instance changes in the buffer (create, update, a change
an action or determination makes), so the ETag a client reads after an
action is not the one it sent. Moving it forward goes by the calendar
(`cl_abap_tstmp=>add` across a second): `20991231235959` is followed by
`21000101000000`, never by a 60th second, and a field of seconds takes the
second its stamp falls in. `etag dependent` is parsed and ignored (an
entity whose ETag is its master's needs compositions first).

**Instance features.** A BDEF that declares `features : instance` on an
operation or action must have a `FOR INSTANCE FEATURES` method (the
generator refuses it otherwise). Before an update, delete or such an action
of one instance, the runtime calls the method with that instance's key and
a request with every flag on, and reads `%update`, `%delete` or
`%action-<a>` of the result row for that key: `fc-o-disabled` refuses the
operation with `%fail-cause = if_abap_behv=>cause-disabled` and a message
(`Update of trip is disabled`, `Delete of trip is disabled`, `Action ACCEPT
of trip is disabled`), which the OData bridge answers 400 like any other
refusal. **The text is this runtime's, not measured on a system**, and so
are the values of `if_abap_behv=>fc` (a pool compares and assigns the names
only). Inside a handler (IN LOCAL MODE) features are not asked, as on a
system. `create ( features : instance )` is refused (there is no instance to
ask; global features are not done), `%field` of the result is not read
(dynamic field control), and the service does not publish operation control
(`Core.OperationAvailable`, `sap:updatable-path`): a client learns of a
disabled operation from the 400.

**Early numbering.** A create of an entity with `early numbering` hands its
rows (a `TABLE FOR CREATE`) to the `FOR NUMBERING` method first, then takes
the key of each row from the `MAPPED` line with its `%cid` (a row without a
`%cid` gets a transient one for the call, chosen so that no row of the
call carries it, and only those rows lose it again: a caller's `%cid`,
whatever it looks like, comes back in MAPPED). A row the method fails is
dropped with the method's FAILED / REPORTED. A row it neither maps nor fails
breaks the method's contract (every input `%cid` in MAPPED or FAILED) and is
failed by the runtime (`Early numbering of trip gave no key and no failure
for an instance`) rather than created with the key it came with. Field control still applies afterwards, so a
`readonly` key is drawn by the method and refused from the client.

### What stays outside, and why each needs a design of its own

- **Compositions** (`association _x { create; }`, `TABLE FOR CREATE
  ent\_x` with `%target`, `READ ... BY \_x`, `FOR NUMBERING ... FOR CREATE
  ent\_x`, `lock / authorization / etag dependent by _parent`): the buffer
  would hold a tree, the child's key extends the parent's, a delete
  cascades, the save writes several tables in parent order, and the OData
  side becomes navigation and deep insert. The first wall of the travel and
  supplement BOs.
- **Several behavior pools per BDEF** (`/DMO/I_TRAVEL_M` has three): the
  adapter reads the header's pool only; follows from compositions.
- **Draft** (7 of the 10 BDEFs): a second buffer with its own tables,
  `%is_draft` in every key, the draft actions, a total ETag.
- **Projection and interface BDEFs** (`use create`, `use action`, 6 of 10).
- **Late numbering** (`/DMO/R_AGENCYTP`): `%pid` as the identity until
  `adjust_numbers` in the save gives the final key, which then has to reach
  MAPPED, the OData answer and every `%cid_ref`.
- **`with additional save` / `with unmanaged save`** (`save_modified`), the
  **internal** and **factory** actions, **determine actions**, and
  **global authorization**; each is refused by the generator with its name.

## R5: compositions, associations and projections

R4 left every flight BDEF at its first wall, and the walls that stop most
of them are the business object as a **tree** (compositions, `association
_x { create; }`, read by association, `lock dependent`) and the
**projection** BDEF (`projection;` with `use`). R5 is the smallest model
of both that is sound on its own terms; draft stays out (its own track),
and so do several pools, `with additional/unmanaged save`, internal,
factory and determine actions and late numbering, each still refused by
name. Proven on the order demo of [`src/rap_r5`](../src/rap_r5/README.md)
(`ZI_RAP_ORDER` with its items, projected by `ZC_RAP_ORDER`, served as
`ZUI_RAP_ORDER`, `test/rap-r5.mjs`, `ZCL_OSD_RAP_R5_TEST`). Nothing here is
measured on a system; the semantics follow the public RAP documentation and
each deviation is written down below.

### The tree comes from CDS, the behavior from the BDEF

A composition is declared where a system declares it: the root view says
`composition [0..*] of ZI_CHILD as _Child`, the child view `association to
parent ZI_ROOT as _Root on $projection.k = _Root.k`. `tools/cds2ddic.mjs`
reads both (`CDSComposition`, `association to parent`): the composition is
an association of kind `CHILD` whose key pairs are the reverse of the
child's to-parent `ON` condition (a composition has no `ON` of its own),
and the to-parent association one of kind `PARENT`. The parent of an entity
is the target of its `PARENT` association, its children the targets of its
`CHILD` ones; a BDEF entity's `lock dependent by _x`, `etag dependent by
_x` and `authorization dependent by _x` must name that association (the
generator refuses another; R6 also accepts an association to an ancestor,
see "Dependencies on an ancestor" below). One root per BDEF, any depth.

**The key of a child extends its parent's.** The pairs of the to-parent
association say which child fields carry the parent key; the runtime fills
them from the parent on a create by association, and a client cannot
(a create by association that names another parent's key in them is
overwritten, not refused: the parent in the URL or the `%tky` decides).
They are the framework's fields: set on the child whether or not they are
part of its key (a UUID child carries its parent's UUID as a plain field),
whatever its `%control` and field control say.

### The model the runtime gets

`ZIF_OSD_RAP_BO=>TY_ENTITY` gains:

| component | what |
| --- | --- |
| `parent`, `parent_assoc` | the parent entity (CDS name) and the to-parent association, initial for the root |
| `root` | the root entity of the tree |
| `lock` | `M` for `lock master`, `D` for `lock dependent` |
| `assocs` | every association the BDEF declares for the entity: `name`, `target`, `kind` (`C` composition child, `P` to parent, `A` other), `create` (`association _x { create; }`), `feat_create` (`create ( features : instance )`), `numbering` (`E` when the target is drawn by a `FOR NUMBERING ... FOR CREATE e\_x` method), `pairs` (source field to target field) |

### Derived types

Per association `_x` of entity `e` with target `t`, `bdef-gen.mjs` writes
the types a pool and EML use (`TYPE TABLE FOR ... e\_x`):

- `CREATE e\_x`: the source's `%tky`, `%cid_ref`, and `%target`, a table
  of `t`'s create rows (`%cid`, `t`'s fields, `%control`);
- `READ IMPORT e\_x`: the source's `%tky` and `t`'s `%control`;
  `READ RESULT e\_x`: `t`'s read result rows; `READ LINK e\_x`:
  `source` (the source's `%tky`) and `target` (`t`'s `%tky`);
- the features result of `e` gets `%assoc-_x` for a `create ( features :
  instance )`;
- `FOR NUMBERING IMPORTING entities FOR CREATE e\_x` gets `TABLE FOR
  CREATE e\_x` and the BDEF's `RESPONSE FOR MAPPED EARLY`, as on a system.
  A `%target` row without a `%cid` gets a temporary one for the call
  that no row of the call carries, and only those rows lose it again; a
  caller's `%cid` always comes back in MAPPED.

### Runtime

- **Create by association** (`create_by( iv_entity iv_assoc it_rows )`,
  `TABLE FOR CREATE e\_x`): each row's parent is resolved by `%tky` or
  `%cid_ref` (an instance created earlier in the same transaction, also in
  the same request), else the row fails on the source entity
  (`not_found`). `create ( features : instance )` asks the source's
  features (`%assoc-_x`). The parent is locked (below). Each `%target` row
  becomes a create of `t`: the parent's key is put into the pair fields
  (not flagged in `%control`, so a read-only key is no refusal), early
  numbering of `t` calls the pool's `FOR NUMBERING ... FOR CREATE e\_x`
  method with the rows, and from there it is the create of R2/R4 (field
  control, `%cid`, MAPPED of `t`, determinations and validations of `t`).
  A create of an entity that has a parent is refused unless it goes through
  the association (a child is never created on its own).
- **Read by association** (`read_by( iv_entity iv_assoc it_keys ct_result
  ct_link )`): for each source instance the target instances whose pair
  fields equal the source's, from the buffer and from the persistent table
  (a buffered instance hides its saved row, a deleted one is not read), in
  key order; to the parent it is one instance. `ct_link` gets the source
  and target keys.
- **Delete cascades.** Deleting an instance deletes its composition
  children, recursively, without asking their features (it is the
  framework's delete, not the client's); the save writes the children's
  deletes too.
- **Lock.** `lock master` / `lock dependent by _parent`: before an update,
  delete, action or create by association of an instance, the runtime
  takes an exclusive lock on its **root** instance (lock object
  `EZOSD_RAP_LOCK`, argument the SHA-256 of BDEF, root entity and root
  key, `_SCOPE 2`), released by the runtime itself (`DEQUEUE`) when the
  transaction ends: after the save's `COMMIT WORK`, after a failed save's
  `ROLLBACK WORK`, and on `rollback( )`. That is needed and not a
  nicety: a `COMMIT WORK` that queued no update releases no lock
  (`tools/osd-enq.mjs`, the measured owner model). Inside a batch that
  holds the LUW the locks stay until the request ends. One lock per root
  per transaction. Held by another owner, the operation fails with
  `%fail-cause = if_abap_behv=>cause-locked` and the message `<Root alias>
  <key> is locked by another user` (this runtime's text). The OData bridge
  answers it with 400 like every other refusal: a system answers a locked
  instance with 409, but `/IWBEP/CX_MGW_BUSI_EXCEPTION` of this tree
  carries no HTTP status yet, so the bridge cannot say so (a gateway
  change of its own). A new root is not locked (nobody else can
  see it); `lock master` on a child, `lock dependent` without a parent or by an
  association the BDEF does not declare, and any lock, etag or
  authorization clause in a projection are refused by the generator. The pool's `FOR LOCK` method (unmanaged lock)
  is not called: managed only.
- **ETag of the root.** A field annotated
  `@Semantics.systemDateTime.lastChangedAt` (or `@Semantics.user.lastChangedBy`)
  on the root is the BO's total change stamp, as on a system: a create,
  update or delete of any instance of the tree stamps the root instance's
  fields too (the `localInstanceLastChanged*` fields stay per instance).
  So the root's `etag master` moves with every child write and a client
  holding the old ETag of the root gets 412 **on the root**. The
  boundary: a write of a child is checked against the child's own `etag
  master` only. The root's tag is not the child's (412 if sent on a child
  PATCH), and a POST through the navigation (a create by association) takes
  no If-Match of the root at all (`test/rap-r5.mjs`). Each entity's own `etag
  master` works as in R4; `etag dependent by _parent` (the child's ETag is
  its master's) is accepted and not served (the child type gets no ETag).
- **Save order.** The delta keeps the order of the changes, and a parent
  is always created before its children; deletes of the children come
  first in the delta of a cascade.

### EML

`ZCL_OSD_RAP_EML=>CREATE_BY` and `=>READ_BY` (and `KERNEL_RAP_EML`'s
`create_by` / `read_by`, with the parameter shape of the other kernel
calls plus `assoc`) are what `MODIFY ENTITIES ... CREATE BY \_x` and `READ
ENTITIES ... BY \_x [LINK]` lower to. The pinned transpiler does not
lower `BY` yet (`ModifyEntities BY, not supported, transpiler`), so the
demo pool writes the call with the statement in a comment above it, as R3
did before the EML pin; the lowering is a transpiler follow-up.

### Projections

A projection BDEF (`projection; define behavior for ZC_X alias X { use
create; use update; use delete; use action a; use association _y { create;
} }`) over projection views (`define root view entity ZC_X provider
contract transactional_query as projection on ZI_X { key a as A, ...,
_Y : redirected to composition child ZC_Y }`) is a **thin layer**: no
buffer, no pool, no runtime of its own.

- `tools/cds2ddic.mjs` reads `as projection on` (one base view, elements
  with `as` renames, `redirected to [composition child|parent]`): a
  redirected association is the base view's association with the target
  replaced and its pairs renamed through both projections.
- `bdef-gen.mjs` resolves a projection BDEF against its base BDEF (the BDEF
  of the base view of its root): every projection entity names a base
  entity, every `use` names something the base declares (else refused),
  and the derived types are written for the projection entities as for
  any (field names as the projection spells them).
- The registry (`ZIF_OSD_RAP_REGISTRY=>PROJECTION`) answers per projection
  entity the base BDEF, base entity, the field map (projection element to
  base element), the `use`d operations, actions and associations, and the
  projection's own `field ( readonly )`.
- `ZCL_OSD_RAP_SADL` maps a projection row to a base row by that map, runs
  the base runtime, and maps the keys back; an operation the projection
  does not `use` is refused (400) before the base sees it.
- EML on a projection (`MODIFY ENTITIES OF zc_x`) is not routed yet; a
  projection's own behavior pool (`augment`, `precheck`) is refused.

### OData

`srvd-gen.mjs` writes for every exposed entity its associations to other
exposed entities: an association `to_<alias without _>` with the pairs as
the referential constraint and the navigation on the source (both
directions of a composition are navigable). Reads through a navigation and
`$expand` then take the existing SADL path (the CDS registry's pairs).
`POST Root(...)/to_Child` (V2) and `POST Root(...)/to_Child` (V4, where
writes through a navigation property were 501) create by association:
the SADL provider sees the navigation path and hands the parent key and
the association to `zif_stg_sadl_behavior~create_by`. A child set has
`creatable` only through its parent: a POST on the child's own set is 400
("created through its parent"). The navigation name is the V2 one
(`to_Items`) on both protocols, as for every service of this registry; a
RAP V4 binding on a system names it `_Items`.

### The measurement: the flight BDEFs before and after

`node tools/rap-flight/constructs.mjs` again, now with the dictionary the
pack builds with (`legacy/` and the overlay's stubs: before R5 no BDEF got
as far as its fields, so nobody had noticed the tool resolved the scenario's
types without them), and a projection generated together with its base BDEF.
The first wall per behavior definition:

| BDEF | before R5 | after R5 |
| --- | --- | --- |
| `/DMO/I_TRAVEL_M` | associations (the combined R1 refusal) | **past compositions, cba numbering, lock and associations**; stops at `internal action ReCalcTotalPrice` (then: factory action, several pools, additional and unmanaged save) |
| `/DMO/C_TRAVEL_PROCESSOR_M`, `/DMO/C_TRAVEL_APPROVER_M` | projection | **the projection resolves**; stops at its base's wall (`ReCalcTotalPrice`) |
| `/DMO/I_SUPPLEMENT`, `/DMO/R_AGENCYTP` | associations / functions / determine actions | `determine action Prepare` (named now; then draft) |
| `/DMO/C_SUPPLEMENT`, `/DMO/C_AGENCYTP` | projection | the base's `determine action` |
| `/DMO/I_CARRIERSLOCKSINGLETON_S`, `/DMO/C_CARRIERSLOCKSINGLETON_S` | unparsed grammar / projection | unparsed singleton grammar (the base's, for the projection) |
| `/DMO/I_AGENCYTP` | interface | interface |

Constructs whose verdict changed (over the ten BDEFs):

| construct | BDEFs | before | after |
| --- | ---: | --- | --- |
| `association (read)` | 5 | refused | runs |
| `association create` | 5 | refused | runs |
| `projection` | 5 | refused | runs |
| `lock master` | 4 | ignored | runs |
| `lock dependent` | 3 | ignored | runs |
| `association create ( features : instance )` | 1 | refused | runs |
| `FOR NUMBERING (create by association)` | 1 | refused | runs |

No flight BDEF runs end to end yet. Three (the travel BO and its two
projections) are past the tree and stop at the internal action; the
supplement and agency BOs and their projections stop earlier, at a
determine action, so whether their trees pass is not measured yet; and
draft is behind seven of the ten.

### What R5 leaves

Draft (and `association _x { with draft; }`, refused), several pools
(`/DMO/I_TRAVEL_M`), `with additional/unmanaged save`, internal, factory
and determine actions, late numbering, deep insert as one create by
association (a POST with the children inline on the parent), `etag
dependent` served, EML on a projection, a projection's own pool, `FOR
LOCK` of an unmanaged lock, global features and authorization.

## R6: internal, determine and factory actions

After R5 the travel BO (`/DMO/I_TRAVEL_M`) and its two projections stop at
`internal action ReCalcTotalPrice`, the supplement and agency BOs and their
projections at `determine action Prepare` (measured with
`node tools/rap-flight/constructs.mjs`, the table in R5 above). R6 makes
the three kinds of action the managed scenario declares run, and measures
each one before building it:

| construct | flight BDEFs | why now |
| --- | ---: | --- |
| `internal action` | 1 (travel; its two projections stop at it too) | the first wall of three BDEFs |
| `determine action X { validation v; determination ( always ) d; }` | 2 (supplement, agency; both `draft determine action`) | the first wall of four BDEFs |
| `factory action x [1]` (instance) | 1 (travel `copyTravel`) | the travel's next wall behind the internal action |
| `static` actions, action parameters, results other than `$self` | 0 of the ten (a parameter only in a draft BDEF) | not hit: still refused by name |

Proven on the bill demo of [`src/rap_r6`](../src/rap_r6/README.md)
(`ZI_RAP_BILL`, served as `ZUI_RAP_BILL`, its projection `ZC_RAP_BILL` as
`ZUI_RAP_BILLC`, `test/rap-r6.mjs`, `ZCL_OSD_RAP_R6_TEST`). Nothing is measured on a system; the semantics
follow the public RAP documentation (the BDEF reference's "action",
"determine action" and "factory action") and each choice of this runtime
is written down.

### Internal actions

`internal action a;` is an instance action that only the business object's
own implementation may execute: on a system, EML outside the BO that names
it does not compile, and the service does not expose it. Here:

- **The model.** The callable gets `internal = abap_true`; the derived
  types are an ordinary action's (`TABLE FOR ACTION IMPORT e~a`, a result
  when it declares one).
- **The runtime.** `execute` of an internal action is refused with
  `ZCX_OSD_RAP` (`Action A of e is internal: only the business object's own
  handlers execute it, IN LOCAL MODE`) unless a handler of the same
  runtime is running (`mv_depth > 0`, the R3 rule that makes EML inside a
  handler local). A handler of another behavior definition is outside when
  no handler of this one is running: its EML reaches the session's runtime,
  at depth 0, and is refused. The
  refusal is an exception, not a FAILED row, because on a system it is a
  syntax error and nothing a caller could correct.
- **Features** are not asked (IN LOCAL MODE skips them, as R4 already does).
- **Known limit.** The guard is the runtime's depth, not the caller's
  identity: while a handler of BO A runs, a handler of BO B that it reached
  through EML may execute A's internal action (A -> B -> A's internal
  action), because A's runtime is still active; a system refuses that at
  compile time.
- **OData.** `srvd-gen.mjs` exposes no internal action: no V2 function
  import, no V4 bound action, so a call is the service's ordinary 404 for
  an unknown operation. `ZCL_OSD_RAP_SADL->actions( )` does not list it
  either, so the bridge never reaches the runtime with it.
- **Projections.** `use action a` of an internal action is refused by the
  generator (a projection exposes, and an internal action is not exposable).

The flight travel's pattern is the demo's: a determination on modify
executes the internal action with `MODIFY ENTITIES ... IN LOCAL MODE
ENTITY bill EXECUTE recalctotal FROM CORRESPONDING #( keys )`.

### Determine actions

`determine action x { determination [( always )] d; validation [( always )]
v; }` runs the named determinations and validations on request. The
grammar is R0's; R6 adds the `( always )` option of a member.

- **Members.** A member names a determination **on save** or a validation
  of the same entity (also qualified with the entity's alias or name, `e~d`).
  A determination on modify, a member of another entity (a child's
  validation, `Child~v`) and an unknown name are refused by the generator,
  each with its name. `draft determine action` (Prepare, the only form the
  ten flight BDEFs use) is refused as draft.
- **When a member runs.** For the instances the call names: a member
  without `( always )` runs for the instances whose trigger conditions are
  met since the last save (the same test the save sequence makes:
  `create`, `update`, a field), a member with `( always )` for all of them.
  Determinations first, then validations, each in the order declared --
  the save sequence's order. **That order is this runtime's choice**, not
  read off a system.
- **Chains wait for the save.** A member determination whose change
  triggers another determination on save does not run that one now; it
  runs at the next save, where its triggers are tested again.
- **Options** (`( features : instance )`, `( authorization : update )`)
  on a determine action are refused by name: neither is asked.
- **What it does not consume.** A determination that ran in a determine
  action runs again at the save if its triggers still hold: the action does
  not reset the triggers (determinations are expected to be idempotent, as
  on a system).
- **Failures.** A validation that fails puts the instance into the call's
  FAILED / REPORTED, as in the save, and nothing is rolled back: the
  instance stays in the buffer. Over OData a FAILED row is the usual 400
  and the transaction is rolled back.
- **The rest is an action's.** Unknown key: FAILED `not_found`. The root
  instance is locked as for any action (a determination may change the
  instance). The import type is `TABLE FOR ACTION IMPORT e~x` (`%tky`,
  `%cid_ref`); there is no result. After the call the determinations on
  modify its changes trigger run, as after any request.
- **OData.** A determine action is exposed like an instance action (V2
  function import, V4 bound action) and answers the instance.

### Factory actions

`factory action x [1];` (instance) creates a new instance from an
existing one (the travel's `copyTravel`). The import row carries `%cid` --
the content ID the new instance is mapped under -- beside `%tky` and
`%cid_ref`; there is no result, the new instance comes back in **MAPPED**.

- **The handler** (`FOR MODIFY IMPORTING keys FOR ACTION e~x`) gets the
  caller's MAPPED (R2's adapter dropped the `mapped` parameter of an action
  handler into a local; it is now passed through), creates with EML IN
  LOCAL MODE with `%cid = key-%cid`, and copies the MAPPED of the create
  into its own -- the flight pool's code.
- **The runtime** passes `cs_mapped` through (`execute` takes it as an
  optional CHANGING; `ZCL_OSD_RAP_EML=>EXECUTE` and `KERNEL_RAP_EML`'s
  `execute` pass the statement's MAPPED) and checks the handler's
  contract: an import row whose `%cid` is neither in MAPPED nor in FAILED
  of the entity is failed (`Factory action X of e gave no instance and no
  failure`), as early numbering does for a key. A row without a `%cid` is
  refused before the handler runs (`Factory action X of e needs a %cid for
  the new instance`).
- **OData.** The bridge gives the import row a `%cid` of its own, reads
  the new key from MAPPED, and answers **the new instance** (V2 function
  import, V4 bound action, both 200 as for the other actions; a system's V4
  status for a factory action is not measured). `zif_stg_sadl_behavior~execute`
  gains an optional `es_row`, the instance to answer when it is not the
  one in the URL.
- `static factory action` and the `[1]` cardinality's alternatives are
  refused (static actions are not in R6).

### Dependencies on an ancestor

Behind the actions the travel BO met an R5 rule that was too narrow: its
booking supplement says `lock dependent by _Travel` and `authorization
dependent by _Travel`, an association to its **root**, while R5 accepted
only the association to the parent (`_Booking`). The BDEF reference names
the association to the lock (etag, authorization) master, which need not be
the parent. So a dependency may now name the parent's association or an
association of the entity's own (`association _Travel;`, kind A) whose
target is an ancestor; a lock's must reach the lock master (the root, the
instance the runtime locks anyway), else the generator refuses it (`lock
dependent by _x, whose target Y is not the lock master Z`). Nothing in the
runtime changes: it always locked the root through the parent chain.
Tested on R5's order with a third level built in the test
(`test/rap-r6.mjs`, "dependencies on an ancestor"). For `etag` and
`authorization dependent by` the generator only checks that the
association reaches an ancestor, not that it is the etag or
authorization master; neither is served yet, and that check belongs with
serving them.

### The measurement: the flight BDEFs before and after

`node tools/rap-flight/constructs.mjs` on the same ten BDEFs. The first
wall per behavior definition:

| BDEF | after R5 | after R6 |
| --- | --- | --- |
| `/DMO/I_TRAVEL_M` | `internal action ReCalcTotalPrice` | **past the internal and the factory action and the supplement's lock by `_Travel`**; stops at `with additional save` (then: several pools -- the booking's handlers are in `/DMO/BP_BOOKING_M` -- and the supplement's `with unmanaged save`) |
| `/DMO/C_TRAVEL_PROCESSOR_M`, `/DMO/C_TRAVEL_APPROVER_M` | the base's `ReCalcTotalPrice` | the base's `with additional save` |
| `/DMO/I_SUPPLEMENT` | `determine action Prepare` | draft: `association _SupplementText { create; with draft; }` |
| `/DMO/R_AGENCYTP` | `determine action Prepare` | draft: `draft action Resume` |
| `/DMO/C_SUPPLEMENT`, `/DMO/C_AGENCYTP` | the base's `determine action` | the base's draft wall |
| `/DMO/I_CARRIERSLOCKSINGLETON_S`, `/DMO/C_CARRIERSLOCKSINGLETON_S` | unparsed singleton grammar | unchanged |
| `/DMO/I_AGENCYTP` | interface | unchanged |

Constructs whose verdict changed:

| construct | BDEFs | after R5 | after R6 |
| --- | ---: | --- | --- |
| `internal action` | 1 | refused | runs |
| `factory action` | 1 | refused | runs |
| `determine action` | 3 | refused | split: a plain `determine action` runs (none of the ten has one), the three are `draft determine action`, refused as draft |
| `lock dependent` | 3 | runs by the parent's association only | runs by the parent's or an association to the lock master |

The determine actions of the supplement and the agency are both `draft
determine action Prepare`, so R6 does not move those two BOs past draft:
their walls are now draft's own, named as draft. The travel BO is three
walls from running: `with additional save` (the saver's `save_modified`
beside the managed save), several pools, and `with unmanaged save`; each is
a track of its own.

### Not in R6

`static` actions and functions, action parameters (the `%param` type is
generated, the runtime and the service do not pass it), results other
than `$self`, members of a determine action in another entity, draft
actions (`draft action`, `draft determine action`), `internal create /
update / delete`, and everything R5 left.

## R7: the saver, additional and unmanaged save, several pools

After R6 the flight travel BO (`/DMO/I_TRAVEL_M`) and its two projections
stop, in this order, at `with additional save` on the travel, at **several
behavior pools** (the booking's handlers are in `/DMO/BP_BOOKING_M`, the
supplement's in `/DMO/BP_BOOKINGSUPPLEMENT_M`) and at `with unmanaged save`
on the booking supplement (`node tools/rap-flight/constructs.mjs`, the table
in R6). All three meet in one method of the travel pool: its local saver
`lcl_save` redefines `save_modified`, writes a change log of the travel into
`/dmo/log_travel` (the additional save) and writes the supplements itself
through the function modules `/DMO/FLIGHT_BOOKSUPPL_C/U/D` (the unmanaged
save). R7 makes that run. Nothing is measured on a system; the semantics
follow the public RAP documentation (the BDEF reference's "with additional
save", "with unmanaged save", "implementation in class"; the saver's
methods in "CL_ABAP_BEHAVIOR_SAVER") and every choice of this runtime is
named as one below.

| construct | flight BDEFs | where |
| --- | ---: | --- |
| `with additional save` | 1 (travel) | the travel entity |
| several pools (`implementation in class` per entity) | 1 (travel: three pools) | booking, supplement |
| `with unmanaged save` | 2 (travel's supplement; the carrier singleton, behind its unparsed grammar) | the supplement entity |
| `with full data`, `and cleanup` | 0 | not used by the ten; parsed, accepted (below) |

### Several pools

`define behavior for e implementation in class P` names the pool of the
entity; an entity without one uses the header's. Each entity's handlers
(determinations, validations, actions, features, numbering, the numbering
of its creates by association) are looked up **in its own pool**: the
adapter's `handler` of an entity is the absolute name of the local handler
class in that pool (`\CLASS-POOL=/DMO/BP_BOOKING_M\CLASS=LHC_BOOKING`), and
the rules of R2..R6 apply per pool (one handler class per entity, a method
bound by its FOR clause or its name). `bdef-gen.mjs` already bound the
derived types per pool (R3's `POOL <p> FOR ...` bindings); the build now
reads every pool the BDEF names, not only the header's, and a pool the BDEF
names that is not in the tree is refused with its name.

**Savers.** Every pool may have a local saver (a class inheriting
`CL_ABAP_BEHAVIOR_SAVER`), at most one per pool. The runtime calls all of
them, in the order the pools first appear in the BDEF (header first), in
each phase. Which savers a system calls when several pools have one, and in
which order, is **unmeasured**.

### The save sequence with savers

```
finalize          determinations on save; each saver's finalize
check_before_save validations; each saver's check_before_save
  (a new FAILED row: each saver's cleanup_finalize, ROLLBACK WORK, buffer kept)
adjust_numbers    each saver's adjust_numbers
save              the managed write of every entity that has one, then each
                  saver's save_modified (or save) with the request
COMMIT WORK
cleanup           each saver's cleanup; the buffer is reset
```

- **adjust_numbers** is called without parameters: late numbering (the
  only reason for its MAPPED LATE) stays refused, so a pool's
  `adjust_numbers` can only observe.
- **save_modified** is written on a system as `METHODS save_modified
  REDEFINITION.` and gets implicit parameters typed by the BDEF: `create`
  and `update` (`TYPE REQUEST FOR CHANGE <bdef>`), `delete` (`TYPE REQUEST
  FOR DELETE <bdef>`) and `reported` (`TYPE RESPONSE FOR REPORTED LATE
  <bdef>`). abaplint voids every parameter of `CL_ABAP_BEHAVIOR_SAVER`'s
  methods (ANORMALIES, "RAP saver phases"), so, as R3 did for the handler
  forms, `lower-derived.mjs` rewrites the declaration in a pool's saver into
  an explicit one over the pool's bindings (`METHODS save_modified
  IMPORTING create TYPE zif_rap_<h>=>r_change update TYPE ... delete TYPE
  zif_rap_<h>=>r_delete CHANGING reported TYPE zif_rap_<h>=>r_reported.`),
  and the adapter calls it by name. `save` (the unmanaged BO's phase) is
  parameterless here, as `finalize` and the rest are.
- **The request.** `REQUEST FOR CHANGE` has one component per entity
  (named by alias), a table of the entity's fields with `%control`, keyed
  `WITH NON-UNIQUE SORTED KEY entity COMPONENTS <keys>` (the flight saver
  reads it `WITH TABLE KEY entity COMPONENTS travel_id = ...`); `REQUEST FOR
  DELETE` the same with the keys only. The runtime fills them from the
  transactional buffer **for the entities that have an additional or an
  unmanaged save** -- the components of the others stay empty, since their
  write is the managed one (unmeasured: whether a system passes them too).
  A create row carries the instance as saved, `%control` on
  (`if_abap_behv=>mk-on`) for every field set since it was created; an
  update row its keys and the fields changed in this transaction, flagged,
  the others initial; a delete row the keys. An instance created and
  deleted in the same transaction is in none of them (the delta collapses
  it, as for the managed write).
- **with full data** (`with additional save with full data`): update rows
  carry every field of the instance as it is in the buffer, not only the
  changed ones; `%control` still flags only the changed ones.
- **and cleanup** (`with additional save and cleanup`, `with unmanaged save
  and cleanup`): accepted and without effect -- this runtime calls the
  savers' `cleanup` after every save anyway (on a system the option is what
  makes a managed BO call it; unmeasured).
- **reported** is the caller's REPORTED: the LATE response is the EARLY type
  (it has a `%cid` a LATE response would not have; a system's LATE type is
  not reproduced).

### with additional save

The entity is written by the managed save as before, and **after** that
write, in the same LUW and before `COMMIT WORK`, the savers' `save_modified`
gets the entity's changes. An exception that leaves a saver is the save's
error, and the runtime ends the transaction itself:

- `ROLLBACK WORK` undoes the managed write with the saver's;
- the savers' `cleanup` runs;
- the buffer is discarded;
- then `ZCX_OSD_RAP` is raised with `save` set, and with `business` set and the saver's text.

The checks have already passed, so the client could not have corrected
anything, and a buffer that is half written must not be saved again.
A refused managed write ends the same way, `technical` and without
`business`. Over OData a saver's failure is a 400 business error carrying
its text (`test/rap-r7.mjs`), while a refused write stays a 500. Inside a
held LUW (a `$batch` changeset or V4 atomicity group) the runtime does not
roll back; the group does. On a system a failure in the save is a short dump
(the save phase must not fail; unmeasured here). A behavior definition with an additional save
and no saver that implements `save_modified` is refused by the generator.

### with unmanaged save

The entity has no persistent table (the flight comments it out:
`//persistent table /DMO/BOOKSUPPL_M`) and **no managed write**: its
changes reach the database only through `save_modified`. It still needs
somewhere to read saved instances from (a read, a read by association, the
update of an instance not in the buffer): the table of its `mapping for`,
which the flight declares (`mapping for /dmo/booksuppl_m corresponding`).
An unmanaged save without a `mapping for` table is refused by the
generator (reading through the CDS view alone is not in R7). The rest of
the entity is managed as before -- buffer, field control, numbering,
determinations, validations, the lock of its root, the cascade of a delete.

### MAPPING FROM ENTITY

The flight saver turns the request into table rows with `CORRESPONDING #(
create-booksuppl MAPPING FROM ENTITY )`: the BDEF's `mapping for` read
backwards. `lower-derived.mjs` rewrites it: `MAPPING FROM ENTITY` after a
source `<x>-<alias>` (a component of a request or response) becomes the
explicit `MAPPING column = field ...` of that entity's `mapping for` (no
clause when it is `corresponding` and names no field), and `MAPPING TO
ENTITY` the other way round. The entity is found by the alias in the pool's
bindings; a source that names none is refused with its line.

The lowering is a token rewrite, so it has limits:

- **One source shape**: the token before `MAPPING` must be the entity's
  alias or name, as in `x-alias` (a component of a request or response).
  A variable of the entity's type, `CORRESPONDING #( lt_rows MAPPING FROM
  ENTITY )`, names no entity and is refused, though a system takes it.
- **Keys by parameter name**: `delete-<alias>` maps the keys only because
  `delete` is save_modified's REQUEST FOR DELETE; a delete request under
  another name gets the full pair list, and the move fails at syntax check
  if a pair names a non-key field.
- **No `USING CONTROL`**: `MAPPING FROM ENTITY USING CONTROL` (move only the
  fields flagged in `%control`) is not lowered. The `USING CONTROL`
  tokens are left in place, and the transpile refuses them.
- **One mapping per entity**: the `mapping for` of the persistent table, or
  the first one; an entity with several mappings cannot choose.

### OData

Nothing new on the wire: a create, update, delete or action of an entity
with an additional or unmanaged save is answered as before, after the
save. What changes is what the save writes.

### Built and proven

On the tour demo of [`src/rap_r7`](../src/rap_r7/README.md) (`ZI_RAP_TOUR`
with its stops, two pools, served as `ZUI_RAP_TOUR` with the log as a
read-only set; `test/rap-r7.mjs`, `ZCL_OSD_RAP_R7_TEST`) and on the flight
travel itself ([rap-flight-pack.md](rap-flight-pack.md), "R7";
`test/rap-flight-travel.mjs`, `ZCL_OSD_RAPFLIGHT_R7_TEST`).

What the flight needed beyond the three constructs, each small:

- a namespaced BDEF keeps its name (`#dmo#i_travel_m` is `/DMO/I_TRAVEL_M`
  for the registry, the bindings and EML); `bdef\\entity` (two
  backslashes, as the pools write it) resolves like `bdef\entity`;
- the table and CDS classes of a namespaced name use the shared
  `classNameOf` (`ZCL_STG_TAB_DMO_TRAVEL_M`), in the runtime model and in
  the service YAML;
- `%path` in a child's FAILED / REPORTED rows (each ancestor's keys, by
  alias), and `cl_abap_behv=>flag_changed` / `flag_unchanged`;
- over V4 a namespaced service comes escaped (`%2FDMO%2FUI_X`) and so does
  its qualified operation (`%2FDMO%2FUI_X.acceptTravel`), as over V2.

### The measurement: the flight BDEFs before and after

`node tools/rap-flight/constructs.mjs`, first wall per behavior definition:

| BDEF | after R6 | after R7 |
| --- | --- | --- |
| `/DMO/I_TRAVEL_M` | `with additional save` (then several pools, `with unmanaged save`) | **accepted**; served: V2 data requests and V4 (V2 `$metadata` of a namespaced service fails, ANORMALIES) |
| `/DMO/C_TRAVEL_PROCESSOR_M`, `/DMO/C_TRAVEL_APPROVER_M` | the base's `with additional save` | **accepted**, served |
| `/DMO/I_SUPPLEMENT`, `/DMO/C_SUPPLEMENT` | draft (`association { with draft; }`) | unchanged |
| `/DMO/R_AGENCYTP`, `/DMO/C_AGENCYTP` | draft (`draft action Resume`) | unchanged |
| `/DMO/I_CARRIERSLOCKSINGLETON_S`, `/DMO/C_CARRIERSLOCKSINGLETON_S` | unparsed singleton grammar | unchanged |
| `/DMO/I_AGENCYTP` | interface | unchanged |

Constructs whose verdict changed: `with additional save` (1 BDEF),
`with unmanaged save` (2), `several pools` (1), `saver save_modified` (2):
refused -> runs. `saver adjust_numbers` stays refused (late numbering,
`/DMO/R_AGENCYTP`).

### Unmeasured

Nothing of R7 was checked on a system. In particular: whether a system
passes the entities without an additional or unmanaged save in
`save_modified`'s request (here their components stay empty); which
savers it calls when several pools have one, and in which order (here
every pool's, the header's first); what a create row's `%control` carries
for keys drawn by early numbering (here on); that `and cleanup` makes a
managed BO call `cleanup` (here it is always called); the order of the
managed write and `save_modified` within the save (here the managed write
first, as the documentation describes); the flight overlay's two
stand-ins (the travel number after the highest saved one; nothing added
for an amount in another currency).

### What R7 does not do

`adjust_numbers` with MAPPED LATE (late numbering), FAILED from a saver
phase (the phases still take no FAILED; ANORMALIES "RAP saver phases"),
an unmanaged *BO* (`unmanaged implementation in class`, the `FOR MODIFY`
of every operation, `FOR READ`), `with unmanaged save` without a mapping
table, reading an entity through its CDS view in the buffer's place,
secondary keys `id` / `entity` on the other derived tables, V2 `$metadata`
of a namespaced service (ANORMALIES), and draft.

## R8: draft

After R7 draft is the first wall of 7 of the 10 flight behavior
definitions (`node tools/rap-flight/constructs.mjs`): `with draft` in the
header of the supplement, agency and carrier BOs and of their projections,
and behind it `draft table`, `total etag`, `draft action`, `draft determine
action Prepare` and `association _x { with draft; }`. R8 is the design of
draft as a whole, and the smallest slice of it that runs end to end: a
draft-enabled root with one child, created as a draft, edited, activated
and discarded over OData V4, and EML with `%is_draft` for create, update
and read.

Nothing in this section was measured on a system. Where the public RAP
documentation (the BDEF reference's "with draft", "draft table", "total
etag", "draft action", the ABAP keyword documentation of `%is_draft`, the
development guide's "Draft-Enabling the Managed Business Object", linked
from [oracle-rap.md](oracle-rap.md)) states a rule, the runtime follows it;
where it does not, the runtime makes a choice and this section names it,
marked **unmeasured**. The draft oracle ([oracle-draft.md](oracle-draft.md))
is the BOPF/SADL V2 draft of the SEGW era; its wire capture is still to be
made, and the RAP flight draft services (`/DMO/UI_SUPPLEMENT`'s V4 binding
among them) are the capture R9 needs from A4H.

### The BDEF grammar

All of it is already parsed by `tools/rap/bdef-parse.mjs` (R0); what R8
changes is what the generators accept.

| Construct | Where | Meaning | R8 |
| --- | --- | --- | --- |
| `with draft;` | header | the BO has a draft version of every entity | runs |
| `with collaborative draft;` | header | several users on one draft | refused (R9+) |
| `draft table t` | entity | where the entity's draft instances are kept | runs, required with `with draft` |
| `draft table t query v` | entity | a draft query view | refused |
| `total etag f` | root | the field whose change marks a change of the whole BO; checked on Activate | runs (the check below) |
| `draft action Edit;` | root | copy the active instance and its composition tree into a new draft | runs |
| `draft action Activate [optimized];` | root | write the draft into the active instance and delete the draft | runs (`optimized` accepted, no effect) |
| `draft action Discard;` | root | delete the draft | runs |
| `draft action Resume [with additional implementation];` | root | take up an existing draft again | runs as "return the draft" (below); `with additional implementation` refused |
| `draft determine action Prepare { validation v; ... }` | root | run the listed validations on the draft | runs for the root's own validations; `Entity~validation` of another entity refused (R9) |
| `association _x { create; with draft; }` | composition | the association reaches the target's draft when the source is a draft | runs (it is how a draft child is created and read) |
| `use draft;`, `use action Edit;` ... | projection | the projection serves its base's draft | refused (R9) |
| `draft action ( features : instance ) Edit` and other options | root | feature control of a draft action | refused |

A `with draft` BDEF must declare `Edit`, `Activate`, `Discard` and
`Prepare` (the documentation calls them mandatory for a draft BO, `Resume`
optional); the generator refuses one without them.

### Draft tables and the admin data

A draft table has one column per **CDS element** of the entity, named as
the element (`SupplementID` becomes `SUPPLEMENTID`), not as the active
table's column -- that is the shape of the flight's `/DMO/SUPPL_D` beside
`/DMO/SUPPLEMENT` (`supplement_id`), and why the active table needs the
`mapping for` and the draft table does not. On a system the draft table
then includes the structure the documentation names for its admin fields
(`sych_bdl_draft_admin_inc`; the flight's draft tables, e.g. `/DMO/SUPPL_D`
in [abap-platform-refscen-flight](https://github.com/SAP-samples/abap-platform-refscen-flight),
include it). `open-abap-core`, a library of this build, carries a stand-in
of that structure, which is how the flight's draft tables resolve here. The
R8 demo's draft tables declare the admin columns themselves (the generated
table classes are not tried on an `.INCLUDE` yet), under the include's
field names and the stand-in's types:

| Column | Here |
| --- | --- |
| `DRAFTENTITYCREATIONDATETIME` | stamped when the draft instance is created |
| `DRAFTENTITYLASTCHANGEDATETIME` | stamped on each change of the draft instance |
| `DRAFTADMINISTRATIVEDATAUUID` | the draft's admin row (one per draft of a root, shared by its children) |
| `DRAFTENTITYOPERATIONCODE` | `C` created as a draft, `U` an Edit of an active instance, `D` deleted in the draft (unmeasured: the codes; here only C and U are written, a deleted draft child is deleted from the draft table) |
| `HASACTIVEENTITY` | `X` when the draft was made by Edit of an active instance |
| `DRAFTFIELDCHANGES` | not kept (R9; the stand-in has it as RSTR) |

The stand-in's types (`DEC 21,7`, RAW 16, CHAR 1) are not measured against a
system here: **unmeasured**.

The draft **administrative data** -- who created the draft, who changed it
last and when, who holds it (in process by) -- is one row per draft of a
root on a system, in a framework table read through
`I_DraftAdministrativeData` (the oracle's V2 `DraftAdministrativeData`
entity, [oracle-draft.md](oracle-draft.md) section 2.2). Here it is
`ZOSD_DRAFT_ADM`, a table of this tree: `DRAFTUUID` (RAW 16, key),
`DRAFTENTITYTYPE` (the root's CDS name), `CREATEDBYUSER`,
`CREATIONDATETIME`, `LASTCHANGEDBYUSER`, `LASTCHANGEDATETIME`,
`INPROCESSBYUSER`. The runtime writes it in the save: a row when a root's
draft is created (by create or Edit), the last-changed pair when any
instance of the draft changes, and deletes it with the draft (Activate,
Discard).

### `%is_draft` and the instance identity

`%is_draft` is a component of `%tky` of every derived type of a draft BO
(R1 already generated it, `x LENGTH 1`, `if_abap_behv=>mk-on` for a draft).
The runtime makes it part of the instance's identity: the draft and the
active instance with the same key are two instances of the buffer. A read,
update, delete or action names which one by `%is_draft`; an instance read
from the database comes from the draft table when `%is_draft` is on and
from the active table otherwise. A create with `%is_draft` on creates a
draft instance; managed numbering draws its key as for an active one, and
Activate keeps it, so draft and active share the key (the documentation's
rule for managed UUID keys; early numbering of drafts is R9).

### Draft instances in the save sequence

`COMMIT ENTITIES` (or the OData request's own save) writes a draft
instance into its draft table, not into the active one. For draft
instances:

- determinations **on modify** run as for active ones;
- determinations **on save** and validations do not run (they run when the
  draft is activated, on the active instances it writes);
- field control: `readonly` is checked, `mandatory` is not (a draft may be
  incomplete; Activate checks it on the active instance);
- the savers' `save_modified` gets no draft instances (the request names
  active instances only);
- the draft's admin row is written (above).

### The draft actions

| Action | On | What the runtime does |
| --- | --- | --- |
| `Edit` | an active root (`%is_draft` off) | refused when a draft of the instance exists (conflict). Otherwise copies the root and its composition tree into draft instances (`HASACTIVEENTITY` X), creates the admin row with the caller in process, and answers the draft root |
| `Activate` | a draft root | first everything that can refuse it, with the buffer untouched: the total ETag, the lock of the active root, every mandatory field of the tree (a refused Activate changes nothing, so a `COMMIT ENTITIES` after it saves nothing). Then for each instance of the draft's tree: updates the active instance it was made from (every field flagged) or creates it; deletes the active children the draft no longer has; deletes the draft and its admin row. Then the save sequence checks the active instances as for any modify: a validation that fails stops the save, nothing is written, the draft stays. Answers the active root |
| `Discard` | a draft root | deletes the draft instances of the tree and the admin row (whether a system answers a result or EML `RESULT` for it is **unmeasured**) |
| `Resume` | a draft root | answers the draft root (and refuses one that does not exist). On a system it re-acquires the exclusive lock of an expired draft; here no lock expires (below). Its import and result shape is **unmeasured** until the A4H oracle |
| `Prepare` | a draft root | runs the validations its `draft determine action` lists on the draft instances, with their messages in REPORTED; it changes nothing |

**`total etag`.** Edit copies the root's total ETag field into the draft;
changes to the draft do not stamp it (only the `etag master` field, the
local one, moves while drafting). Activate compares the draft's value with
the active instance's: different means the active instance changed after
Edit, and Activate fails with a conflict. That is the documentation's
purpose of the total ETag (an optimistic check over the whole BO between
Edit and Activate); how a system words the failure is **unmeasured**.

### Locks: exclusive on edit, optimistic while drafting

On a system, Edit takes an **exclusive** (durable, enqueue) lock on the
active instance that outlives the request, held by the draft's owner until
Activate or Discard, released after an expiry time, after which the draft
is still there but only optimistically locked: Resume takes the lock again
if the active instance is unchanged (total ETag). Here:

- the request that runs Edit, Activate or Discard holds the R5 lock of the
  root (`EZOSD_RAP_LOCK`) for its own duration, as every write does;
- the durable part is **the draft itself**: while a draft of an instance
  exists, an update, delete or action on the active instance is refused
  (FAILED, cause `locked`) and a second Edit is refused (cause `conflict`).
  There is no owner check (no user switch in this tree's requests) and no
  expiry, so Resume never has a lock to take back; the expiry and the
  owner (`INPROCESSBYUSER`) are R9 and **unmeasured**. Said plainly: **the
  lock is per instance, not per user** -- the draft holds the active
  instance against every writer, its own creator included, and any client
  may change, activate or discard any draft;
- the optimistic part is the total ETag check on Activate (above).
- over OData a refusal (`conflict` for a second Edit or a stale total ETag,
  `locked` for a write to a held active instance) is a 400 business error,
  as every RAP refusal here (R5's follow-up: `/IWBEP/CX_MGW_BUSI_EXCEPTION`
  carries no status). Whether a system answers 409 / 423 for them is
  **unmeasured**.

### EML

`MODIFY ENTITIES ... CREATE / UPDATE / DELETE` with `%is_draft` in the
rows, `READ ENTITIES ... WITH VALUE #( ( %is_draft = if_abap_behv=>mk-on
... ) )` and `EXECUTE Edit / Activate / Discard / Resume / Prepare FROM`
go through the same runtime calls as every other EML statement
([rap-eml.md](rap-eml.md)); `%is_draft` is a component like the keys.
`READ ENTITIES` of a draft reads the draft table when the instance is not
in the buffer.

### The OData V4 draft protocol (what Fiori Elements V4 sends)

From the OData V4 vocabularies (`Common.DraftRoot`, `Common.DraftNode`)
and UI5's V4 model and Fiori Elements V4 (`sap.fe.core`'s draft
handling), which name the request flow; a RAP service's exact `$metadata`
is **unmeasured** (the V4 binding of a flight draft service is the capture
R9 needs):

- every entity type of the BO gets the key `IsActiveEntity` (Edm.Boolean)
  after its own keys, and the properties `HasActiveEntity` and
  `HasDraftEntity` (Edm.Boolean), and the navigation properties
  `DraftAdministrativeData` (to the admin entity) and `SiblingEntity` (the
  other version of the same instance);
- the root's entity set is annotated `Common.DraftRoot` with
  `ActivationAction`, `EditAction`, `PreparationAction` (and, on newer
  stacks, `DiscardAction`, `ResumeAction`); a child's with `Common.DraftNode`
  and its `PreparationAction`. The values are the qualified names of bound
  actions. RAP names them after the BDEF's draft actions (`Edit`,
  `Activate`, `Prepare`, `Discard`, `Resume`); CAP names them `draftEdit`,
  `draftActivate`, `draftPrepare`. Fiori Elements reads the names from the
  annotation, so the choice is the server's; here they are the BDEF names.
  `Edit` has the parameter `PreserveChanges` (Edm.Boolean);
- the flow: `POST Set` with the new entity's fields creates a draft
  (`IsActiveEntity` false in the answer); `PATCH Set(Key=..,IsActiveEntity=false)`
  changes the draft; `POST Set(..,IsActiveEntity=false)/<ns>.Prepare`
  then `POST Set(..,IsActiveEntity=false)/<ns>.Activate` saves (the answer
  is the active entity; Fiori Elements navigates to it);
  `POST Set(..,IsActiveEntity=true)/<ns>.Edit` with
  `{"PreserveChanges":true}` starts editing; `DELETE
  Set(..,IsActiveEntity=false)` discards (Fiori Elements V4 deletes the
  draft root rather than calling Discard); a child of a draft is created by
  `POST Set(..,IsActiveEntity=false)/_Child`;
- the list report's "All" filter is `$filter=IsActiveEntity eq false or
  SiblingEntity/IsActiveEntity eq null` (drafts, and the active instances
  that have none), with `$expand=DraftAdministrativeData` for the draft
  indicator.

**V2** (Fiori Elements V2 over a RAP V2 binding, or BOPF draft in the SEGW
era): the same key and the same three flags, `DraftAdministrativeData` and
`SiblingEntity` as V2 navigations, the draft actions as function imports
bound by `sap:action-for` (the oracle's `<Entity>Edit`, `<Entity>Activation`,
`<Entity>Preparation`, `<Entity>Validation` for BOPF; RAP's names are
**unmeasured**), and `Common.DraftRoot` with `ActivationAction`,
`EditAction`, `PreparationAction` naming the function imports. Discard is
`DELETE` of the draft there too.

**Which first: V4.** Fiori Elements V4 is the client RAP's draft is made
for, the V4 facade already has bound actions with the RAP behavior behind
them (R2c, #875), and the V2 draft service differs in function import names
nobody has measured yet. Because the V4 facade serves the V2 model, the
model R8 builds (the key, the flags, the draft actions as operations of the
service) is visible over V2 as well; what V2 lacks is checked against a
capture first (R9).

### How it is served here

The served entity of a draft BO is the **union** of its active instances
(the CDS view) and its drafts (the draft table), each row with the three
flags and the draft's admin UUID. That union is a generated class per
entity (`zif_stg_cds_source`, beside the BDEF's adapter), which the SADL
data provider reads in place of the view when the behavior says the
entity is draft-enabled; the flag conditions of a `$filter` and a key are
taken out of the SQL and applied to the union (the view has no such
columns), and the list report's "All" filter is recognised as the
condition it stands for (`IsActiveEntity eq false or HasDraftEntity eq
false`). Writes go to the behavior with `%is_draft` from the key: a POST to
the set creates a draft, a PATCH, DELETE or action names the version by
`IsActiveEntity`, and a DELETE of a draft root is Discard.

### The slice R8 builds

`src/rap_r8`: a root `ZI_RAP_DTRIP` (managed numbering, UUID key) with one
composition child `ZI_RAP_DLEG`, `with draft`, draft tables, `total etag`,
the five draft actions with `Prepare` running the root's validation, served
as `ZUI_RAP_DTRIP` over V4, and an ABAP Unit test of the runtime with EML
`%is_draft`. Everything else in this section that the slice does not
exercise is R9 (the list below).

### Built and proven

On the trip demo ([`src/rap_r8`](../src/rap_r8/README.md)):

- **Generators.** `bdef-gen.mjs` accepts `with draft`, `draft table`,
  `total etag`, the four draft actions and `draft determine action Prepare`
  of the root, `association ... { with draft; }`; it gives Edit, Activate
  and Resume a `$self` result (unmeasured: a system's EML result of a draft
  action). What only the runtime needs -- the draft table with a column per
  CDS element and the admin columns, the four mandatory draft actions,
  every association `with draft` -- is checked there and refused by
  `rap-runtime-gen.mjs`, so the derived types of a BDEF without a draft
  table still generate. The adapter's model carries `draft`, each entity's
  draft table and table class, the root's `total_etag`, the draft actions as
  callables of kind `E`, and a generated **union class** per entity
  (`zcl_rap_<hash>_d<n>`, `zif_stg_cds_draft_source`).
- **Runtime** (`ZCL_OSD_RAP_RUNTIME`, `ZCL_OSD_RAP_DRAFT`): `%is_draft` in
  the instance identity (a draft's key is prefixed `D|`), reads and writes
  of drafts in the draft table by element name, determinations on save and
  validations skipped for drafts, mandatory checked on Activate, the draft's
  admin columns and `ZOSD_DRAFT_ADM` written in the save, `save_modified`
  given active instances only, and Edit, Activate, Discard, Resume as
  described above. Prepare runs its listed validations on every draft
  instance it is given, without their triggers (unmeasured: a system keeps
  `DRAFTFIELDCHANGES` and may run fewer).
- **Serving.** The SADL data provider reads a draft entity through its
  union class: the CDS view's rows and the draft table's, both with the
  request's SQL condition (the CDS elements are columns of both), merged with
  `IsActiveEntity`, `HasActiveEntity`, `HasDraftEntity` -- an active row's
  `HasDraftEntity` (and so the list filter) is taken from every draft's key,
  not from the drafts that match the condition; the flag
  conditions of a `$filter` or key are applied to the merged rows, and the
  Fiori Elements list filter is recognised by the V4 facade
  (`ZCL_OSD_V4_QUERY=>GC_DRAFT_LATEST`) and handed on as "each instance once,
  its draft when it has one" -- in that spelling only, the whole filter or
  parenthesized and AND-ed with the rest; any other `SiblingEntity` filter
  is 501. A V4 key takes `IsActiveEntity=true|false`.
  `ZCL_OSD_RAP_SADL` maps `IsActiveEntity` to `%is_draft` and back, creates
  a draft for a POST to the root's set, discards for a DELETE of a draft
  root, and answers Edit with the draft and Activate with the active
  instance. The draft actions are bound actions named as in the BDEF
  (Discard is not: it is the DELETE), and stg-compile writes
  `Common.DraftRoot` (ActivationAction, EditAction, PreparationAction) on the
  root's set and `Common.DraftNode` on the child's.
- **Tests.** `ZCL_OSD_RAP_R8_TEST` (11): a draft created and read with EML
  `%is_draft`, saved unvalidated into the draft tables with its admin row;
  Activate (and the validation and the mandatory field that stop it); Edit,
  a change of the draft, Activate; the draft holding the active instance
  (second Edit a conflict, an update of the active one locked); Discard; a
  leg deleted in the draft and so in the active tree; the total ETag
  conflict; Resume and Prepare. `test/rap-r8.mjs`: the generator half and
  the V4 flow Fiori Elements sends, from `$metadata` to Discard, and the V2
  key.

### The measurement: the flight BDEFs before and after

`node tools/rap-flight/constructs.mjs`, first wall per behavior definition:

| BDEF | after R7 | after R8 |
| --- | --- | --- |
| `/DMO/I_SUPPLEMENT` | `association { with draft; }` (draft) | **accepted** by the generators; not run or served here (its pool's early numbering of drafts, the projection `use draft`: R9) |
| `/DMO/C_SUPPLEMENT` | the base's draft | a projection's field control other than readonly (`field ( modify )`), then `use draft` |
| `/DMO/R_AGENCYTP` | `draft action Resume` | response aliases must be ABAP identifiers (namespaced aliases), then late numbering |
| `/DMO/C_AGENCYTP` | the base's draft | the base's wall |
| `/DMO/I_CARRIERSLOCKSINGLETON_S`, `/DMO/C_CARRIERSLOCKSINGLETON_S` | unparsed singleton grammar | unchanged |
| `/DMO/I_AGENCYTP` | interface | unchanged |
| `/DMO/I_TRAVEL_M` and its projections | accepted | accepted |

Constructs whose verdict changed: `with draft` (4 BDEFs), `draft
determine action` (3), `total etag` (3, ignored before): refused -> runs;
new in the table: `draft table`, `draft action`, `association with draft`
(3 each, runs), `use draft` (3, refused).

### Unmeasured

Nothing of R8 was checked on a system. In particular: the V4 `$metadata`
of a RAP draft service (the action names, `SiblingEntity`,
`DraftAdministrativeData` and their properties); the draft table's admin
column types and `DRAFTENTITYOPERATIONCODE`'s values; what EML answers for
a draft action (here a `$self` result); whether a system validates
mandatory fields on Activate the way this runtime does; what Prepare runs
for a draft without changes; how a system words the total ETag conflict
and the "has a draft" lock; that a POST to a draft root's set always makes
a draft.

### Not in R8 (R9)

R9 (below) did the navigations, the admin entity, the "locked by another
user" filter, the app, and the owner part of the third item; the rest stays.

- `SiblingEntity` and `DraftAdministrativeData` as navigation properties
  (the admin data is written, not served), and the admin entity's
  `DraftIsCreatedByMe`-style fields; the "locked by another user" list
  filter;
- the Fiori Elements V4 app over the service, run in a browser (the wire is
  shaped and tested after what it sends, the app itself is not built);
- the exclusive lock as a durable enqueue with an owner and an expiry, and
  Resume taking it back; `with collaborative draft`;
- `use draft` and the draft actions of a projection; Prepare members of
  another entity (`Booking~validateCustomer`); `draft action ... with
  additional implementation`; feature control of draft actions;
- early and late numbering of drafts, `DRAFTFIELDCHANGES`, the draft
  table's `.INCLUDE` of the admin structure;
- V2 draft beyond the key: the function import names a V2 client expects
  and `Common.DraftRoot` over V2 (measured first);
- the flight's draft BOs (supplement, agency, carrier) built and served.

## R9: draft for a real Fiori Elements V4 app

R8 shaped the V4 draft wire after what Fiori Elements is documented to send;
R9 runs the app. `webapp/trip4` is a Fiori Elements V4 list report and
object page over the R8 trip demo `ZUI_RAP_DTRIP`, with nothing
draft-specific in it: sap.fe runs its own draft flow because the set is a
`Common.DraftRoot`. The requests it sends were captured from the running app
(SAPUI5 1.120.50, the version every app here bootstraps) and are each
served; `test/e2e/trip4.spec.mjs` drives it -- open the list, Create (a
draft), change a field, add a leg, Save (Prepare + Activate), Edit an active
trip, change it, Save; Edit, change, Discard; delete from the list; every
"Editing Status" value; another user's lock; the launchpad tile.

Nothing in this section was measured on a system either: the A4H capture of
a RAP draft service's V4 `$metadata` and a Fiori Elements trace against it
still waits for Alice's go ([oracle-draft.md](oracle-draft.md)). Where the
client decides (the request it sends) the capture is the authority; where
the server decides (names, types, status codes, who sees what) the choice is
named and marked **unmeasured**.

### What sap.fe sends, and what answers it

`$select`/`$expand` lists shortened; `(k,false)` is
`(trip_uuid='<32 hex>',IsActiveEntity=false)`. Every request but the
metadata and the token goes in a multipart `$batch`.

| Step | Request | Served by |
| --- | --- | --- |
| start | `GET $metadata?sap-language=EN`, `HEAD /` (token) | R8 |
| list | `GET Trip?$count=true&$select=HasActiveEntity,HasDraftEntity,IsActiveEntity,...&$filter=(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)&$expand=DraftAdministrativeData($select=DraftUUID,InProcessByUser,InProcessByUserDescription,LastChangedByUser,LastChangedByUserDescription)&$skip=0&$top=30` | R8 filter; **R9** the expand (the draft indicator: "Draft", "Locked by ALICE") |
| Create | `POST Trip` with `{}` | R8 (no key dialog: **R9** `Core.Computed` on the key) |
| object page | `GET Trip(k,false)?$select=...&$expand=DraftAdministrativeData($select=DraftIsCreatedByMe,DraftUUID,InProcessByUser)`; `GET Trip(k,false)?$select=DraftAdministrativeData&$expand=DraftAdministrativeData(...)` (a navigation property in `$select`); `GET Trip(k,false)/to_Legs?$count=true&$select=...&$skip=0&$top=10` | **R9** the expands; the rest R8 |
| field change | `PATCH Trip(k,false)` | R8 |
| leg | `POST Trip(k,false)/to_Legs`, then `PATCH Leg(k,false)` | R8 |
| Save | `POST Trip(k,false)/ZUI_RAP_DTRIP.Prepare` and `POST Trip(k,false)/ZUI_RAP_DTRIP.Activate?$select=...&$expand=DraftAdministrativeData(...)` in one change set; then `GET Trip(k,true)?$select=DraftAdministrativeData&$expand=...` and the legs | R8 actions; **R9** the expands |
| after a create | the active trip by its semantic key, `#/Trip('<uuid>')` | the app's `Common.SemanticKey` |
| Edit | `POST Trip(k,true)/ZUI_RAP_DTRIP.Edit?$select=...&$expand=...` (`{"PreserveChanges":true}`) | R8; **R9** the owner |
| Discard | `GET Trip(k,false)/SiblingEntity`, then `DELETE Trip(k,false)`, then `GET Trip(k,true)` | **R9** `SiblingEntity`; R8 the DELETE |
| delete in the list | `DELETE Trip(k,true)` | R5 |
| Editing Status | the six filters below | **R9** |

Not seen in the captured flows, so not built for them: a call of `Resume`
(the action is served since R8), `Discard` as an action (the DELETE replaces
it), a read of its own for the draft indicator's popover (the list's expand
already carries the admin data).

### `SiblingEntity` and `DraftAdministrativeData`

`srvd-gen.mjs` gives every entity of a draft BO two navigation properties,
both to 0..1, neither a CDS association, resolved by the SADL data provider
(`zcl_stg_sadl_dpc`, `draft_navigation`):

- **`SiblingEntity`**: the other version of the same instance -- a draft's
  active instance, an active instance's draft. Of the user's own draft only
  (below); nothing (204, `null` in an expand) when there is none. It is not
  its own `Partner` in `$metadata`.
- **`DraftAdministrativeData`**: the admin row of the instance's draft, of
  a draft and of an active instance that has one (also another user's: that
  is how the list says "Locked by ALICE"); nothing otherwise.

The admin data is an entity set of the service, `DraftAdministrativeData`
of type `DraftAdministrativeDataType` (**unmeasured**: a system's set and
type names, and whether the UUID is `Edm.Guid`; here `Edm.String` of 32 hex
digits like every RAW16 key), read through `ZOSD_I_DRAFTADM`, a view over
`ZOSD_DRAFT_ADM` under the element names of the public draft vocabulary:
`DraftUUID`, `DraftEntityType`, `CreationDateTime`, `CreatedByUser`,
`LastChangeDateTime`, `LastChangedByUser`, `InProcessByUser` (columns), and
the virtual elements `CreatedByUserDescription`,
`LastChangedByUserDescription`, `InProcessByUserDescription` (the user name:
there is no user master) and `DraftIsCreatedByMe`, `DraftIsLastChangedByMe`,
`DraftIsProcessedByMe` (`Edm.Boolean`, against the request's user), filled
by `ZCL_OSD_DRAFT_ADM_CALC`. The two date-times are `Edm.DateTimeOffset`
over the `DEC 21,7` columns. Not served: `ProcessingStartDateTime`,
`EnqueueStartDateTime`, `DraftAccessType`, `DraftIsKeptByUser` (sap.fe 1.120
did not ask for them).

### `Core.Computed`

sap.fe asks for every key that is not `Core.Computed` in a dialog before it
creates a draft -- here `trip_uuid` and `IsActiveEntity`, which nobody can
type. On a draft-enabled entity type (`IsActiveEntity` in its key) the V4
facade now annotates each property the model makes neither creatable nor
updatable `Core.Computed`: the managed key, the readonly fields, the draft
flags. Other services are unchanged (**unmeasured**: the exact set a system
annotates; RAP's documented mapping of `readonly` is `Core.Computed`).

### The owner

A draft belongs to a user. On a system that user is `SY-UNAME`, from the
logon; here there is no logon and one `SY-UNAME` per process, so R9 adds
**`src/logon`** (`ZCL_OSD_LOGON`): the HTTP fronts set the request's user
from the user name of its `Authorization: Basic` header (the password is not
checked: this is **identification, not authentication** -- anyone who
names ALICE acts as ALICE, as with the rest of this tree's HTTP, which has
no authentication and binds to loopback by default). The fronts clear it
again when the request is answered, so without a credential, and outside a
request (EML, ABAP Unit, jobs), it is `SY-UNAME` as before
(`ZCL_OSD_LOGON=>SET` switches it in a test). `SY-UNAME` itself is not
changed: locks, enqueue owners, logs and the system identity keep it.

- The admin row's `CREATEDBYUSER`, `INPROCESSBYUSER` and
  `LASTCHANGEDBYUSER` are that user.
- So are the managed administrative `*_BY` fields (`@Semantics.user.createdBy`,
  `lastChangedBy`, `localInstanceLastChangedBy`) of **every** managed RAP BO
  written over OData, draft-enabled or not: a request with Bob's Basic
  credential stamps `BOB` where it stamped `SY-UNAME` before.
- **The owner lock.** A change of a draft instance (update, delete, create
  by association below it), and Activate, Discard, Resume and Prepare of
  it, by any user other than its `INPROCESSBYUSER`, is refused: FAILED with
  cause `locked`, REPORTED "trip ... is a draft of user ALICE". Edit of an
  active instance another user has a draft of is refused the same way ("...
  is locked by user ALICE"); the owner's own second Edit stays R8's
  `conflict`. The owner goes on -- changes, Resume, Activate, Discard -- as
  before. `ZCL_OSD_RAP_R9_TEST`.
- **Who sees a draft.** The draft-enabled union (`ZCL_OSD_RAP_DRAFT`)
  serves a user their own drafts only (created by or in process by them).
  Another user's draft is not read, not reachable through `SiblingEntity`
  and so not changed over OData: a GET, PATCH, DELETE or action on it is a
  404. Its active instance still says `HasDraftEntity` true and names the
  draft's admin data. That is what the Editing Status values of sap.fe
  presuppose (an active instance "locked by another user" has
  `SiblingEntity` null). **Unmeasured**: the status a system answers for
  another user's draft by key (404 here) and for the refused Edit (400 here,
  as every RAP refusal since R5).
- A navigation from a source that is not there -- a version that does not
  exist, or another user's draft -- is a 404; a source that is there
  without the related entity is a 204 (`null` in an expand).
- No expiry: a draft holds its instance until it is activated or discarded,
  so "Unsaved Changes by Another User" (a draft whose exclusive lock has run
  out, `InProcessByUser` empty) never occurs; the filter is served and
  answers nothing. Taking over another user's draft is not built.

### The Editing Status filter

Captured from the filter bar's "Editing Status" field:

| Value | `$filter` sap.fe sends | Here |
| --- | --- | --- |
| All | `(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)` | R8's latest-version condition, per user since R9 |
| All (Hiding Drafts) | `IsActiveEntity eq true` | a flag (R8) |
| Unchanged | `IsActiveEntity eq true and HasDraftEntity eq false` | flags (R8) |
| Own Draft | `IsActiveEntity eq false` | a flag; only own drafts are served |
| Locked by Another User | `IsActiveEntity eq true and SiblingEntity/IsActiveEntity eq null and DraftAdministrativeData/InProcessByUser ne '' and DraftAdministrativeData/InProcessByUser ne null` | **R9** |
| Unsaved Changes by Another User | `IsActiveEntity eq true and SiblingEntity/IsActiveEntity eq null and DraftAdministrativeData/InProcessByUser eq ''` | **R9** (empty: no expiry) |

The V4 facade (`ZCL_OSD_V4_QUERY`, `draft_paths`) takes the navigation
conditions out of the filter when they are top-level conjuncts (also inside
a parenthesized group of ANDs) and hands them to the data provider as
conditions on three columns of the union's rows: `SIBLINGENTITY` (the other
version is there for this user), `DRAFTADMIN` (there is admin data) and
`INPROCESSBYUSER`. A navigation to nothing is null, and a comparison with
null is false except `eq null` / `ne null`, so `InProcessByUser ne ''`
alone (true without admin data) is taken only beside `ne null`; any other
condition through either navigation, or one under a top-level `or`, stays
501.

### Not in R9

- The A4H oracle: a RAP draft service's V4 `$metadata` and an sap.fe trace
  against it (pending Alice's go); everything marked unmeasured above.
- The lock's expiry, Resume taking it back, taking over another user's
  draft, `with collaborative draft`; a durable enqueue.
- The rest of R8's list: `use draft` and projection draft actions, Prepare
  members of another entity, `with additional implementation`, draft action
  features, early and late numbering of drafts, `DRAFTFIELDCHANGES`, the
  `.INCLUDE` of the admin structure, V2 draft beyond the key, the flight's
  draft BOs.
- Side effects, value helps and messages of a draft app beyond what sap.fe
  showed here; UI annotations from metadata extensions (the app carries a
  local annotation file).

## Not in R2

EML; draft; unmanaged save, `with additional save`,
`with unmanaged save`; early/late numbering through the pool and
`adjust_numbers`; associations and compositions (R1 refuses them); static,
factory and internal actions, action parameters and results other than
`$self`; functions; delete triggers; feature and authorization control; locks
and ETags; projections. Each is refused by the generator or ignored as listed
above. R4 (above) adds the ETag, instance features and early numbering.
