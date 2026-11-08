package adtwrite

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/objstore"
)

type heldSession struct {
	handle, typ, name         string
	alive, enqueued, released bool
}

func (s *heldSession) Holds(h, typ, name string) bool {
	return s.alive && s.enqueued && h == s.handle && typ == s.typ && name == s.name
}
func (s *heldSession) Release(_, _, _ string) { s.released = true; s.enqueued = false }
func setup(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for file, text := range map[string]string{"abap_transpile.json": "{}", "src/package.devc.xml": `<abapGit><DEVC><DEVCLASS>$WRITES</DEVCLASS><CTEXT>Writes</CTEXT></DEVC></abapGit>`} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file), []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	cfg, _ := json.Marshal(objstore.Config{Roots: []objstore.Root{{Path: "src", Writable: true, Package: "$WRITES"}}})
	if err := objstore.SetStore(root, cfg, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = objstore.SetStore("", nil, "") })
	return root
}
func createRequest(collection, name string) Request {
	return Request{Method: "POST", Path: "/sap/bc/adt/" + collection, Body: []byte(`<c:object xmlns:c="urn:synthetic" xmlns:a="http://www.sap.com/adt/core" a:name="` + name + `" a:description="A &amp; B"><a:packageRef a:name="$WRITES"/></c:object>`)}
}
func run(t *testing.T, r Request, s Session, status int32) Response {
	t.Helper()
	answer, ok := Serve(r, s)
	if !ok || answer.Status != status {
		t.Fatalf("%s %s: handled=%v status=%d body=%s; want %d", r.Method, r.Path, ok, answer.Status, answer.Body, status)
	}
	return answer
}
func read(t *testing.T, typ, name, include, version string) string {
	t.Helper()
	cmd := "READ"
	a := objstore.Call(map[string]*string{"IV_COMMAND": &cmd, "IV_TYPE": &typ, "IV_NAME": &name, "IV_INCLUDE": &include, "IV_REVISION": &version})
	if a.Scalars["EV_ERROR"] != "" {
		t.Fatal(a.Scalars)
	}
	return a.Scalars["EV_SOURCE"]
}
func TestSourceLifecycle(t *testing.T) {
	root := setup(t)
	for _, tc := range []struct {
		typ, collection, name string
		created, duplicate    int32
	}{{"CLAS", "oo/classes", "ZCL_WRITE", 200, 400}, {"INTF", "oo/interfaces", "ZIF_WRITE", 201, 409}, {"PROG", "programs/programs", "ZWRITE", 200, 500}} {
		t.Run(tc.typ, func(t *testing.T) {
			request := createRequest(tc.collection, tc.name)
			run(t, request, nil, tc.created)
			run(t, request, nil, tc.duplicate)
			path := request.Path + "/" + strings.ToLower(tc.name)
			session := &heldSession{handle: strings.Repeat("a", 40), typ: tc.typ, name: tc.name, alive: true, enqueued: true}
			put := Request{Method: "PUT", Path: path + "/source/main", Query: "lockHandle=" + session.handle, Body: []byte("* saved\r\n")}
			active := ""
			if tc.typ == "CLAS" {
				active = read(t, tc.typ, tc.name, "main", "active")
			}
			bad := put
			bad.Query = "lockHandle=" + strings.Repeat("b", 40)
			status := int32(409)
			if tc.typ == "CLAS" {
				status = 423
			}
			run(t, bad, session, status)
			session.alive = false
			run(t, put, session, status)
			session.alive = true
			session.enqueued = false
			run(t, put, session, status)
			session.enqueued = true
			session.name = "ANOTHER"
			run(t, put, session, status)
			session.name = tc.name
			stale := put
			stale.Headers = [][2]string{{"If-Match", `"old"`}}
			run(t, stale, session, 412)
			saved := run(t, put, session, 200)
			if len(saved.Headers) != 1 || saved.Headers[0][0] != "etag" {
				t.Fatalf("save ETag missing: %+v", saved)
			}
			if got := read(t, tc.typ, tc.name, "main", "inactive"); got != "* saved\n" {
				t.Fatalf("source: %q", got)
			}
			if tc.typ == "CLAS" && read(t, tc.typ, tc.name, "main", "active") != active {
				t.Fatal("PUT changed active")
			}
			put.Headers = [][2]string{{"if-match", saved.Headers[0][1]}}
			run(t, put, session, 200)
			if tc.typ == "CLAS" {
				inc := Request{Method: "POST", Path: path + "/includes", Query: put.Query, Body: []byte(`<c:abapClassInclude xmlns:c="http://www.sap.com/adt/oo/classes" c:includeType="testclasses"/>`)}
				incPut := put
				incPut.Headers = nil
				incPut.Path = path + "/includes/testclasses/source/main"
				run(t, incPut, session, 500)
				run(t, inc, session, 201)
				run(t, inc, session, 409)
				run(t, incPut, session, 200)
				incPut.Path = path + "/includes/implementations"
				run(t, incPut, session, 200)
				if read(t, "CLAS", tc.name, "testclasses", "inactive") != "* saved\n" {
					t.Fatal("include not saved")
				}
			}
			run(t, Request{Method: "DELETE", Path: path}, session, status)
			run(t, Request{Method: "DELETE", Path: path, Query: put.Query}, session, 200)
			if !session.released {
				t.Fatal("DELETE retained lock")
			}
			files, err := os.ReadDir(filepath.Join(root, "src"))
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range files {
				if strings.HasPrefix(f.Name(), strings.ToLower(tc.name)+".") {
					t.Fatalf("DELETE left %s", f.Name())
				}
			}
		})
	}
}
func TestCreateRefusalsAndSymlinks(t *testing.T) {
	root := setup(t)
	request := createRequest("oo/classes", "../../BAD")
	run(t, request, nil, 400)
	request = createRequest("oo/classes", "ZCL_WRITE")
	request.Body = []byte(strings.ReplaceAll(string(request.Body), "$WRITES", "$MISSING"))
	run(t, request, nil, 404)
	request = createRequest("oo/classes", "ZCL_WRITE")
	run(t, request, nil, 200)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "src", "zcl_write.clas.abap")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, file); err != nil {
		t.Fatal(err)
	}
	s := &heldSession{handle: "handle", typ: "CLAS", name: "ZCL_WRITE", alive: true, enqueued: true}
	run(t, Request{Method: "PUT", Path: request.Path + "/zcl_write/source/main", Query: "lockHandle=handle", Body: []byte("overwrite")}, s, 405)
	run(t, Request{Method: "DELETE", Path: request.Path + "/zcl_write", Query: "lockHandle=handle"}, s, 405)
	if got, _ := os.ReadFile(outside); string(got) != "keep" {
		t.Fatal("followed symlink")
	}
}
func TestUnrelatedHostRoute(t *testing.T) {
	for _, r := range []Request{{Method: "POST", Path: "/sap/bc/adt/activation"}, {Method: "POST", Path: "/sap/bc/adt/oo/classes/zcl_write", Query: "_action=LOCK"}} {
		if _, ok := Serve(r, nil); ok {
			t.Fatalf("handled unrelated route: %+v", r)
		}
	}
}

// These are the CRLF source representations served by the shared ABAP GET.
func TestFirstConditionalIncludeSave(t *testing.T) {
	setup(t)
	run(t, createRequest("oo/classes", "ZCL_FIRST_SAVE"), nil, 200)
	session := &heldSession{handle: "handle", typ: "CLAS", name: "ZCL_FIRST_SAVE", alive: true, enqueued: true}
	for _, tc := range []struct{ include, template string }{
		{"definitions", "*\"* use this source file for any type of declarations (class\r\n*\"* definitions, interfaces or type declarations) you need for\r\n*\"* components in the private section\r\n"},
		{"macros", "*\"* use this source file for any macro definitions you need\r\n*\"* in the implementation part of the class\r\n"},
		{"implementations", "*\"* use this source file for the definition and implementation of\r\n*\"* local helper classes, interface definitions and type\r\n*\"* declarations\r\n"},
	} {
		t.Run(tc.include, func(t *testing.T) {
			put := Request{Method: "PUT", Path: "/sap/bc/adt/oo/classes/zcl_first_save/includes/" + tc.include + "/source/main", Query: "lockHandle=handle", Body: []byte("* first save\r\n")}
			put.Headers = [][2]string{{"If-Match", `"stale"`}}
			run(t, put, session, 412)
			put.Headers = [][2]string{{"If-Match", `W/"` + tag(tc.template) + `"`}}
			saved := run(t, put, session, 200)
			if got := read(t, "CLAS", session.name, tc.include, "inactive"); got != "* first save\n" {
				t.Fatalf("saved source: %q", got)
			}
			// A template tag must become stale once the include exists.
			run(t, put, session, 412)
			put.Headers = [][2]string{{"If-Match", saved.Headers[0][1]}}
			put.Body = nil
			saved = run(t, put, session, 200)
			// An existing zero-byte include is empty source, not an absent template.
			put.Headers = [][2]string{{"If-Match", saved.Headers[0][1]}}
			run(t, put, session, 200)
		})
	}
}

func TestProgramCreateNameLimits(t *testing.T) {
	setup(t)
	for _, length := range []int{31, 40, 41} {
		name := "Z" + strings.Repeat("P", length-1)
		status := int32(200)
		if length > 40 {
			status = 400
		}
		run(t, createRequest("programs/programs", name), nil, status)
		if status == 200 && read(t, "PROG", name, "main", "inactive") != "REPORT "+strings.ToLower(name)+".\n" {
			t.Fatal("missing program skeleton")
		}
	}
	for _, collection := range []string{"oo/classes", "oo/interfaces"} {
		run(t, createRequest(collection, "Z"+strings.Repeat("C", 30)), nil, 400)
	}
}
