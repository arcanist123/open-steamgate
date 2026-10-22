package lintinput

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/lintresolve"
	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

func TestNativeResolveAndCheckRunWithoutNode(t *testing.T) {
	root := t.TempDir()
	write := func(file, raw string) {
		t.Helper()
		at := filepath.Join(root, file)
		if err := os.MkdirAll(filepath.Dir(at), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("abap_transpile.json", `{"input_folder":["src"],"libs":[{"folder":"/lib"}]}`)
	write("abaplint.jsonc", `{"syntax":{"version":"v702"}}`)
	write("libs.lock.json", `{"libraries":[]}`)
	write("src/ztest.prog.abap", "REPORT ztest.")
	spec := buildSpec(t, root)
	// Exercise the production per-instance resolver, not the test injection.
	Resolve = nil
	t.Setenv("PATH", t.TempDir())
	resolved, err := lintresolve.Resolve(root, spec.Rules)
	if err != nil || len(resolved.Files) != 1 {
		t.Fatal(resolved, err)
	}
	calls := 0
	c := New(root, nil, storelint.Engine{Prime: func([]objstore.LintFile, string) {}, Update: func(string, *string) {}, Check: func(string) []storelint.Issue { calls++; return nil }}, spec)
	if err := c.Prime(spec.Config); err != nil {
		t.Fatal(err)
	}
	req := storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true, Input: storecheck.Input{Root: root, CheckRun: true, Type: "PROG", Name: "ZTEST", Logical: []string{"src/ztest.prog.abap"}}}
	check := func() {
		t.Helper()
		r, err := storecheck.Run(c, req)
		if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"processed"`) {
			t.Fatal(r, err)
		}
	}
	check()
	write("lib/src/zdep.intf.abap", "INTERFACE zdep PUBLIC. ENDINTERFACE.")
	check()
	// Test source overlays and restoration without any executable available.
	raw := "REPORT ztest. WRITE 'buffer'."
	req.Input.Source = &raw
	check()
	req.Input.Source = nil
	check()
	if calls != 4 {
		t.Fatal(calls)
	}
	write("abaplint.jsonc", `{"syntax":{"version":"v750"}}`)
	r, err := storecheck.Run(c, req)
	if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"notProcessed"`) || !strings.Contains(r.Scalars["EV_JSON"], "rebuild") || calls != 4 {
		t.Fatal(r, err, calls)
	}
	// A refusal doesn't poison a previously healthy registry or accept new config.
	write("abaplint.jsonc", `{"syntax":{"version":"v702"}}`)
	check()
	// Guard mutations during a check still refuse the result.
	c.Engine.Check = func(string) []storelint.Issue { write("libs.lock.json", "{}\n"); return nil }
	if _, err := c.Check(context.Background(), req.Input); err == nil || !strings.Contains(err.Error(), "rebuild") {
		t.Fatal(err)
	}
}
