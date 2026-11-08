# ADT data preview SQL on OSGo

`adtpreview` answers the SYSTEM kinds `SQL` and `SQLCHECK` that
`ZCL_OSD_ADT_FREESTYLE=>SQL` sends through `ZOSD_STORE`, so the ABAP data
preview routes (`/sap/bc/adt/datapreview/freestyle`, `ddic`, `cds`) run on
OSGo as they do on Node's serving child. It is the Go form of
`tools/adt-preview-sql.mjs`, `tools/adt-single-select.mjs` and the
`Data.query` / `Data.check` seams of `tools/osd-data.mjs`:

- one SELECT only, refused with `NOT_ALLOWED` otherwise. `SingleSelect` lexes
  as SQLite does (no dollar quotes, no backslash escapes, block comments do
  not nest; Node's guard knows PostgreSQL's forms too, which on SQLite would
  hide a second statement), and the text actually sent is proven to be one
  statement by SQLite's own tokenizer (`sqlite3_complete` over each `;`),
  because the driver runs every statement of a text. Without SQLite (wasm,
  `nodatabase`) any `;` is refused;
- the Open SQL spellings rewritten (`OpenSQLToSQL`, `SQLite`: comma-less
  lists, `UP TO n ROWS`, `~`, `ORDER BY PRIMARY KEY`, `ASCENDING`, `LEFT`/`RIGHT`);
- at most `limit` rows (absent: 100, `""`: 0 as Node's `Number`; a negative
  or non-numeric limit is 100 here, where Node would send an unbounded
  `LIMIT` or an SQL error), cells rendered as the Node host renders them
  (bytes as upper-case hex, NULL empty, trailing blanks trimmed);
- run inside `SAVEPOINT osd_adt_preview` on the calling step's transaction
  with `PRAGMA query_only` on, rolled back to on failure, so a preview can
  neither write nor leave a failed step behind.

`cmd/osgo` puts `Provider` behind the request's `adtsystem` provider (`Behind`) and sets
`abap.ADTPreview` under `-adt`, which makes `ZCL_OSD_ADT_HOST=>ONE_RUNTIME`
true and mounts the routes. The package depends on `database/sql`, the SQLite library's tokenizer and
`objstore`'s provider interface, not on `go/abap`.
Run `go test ./adtpreview` and `go vet ./adtpreview` from the Go module.
