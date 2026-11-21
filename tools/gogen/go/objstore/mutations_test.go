package objstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteRecreateClearsBuiltActiveIncludes(t *testing.T) {
	root := t.TempDir()
	write := func(file, source string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file), []byte(source), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("abap_transpile.json", "{}")
	write("src/package.devc.xml", `<abapGit><DEVC><DEVCLASS>$WRITES</DEVCLASS></DEVC></abapGit>`)
	cfg := Config{Roots: []Root{{Path: "src", Writable: true, Package: "$WRITES"}}, Active: map[string]string{}, Built: map[string]string{}}
	snapshots := map[string]string{}
	for _, inc := range storeIncludes {
		file := "src/zcl_recreated" + inc.Suffix
		source := "* old " + inc.Name + "\n"
		if inc.Name == "testclasses" {
			source = "CLASS old_tests DEFINITION FOR TESTING. ENDCLASS.\n"
		}
		snapshot := "build/zcl_recreated" + inc.Suffix
		write(file, source)
		write(snapshot, source)
		cfg.Active[file], cfg.Built[file] = snapshot, storeDigestBytes([]byte(source))
		snapshots[snapshot] = source
	}
	// Active proofs must also be removed for includes already absent on disk.
	if err := os.Remove(filepath.Join(root, "src/zcl_recreated.clas.testclasses.abap")); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetStore(root, data, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = SetStore("", nil, "") })
	read := func(include string) Answer {
		t.Helper()
		cmd, typ, name, version := "READ", "CLAS", "ZCL_RECREATED", "active"
		a := Call(map[string]*string{"IV_COMMAND": &cmd, "IV_TYPE": &typ, "IV_NAME": &name, "IV_INCLUDE": &include, "IV_REVISION": &version})
		if a.Scalars["EV_ERROR"] != "" {
			t.Fatal(a.Scalars)
		}
		return a
	}
	if got := read("testclasses").Scalars["EV_SOURCE"]; got != snapshots["build/zcl_recreated.clas.testclasses.abap"] {
		t.Fatalf("fixture active tests: %q", got)
	}
	if err := DeleteSource("CLAS", "ZCL_RECREATED"); err != nil {
		t.Fatal(err)
	}
	if err := CreateSource("CLAS", "ZCL_RECREATED", "$WRITES", "New class"); err != nil {
		t.Fatal(err)
	}
	for _, inc := range storeIncludes {
		a := read(inc.Name)
		var info struct{ Empty bool }
		if err := json.Unmarshal([]byte(a.Scalars["EV_JSON"]), &info); err != nil {
			t.Fatal(err)
		}
		if inc.Name == "main" {
			if info.Empty || a.Scalars["EV_SOURCE"] == snapshots["build/zcl_recreated.clas.abap"] {
				t.Error("missing new active skeleton")
			}
		} else if !info.Empty || a.Scalars["EV_SOURCE"] != "" {
			t.Errorf("%s inherited deleted active source: %v", inc.Name, a.Scalars)
		}
		file := "src/zcl_recreated" + inc.Suffix
		if _, ok := storeState.cfg.Active[file]; ok {
			t.Errorf("retained active mapping for %s", inc.Name)
		}
		if _, ok := storeState.cfg.Built[file]; ok {
			t.Errorf("retained built mapping for %s", inc.Name)
		}
	}
	for snapshot, want := range snapshots {
		b, err := os.ReadFile(filepath.Join(root, snapshot))
		if err != nil || string(b) != want {
			t.Errorf("immutable snapshot changed: %s (%v)", snapshot, err)
		}
	}
}
