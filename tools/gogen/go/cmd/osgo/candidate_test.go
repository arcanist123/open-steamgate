package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/abap"
	"osg/gogen/adtactivate"
)

// a candidate's database is read-only until its promotion opens the same
// file for writing in its place (candidate.go)
func TestCandidatePromotionOpensTheFileForWriting(t *testing.T) {
	file := filepath.Join(t.TempDir(), "osgo.sqlite")
	serving, _, err := abap.OpenDBFile(file, dbScript)
	if err != nil {
		t.Fatal(err)
	}
	serving.Close()
	ro, err := abap.OpenDBCandidate(file, dbScript)
	if err != nil {
		t.Fatal(err)
	}
	own, wasCandidate := instance, candidate.Load()
	defer func() { instance = own; candidate.Store(wasCandidate) }()
	instance = abap.NewInstance(ro)
	candidate.Store(true)
	if _, err := ro.SQL().Exec("CREATE TABLE zz_candidate_probe (x TEXT)"); err == nil {
		t.Fatal("the candidate's database took a write")
	}
	if err := promote(file); err != nil {
		t.Fatal(err)
	}
	if candidate.Load() || instance.DB == ro {
		t.Fatal("not promoted")
	}
	if _, err := instance.DB.SQL().Exec("CREATE TABLE zz_candidate_probe (x TEXT)"); err != nil {
		t.Fatalf("the promoted database refuses a write: %v", err)
	}
	instance.DB.Close()
}

// -gateway-builds: a publishing activation asks the gateway for a build
func TestGatewayBuildsHeader(t *testing.T) {
	defer func() { adtactivate.Builds = nil }()
	useGatewayBuilds()
	header, note := adtactivate.Builds()
	if header != "published; building" || !strings.Contains(note, "the gateway is building") {
		t.Fatalf("%q %q", header, note)
	}
}

// -gateway-builds: the gateway's build-time gate door, GET /osd/inactive
// (gatedBuilder, go/osgw), answers how many objects are inactive here;
// another method is not its
func TestGatewayBuildsInactiveDoor(t *testing.T) {
	rt := inactiveRoute()
	if rt.prefix != "/osd/inactive" || !rt.exact {
		t.Fatalf("%+v", rt)
	}
	w := httptest.NewRecorder()
	rt.h(w, httptest.NewRequest("GET", "/osd/inactive", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"inactive":0`) {
		t.Fatalf("GET: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	rt.h(w, httptest.NewRequest("POST", "/osd/inactive", nil))
	if w.Code != 404 {
		t.Fatalf("POST answered %d", w.Code)
	}
}
