package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"osg/gogen/abap"
	"osg/gogen/workpool"
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
		{"GET", odataBase}, // the base icfHandler is mounted with
		{"HEAD", odataBase},
		{"GET", statusODataPath},
		{"GET", "/sap/bc/adt"},
	}
	for _, tc := range read {
		if stepKindOf(tc.method, tc.base) != abap.ReadStep {
			t.Errorf("%s of %s is not a read step", tc.method, tc.base)
		}
	}
	write := []struct{ method, base string }{
		{"POST", odataBase},
		{"PUT", odataBase},
		{"MERGE", odataBase},
		{"DELETE", odataBase},
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

// take is stepSession with no deadline, as the tests below wait.
func take(t *testing.T, table *sessionTable, key string) (*logicalSession, func()) {
	t.Helper()
	s, done, err := table.stepSession(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	return s, done
}

func TestSessionTableOneStepAtATime(t *testing.T) {
	table := newSessionTable()
	inStep := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		s, finished := take(t, table, "stateful-1")
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
		_, finished := take(t, table, "stateful-1")
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
		_, finished := take(t, table, "stateful-2")
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
	// two stateless requests at the same time never share a store; one
	// after the other reuse it (the stateless stores, sessionTable)
	a, doneA := take(t, table, "")
	b, doneB := take(t, table, "")
	if a == nil || b == nil || a == b {
		t.Fatalf("two concurrent stateless requests: %p %p", a, b)
	}
	doneA()
	doneB()
	c, doneC := take(t, table, "")
	if c != a && c != b {
		t.Error("a stateless request after two ended made a third store instead of reusing one")
	}
	doneC()
}

func TestSessionTableForget(t *testing.T) {
	table := newSessionTable()
	s, finished := take(t, table, "cookie-1")
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
	again, finishedAgain := take(t, table, "cookie-1")
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

// fakeConn is a lent connection that runs nothing: enough for the bracket.
type fakeConn struct{}

func (fakeConn) Query(string, ...any) (*sql.Rows, error) { return nil, nil }
func (fakeConn) Exec(string, ...any) (sql.Result, error) { return nil, nil }
func (fakeConn) Prepare(string) (*sql.Stmt, error)       { return nil, nil }

// The ADT session rows leave the step only in a read step: a modifying
// step holds the file's one write lock, and the state session writing on
// its own connection inside it waited for that very lock (every ADT POST
// through the gateway answered SQLITE_BUSY after the busy timeout). In a
// read step they run on the state work process, one transaction a call.
func TestADTStateOnlyOutsideWriteSteps(t *testing.T) {
	d, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "state.sqlite")+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	p, err := workpool.New(workpool.Options{DB: d, Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	state := &abap.Session{}
	adtState.pool, adtState.s, adtState.tuned = p, state, false
	defer func() { adtState.pool, adtState.s, adtState.tuned = nil, nil, false }()
	on := func(kind abap.StepKind) *abap.Session {
		step := &abap.Session{}
		var got *abap.Session
		abap.DialogStepOn(step, kind, fakeConn{}, func() {
			withADTState(step, func(s *abap.Session) {
				got = s
				if s == state && !s.InWriteStep() {
					t.Error("the state session ran outside its own transaction")
				}
			})
		})
		return got
	}
	if got := on(abap.ReadStep); got != state {
		t.Fatalf("a read step's ADT rows ran on %p, want the state session", got)
	}
	if got := on(abap.WriteStep); got == state {
		t.Fatal("a modifying step's ADT rows ran on the state session: it would wait for the step's own write lock")
	}
	if !adtState.tuned {
		t.Error("the state connection's synchronous pragma was not set")
	}
}

// A candidate's pool is read-only: every step is lent as a read, and the
// kernel must open it as one (BEGIN, not BEGIN IMMEDIATE, on a query_only
// connection), or the candidate's boot dies before it can be smoked.
func TestStepKindFollowsAReadOnlyPool(t *testing.T) {
	d, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "cand.sqlite")+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec("CREATE TABLE r (id INTEGER)"); err != nil {
		t.Fatal(err)
	}
	p, err := workpool.New(workpool.Options{DB: d, Workers: 1, ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if err := p.Step(context.Background(), workpool.Write, func(st *workpool.Step) {
		if k := stepKindOn(st); k != abap.ReadStep {
			t.Errorf("a read-only pool's step opens as %v", k)
		}
		abap.DialogStepOn(&abap.Session{}, stepKindOn(st), st, func() {})
	}); err != nil {
		t.Fatal(err)
	}
}

// Regression (PR #900 review, MUST 3): a step of a session in a WAIT holds
// the session's turn and gives up its work process and, a modifying one,
// the write token. A second step of the same session took the token and a
// work process first and only then waited for the turn: the first, back
// from the WAIT, waited for the token the second held -- both hung, and
// every writer behind them. The turn comes first now. Two work processes
// with writers, and one work process with readers (where the second step
// held the only work process).
func TestSameSessionStepDuringWaitDoesNotDeadlock(t *testing.T) {
	for _, tc := range []struct {
		name    string
		workers int
		kind    abap.StepKind
	}{
		{"writers on two work processes", 2, abap.WriteStep},
		{"readers on one work process", 1, abap.ReadStep},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "s.sqlite")+"?_pragma=journal_mode(WAL)")
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			d.SetMaxOpenConns(tc.workers + 1)
			p, err := workpool.New(workpool.Options{DB: d, Workers: tc.workers})
			if err != nil {
				t.Fatal(err)
			}
			savedWP, savedSessions := wp, sessions
			wp, sessions = p, newSessionTable()
			defer func() { p.Close(); wp, sessions = savedWP, savedSessions }()

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel() // breaks the cycle if there is one, so the test ends
			req := httptest.NewRequest("POST", "/", nil).WithContext(ctx)
			waiting := make(chan struct{})
			aDone, bDone := make(chan struct{}), make(chan struct{})
			go func() {
				defer close(aDone)
				runWorkStep(req, tc.kind, "same-session", "A", func(s *abap.Session) {
					close(waiting)
					s.YieldSleep(300 * time.Millisecond)
				})
			}()
			<-waiting
			for p.InFlight() != 0 {
				time.Sleep(time.Millisecond)
			}
			go func() {
				defer close(bDone)
				runWorkStep(req, tc.kind, "same-session", "B", func(s *abap.Session) {})
			}()
			for _, c := range []struct {
				name string
				done chan struct{}
			}{{"A, back from its WAIT", aDone}, {"B, after A's turn", bDone}} {
				select {
				case <-c.done:
					continue
				case <-time.After(3 * time.Second):
					t.Errorf("%s never finished: the session's turn and the pool's resources wait for each other", c.name)
				}
				break
			}
			cancel() // the cycle, if any, is broken here; both end before the globals go back
			<-aDone
			<-bDone
		})
	}
}

// PR #900 review (SHOULD): the keyed sessions are reclaimed -- on the ABAP
// session's END while a step holds the turn and another waits (the waiter
// keeps its one-at-a-time and starts without the ended session's statics),
// after a step whose cookie the session class did not accept, after the
// idle time, and a wait for the turn ends with its context.
func TestSessionTableReclaims(t *testing.T) {
	table := newSessionTable()
	saved := sessions
	sessions = table // keyResolved and adtSessionEnded forget on the global table
	defer func() { sessions = saved }()
	clock := time.Unix(1_000_000, 0)
	table.now = func() time.Time { return clock }

	// END during a step, with a second step of the session queued
	held, doneHeld := take(t, table, "ended")
	held.statics = &abap.Statics{}
	queued := make(chan *logicalSession)
	go func() {
		s, done := take(t, table, "ended")
		queued <- s
		<-queued
		done()
	}()
	for {
		table.mu.Lock()
		refs := held.refs
		table.mu.Unlock()
		if refs == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	adtSessionEnded("ended") // the generated adapter's END
	select {
	case <-queued:
		t.Fatal("the queued step ran beside the step that ended the session")
	case <-time.After(30 * time.Millisecond):
	}
	doneHeld()
	next := <-queued
	if next != held || next.statics != nil {
		t.Errorf("the queued step after the END: same entry %v, statics %p", next == held, next.statics)
	}
	queued <- nil
	for {
		table.mu.Lock()
		n := len(table.byKey)
		table.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}

	// a cookie the class did not accept: the step resolved another session
	_, done := take(t, table, "unknown-cookie")
	s := &abap.Session{}
	adtResolved.Store(s, "fresh-id")
	keyResolved(s, "unknown-cookie")
	done()
	if _, ok := table.byKey["unknown-cookie"]; ok {
		t.Error("a cookie that named no session stayed in the table")
	}
	// one it did accept stays
	_, done = take(t, table, "live")
	s = &abap.Session{}
	adtResolved.Store(s, "live")
	keyResolved(s, "live")
	done()
	if _, ok := table.byKey["live"]; !ok {
		t.Error("a live session was dropped")
	}

	// idle: swept once the ADT session's lifetime has passed; the
	// instance's own session never is
	_, done = take(t, table, systemSessionKey)
	done()
	clock = clock.Add(sessionIdleTTL + sessionSweepEvery + time.Second)
	_, done = take(t, table, "other")
	done()
	if _, ok := table.byKey["live"]; ok {
		t.Error("an idle session outlived the ADT session's lifetime")
	}
	if _, ok := table.byKey[systemSessionKey]; !ok {
		t.Error("the instance's own session was swept")
	}

	// a wait for the turn ends with its context
	_, done = take(t, table, "busy")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := table.stepSession(ctx, "busy"); err == nil {
		t.Error("a cancelled wait for the turn took it")
	}
	done()
	if table.byKey["busy"].refs != 0 {
		t.Error("the cancelled wait left its reference")
	}
}
