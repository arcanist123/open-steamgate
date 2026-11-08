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
