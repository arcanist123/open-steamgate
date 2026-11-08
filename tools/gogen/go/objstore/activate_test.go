package objstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestActivatePublishesWorkingSourceAndLiveTracksBuild(t *testing.T) {
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
	built := "CLASS zcl_act DEFINITION PUBLIC. ENDCLASS.\nCLASS zcl_act IMPLEMENTATION. ENDCLASS.\n"
	write("abap_transpile.json", "{}")
	write("src/package.devc.xml", `<abapGit><DEVC><DEVCLASS>$WRITES</DEVCLASS></DEVC></abapGit>`)
	write("src/zcl_act.clas.abap", built)
	write("build/zcl_act.clas.abap", built)
	cfg := Config{Roots: []Root{{Path: "src", Writable: true, Package: "$WRITES"}},
		Active: map[string]string{"src/zcl_act.clas.abap": "build/zcl_act.clas.abap"},
		Built:  map[string]string{"src/zcl_act.clas.abap": storeDigestBytes([]byte(built))}}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetStore(root, data, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = SetStore("", nil, "") })
	call := func(command, include, version string, source *string) Answer {
		t.Helper()
		typ, name := "CLAS", "ZCL_ACT"
		in := map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name, "IV_INCLUDE": &include, "IV_REVISION": &version}
		if source != nil {
			in["IV_SOURCE"] = source
		}
		a := Call(in)
		if a.Scalars["EV_ERROR"] != "" {
			t.Fatal(a.Scalars)
		}
		return a
	}
	if !Live("CLAS", "zcl_act") {
		t.Fatal("unchanged class must be live")
	}
	changed := built + "* changed\n"
	call("WRITE", "main", "", &changed)
	if Live("CLAS", "ZCL_ACT") {
		t.Fatal("saved class must not be live")
	}
	if rows := Inactive(); len(rows) != 1 || rows[0].NAME != "ZCL_ACT" {
		t.Fatalf("inactive before activation: %+v", rows)
	}
	if got := call("READ", "main", "active", nil).Scalars["EV_SOURCE"]; got != built {
		t.Fatalf("active before activation: %q", got)
	}
	if err := Activate("CLAS", "zcl_act"); err != nil {
		t.Fatal(err)
	}
	if rows := Inactive(); len(rows) != 0 {
		t.Fatalf("inactive after activation: %+v", rows)
	}
	a := call("READ", "main", "active", nil)
	if a.Scalars["EV_SOURCE"] != changed || a.Scalars["EV_VERSION"] != "active" {
		t.Fatalf("active after activation: %q %q", a.Scalars["EV_SOURCE"], a.Scalars["EV_VERSION"])
	}
	if Live("CLAS", "ZCL_ACT") {
		t.Fatal("published class is still not what the binary was built from")
	}
	if err := Activate("CLAS", "ZCL_NONE"); err == nil {
		t.Fatal("unknown object activated")
	}
	if Live("CLAS", "ZCL_NONE") {
		t.Fatal("unknown object live")
	}
}

// setupActivation is a one-class tree with a build snapshot of zcl_act.
func setupActivation(t *testing.T) (root, built string) {
	t.Helper()
	root = t.TempDir()
	write := func(file, source string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file), []byte(source), 0644); err != nil {
			t.Fatal(err)
		}
	}
	built = "CLASS zcl_act DEFINITION PUBLIC. ENDCLASS.\nCLASS zcl_act IMPLEMENTATION. ENDCLASS.\n"
	write("abap_transpile.json", "{}")
	write("src/package.devc.xml", `<abapGit><DEVC><DEVCLASS>$WRITES</DEVCLASS></DEVC></abapGit>`)
	write("src/zcl_act.clas.abap", built)
	write("build/zcl_act.clas.abap", built)
	cfg := Config{Roots: []Root{{Path: "src", Writable: true, Package: "$WRITES"}},
		Active: map[string]string{"src/zcl_act.clas.abap": "build/zcl_act.clas.abap"},
		Built:  map[string]string{"src/zcl_act.clas.abap": storeDigestBytes([]byte(built))}}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetStore(root, data, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = SetStore("", nil, "") })
	return root, built
}

func save(t *testing.T, source string) {
	t.Helper()
	command, typ, name, include := "WRITE", "CLAS", "ZCL_ACT", "main"
	if a := Call(map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name, "IV_INCLUDE": &include, "IV_SOURCE": &source}); a.Scalars["EV_ERROR"] != "" {
		t.Fatal(a.Scalars)
	}
}

// critic #863 MUST 1: the compiler's active input is the published source,
// before and after a second save.
func TestActiveCompilerInputIsThePublishedSource(t *testing.T) {
	root, built := setupActivation(t)
	activeInput := func() string {
		t.Helper()
		storeState.mu.Lock()
		in, err := compilerInput(storeBuild(), "CLAS", "ZCL_ACT", "active")
		storeState.mu.Unlock()
		if err != nil || len(in.Files) != 1 {
			t.Fatal(err, in.Files)
		}
		b, err := os.ReadFile(filepath.Join(root, in.Files[0]))
		if err != nil || storeDigestBytes(b) != in.Expected[in.Files[0]] {
			t.Fatal(err, "snapshot digest")
		}
		return string(b)
	}
	if activeInput() != built {
		t.Fatal("build snapshot before activation")
	}
	published := built + "* new_method\n"
	save(t, published)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	if got := activeInput(); got != published {
		t.Fatalf("active input after activation: %q", got)
	}
	save(t, published+"* second save\n")
	if got := activeInput(); got != published {
		t.Fatalf("active input after a second save: %q", got)
	}
	save(t, built)
	if err := Activate("CLAS", "ZCL_ACT"); err != nil {
		t.Fatal(err)
	}
	if got := activeInput(); got != built || !Live("CLAS", "ZCL_ACT") {
		t.Fatalf("back to the build's bytes: %q", got)
	}
}

// critic #863 MUST 2: a batch with a missing or unreadable member publishes nothing.
func TestActivateAllIsAllOrNothing(t *testing.T) {
	root, built := setupActivation(t)
	changed := built + "* changed\n"
	save(t, changed)
	unchanged := func() {
		t.Helper()
		if rows := Inactive(); len(rows) != 1 {
			t.Fatalf("inactive: %+v", rows)
		}
		command, typ, name, version := "READ", "CLAS", "ZCL_ACT", "active"
		if a := Call(map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name, "IV_REVISION": &version}); a.Scalars["EV_SOURCE"] != built {
			t.Fatalf("active changed: %q", a.Scalars["EV_SOURCE"])
		}
	}
	if err := ActivateAll([]Object{{"CLAS", "ZCL_ACT"}, {"CLAS", "ZCL_MISSING"}}); err == nil {
		t.Fatal("batch with a missing object activated")
	}
	unchanged()
	include := filepath.Join(root, "src/zcl_act.clas.locals_imp.abap")
	if err := os.WriteFile(include, []byte("* imp\n"), 0o000); err != nil {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(include); err == nil {
		t.Skip("running with permissions that read a 000 file")
	}
	if err := ActivateAll([]Object{{"CLAS", "ZCL_ACT"}}); err == nil {
		t.Fatal("unreadable include activated")
	}
	unchanged()
	if err := os.Chmod(include, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ActivateAll([]Object{{"CLAS", "ZCL_ACT"}}); err != nil || len(Inactive()) != 0 {
		t.Fatal(err, Inactive())
	}
}
