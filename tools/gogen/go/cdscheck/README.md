# cdscheck

The diagnostic subset of `parseDDLS`, `viewFieldsOf` and `ddlsIssues`, preserving
extra issue ordering, source resolution, unsupported view shapes and E/W mapping.
Inputs come from the original translated CDS parser and dictionary types through
a copied `Inspector` snapshot. This package does not parse CDS text itself.
The generated bridge uses abapiti PR #246’s CDS, DDIC and Files APIs directly.
SQLView preserves nil (absent) versus a pointer to an empty name, matching Node’s
nullish fallback to the CDS object name.

The branch audit is in `docs/native-cdscheck-audit.md`. Table-driven Go tests
consume the critic's Objects/Expected fact shape; the independent Node differential
also copies real parser facts and compares original ddlsIssues output. The linked
CHECK/OUTLINE differential retains blank/valid/absent class and named-client cases.
Only diagnostic dependencies are retained: EDM/label/association metadata and
viewFieldsOf's client=false generator-only option do not affect this policy.
