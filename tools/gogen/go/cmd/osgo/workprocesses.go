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
		ReadOnly: candidate.Load(), Generation: buildGeneration})
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
// its holder in fsync. NORMAL in WAL mode keeps the file consistent and
// loses at most the last session touches on a power cut (they are made
// durable by the next business commit's fsync of the same WAL): a lost
// session row is a logon again, which is what a system restart is too.
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
		ReadOnly: candidate.Load(), Generation: buildGeneration})
	if err != nil {
		log.Fatalf("ADT state work process: %v", err)
	}
	adtState.pool = p
	adtState.s = &abap.Session{DB: instance.DB, Shared: instance.Statics}
}

// logicalSession is one logical internal session: its turn (one step of a
// session at a time) and its statics, which every work process that runs
// one of its steps borrows.
type logicalSession struct {
	mu      sync.Mutex
	statics *abap.Statics
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
type sessionTable struct {
	mu        sync.Mutex
	byKey     map[string]*logicalSession
	stateless []*logicalSession
}

var sessions = &sessionTable{byKey: map[string]*logicalSession{}}

// stepSession is the session the step runs in, with its turn taken: the
// key's session, or a fresh one when the key is empty. The caller returns
// the turn when the step has run.
func (t *sessionTable) stepSession(key string) (s *logicalSession, done func()) {
	if key == "" {
		t.mu.Lock()
		var free *logicalSession
		if n := len(t.stateless); n > 0 {
			free, t.stateless = t.stateless[n-1], t.stateless[:n-1]
		} else {
			free = &logicalSession{}
		}
		t.mu.Unlock()
		free.mu.Lock()
		return free, func() {
			free.mu.Unlock()
			t.mu.Lock()
			t.stateless = append(t.stateless, free)
			t.mu.Unlock()
		}
	}
	t.mu.Lock()
	s, ok := t.byKey[key]
	if !ok {
		s = &logicalSession{}
		t.byKey[key] = s
	}
	t.mu.Unlock()
	s.mu.Lock()
	return s, s.mu.Unlock
}

// forget ends a logical session (a logoff): its statics die with it, as a
// system's internal session does.
func (t *sessionTable) forget(key string) {
	t.mu.Lock()
	delete(t.byKey, key)
	t.mu.Unlock()
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
			work(&abap.Session{})
		}()
		return dump, frames, nil
	}
	err = wp.Step(requestContext(r), workpool.Kind(kind), func(st *workpool.Step) {
		st.SetReport(report)
		defer func() {
			if rec := recover(); rec != nil {
				dump, frames = rec, abapStack(rec)
			}
		}()
		sess, done := sessions.stepSession(key)
		defer done()
		s := &abap.Session{DB: instance.DB, Statics: sess.statics, Shared: instance.Statics}
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
	return wp.Step(context.Background(), workpool.Kind(kind), func(st *workpool.Step) {
		st.SetReport(report)
		sess, done := sessions.stepSession("osgo-system")
		defer done()
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
