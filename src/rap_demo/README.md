# RAP note compiler demo

An original managed BDEF over `ZRAP_NOTE`, with create/update/delete, Approve,
SetStatus and CheckText. No corpus source was copied.

`ZBP_RAP_NOTE` has an `lhc_note` class whose explicit signatures cover the
R1 derived types. The local class deliberately has ordinary methods: implicit
`FOR MODIFY` / `FOR DETERMINE` / `FOR VALIDATE` handler parameters still need
upstream syntax support or a separate lowering stage. No handler dispatch,
persistence, EML or transactional runtime is supplied here (R2).

Run `npx mocha test/rap-derived-types.mjs`; the test lints and transpiles the
demo through the real source loader, without compiling the whole system.
See [derived types](../../docs/rap-derived-types.md).
