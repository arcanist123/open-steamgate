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

// critic #895 SHOULD 3: the index on disk is merged, not overwritten from
// the writing process's own view. Generation N+1 publishes a change; while
// it drains, a session pinned to generation N activates the object whose
// working file is N's own build bytes (a drop): N's write must keep N+1's
// entry, or a process of N+1 started after it (a crash replacement)
// restores nothing and reads the object from the tree. A drop still takes
// out the entry it owns: the process's own, or one naming the very bytes
// the starting build was built from.
func TestPublishedIndexMergesAcrossGenerations(t *testing.T) {
	root, built := setupActivation(t)
	gen := func(self string) {
		t.Helper()
		cfg, _ := json.Marshal(Config{Roots: []Root{{Path: "src", Writable: true, Package: "$WRITES"}},
			Active: map[string]string{"src/zcl_act.clas.abap": "build2.abap"},
			Built:  map[string]string{"src/zcl_act.clas.abap": self}})
		if err := SetStore(root, cfg, ""); err != nil {
			t.Fatal(err)
		}
	}
	digestOf := func(s string) string { return storeDigestBytes([]byte(s)) }
	entry := func() (publishedEntry, bool) {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(root, publishedIndex))
		if err != nil {
			t.Fatal(err)
		}
		var index map[string]publishedEntry
		if err := json.Unmarshal(raw, &index); err != nil {
			t.Fatal(err)
		}
		e, ok := index["src/zcl_act.clas.abap"]
		return e, ok
	}
	v1, v2 := built+"* version one\n", built+"* version two\n"
	// generation N publishes v1; generation N+1, built from v1, publishes v2
	save(t, v1)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	gen(digestOf(v1))
	save(t, v2)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	// a session pinned to N activates the object back to N's build bytes
	gen(digestOf(built))
	save(t, built)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	if e, ok := entry(); !ok {
		t.Fatal("the draining generation's activation dropped the serving generation's entry")
	} else if e.Digest != digestOf(v2) {
		t.Fatalf("the entry is not what N+1 published: %+v", e)
	}
	// a crash replacement of N+1 restores what N+1 published
	gen(digestOf(v1))
	if n, err := RestorePublished(); err != nil || n != 1 {
		t.Fatalf("the replacement restored %d %v", n, err)
	}
	if got := activeSource(t); got != v2 {
		t.Fatalf("the replacement reads %q, not what N+1 published", got)
	}
	// the entry naming the starting build's own bytes goes (a snapshot that
	// became active is no longer published)
	gen(digestOf(v2))
	save(t, v2)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	if _, ok := entry(); ok {
		t.Fatal("the entry of the starting build's own bytes stayed in the index")
	}
	// and the process's own entry goes: N publishes v1, then reverts to its
	// build bytes
	gen(digestOf(built))
	save(t, v1)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	if _, ok := entry(); !ok {
		t.Fatal("N's own publish left no entry")
	}
	save(t, built)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	if _, ok := entry(); ok {
		t.Fatal("the process's own entry stayed after its revert")
	}
}
