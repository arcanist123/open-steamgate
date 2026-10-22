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
	write("packs/late/osd-pack.json", `{ "name":"late", "abap":"src" }`)
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
	refuse := func(label string) {
		t.Helper()
		before := calls
		r, err := storecheck.Run(c, req)
		if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"notProcessed"`) || !strings.Contains(r.Scalars["EV_JSON"], "rebuild") || calls != before {
			t.Fatal(label, r, err, calls)
		}
	}
	for _, file := range []string{"abaplint.jsonc", "abap_transpile.json", "libs.lock.json", "packs/late/osd-pack.json"} {
		original, err := os.ReadFile(filepath.Join(root, file))
		if err != nil {
			t.Fatal(err)
		}
		write(file, string(original)+"\n")
		refuse(file)
		if err := os.Remove(filepath.Join(root, file)); err != nil {
			t.Fatal(err)
		}
		refuse(file + " missing")
		write(file, string(original))
		check()
	}
	for _, key := range []string{"OSD_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_WEB_PACKS", "OSD_LAYER_PACKAGE", "OSD_LAYER_DISCOVERY_ONLY", "OSD_LIB_NEW"} {
		t.Run(key, func(t *testing.T) { t.Setenv(key, "changed"); refuse(key) })
	}
	write("packs/new/osd-pack.json", `{"name":"new"}`)
	refuse("new pack")
	if err := os.RemoveAll(filepath.Join(root, "packs/new")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "packs/late"), filepath.Join(root, "packs/renamed")); err != nil {
		t.Fatal(err)
	}
	refuse("renamed pack")
	if err := os.Rename(filepath.Join(root, "packs/renamed"), filepath.Join(root, "packs/late")); err != nil {
		t.Fatal(err)
	}
	// Refusals do not poison an already healthy registry after restoring guards.
	check()
	// Guard mutations during a check still refuse the result.
	c.Engine.Check = func(string) []storelint.Issue { write("libs.lock.json", "{}\n"); return nil }
	if _, err := c.Check(context.Background(), req.Input); err == nil || !strings.Contains(err.Error(), "rebuild") {
		t.Fatal(err)
	}
}
