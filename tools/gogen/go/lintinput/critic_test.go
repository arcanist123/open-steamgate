package lintinput

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

func criticWrite(t *testing.T, root, file, raw string) {
	t.Helper()
	at := filepath.Join(root, file)
	if err := os.MkdirAll(filepath.Dir(at), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(at, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
}

func criticFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for file, raw := range map[string]string{
		"abap_transpile.json":  `{"input_folder":["base","gen"],"libs":[]}`,
		"abaplint.jsonc":       `{"syntax":{"version":"v702"}}`,
		"libs.lock.json":       `{"libraries":[]}`,
		"base/ztest.prog.abap": "REPORT ztest.",
	} {
		criticWrite(t, root, file, raw)
	}
	return root
}

// Test both a mutation before startup and after a healthy prime/CHECKRUN.
func criticLifecycle(t *testing.T, root string, spec Spec, mutate func(), restore func()) {
	t.Helper()
	Resolve = nil
	calls := 0
	engine := storelint.Engine{Prime: func([]objstore.LintFile, string) {}, Update: func(string, *string) {}, Check: func(string) []storelint.Issue { calls++; return nil }}
	req := storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true, Input: storecheck.Input{Root: root, CheckRun: true, Type: "PROG", Name: "ZTEST", Logical: []string{"base/ztest.prog.abap"}}}
	for _, startup := range []bool{false, true} {
		c := New(root, nil, engine, spec)
		if startup {
			mutate()
		}
		if err := c.Prime(spec.Config); err != nil && (!startup || !strings.Contains(err.Error(), "rebuild")) {
			t.Fatal(err)
		}
		if !startup {
			r, err := storecheck.Run(c, req)
			if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"processed"`) {
				t.Fatal(r, err)
			}
			mutate()
		}
		before := calls
		r, err := storecheck.Run(c, req)
		if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"notProcessed"`) || !strings.Contains(r.Scalars["EV_JSON"], "rebuild") || calls != before {
			t.Fatalf("startup=%v calls=%d before=%d result=%+v err=%v", startup, calls, before, r, err)
		}
		restore()
	}
}

func TestCriticUnnamedPackageLifecycle(t *testing.T) {
	root := criticFixture(t)
	criticWrite(t, root, "base/.abapgit.xml", "<abapGit><STARTING_FOLDER>/</STARTING_FOLDER></abapGit>")
	criticWrite(t, root, "base/package.devc.xml", "<DEVC><CTEXT>Root package</CTEXT></DEVC>")
	criticWrite(t, root, "base/zcl_one_first.clas.abap", "CLASS zcl_one_first DEFINITION PUBLIC. ENDCLASS.")
	spec := buildSpec(t, root)
	criticLifecycle(t, root, spec, func() {
		criticWrite(t, root, "base/zcl_other_first.clas.abap", "CLASS zcl_other_first DEFINITION PUBLIC. ENDCLASS.")
	}, func() {
		if err := os.Remove(filepath.Join(root, "base/zcl_other_first.clas.abap")); err != nil {
			t.Fatal(err)
		}
	})
}
