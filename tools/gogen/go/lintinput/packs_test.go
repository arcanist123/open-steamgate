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

func TestCriticLateDeclaredPackRoot(t *testing.T) {
	root := t.TempDir()
	realResolve := Resolve
	resolves := 0
	Resolve = func(root string) (Spec, error) { resolves++; return realResolve(root) }
	defer func() { Resolve = realResolve }()
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
	write("abap_transpile.json", `{"input_folder":["src"],"libs":[]}`)
	write("abaplint.jsonc", `{"syntax":{"version":"v702"}}`)
	write("libs.lock.json", `{"libraries":[]}`)
	write("src/zdep.intf.abap", "INTERFACE zdep PUBLIC. METHODS old_method. ENDINTERFACE.")
	write("packs/late/osd-pack.json", `{"name":"late","abap":["src","addon"]}`)
	write("packs/late/src/zother.prog.abap", "REPORT zother.")
	spec, err := Resolve(root)
	if err != nil {
		t.Fatal(err)
	}
	var registry []objstore.LintFile
	engine := storelint.Engine{
		Prime:  func(files []objstore.LintFile, _ string) { registry = append([]objstore.LintFile{}, files...) },
		Update: func(string, *string) { t.Fatal("unexpected update") },
		Check: func(string) []storelint.Issue {
			for _, f := range registry {
				if strings.HasSuffix(f.Filename, "/zdep.intf.abap") {
					return []storelint.Issue{{Filename: f.Filename, Message: f.Raw}}
				}
			}
			t.Fatal("no zdep")
			return nil
		},
	}
	c := New(root, nil, engine, spec)
	if err := c.Prime(spec.Config); err != nil {
		t.Fatal(err)
	}
	stable := resolves
	if _, err := c.Check(context.Background(), storecheck.Input{Root: root, CheckRun: true, Type: "INTF", Name: "ZDEP", Logical: []string{"src/zdep.intf.abap"}}); err != nil {
		t.Fatal(err)
	}
	if resolves != stable {
		t.Fatal("unchanged check launched resolver")
	}
	write("packs/late/addon/zdep.intf.abap", "INTERFACE zdep PUBLIC. METHODS new_method. ENDINTERFACE.")
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
		if strings.HasSuffix(f.Filename, "/zdep.intf.abap") {
			want = f
			break
		}
	}
	stable = resolves
	for attempt := 0; attempt < 2; attempt++ {
		rows, err := c.Check(context.Background(), storecheck.Input{Root: root, CheckRun: true, Type: "INTF", Name: "ZDEP", Logical: []string{"src/zdep.intf.abap"}})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("attempt %d: rows=%+v fresh=%+v", attempt, rows, want)
		if len(rows) != 1 {
			t.Fatal(rows)
		}
		if rows[0].MESSAGE != want.Raw || rows[0].FILE != want.Filename {
			t.Errorf("stale successful report; fresh resolver selects %s", want.Filename)
		}
	}
	if resolves != stable+1 {
		t.Fatalf("wanted one structural resolution, got %d", resolves-stable)
	}
}

func TestPackSourceTypes(t *testing.T) {
	root := t.TempDir()
	candidate := filepath.Join(root, "addon")
	spec := Spec{PackSources: map[string]string{"addon": "missing"}}
	check := func(want bool) {
		t.Helper()
		_, changed, err := Structure(root, spec)
		if err != nil || changed != want {
			t.Fatal(changed, err)
		}
	}
	check(false)
	if err := os.WriteFile(candidate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	check(true)
	spec.PackSources["addon"] = "other"
	check(false)
	if err := os.Remove(candidate); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(candidate, 0700); err != nil {
		t.Fatal(err)
	}
	check(true)
	spec.PackSources["addon"] = "directory"
	check(false)
	if err := os.Remove(candidate); err != nil {
		t.Fatal(err)
	}
	check(true)
}
