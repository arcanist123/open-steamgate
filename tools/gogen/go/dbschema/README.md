# dbschema -- the schema stamp of a database file

ADR 0010 slice 4 ("The database across generations"). A file is stamped in
`osd_schema` (the Node host's table, `tools/osd-persist.mjs`, plus a `seed`
column) with the **fingerprint of the DDL** a build describes and, apart from
it, the mark of the seed rows that went in. Since the mark is no longer the
whole script, a generation whose tables are the same opens a file another
generation serves even when its seed rows differ (the seed runs only into an
empty file), and a generation whose tables differ is refused: a host refuses
the file, a candidate generation refuses the swap.

API: `Fingerprint(stmts)` (16 hex of the SHA-256 of the DDL statements joined
by `\n`, the same value as `fingerprintOf` on Node), `IsDDL`, `StampOf(db)`,
`Stamp(db or tx, fingerprint, seed)`, `Check(db, path, stmts, scriptMark)` ->
`adopt` or an `*Error`. A file from before the stamp carries only `PRAGMA
user_version` (the whole script's mark): the build whose script made it adopts
it and stamps it; any other is refused as before.

Callers: `go/abap` `OpenDBFile` (seed, stamp, check) and `OpenDBCandidate`
(check only, read-only). No import of `go/abap`.

```sh
go test ./dbschema/ ./abap/ -run 'Fingerprint|OpenDB'
```
