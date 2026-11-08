# RAP note demo

An original managed BDEF over `ZRAP_NOTE`, run by the managed RAP runtime
([docs/rap-runtime.md](../../docs/rap-runtime.md)). No corpus source was
copied.

- `NoteId` is a UUID (`numbering : managed`), `Status` is read-only,
  `NoteText` mandatory.
- `SetStatus` (on modify, create) sets the default status `N`.
- `Normalize` (on save, field NoteText) condenses the text.
- `CheckText` (on save) rejects a text shorter than three characters; then
  nothing is written.
- `Approve` sets the status to `A` and returns the note (`result [1] $self`).
- `lsc_note` records the saver phases in `ZBP_RAP_NOTE=>PHASES`.
- `ZUI_RAP_NOTE` (service definition) exposes it as `Note`: the service
  `ZUI_RAP_NOTE` over V2 (read-write, `Approve` as a function import) and
  V4 (read), `test/rap-serve.mjs`.

`ZBP_RAP_NOTE`'s `lhc_note` uses explicit derived signatures (R1); its methods
are bound to the BDEF by name. `test/unit/zcl_osd_rap_test` drives it through
`ZCL_OSD_RAP_RUNTIME`; `npx mocha test/rap-derived-types.mjs
test/rap-runtime-gen.mjs` checks the types and the generated adapter.
