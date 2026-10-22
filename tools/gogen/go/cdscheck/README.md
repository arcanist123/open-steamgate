# cdscheck

The diagnostic subset of `parseDDLS`, `viewFieldsOf` and `ddlsIssues`, preserving
extra issue ordering, source resolution, unsupported view shapes and E/W mapping.
Inputs come from the original translated CDS parser and dictionary types through
a copied `Inspector` snapshot. This package does not parse CDS text itself.
`tools/step3/cds-inspect.mjs` installs the pinned extraction adapter alongside the
emitted library because upstream Tree deliberately returns no non-ABAP trees.
