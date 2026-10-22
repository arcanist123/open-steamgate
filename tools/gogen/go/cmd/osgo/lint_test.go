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
	for _, value := range []string{"", "node", " NODE ", "abap"} {
		selected, err := selectedLintEngine(value)
		if err != nil || selected != "node" && selected != "abap" {
			t.Fatalf("%q: %q %v", value, selected, err)
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
	calls := 0
	c := configuredLintCompiler(root, nil, storelint.Engine{Prime: func([]objstore.LintFile, string) {}, Check: func(string) []storelint.Issue { calls++; return nil }}, spec)
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
	if err != nil || !strings.Contains(r.Scalars["EV_JSON"], "changed since build") || calls != 1 {
		t.Fatal(r, err, calls)
	}
	write("abaplint.jsonc", "{}")
	write("src/new.prog.abap", "REPORT new.")
	r, err = storecheck.Run(c, req)
	if err != nil || !strings.Contains(r.Scalars["EV_JSON"], "membership/order differs") || calls != 1 {
		t.Fatal(r, err, calls)
	}
}
