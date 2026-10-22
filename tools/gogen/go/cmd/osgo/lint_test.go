package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

func TestLintSelection(t *testing.T) {
	saved := makeGoLintCompiler
	defer func() { makeGoLintCompiler = saved }()
	for _, linked := range []bool{false, true} {
		makeGoLintCompiler = nil
		wantDefault := "node"
		if linked {
			wantDefault = "go"
			makeGoLintCompiler = func(string, storecheck.Compiler) (*storelint.Compiler, string) {
				t.Fatal("selection must not construct or prime the engine")
				return nil, ""
			}
		}
		for value, want := range map[string]string{"": wantDefault, "  ": wantDefault, "node": "node", " NODE ": "node", "abap": "abap", "go": "go", " GO ": "go"} {
			selected, err := selectedLintEngine(value)
			if err != nil || selected != want {
				t.Fatalf("linked=%v %q: got %q %v, want %q", linked, value, selected, err, want)
			}
		}
	}
	if _, err := selectedLintEngine("automatic"); err == nil {
		t.Fatal("invalid engine accepted")
	}
}

func TestLintBuildGuards(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(file, raw string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, file), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("abap_transpile.json", "{}")
	write("abaplint.jsonc", "{}")
	write("src/ztest.prog.abap", "REPORT ztest.")
	if err := objstore.SetStore(root, []byte(`{"roots":[{"path":"src"}]}`), ""); err != nil {
		t.Fatal(err)
	}
	defer objstore.SetStore("", nil, "")
	spec := lintSpec{Config: "{}", Files: []string{"/src/ztest.prog.abap"}, Guards: map[string]string{"abaplint.jsonc": fmt.Sprintf("%x", sha256.Sum256([]byte("{}")))}}
	savedResolver := resolveLintSpec
	defer func() { resolveLintSpec = savedResolver }()
	resolves := 0
	resolveLintSpec = func(string) (lintSpec, error) {
		resolves++
		config, _ := os.ReadFile(filepath.Join(root, "abaplint.jsonc"))
		snapshot, err := objstore.CaptureLint(nil)
		facts := &objstore.Config{Roots: []objstore.Root{{Path: "src"}}}
		next := lintSpec{Config: string(config), Guards: map[string]string{"abaplint.jsonc": fmt.Sprintf("%x", sha256.Sum256(config))}, Store: facts}
		for _, f := range snapshot.Files {
			next.Files = append(next.Files, f.Filename)
		}
		return next, err
	}
	calls, primes, updates := 0, 0, 0
	c := configuredLintCompiler(root, nil, storelint.Engine{Prime: func([]objstore.LintFile, string) { primes++ }, Update: func(string, *string) { updates++ }, Check: func(string) []storelint.Issue { calls++; return nil }}, spec)
	if err := c.Prime(spec.Config); err != nil {
		t.Fatal(err)
	}
	in := storecheck.Input{CheckRun: true, Root: root, Type: "PROG", Name: "ZTEST", Logical: []string{"src/ztest.prog.abap"}}
	req := storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true, Input: in}
	r, err := storecheck.Run(c, req)
	if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"processed"`) || calls != 1 {
		t.Fatal(r, err, calls)
	}
	write("abaplint.jsonc", `{"syntax":{}}`)
	r, err = storecheck.Run(c, req)
	if err != nil || !strings.Contains(r.Scalars["EV_JSON"], "full re-prime") || calls != 2 || primes != 2 || resolves != 1 {
		t.Fatal(r, err, calls)
	}
	write("src/new.prog.abap", "REPORT new.")
	r, err = storecheck.Run(c, req)
	if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"processed"`) || calls != 3 || updates != 1 || resolves != 1 {
		t.Fatal(r, err, calls)
	}
}

func TestLintPackDiscoveryAndLayerChanges(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "packs"), 0700); err != nil {
		t.Fatal(err)
	}
	spec := lintSpec{Guards: map[string]string{}, Places: []string{"packs"}}
	initial, changed, err := lintStructure(root, spec)
	if err != nil || changed {
		t.Fatal(initial, changed, err)
	}
	manifest := "packs/new/osd-pack.json"
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, manifest)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, manifest), []byte(`{"name":"new"}`), 0600); err != nil {
		t.Fatal(err)
	}
	added, changed, err := lintStructure(root, spec)
	if err != nil || !changed || added == initial {
		t.Fatal(added, changed, err)
	}
	spec.Guards[manifest] = fmt.Sprintf("%x", sha256.Sum256([]byte(`{"name":"new"}`)))
	if _, changed, err := lintStructure(root, spec); err != nil || changed {
		t.Fatal(changed, err)
	}
	if err := os.Remove(filepath.Join(root, manifest)); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := lintStructure(root, spec); err != nil || !changed {
		t.Fatal(changed, err)
	}
	hidden := "base/ztest.clas.abap"
	if err := os.MkdirAll(filepath.Join(root, "base"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, hidden), []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	spec.Hidden = []string{hidden}
	spec.Files = []string{"/overlay/ztest.clas.abap"}
	// Deleting the winner must expose the base through full layer resolution.
	if !lintNeedsLayers(root, spec, objstore.LintSnapshot{}) {
		t.Fatal("deleted winner missed")
	}
	// New duplicate files must be resolved by Node's layer rules.
	if !lintNeedsLayers(root, lintSpec{}, objstore.LintSnapshot{Files: []objstore.LintFile{{Filename: "/base/ztest.clas.abap"}, {Filename: "/overlay/ztest.clas.abap"}}}) {
		t.Fatal("new shadow missed")
	}
	// New ordinary files, including sibling includes, stay incremental.
	if lintNeedsLayers(root, lintSpec{}, objstore.LintSnapshot{Files: []objstore.LintFile{{Filename: "/base/ztest.clas.abap"}, {Filename: "/base/ztest.clas.locals_def.abap"}}}) {
		t.Fatal("ordinary addition became structural")
	}
}

func TestGoLintSelectionAndMissingBuild(t *testing.T) {
	other := &storelint.Compiler{}
	if got := selectCheckCompiler("/tree", other, "node"); got != other {
		t.Fatal("default compiler changed")
	}
	saved := makeGoLintCompiler
	defer func() { makeGoLintCompiler = saved }()
	makeGoLintCompiler = func(root string, delegate storecheck.Compiler) (*storelint.Compiler, string) {
		if root != "/tree" || delegate != other {
			t.Fatal("wrong factory inputs")
		}
		return &storelint.Compiler{Other: delegate, Engine: storelint.Engine{Name: "go"}}, ""
	}
	selected := selectCheckCompiler("/tree", other, "go")
	if selected == other {
		t.Fatal("Go CHECKRUN fell back")
	}
	c := selected.(*storelint.Compiler)
	req := storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true,
		Input: storecheck.Input{Root: "/tree", Type: "PROG", Name: "ZTEST", Logical: []string{"/src/ztest.prog.abap"}}}
	result, err := storecheck.Run(c, req)
	if err != nil || !strings.Contains(result.Scalars["EV_JSON"], "notProcessed") || !strings.Contains(result.Scalars["EV_JSON"], "Go lint engine not compiled") {
		t.Fatal(result, err)
	}
}

func TestLintKnownDuplicatesStayIncremental(t *testing.T) {
	// Node may retain a project file and a library file with the same name.
	// They must not force structural resolution on every pre/post-check capture.
	project, library := "/src/ztest.intf.abap", "/lib/ztest.intf.abap"
	spec := lintSpec{Files: []string{project, library}}
	known := []objstore.LintFile{{Filename: project}, {Filename: library}}
	if lintNeedsLayers(t.TempDir(), spec, objstore.LintSnapshot{Files: known}) {
		t.Fatal("unchanged resolved duplicate forced structural resolution")
	}
	// A new competitor must resolve regardless of traversal order.
	for _, files := range [][]objstore.LintFile{
		{{Filename: "/new/ztest.intf.abap"}, {Filename: project}, {Filename: library}},
		{{Filename: project}, {Filename: library}, {Filename: "/new/ztest.intf.abap"}},
	} {
		if !lintNeedsLayers(t.TempDir(), spec, objstore.LintSnapshot{Files: files}) {
			t.Fatal("new duplicate missed")
		}
	}
}
