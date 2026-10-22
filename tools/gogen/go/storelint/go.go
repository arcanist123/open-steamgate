package storelint

import "osg/gogen/objstore"

// GoLibrary is the host-facing view of abapiti's generated Checker. The optional
// typed bridge converts its public File/Issue/Stats types; storelint itself
// never imports the external generated module.
type GoLibrary interface {
	Prime(files, deps []objstore.LintFile, config string)
	Check(filename string) []Issue
	Update(filename string, raw *string)
	Stats() Stats
}

// NewGoEngine shares the ABAP compiler's mapping, refusal, invalidation and
// overlay/restore lifecycle. OSG libraries remain checkable files, as in Node.
func NewGoEngine(library GoLibrary) Engine {
	return Engine{Name: "go", Entry: "abaplint.Checker.Check",
		Prime: func(files []objstore.LintFile, config string) { library.Prime(files, nil, config) },
		Check: library.Check, Update: library.Update, Stats: library.Stats,
	}
}
