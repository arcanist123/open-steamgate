# OData V4 facade

This package serves `/sap/opu/odata4/sap/<service>/` for the same service
registrations as V2. It uses the existing MPC model, model-info registry,
DPC read and write methods, entry provider, request context and filter parser. It does not implement
the `/IWBEP/` V4 provider API.

- `ZCL_OSD_V4_MODEL`: V4 property types/facets, ETag properties and CSDL XML,
  including the MPC's vocabulary annotations (`vocab_anno_model`).
- `ZCL_OSD_V4_QUERY`: resource/query validation (entity sets, keys, one
  navigation segment, an operation segment with its parameters), `$expand`
  items with the options inside their parentheses, `$select` paths,
  `$search` terms, and V4 literals adapted to the existing select-options
  contract.
- `ZCL_OSD_V4_JSON`: typed JSON without V2 envelopes or deferred links.
- `ZCL_OSD_V4_WRITE`: POST/PATCH/PUT/DELETE through the DPC
  create/update/delete, deep insert through `create_deep_entity`, typed V4
  body values (ajson; `CONVERT` is the scalar converter the operations
  share), ETags and `If-Match` under the entity lock `EZOSD_V4_LOCK` (table
  `ZOSD_V4_LOCK`).
- `ZCL_OSD_V4_PROVIDER`: the entry provider those writes hand the DPC (a deep
  insert's related entities through the V2 provider's nested fill).
- `ZCL_OSD_V4_ACTION`: the model's function imports as bound and unbound
  actions and functions (CSDL, imports, invocation through `execute_action`,
  result serialization).
- `ZCL_OSD_V4_BATCH`: JSON `$batch` (atomicity groups as LUWs, `dependsOn`,
  `$<id>` references) and multipart `$batch` (parsed by the V2
  `ZCL_STG_BATCH`, a change set becomes an atomicity group).
- `ZCL_OSD_V4_STICKY`: sticky-session editing for Fiori Elements V4
  (`Session.StickySessionSupported`): Edit/Save/New bound actions, the
  unbound Discard, a per-session buffer keyed by `SAP-ContextId`.
- `ZCL_OSD_V4_HTTP`: dispatch (one LUW per modifying request), HEAD and
  the CSRF token, collection counts/paging, `$search`, reads through a
  navigation property and expansion through DPC navigation calls, each
  expanded navigation read as a query of its target set (nested options and
  levels). Raw queries reuse the existing
  `ZCL_OSD_FORM` decoder (the shim name/plus gap is logged in ANORMALIES).
- `zosd_odata4.sicf.xml`: mounts the handler through the existing SICF
  registry in the inline server, child server and browser preview.

The classes use the current `OSD` prefix. All new runtime objects are here;
V2 sources and service implementations are unchanged. The shared response
structure and navigation JSON pair type are data contracts, not V2 output.

See [the consumer contract](../../docs/odata-v4.md) for supported requests,
limits and next slices. Wire coverage lives in `test/odata-v4.mjs` with a
small synthetic literal/facet service in `test/v4/` (with a writable
`NoteSet` that carries an ETag, stored in `ZOSD_V4_NOTE`). The Fiori Elements V4
consumer is `webapp/travel4` with `test/e2e/travel4.spec.mjs`.
