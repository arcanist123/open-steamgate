package lintinput

import (
	"context"
	"os"
	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
	"path/filepath"
	"strings"
	"testing"
)

func TestCriticEncodedNamespaceOverride(t *testing.T) {
	root := t.TempDir()
	write := func(file, raw string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	repo, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(repo, "tools"), filepath.Join(root, "tools")); err != nil {
		t.Fatal(err)
	}
	write("abap_transpile.json", `{"input_folder":["src"],"libs":[{"folder":"/lib","files":"/src/**"}]}`)
	write("abaplint.jsonc", `{"syntax":{"version":"v702"}}`)
	write("libs.lock.json", `{"libraries":[]}`)
	write("src/ztest.prog.abap", "REPORT ztest.")
	write("lib/src/%23acme%23zif_dep.intf.abap", "INTERFACE /acme/zif_dep PUBLIC. METHODS library_method. ENDINTERFACE.")
	spec, err := Resolve(root)
	if err != nil {
		t.Fatal(err)
	}
	var registry []objstore.LintFile
	identity := func(f string) bool {
		return strings.ReplaceAll(strings.ToLower(filepath.Base(f)), "%23", "#") == "#acme#zif_dep.intf.abap"
	}
	engine := storelint.Engine{
		Prime: func(files []objstore.LintFile, _ string) { registry = append([]objstore.LintFile{}, files...) },
		Update: func(name string, raw *string) {
			if raw != nil {
				registry = append(registry, objstore.LintFile{Filename: name, Raw: *raw})
			}
		},
		Check: func(string) []storelint.Issue {
			for _, f := range registry {
				if identity(f.Filename) {
					return []storelint.Issue{{Filename: f.Filename, Message: f.Raw}}
				}
			}
			t.Fatal("missing interface")
			return nil
		},
	}
	c := New(root, nil, engine, spec)
	if err := c.Prime(spec.Config); err != nil {
		t.Fatal(err)
	}
	write("src/#acme#zif_dep.intf.abap", "INTERFACE /acme/zif_dep PUBLIC. METHODS project_method. ENDINTERFACE.")
	fresh, err := Resolve(root)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := objstore.CaptureLintView(root, fresh.Store, fresh.Hidden)
	if err != nil {
		t.Fatal(err)
	}
	var want objstore.LintFile
	for _, f := range snapshot.Files {
		if identity(f.Filename) {
			want = f
			break
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		rows, err := c.Check(context.Background(), storecheck.Input{Root: root, CheckRun: true, Type: "PROG", Name: "ZTEST", Logical: []string{"src/ztest.prog.abap"}})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("rows=%+v fresh=%+v", rows, want)
		if len(rows) != 1 || rows[0].MESSAGE != want.Raw || rows[0].FILE != want.Filename {
			t.Fatalf("encoded namespace bypasses competing membership detection")
		}
	}
}

func TestEncodedNamespaceNeedsLayers(t *testing.T) {
	library := "/lib/%23acme%23zif_dep.intf.abap"
	project := "/src/#acme#zif_dep.intf.abap"
	snapshot := objstore.LintSnapshot{Files: []objstore.LintFile{{Filename: project}, {Filename: library}}}
	if !NeedsLayers(t.TempDir(), Spec{Files: []string{library}}, snapshot) {
		t.Fatal("encoded competitor missed")
	}
	if NeedsLayers(t.TempDir(), Spec{Files: []string{project, library}}, snapshot) {
		t.Fatal("unchanged competing files resolved again")
	}
}
