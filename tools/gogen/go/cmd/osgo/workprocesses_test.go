package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"osg/gogen/abap"
)

// The dispatcher's own rules (ADR 0010 slice 5), the half the kernel cannot
// test: the logical internal sessions and the step kinds by request.

func TestWorkProcessesConfig(t *testing.T) {
	for _, tc := range []struct {
		flag  string
		env   string
		cores int
		want  int
	}{
		{"", "", 4, 4},     // the cores
		{"", "", 0, 1},     // a host that reports none
		{"8", "", 4, 8},    // the flag
		{" 3 ", "", 40, 3}, // blanks are the request's
		{"0", "", 4, 4},    // zero is not a count of work processes
		{"bad", "", 4, 4},  // nor is anything else
		{"", "6", 4, 6},    // OSD_WPS
		{"2", "6", 4, 2},   // the flag over the environment
	} {
		lookup := func(string) (string, bool) { return tc.env, tc.env != "" }
		if got := workProcesses(tc.flag, lookup, tc.cores); got != tc.want {
			t.Errorf("workProcesses(%q, %q, %d) = %d, want %d", tc.flag, tc.env, tc.cores, got, tc.want)
		}
	}
}

func TestStepKindOf(t *testing.T) {
	adtReadSteps = true
	defer func() { adtReadSteps = false }()
	read := []struct{ method, base string }{
		{"GET", odataBase + "/"},
		{"HEAD", odataBase + "/"},
		{"GET", statusODataPath},
		{"GET", "/sap/bc/adt"},
	}
	for _, tc := range read {
		if stepKindOf(tc.method, tc.base) != abap.ReadStep {
			t.Errorf("%s of %s is not a read step", tc.method, tc.base)
		}
	}
	write := []struct{ method, base string }{
		{"POST", odataBase + "/"},
		{"PUT", odataBase + "/"},
		{"MERGE", odataBase + "/"},
		{"DELETE", odataBase + "/"},
		{"GET", "/sap/bc/gui/sap/its/webgui"}, // the webgui writes session rows
	}
	for _, tc := range write {
		if stepKindOf(tc.method, tc.base) != abap.WriteStep {
			t.Errorf("%s of %s is not a modifying step", tc.method, tc.base)
		}
	}
	// an in-memory database has no connection for the ADT session rows:
	// the ADT GET is the modifying step it is there
	adtReadSteps = false
	if stepKindOf("GET", "/sap/bc/adt") != abap.WriteStep {
		t.Error("the ADT GET of an in-memory database is a modifying step")
	}
}

func TestSessionTableOneStepAtATime(t *testing.T) {
	table := &sessionTable{byKey: map[string]*logicalSession{}}
	inStep := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		s, finished := table.stepSession("stateful-1")
		if s == nil {
			t.Error("no session")
		}
		close(inStep)
		<-release
		finished()
	}()
	<-inStep
	// the same key waits for its turn
	waited := make(chan struct{})
	go func() {
		defer close(waited)
		_, finished := table.stepSession("stateful-1")
		finished()
	}()
	select {
	case <-waited:
		t.Error("the session's second step ran beside its first")
	case <-time.After(50 * time.Millisecond):
	}
	// another session's step does not
	other := make(chan struct{})
	go func() {
		defer close(other)
		_, finished := table.stepSession("stateful-2")
		finished()
	}()
	select {
	case <-other:
	case <-time.After(2 * time.Second):
		t.Error("another session's step waited for the first session's turn")
	}
	close(release)
	<-done
	<-waited
	// a stateless request is a session of its own, twice
	a, doneA := table.stepSession("")
	if a == nil {
		t.Fatal("no session")
	}
	doneA()
	b, doneB := table.stepSession("")
	if a == b {
		t.Error("two stateless requests share one logical session")
	}
	doneB()
}

func TestSessionTableForget(t *testing.T) {
	table := &sessionTable{byKey: map[string]*logicalSession{}}
	s, finished := table.stepSession("cookie-1")
	finished()
	if got := len(table.byKey); got != 1 {
		t.Fatalf("%d rows", got)
	}
	table.forget("cookie-1")
	if got := len(table.byKey); got != 0 {
		t.Fatalf("forget left %d rows", got)
	}
	// a forgotten session's statics are nobody's: the next step of the key
	// is a new session, which is what a logoff means
	again, finishedAgain := table.stepSession("cookie-1")
	if again == s {
		t.Error("the session after the logoff is the one before it")
	}
	finishedAgain()
}

func TestADTSessionKey(t *testing.T) {
	adtReadSteps = true
	defer func() { adtReadSteps = false }()
	r := httptest.NewRequest("GET", "/sap/bc/adt/oo/classes/zcl_a/source/main", nil)
	if got := adtSessionKey(r); got != "" {
		t.Fatalf("a request without the cookie: %q", got)
	}
	r.AddCookie(&http.Cookie{Name: "SAP_SESSIONID_" + abap.SysID + "_" + adtClient(), Value: "abc123"})
	if got := adtSessionKey(r); got != "abc123" {
		t.Fatalf("the cookie's session: %q", got)
	}
	// the sap-contextid cookie (the ABAP class's first choice) is not the
	// host's key: the class reads it itself, and the host's key is the one
	// the client keeps across the logon
	r2 := httptest.NewRequest("GET", "/sap/bc/adt", nil)
	r2.AddCookie(&http.Cookie{Name: "sap-contextid", Value: "ctx"})
	if got := adtSessionKey(r2); got != "" {
		t.Fatalf("the context id is not the host's session key: %q", got)
	}
	if adtSessionKey(nil) != "" {
		t.Error("no request, no session")
	}
}

func TestStepReport(t *testing.T) {
	if got := stepReport("GET", "/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet", odataBase+"/"); got != "sap/opu/odata/sap ZSTG_DEMO_SRV/TravelSet" {
		t.Fatalf("report %q", got)
	}
	if got := stepReport("GET", "/sap/bc/adt", "/sap/bc/adt"); got != "sap/bc/adt" {
		t.Fatalf("the mount itself: %q", got)
	}
}
