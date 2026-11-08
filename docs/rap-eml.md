# EML over the managed runtime (R2a)

R2a of [the RAP plan](oracle-rap.md): the Entity Manipulation Language,
`MODIFY ENTITIES`, `READ ENTITIES`, `COMMIT ENTITIES` and `ROLLBACK
ENTITIES`, runs over [the managed runtime](rap-runtime.md). Two halves:

- **here**: `src/rap/zcl_osd_rap_eml`, the statements' semantics as static
  methods over `ZCL_OSD_RAP_RUNTIME`, and `src/rap/kernel_rap_eml`, the
  class the transpiled statements call. Both transpile and run today;
  `test/unit/zcl_osd_rap_eml_test` drives them without EML syntax.
- **in the transpiler**: `@abaplint/transpiler` parses the statements
  (abaplint, v754 and OpenABAP) and until now emitted
  `throw new Error("ModifyEntities, not supported, transpiler")` for
  `MODIFY` / `READ ENTITIES` and had no `COMMIT` / `ROLLBACK ENTITIES` at
  all. The patch lowering them onto `KERNEL_RAP_EML` is kept beside this
  repository until it is sent upstream ([upstream.md](upstream.md), "EML");
  the pinned transpiler does not carry it yet, so a class written with EML
  does not even transpile: `COMMIT ENTITIES` has no statement transpiler
  there and the build stops at `Statement CommitEntities not supported`.
  `src/rap_demo/zcl_rap_note_eml` is such a class; it is in the
  `exclude_filter` of `abap_transpile.json` (lint still reads it) until the
  pin moves, and its three tests run with the patched build (below).

```
npm run transpile                                 # under the lock
node tools/osd-unit.mjs CLAS ZCL_OSD_RAP_EML_TEST  # the facade and the kernel entry
node tools/osd-unit.mjs CLAS ZCL_RAP_NOTE_EML      # real EML: patched transpiler linked, the exclude line removed
```

## The calling convention

The transpiler lowers a `MODIFY` or `READ ENTITIES` statement to a
**`begin` with the statement's targets, then one call per operation**, in
the order of the statement, on `abap.Classes['KERNEL_RAP_EML']`, after the
guard the other statement kernels use (`CALL TRANSFORMATION`,
`AUTHORITY-CHECK`, `SCAN`):

```js
if (abap.Classes['KERNEL_RAP_EML'] === undefined) throw new Error("ModifyEntities, kernel class missing");
await abap.Classes['KERNEL_RAP_EML'].begin({bdef: new abap.types.String().set("ZI_RAP_NOTE"), mapped: ls_mapped, failed: ls_failed, reported: ls_reported});
await abap.Classes['KERNEL_RAP_EML'].modify({bdef: new abap.types.String().set("ZI_RAP_NOTE"), entity: new abap.types.String().set("NOTE"), operation: new abap.types.String().set("CREATE"), rows: lt_create, fields: new abap.types.String().set("NOTETEXT"), auto_fill_cid: abap.CharacterFactory.get(1, 'X')});
```

Names travel as ABAP strings, upper case; the `FROM` / `WITH` table and
the targets are the caller's data objects, passed as they are. `begin` is
the **statement boundary**: it clears the MAPPED / FAILED / REPORTED the
statement names and binds a scratch structure of the BDEF's response type
for each one it does not, so a statement's responses are its own and never
an earlier statement's, and SY-SUBRC after each operation is the
statement's so far (4 once any operation of it failed). A `RESULT` is the
operation's own, cleared by it. `commit` clears the targets it is given
before the save. Flags are `'X'`.

| Statement | Call | Parameters |
| --- | --- | --- |
| `MODIFY ENTITIES OF b ENTITY e CREATE\|UPDATE\|DELETE FROM t` | `modify` | `bdef`, `entity`, `operation` (`CREATE`/`UPDATE`/`DELETE`), `rows` |
| `... FIELDS ( f g ) WITH t` | `modify` | + `fields: "F,G"` |
| `... SET FIELDS WITH t` | `modify` | + `set_fields: 'X'` |
| `... CREATE AUTO FILL CID ...` | `modify` | + `auto_fill_cid: 'X'` |
| `... EXECUTE a FROM t [RESULT r]` | `execute` | `bdef`, `entity`, `action`, `rows`, `result` |
| `MODIFY ENTITIES OF b ... MAPPED m FAILED f REPORTED r` | `begin`, first | `bdef`, and `mapped`, `failed`, `reported` as named |
| `MODIFY ENTITY b ...` (short form) | as above | `entity` = `bdef` (the root) |
| `READ ENTITIES OF b ENTITY e FROM t RESULT r` | `read` | `bdef`, `entity`, `keys`, `result` |
| `... ALL FIELDS WITH t` | `read` | + `fields: "*"` |
| `... FIELDS ( f ) WITH t` | `read` | + `fields: "F"` |
| `READ ENTITIES OF b ... FAILED f REPORTED r` | `begin`, first | `bdef`, and `failed`, `reported` as named |
| `COMMIT ENTITIES` | `commit` | none |
| `COMMIT ENTITIES RESPONSE OF b FAILED f REPORTED r` | `commit` | `bdef`, `failed`, `reported` |
| `COMMIT ENTITIES RESPONSES FAILED f REPORTED r` | `commit` | `failed`, `reported` (generic late responses, see below) |
| `ROLLBACK ENTITIES` | `rollback` | none |

Not lowered, and said so at run time with the addition's name (`throw new
Error("ModifyEntities BY, not supported, transpiler")`): the dynamic form
`MODIFY ENTITIES OPERATIONS`, `CREATE BY \_assoc` and every other path
(deep EML), `RELATING TO`, `AUGMENTING`, `READ ... BY`, `LINK`, `READ ...
EXECUTE` (functions), `COMMIT ENTITIES IN SIMULATION MODE`. `IN LOCAL MODE`,
`PRIVILEGED` and `FORWARDING` are accepted and ignored: there is one buffer
and no authorization.

`ZCL_OSD_RAP_EML` has the operation methods with `iv_` / `cs_` names and
non-optional targets, and no statement boundary: a direct caller owns its
structures. `KERNEL_RAP_EML` is the thin entry that holds the open
statement's bindings (until the next `begin`, `commit` or `rollback`, or
a `reset` of the session) and forwards; an operation called without a
`begin` gets scratch of its own.

The targets must be declared with a type (`TYPE TABLE FOR READ RESULT ...`,
`TYPE RESPONSE FOR FAILED EARLY ...`): abaplint types an inline `FAILED
DATA(f)` / `RESULT DATA(r)` of an EML statement as void, so the transpiler
emits a `Void type` error for the declaration before the statement runs.
That is on the abaplint side ([upstream.md](upstream.md), "EML").

## Semantics

- **The session.** `zcl_osd_rap_eml=>runtime( bdef )` creates one
  `ZCL_OSD_RAP_RUNTIME` per behavior definition on first use and keeps it:
  that is the transactional buffer the statements share across methods and
  classes, as on a system. `COMMIT ENTITIES` runs the save sequence of every
  runtime of the session, `ROLLBACK ENTITIES` makes every one forget its
  buffer; `reset( )` forgets the runtimes themselves (the tests, a new
  session). The gateway's request handling (R2c) is a consumer like any
  other: it can use the session or its own runtime.
- **FIELDS ( ... ) WITH** sets `%control` of every row to exactly the listed
  fields; a name that is not a field of the entity raises `ZCX_OSD_RAP`.
  **SET FIELDS WITH** sets `%control` from the fields that are not initial.
  **FROM** leaves the rows' `%control` as given. **AUTO FILL CID** gives a
  row without `%cid` one (`%AUTOn`), which comes back in MAPPED. The
  caller's table is not changed; the statement works on a copy. The
  automatic `%cid` is `%AUTO-` and a UUID, and a caller's `%cid` in that
  namespace is refused (`ZCX_OSD_RAP`), so the two cannot collide, as a
  system reserves its automatic prefix.
- **READ** returns every field for `FROM` and `ALL FIELDS WITH`; for
  `FIELDS ( ... ) WITH` the fields not listed are initial and the keys stay,
  and a name that is not a field of the entity raises `ZCX_OSD_RAP` before
  anything is read.
  The `%control` of the import rows is not read (a deviation: `FROM` on a
  system reads what the rows flag).
- **SY-SUBRC** after `COMMIT ENTITIES` is 0 when every save succeeded and 4
  when one failed (the public contract; 8, a late-save failure, does not
  occur here), and then the buffers are kept for a correction or a
  `ROLLBACK ENTITIES`, as the runtime keeps them. After `MODIFY` and `READ`
  it is 0 when the statement added no row to FAILED and 4 when it did: an
  **OSG convention**, not something the public documentation establishes
  for those two; portable code reads FAILED, as the demo does.
- **ROLLBACK ENTITIES** makes every runtime forget its buffer and, when the
  transaction held modifications, ends the LUW with `ROLLBACK WORK`, as a
  system does: a row written with SQL beside the RAP changes goes with
  them.
- **RESPONSE OF b** gets that definition's FAILED and REPORTED of the save;
  a `COMMIT ENTITIES` without it, over one definition, fills the kernel's
  scratch. The generic `RESPONSES FAILED f REPORTED r` tables are not
  filled: their row type is the generic late-response type, which the
  runtime does not produce.
- **Several definitions** in one session are saved one after the other,
  each in its own `COMMIT WORK`; a failure of the second does not undo the
  first. A system saves them in one LUW. One definition per transaction is
  what the demo and the gateway use; the gap is noted here rather than
  hidden.
- **Errors.** An unknown behavior definition, entity, action or field raises
  `ZCX_OSD_RAP` out of the statement (a system dumps).

## Not in R2a

Draft (`%is_draft`, draft actions), unmanaged save, deep EML (`%target`,
`CREATE BY`, `READ BY`), late numbering (`%pid`), functions (`READ ...
EXECUTE`), `IN SIMULATION MODE`, `RESPONSES` filling, `%control` on
`READ ... FROM`, one LUW over several definitions. The runtime's own limits
are in [rap-runtime.md](rap-runtime.md), "Not in R2".
