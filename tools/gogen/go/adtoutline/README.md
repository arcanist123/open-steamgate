# adtoutline

A port of `programParts`, `classParts`, `structureOf` and OUTLINE's row encoder
in `tools/adt-documents.mjs` and `tools/osd-store-destination.mjs`. It consumes
copied abapiti Tree values through neutral types, with no generated library or
ABAP runtime dependency. Array order, owning classes, include links, raw program
coordinates, identifier/block coordinate differences and JSON insertion order
follow the Node producer. Snapshot selection and freshness belong to storelint.
