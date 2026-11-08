# ADT data preview SQL on OSGo

`adtpreview` answers the SYSTEM kinds `SQL` and `SQLCHECK` that
`ZCL_OSD_ADT_FREESTYLE=>SQL` sends through `ZOSD_STORE`, so the ABAP data
preview routes (`/sap/bc/adt/datapreview/freestyle`, `ddic`, `cds`) run on
OSGo as they do on Node's serving child. It is the Go form of
`tools/adt-preview-sql.mjs`, `tools/adt-single-select.mjs` and the
`Data.query` / `Data.check` seams of `tools/osd-data.mjs`:

- one SELECT only (`SingleSelect`: comments blanked, quoted text opaque,
  nothing after `;`), refused with `NOT_ALLOWED` otherwise;
- the Open SQL spellings rewritten (`OpenSQLToSQL`, `SQLite`: comma-less
  lists, `UP TO n ROWS`, `~`, `ORDER BY PRIMARY KEY`, `ASCENDING`, `LEFT`/`RIGHT`);
- at most `limit` rows, cells rendered as the Node host renders them
  (bytes as upper-case hex, NULL empty, trailing blanks trimmed);
- run inside `SAVEPOINT osd_adt_preview` on the calling step's transaction,
  rolled back to on failure, so a failed preview leaves the step unchanged.

`cmd/osgo` puts `Provider` behind the request's `adtsystem` provider (`Behind`) and sets
`abap.ADTPreview` under `-adt`, which makes `ZCL_OSD_ADT_HOST=>ONE_RUNTIME`
true and mounts the routes. The package depends on `database/sql` and `objstore`'s provider interface, not on `go/abap`.
Run `go test ./adtpreview` and `go vet ./adtpreview` from the Go module.
