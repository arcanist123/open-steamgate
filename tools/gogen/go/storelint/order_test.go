package storelint

import (
	"osg/gogen/objstore"
	"testing"
)

func TestObjectIdentity(t *testing.T) {
	for file, want := range map[string]string{
		"/lib/%23acme%23zif_dep.intf.abap":     "/ACME/ZIF_DEP.INTF",
		"/src/#ACME#ZIF_DEP.INTF.abap":         "/ACME/ZIF_DEP.INTF",
		"/src/(acme)zif_dep.intf.abap":         "/ACME/ZIF_DEP.INTF",
		`C:\src\#acme#zif_dep.intf.abap`:       "/ACME/ZIF_DEP.INTF",
		"/src/z%3cfoo%3e.clas.locals_def.abap": "Z<FOO>.CLAS",
		"/src/z%3Cfoo%3E.clas.abap":            "Z%3CFOO%3E.CLAS",
		"/src/z%2ffoo.clas.abap":               "Z%2FFOO.CLAS",
		"/src/(a)(b).clas.abap":                "/A/(B).CLAS",
		"/src/no-extension":                    "",
	} {
		if got := ObjectIdentity(file); got != want {
			t.Errorf("%s: got %q want %q", file, got, want)
		}
	}
}

func TestEncodedNamespaceOrder(t *testing.T) {
	library := objstore.LintFile{Filename: "/lib/%23acme%23zif_dep.intf.abap", Raw: "library"}
	project := objstore.LintFile{Filename: "/src/#acme#zif_dep.intf.abap", Raw: "project"}
	if !competingOrderChanged([]objstore.LintFile{library}, []objstore.LintFile{project, library}) {
		t.Fatal("encoded addition missed")
	}
	if !competingOrderChanged([]objstore.LintFile{library, project}, []objstore.LintFile{project, library}) {
		t.Fatal("physical order change missed")
	}
	before := []objstore.LintFile{project, library}
	edited := project
	edited.Raw = "edited"
	if competingOrderChanged(before, []objstore.LintFile{edited, library}) {
		t.Fatal("byte edit changed order")
	}
}
