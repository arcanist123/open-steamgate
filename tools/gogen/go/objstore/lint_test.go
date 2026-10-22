package objstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLintStoreView(t *testing.T) {
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
	write("abap_transpile.json", "{}")
	for _, file := range []string{"src/z.clas.abap", "src/z.clas.xml", "src/z.clas.locals_def.abap", "src/old.clas.abap", "src/excluded.prog.abap", "src/no.txt", "lib/l.intf.abap"} {
		write(file, file)
	}
	cfg, _ := json.Marshal(Config{Roots: []Root{{Path: "src"}, {Path: "local/tmp"}}, Libs: []Root{{Path: "lib", Library: true, Files: []string{"lib/l.intf.abap"}}}, Excluded: []string{"excluded"}})
	if err := SetStore(root, cfg, ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	capture := func() LintSnapshot {
		t.Helper()
		value, err := CaptureLint([]string{"src/old.clas.abap"})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	first := capture()
	var names []string
	for _, file := range first.Files {
		names = append(names, file.Filename)
	}
	if !reflect.DeepEqual(names, []string{"/src/z.clas.abap", "/src/z.clas.locals_def.abap", "/src/z.clas.xml", "/lib/l.intf.abap"}) {
		t.Fatal(names)
	}
	if first.Digest != capture().Digest {
		t.Fatal("unstable snapshot")
	}
	write("lib/l.intf.abap", "changed dependency")
	if first.Digest == capture().Digest {
		t.Fatal("library edit missed")
	}
	before := capture()
	write("src/new.prog.abap", "REPORT new.")
	if before.Digest == capture().Digest {
		t.Fatal("added file missed")
	}
	before = capture()
	write("src/old.clas.abap", "hidden edit")
	if before.Digest == capture().Digest {
		t.Fatal("hidden edit missed")
	}
	if err := os.Remove(filepath.Join(root, "lib/l.intf.abap")); err != nil {
		t.Fatal(err)
	}
	if _, err := CaptureLint(nil); err == nil {
		t.Fatal("missing library must refuse")
	}
}
