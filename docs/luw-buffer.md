# The transactional buffer

Backlog B.2. What holds changes until they are saved, and what a reader sees
while they are held.

## Why it is a level of its own, and not "a draft without persistence"

A buffer and a draft look alike from outside — both hold changes that are not
in the database yet — and treating them as one thing with two lifetimes is the
mistake that makes the draft a rewrite. They are two levels:

- **the buffer** lives exactly one LUW. `modify` collects, the save sequence
  runs — determinations, validations, then the write — and only then do rows
  reach the database.
- **a draft** lives *between* requests, in a table of its own, and is
  activated by an action. That activation **runs in the buffer**, because
  activating re-runs the behaviour.

So a draft stands on a buffer rather than replacing it. Fold them together and
there is nowhere for the save sequence to happen, which is a thing you find
out at the first validation rather than at design time.

What carries between them is the **delta**: entity, key, operation, the row
after. It is serialisable from the first day, so persisting it later is a
change of storage and not of model — and the merge of delta with active data
is written **against the delta**, never against the storage, or it has to be
written twice.

## What it holds

`ZIF_OSD_LUW`, implemented by `ZCL_OSD_LUW`:

```abap
mi_luw->modify( iv_entity = 'Travel' iv_key = 'T1' iv_operation = 'C' ir_row = lr_row ).
mi_luw->operation_of( iv_entity = 'Travel' iv_key = 'T1' ).   " C / U / D, or initial
mi_luw->row_of( iv_entity = 'Travel' iv_key = 'T1' ).
mi_luw->delta( ).                                             " in the order recorded
```

The key is the entity's key **rendered as text**, which is what lets two
changes to the same row be recognised without the buffer knowing the row's
type. The row itself travels as `REF TO data`.

## Collapsing, which is the whole job

Collecting changes is not the hard part; collapsing two changes to the same
row is. Each of these would be wrong if the buffer simply appended:

| first | then | held as | why |
| --- | --- | --- | --- |
| create | update | **create**, later row | saving it as an update finds nothing to update |
| create | delete | **nothing** | the row never existed |
| update | delete | **delete** | |
| **delete** | **create** | **update**, new row | the row ends up present and different |

The last one is the one that is easy to get wrong, and it is the reason this
has tests before it has callers. A delete followed by a create of the same key
is not two changes to replay: replaying them would delete what had just been
written. It is one row that is there, with new content.

A create stays a create however often it is updated afterwards. Everything
else takes the later operation.

## The bracket, and what ends it when nothing catches

One modifying request is one LUW. `ZCL_STG_HTTP_HANDLER` opens with a fencing
`COMMIT WORK` -- nothing in this system commits on its own, so without it a
later `ROLLBACK WORK` would reach back to whatever the process last wrote,
including the tables the generation writes at boot -- and closes with a
`COMMIT WORK` or, when the answer is 400 or worse, a `ROLLBACK WORK`.
`ZCL_STG_BATCH` does the same around a changeset, which is why `$batch` is
excluded from the handler's bracket: the changesets own their own.

That covers every failure the dispatcher *catches*. It does not cover the
failure it does not: an exception nobody declared -- a conversion, a missing
table line, a zero divide -- is none of the four gateway families
`zcl_stg_dispatcher=>dispatch` catches, so it unwinds straight past the
`ROLLBACK WORK` below it. The rows the request had already written stay
pending on the connection, uncommitted and invisible; the **next** modifying
request opens with its fencing `COMMIT WORK` and adopts them. A half-write
becomes permanent one request later, and nothing in between looks wrong.

Ending the LUW on a dump is the **kernel's** job, not the application's: on a
system such an exception is a short dump, and a dump rolls the LUW back. So
the rule lives in `tools/osd-dialog-step.mjs`, in one file, and every host
that runs the ABAP calls it -- `tools/osd-serve.mjs` (the binary and the work
processes), `test/start.mjs`'s inline front, and `web/preview-backend.mjs`.
Until 2026-09-18 only the first of the three had it, which is the part worth
remembering: the rule had been written down once, correctly, next to one
caller. Two other hosts were written afterwards and neither copied it, and
nothing said so, because the half-write is silent by construction.

`test/mocha.mjs`, "a request that dumps leaves nothing behind, not even for
the next write", is the reproduction: a changeset whose first request writes a
row and whose second sets `Seats` to `"abc"`, then an ordinary write, then a
read of the first row. It fails without the bracket and passes with it.

### What the bracket still does not reach

- **A function import declared as a GET.** The handler brackets by method, so
  an action mapped to `GET` -- which SEGW allows and some services use --
  writes outside the bracket entirely. Neither the fence nor the rollback
  applies to it. Declaring such an operation `POST` is the fix at the model
  level; bracketing by *what the operation does* rather than by its verb is
  the fix at the runtime level, and it is not built.
- **Two modifying requests in one work process.** They share a connection, so
  their brackets are not isolated from each other. Nothing in the suite
  interleaves them today, so this is not known to be broken -- it is known to
  be unmeasured, which is a different thing.

## What is not built yet

- **The save sequence, outside RAP.** `delta( )` gives the changes in order.
  For a managed RAP behavior definition `ZCL_OSD_RAP_RUNTIME` runs
  determinations and validations over them and writes them
  ([docs/rap-runtime.md](rap-runtime.md)); nothing else does yet.
- **Reading through the buffer.** `operation_of` and `row_of` are the two
  answers a reader needs, but the SADL DPC does not consult them yet, so a
  read still goes straight to the database.
- **Draft.** The delta is shaped for it; the table and the activation action
  are not written.
