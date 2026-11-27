package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"osg/gogen/abap"
	"osg/gogen/workpool"
)

// The dispatcher of this sidecar (ADR 0010 slice 5): M work processes of
// go/workpool over the database, and the table of logical internal
// sessions. A session's statics are its own (a system keeps CLASS-DATA in
// the internal session, rolled in with the user context), except the slots
// marked instance-wide (abap.RegisterSharedStatics), which every session
// reads from one store: the runtime's own caches, a system's shared program
// buffer. One step of a session at a time, as on a system; the steps of a
// stateless request are each a session of their own, which is what a
// stateless request is on a system too.
//
// The step's kind is decided by the request: GET and HEAD of the fronts
// that write nothing (OData, the ADT reads over a file database, the status
// service) are read steps -- M of them in parallel beside a writer, a write
// inside one a dump -- and everything else (POST, PUT, MERGE, DELETE,
// $batch, an APC message, the boot, the status refresh) is a modifying
// step. A front whose GET writes (the webgui's session rows) stays
// modifying on purpose: the safe default is a writer, and a front becomes
// a read step when its reads are proven to write nothing.

// wp is the pool; nil until the database is open (a -version run never
// opens one).
var wp *workpool.Pool

// workProcessCount is what -wp / OSD_WPS / the cores asked for, so a
// promotion can rebuild the pool as it was.
var workProcessCount int

// workProcesses is M: -wp, else OSD_WPS, else the cores.
func workProcesses(count string, getenv func(string) (string, bool), cores int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(count)); err == nil && n > 0 {
		return n
	}
	if v, ok := getenv("OSD_WPS"); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
			return n
		}
	}
	if cores < 1 {
		cores = 1
	}
	return cores
}

// openWorkProcesses makes the pool over the database the instance opened.
// An in-memory database gets the one connection it can have and no spare
// (one database per connection: a spare would see an empty private
// database, and M would be M databases); a file gets two spares: the ADT
// state work process below holds one, the other is for what runs outside
// a step (a tool reading the file).
func openWorkProcesses(dbFile string, count int) {
	workProcessCount = count
	if count < 1 {
		count = 1 // workProcesses answers at least one; a zero is a caller's
	}
	memory := dbFile == ""
	workers, spare := count, 2
	if memory {
		workers, spare = 1, 0
	}
	instance.DB.OpenPool(workers, spare)
	adtStateSpare = spare > 0
	p, err := workpool.New(workpool.Options{DB: instance.DB.SQL(), Workers: workers,
		ReadOnly: candidate.Load(), Generation: buildGeneration, Logf: log.Printf})
	if err != nil {
		log.Fatalf("work processes: %v", err)
	}
	if wp != nil {
		wp.Close()
	}
	wp = p
	adtReadSteps = !memory
	if memory {
		log.Printf("work processes: 1 (an in-memory database is one database per connection)")
	} else {
		log.Printf("work processes: %d (OSD_WPS or -wp to change)", p.Workers())
	}
}

// adtReadSteps says whether the ADT fronts' GETs run as read steps: over a
// file, with the session rows on the state session below. On the one
// connection of an in-memory database there is no connection for them, so
// the whole ADT step runs as the modifying step it is.
var adtReadSteps bool

// adtStateSpare says the pool made the spare connection the state session
// runs on; an in-memory database has none.
var adtStateSpare bool

// adtState is where the ADT session class keeps its rows: a session of its
// own on a work process of its own (a one-worker pool over a spare
// connection), outside the step's LUW. A system's session context is
// kernel state, not business data -- it must survive a dumped request (the
// user's session does), and it must not make every ADT read a writer of
// the business database, which would serialise the very reads the work
// processes exist to parallelise (ZCL_OSD_ADT_SESSION touches its row on
// every resolve: the sweep, the open, the touched UPDATE). One call at a
// time, each one transaction (BEGIN IMMEDIATE: no snapshot to lose at the
// upgrade) on a connection with synchronous = NORMAL: the first version
// ran every statement in autocommit with a full fsync, under a mutex, and
// the ADT source read through 12 work processes on i10 went from 15 to 21
// rps instead of scaling -- the goroutine dumps were all on that mutex,
// its holder in fsync.
//
// What NORMAL gives up, in full (https://www.sqlite.org/pragma.html#pragma_synchronous):
// a process crash loses nothing -- a committed transaction is in the WAL
// file, and the next open replays it. An OS crash or a power cut can roll
// back every transaction of this connection committed since the WAL was
// last synced (the next fsync of the same WAL -- a business commit, a
// checkpoint -- makes them durable). Those are all of the session class's
// writes, not only the touches: a session opened (its row and token gone:
// the client's next request is refused and logs on again, as after a
// system restart), a session ended or swept (its row back: it is expired
// by its TOUCHED time on sight, or alive again until the TTL if the cut
// came within it -- an ended session's cookie can work again), a handle
// adopted (gone: the editor's lock handle is unknown, it locks again) or
// released (back: a stale handle row, which HOLDS still checks against the
// enqueue server, empty after a restart). The file stays consistent in
// every case; no business row is on this connection, and the modifying
// steps' own connections keep the database's synchronous setting.
var adtState struct {
	pool  *workpool.Pool
	s     *abap.Session
	tuned bool // the state connection's synchronous pragma, set once
}

// withADTState runs the ADT session class's persistence on that session,
// or -- on the one connection of an in-memory database, where the work
// process holds it -- on the step's own session, as it always ran. The
// generated adapter (zz_adt_session.go) wraps every call of the class in
// this, so its rows leave the step's transaction wherever there is a
// connection for them.
//
// Only a read step leaves: a modifying step holds the file's one write lock
// (BEGIN IMMEDIATE) until it ends, and a write of the state session on the
// spare connection inside it would wait for that very lock -- a deadlock
// broken only by busy_timeout, found by the first conformance run through
// the gateway (every ADT POST SQLITE_BUSY). In a modifying step the rows
// stay in the step's LUW, as before slice 5: a dump there rolls the touch
// back with the rest of the step.
func withADTState(step *abap.Session, run func(*abap.Session)) {
	if adtState.pool == nil || step.InWriteStep() {
		run(step)
		return
	}
	kind := abap.WriteStep
	if candidate.Load() {
		kind = abap.ReadStep // a candidate writes nothing until promoted
	}
	err := adtState.pool.Step(context.Background(), workpool.Kind(kind), func(st *workpool.Step) {
		if !adtState.tuned { // one worker: the steps here are serial
			if _, err := st.Exec("PRAGMA synchronous = NORMAL"); err != nil {
				panic(abap.ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
			}
			adtState.tuned = true
		}
		abap.DialogStepOn(adtState.s, stepKindOn(st), st, func() { run(adtState.s) })
	})
	if err != nil { // the state work process is closed: the host is stopping
		panic(abap.ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
}

// mintADTState makes the state session once the instance has its database:
// on the spare connection, when there is one (a file); an in-memory
// database has none, and the rows stay in the step.
func mintADTState() {
	if adtState.pool != nil {
		adtState.pool.Close()
		adtState.pool, adtState.tuned = nil, false
	}
	if !adtStateSpare {
		return
	}
	p, err := workpool.New(workpool.Options{DB: instance.DB.SQL(), Workers: 1,
		ReadOnly: candidate.Load(), Generation: buildGeneration, Logf: log.Printf})
	if err != nil {
		log.Fatalf("ADT state work process: %v", err)
	}
	adtState.pool = p
	adtState.s = &abap.Session{DB: instance.DB, Shared: instance.Statics}
}

// logicalSession is one logical internal session: its turn (one step of a
// session at a time) and its statics, which every work process that runs
// one of its steps borrows. The turn is a channel so a step waiting for it
// can be cancelled (its client went away) -- a sync.Mutex cannot.
type logicalSession struct {
	turn    chan struct{} // holding a value is holding the turn
	statics *abap.Statics // read and written only by the turn's holder
	// guarded by sessionTable.mu:
	refs  int       // steps holding the turn or waiting for it
	last  time.Time // when a step last gave the turn back
	ended bool      // ended (logoff) while a step held the turn: its statics go at the release
	gone  bool      // ended: the entry goes when no step holds or waits for it
}

func newLogicalSession() *logicalSession {
	return &logicalSession{turn: make(chan struct{}, 1)}
}

// sessionTable is the sidecar's logical internal sessions, keyed by what
// identifies one: an ADT session's cookie (a stateful session), a push
// channel, or nothing -- a stateless request.
//
// A stateless request borrows one of the stateless stores: a free list,
// one store per stateless step running at the moment (at most the work
// processes plus the steps parked in a WAIT), each kept across requests.
// The ADR's first choice, a fresh store per stateless request (what a
// system does), cost the OData read a third of its rate at one client and
// half at sixteen on i10 (class constructors and lazy caches rebuilt per
// request; ADR 0010 slice 5 row); the ADR left exactly this to that number.
// A list and not a store per work process: a step that WAITs moves to
// another work process and keeps its store, so a store tied to the work
// process would be shared by two steps. A stateless request so sees the
// CLASS-DATA a previous stateless request left in its store -- what both
// hosts did before this slice with one store per process (ANORMALIES), now
// one per concurrent step.
//
// A keyed session is reclaimed (PR #900 review) when the ABAP session it
// stands for ends -- a logoff (adtSessionEnded), a cookie the session
// class did not accept (the step resolved another session, so the key
// named none: dropped after its step, which bounds what unknown cookie
// values can leave behind to the steps in flight) -- or when nobody used
// it for the ADT session's own lifetime (an expiry the class sweeps by
// itself, without the host hearing of it). A session ended while steps
// still hold or wait for its turn stays in the table until the last of
// them gives it back, so they keep their one-at-a-time; its statics are
// gone for the steps after the end, as a system's internal session is.
type sessionTable struct {
	mu        sync.Mutex
	byKey     map[string]*logicalSession
	stateless []*logicalSession
	idle      time.Duration    // a keyed session unused this long is reclaimed
	swept     time.Time        // the last idle sweep
	now       func() time.Time // the clock (a test's)
}

// sessionIdleTTL is the ADT session class's own lifetime (the 1800 s the
// adapter constructs ZCL_OSD_ADT_SESSION with): a session idle that long
// has expired in ABAP too, and its next request opens a new one.
const sessionIdleTTL = 30 * time.Minute

// sessionSweepEvery bounds the cost of the idle sweep: one pass over the
// table at most this often, on the way into a keyed step.
const sessionSweepEvery = 30 * time.Second

// systemSessionKey is the instance's own logical session (runSystemStep):
// the boot's statics live there for the process's life, never swept.
const systemSessionKey = "osgo-system"

func newSessionTable() *sessionTable {
	return &sessionTable{byKey: map[string]*logicalSession{}, idle: sessionIdleTTL, now: time.Now}
}

var sessions = newSessionTable()

// stepSession is the session the step runs in, with its turn taken: the
// key's session, or a stateless store when the key is empty. The caller
// takes it before the pool's write token and work process (runWorkStep):
// a step of the session parked in a WAIT holds the turn and gives those
// up, and must find them free again when it wakes -- a second step of the
// session that took them first and then waited for the turn deadlocked
// with it (PR #900 review). A cancelled ctx ends the wait; done returns
// the turn, with the statics the step leaves behind.
func (t *sessionTable) stepSession(ctx context.Context, key string) (s *logicalSession, done func(), err error) {
	if key == "" {
		t.mu.Lock()
		var free *logicalSession
		if n := len(t.stateless); n > 0 {
			free, t.stateless = t.stateless[n-1], t.stateless[:n-1]
		} else {
			free = newLogicalSession()
		}
		t.mu.Unlock()
		// taken off the list, the store is this step's alone: no turn to wait for
		return free, func() {
			t.mu.Lock()
			t.stateless = append(t.stateless, free)
			t.mu.Unlock()
		}, nil
	}
	t.mu.Lock()
	t.sweepLocked()
	s, ok := t.byKey[key]
	if !ok {
		s = newLogicalSession()
		t.byKey[key] = s
	}
	s.refs++
	t.mu.Unlock()
	select {
	case s.turn <- struct{}{}:
	case <-ctx.Done():
		t.mu.Lock()
		s.refs--
		t.dropIfDoneLocked(key, s)
		t.mu.Unlock()
		return nil, nil, ctx.Err()
	}
	return s, func() { t.release(key, s) }, nil
}

// release gives the turn back. The statics of a session that ended during
// the step go with it; the entry goes when no step holds or waits for it.
func (t *sessionTable) release(key string, s *logicalSession) {
	t.mu.Lock()
	s.refs--
	s.last = t.now()
	if s.ended {
		// the steps after the end start a new internal session; the entry
		// stays for them (their one-at-a-time) and goes with the last
		s.statics, s.ended = nil, false
	}
	t.dropIfDoneLocked(key, s)
	t.mu.Unlock()
	<-s.turn
}

// dropIfDoneLocked removes an ended session nobody holds or waits for.
func (t *sessionTable) dropIfDoneLocked(key string, s *logicalSession) {
	if s.refs == 0 && s.gone && t.byKey[key] == s {
		delete(t.byKey, key)
	}
}

// sweepLocked reclaims the keyed sessions nobody used for the idle time.
func (t *sessionTable) sweepLocked() {
	now := t.now()
	if now.Sub(t.swept) < sessionSweepEvery {
		return
	}
	t.swept = now
	for key, s := range t.byKey {
		if key != systemSessionKey && s.refs == 0 && now.Sub(s.last) > t.idle {
			delete(t.byKey, key)
		}
	}
}

// forget ends a logical session (a logoff, a key the ABAP session class
// did not accept): its statics die with it, as a system's internal session
// does. Steps that hold or wait for its turn keep it until they are done.
func (t *sessionTable) forget(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s, ok := t.byKey[key]
	if !ok {
		return
	}
	if s.refs == 0 {
		delete(t.byKey, key)
		return
	}
	s.ended, s.gone = true, true
}

// adtSessionEnded is the ADT session class's END as the generated adapter
// reports it (osgo.mjs adtSessionAdapter): the session's id is the value of
// the cookie the host keys the logical session by.
func adtSessionEnded(id string) { sessions.forget(id) }

// adtResolved is the ADT session a step resolved, by the step's session
// (noteADTSession), for runWorkStep to compare with the key it ran under.
var adtResolved sync.Map

// noteADTSession records the ADT session the step resolved, if it did.
func noteADTSession(s *abap.Session) {
	v, ok := adtWriteSessions.Load(s)
	if !ok {
		return
	}
	view, ok := v.(interface{ View() (string, bool) })
	if !ok {
		return
	}
	if id, _ := view.View(); id != "" {
		adtResolved.Store(s, id)
	}
}

// keyResolved drops a keyed logical session whose step resolved another
// ADT session: the cookie named no live session (an unknown, ended or
// expired value), so nothing stateful will come back under it.
func keyResolved(s *abap.Session, key string) {
	v, ok := adtResolved.LoadAndDelete(s)
	if !ok || key == "" {
		return
	}
	if id, _ := v.(string); id != key {
		sessions.forget(key)
	}
}

// adtSessionKey is the logical internal session of a request: the ADT
// session cookie, the name the ABAP session class bakes from the same
// identity (cookie_name: SAP_SESSIONID_<sid>_<client>), or "" -- a
// stateless request.
func adtSessionKey(r *http.Request) string {
	if r == nil {
		return ""
	}
	c, err := r.Cookie("SAP_SESSIONID_" + abap.SysID + "_" + adtClient())
	if err != nil {
		return ""
	}
	return c.Value
}

// adtClient is the logon client of the ADT identity, the same one
// adtIdentity bakes the cookie name with.
func adtClient() string {
	return adtIdentity(abap.SysID, os.LookupEnv).Client
}

// stepKindOf decides the step's kind: a read step only for the GETs and
// HEADs of the fronts that write nothing.
func stepKindOf(method, base string) abap.StepKind {
	if method != "GET" && method != "HEAD" {
		return abap.WriteStep
	}
	// base is what icfHandler was mounted with: odataBase for the OData
	// front and the status service alike (no trailing slash; the first
	// version compared odataBase+"/", so every OData read ran as a
	// modifying step and queued on the write lock -- found by the bench)
	if base == odataBase || base == statusODataPath || (base == "/sap/bc/adt" && adtReadSteps) {
		return abap.ReadStep
	}
	return abap.WriteStep
}

// runWorkStep runs one dialog step of a request on a work process: the
// logical session borrowed, the kind's transaction on the lent connection,
// the step's report in the work-process row. The dump, if there is one,
// comes back with its ABAP frames; err is the pool's refusal to lend (the
// drain), which the caller answers as a stop, not a dump.
func runWorkStep(r *http.Request, kind abap.StepKind, key, report string, work func(s *abap.Session)) (dump any, frames []string, err error) {
	if wp == nil { // a host that never opened a database (its tests)
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					dump, frames = rec, abapStack(rec)
				}
			}()
			s := &abap.Session{}
			defer adtResolved.Delete(s)
			work(s)
		}()
		return dump, frames, nil
	}
	// the session's turn first, then the pool's write token and work
	// process (stepSession): never the other way round
	ctx := requestContext(r)
	sess, done, err := sessions.stepSession(ctx, key)
	if err != nil {
		return nil, nil, err
	}
	defer done()
	err = wp.Step(ctx, workpool.Kind(kind), func(st *workpool.Step) {
		st.SetReport(report)
		defer func() {
			if rec := recover(); rec != nil {
				dump, frames = rec, abapStack(rec)
			}
		}()
		s := &abap.Session{DB: instance.DB, Statics: sess.statics, Shared: instance.Statics}
		defer keyResolved(s, key)
		abap.DialogStepOn(s, stepKindOn(st), st, func() { work(s) })
		sess.statics = s.Statics
	})
	return dump, frames, err
}

// stepKindOn is the kind the kernel opens the step's transaction with: the
// one the pool lent the work process for. A read-only pool (a candidate
// generation, query_only until promoted) lends every step as a read, and
// BEGIN IMMEDIATE on its connection is refused ("attempt to write a
// readonly database"): the candidate's boot died of it in the CI swap test.
func stepKindOn(st *workpool.Step) abap.StepKind { return abap.StepKind(st.Kind()) }

// requestContext is the request's, so a client that goes away fences the
// statements of its step (sqlite3_interrupt through the driver).
func requestContext(r *http.Request) context.Context {
	if r == nil {
		return context.Background()
	}
	return r.Context()
}

// runSystemStep is a step the host itself runs -- the boot, the demo rows,
// the status refresh -- on the instance's own logical session.
func runSystemStep(kind abap.StepKind, report string, work func(s *abap.Session)) error {
	if wp == nil {
		s := instance.NewSession()
		abap.DialogStep(s, func() { work(s) })
		return nil
	}
	sess, done, err := sessions.stepSession(context.Background(), systemSessionKey)
	if err != nil {
		return err
	}
	defer done()
	return wp.Step(context.Background(), workpool.Kind(kind), func(st *workpool.Step) {
		st.SetReport(report)
		s := &abap.Session{DB: instance.DB, Statics: sess.statics, Shared: instance.Statics}
		abap.DialogStepOn(s, stepKindOn(st), st, func() { work(s) })
		sess.statics = s.Statics
	})
}

// stepLock is the drain's lock: the pool, or the one work process of a
// host that never opened a database.
func stepLock() sync.Locker {
	if wp != nil {
		return workpool.Locker{P: wp}
	}
	return workProcess
}

// wpServing is the work processes as GET /osd/serving reports them: M, and
// how many of them a connection that could not be replaced took out of
// service (their ZOSD_WP rows say Stopped). Nil without a pool.
func wpServing() map[string]any {
	if wp == nil {
		return nil
	}
	out := wp.OutOfService()
	return map[string]any{"workProcesses": map[string]any{
		"workers": wp.Workers(), "inService": wp.Workers() - out, "outOfService": out}}
}

// wpSnapshot is the work-process rows for the status tables (ZOSD_WP).
func wpSnapshot() []workpool.WPRow {
	if wp == nil {
		return nil
	}
	return wp.Snapshot()
}

// wpStarted is when a work process's running step began, ISO, for the row.
func wpStarted(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
