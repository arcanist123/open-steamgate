# OData V4 facade

This package serves `/sap/opu/odata4/sap/<service>/` for the same service
registrations as V2. It uses the existing MPC model, model-info registry,
DPC read and write methods, entry provider, request context and filter parser. It does not implement
the `/IWBEP/` V4 provider API.

- `ZCL_OSD_V4_MODEL`: V4 property types/facets, ETag properties and CSDL XML.
- `ZCL_OSD_V4_QUERY`: resource/query validation and V4 literals adapted to the
  existing select-options contract.
- `ZCL_OSD_V4_JSON`: typed JSON without V2 envelopes or deferred links.
- `ZCL_OSD_V4_WRITE`: POST/PATCH/PUT/DELETE through the DPC
  create/update/delete, V4 body values, ETags and `If-Match`.
- `ZCL_OSD_V4_BATCH`: JSON `$batch` (atomicity groups as LUWs, `dependsOn`,
  `$<id>` references); multipart answers 501.
- `ZCL_OSD_V4_HTTP`: dispatch (one LUW per modifying request), collection
  counts/paging and single-level expansion through DPC navigation calls. Raw queries reuse the existing
  `ZCL_OSD_FORM` decoder (the shim name/plus gap is logged in ANORMALIES).
- `zosd_odata4.sicf.xml`: mounts the handler through the existing SICF
  registry in the inline server, child server and browser preview.

The classes use the current `OSD` prefix. All new runtime objects are here;
V2 sources and service implementations are unchanged. The shared response
structure and navigation JSON pair type are data contracts, not V2 output.

See [the consumer contract](../../docs/odata-v4.md) for supported requests,
limits and next slices. Wire coverage lives in `test/odata-v4.mjs` with a
small synthetic literal/facet service in `test/v4/` (with a writable
`NoteSet` that carries an ETag).
