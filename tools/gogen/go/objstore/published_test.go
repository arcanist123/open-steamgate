package objstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func activeSource(t *testing.T) string {
	t.Helper()
	command, typ, name, include, version := "READ", "CLAS", "ZCL_ACT", "main", "active"
	a := Call(map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name, "IV_INCLUDE": &include, "IV_REVISION": &version})
	if a.Scalars["EV_ERROR"] != "" {
		t.Fatal(a.Scalars)
	}
	return a.Scalars["EV_SOURCE"]
}

// ADR 0010 slice 4: the published state outlives the process. A process of
// the same build (a replacement, a restart) restores it from the index; a
// process of a build made from the published source finds the object
// active and live (so ABAP Unit's 409 goes), and restores nothing.
func TestPublishedStateOutlivesTheProcess(t *testing.T) {
	root, built := setupActivation(t)
	changed := built + "* published\n"
	save(t, changed)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, publishedIndex)); err != nil {
		t.Fatalf("no index: %v", err)
	}
	sameBuild, _ := json.Marshal(Config{Roots: []Root{{Path: "src", Writable: true, Package: "$WRITES"}},
		Active: map[string]string{"src/zcl_act.clas.abap": "build/zcl_act.clas.abap"},
		Built:  map[string]string{"src/zcl_act.clas.abap": storeDigestBytes([]byte(built))}})
	if err := SetStore(root, sameBuild, ""); err != nil {
		t.Fatal(err)
	}
	if got := activeSource(t); got != built {
		t.Fatalf("a fresh process before the restore: %q", got)
	}
	if n, err := RestorePublished(); err != nil || n != 1 {
		t.Fatalf("restored %d %v", n, err)
	}
	if got := activeSource(t); got != changed {
		t.Fatalf("after the restore the active source is %q", got)
	}
	if Live("CLAS", "ZCL_ACT") {
		t.Fatal("the old build runs the published class as live")
	}
	// the next generation, built from the published source
	os.WriteFile(filepath.Join(root, "build2.abap"), []byte(changed), 0o644)
	newBuild, _ := json.Marshal(Config{Roots: []Root{{Path: "src", Writable: true, Package: "$WRITES"}},
		Active: map[string]string{"src/zcl_act.clas.abap": "build2.abap"},
		Built:  map[string]string{"src/zcl_act.clas.abap": storeDigestBytes([]byte(changed))}})
	if err := SetStore(root, newBuild, ""); err != nil {
		t.Fatal(err)
	}
	if n, err := RestorePublished(); err != nil || n != 0 {
		t.Fatalf("the new build restored %d %v", n, err)
	}
	if !Live("CLAS", "ZCL_ACT") || activeSource(t) != changed {
		t.Fatal("the class built from the published source is not live")
	}
	// a snapshot whose bytes are not its digest is not restored
	if err := SetStore(root, sameBuild, ""); err != nil {
		t.Fatal(err)
	}
	var index map[string]publishedEntry
	raw, _ := os.ReadFile(filepath.Join(root, publishedIndex))
	json.Unmarshal(raw, &index)
	os.WriteFile(filepath.Join(root, index["src/zcl_act.clas.abap"].Snapshot), []byte("tampered"), 0o644)
	if n, _ := RestorePublished(); n != 0 {
		t.Fatal("a tampered snapshot was restored")
	}
}
