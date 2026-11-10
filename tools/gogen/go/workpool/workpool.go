// Package workpool is the work-process pool of a serving sidecar (ADR 0010
// slice 5): M work processes, each one connection of the one SQLite WAL
// file, one dialog step at a time on each. What a system's dispatcher gives
// a request -- a work process of its own, the step's kind deciding what the
// step may do to the database -- is decided here for the sidecar, and the
// policy is the ADR's:
//
//   - a read step (ICF GET/HEAD, an ADT read, $metadata, an OData read
//     without a function import) runs on a connection in query_only mode,
//     so it never takes the write lock and M of them run in parallel; a
//     write attempt inside one is a dump, as a write in a GET is already
//     outside the LUW bracket (docs/luw-buffer.md);
//   - a modifying step (POST, PUT, MERGE, DELETE, $batch, a function
//     import, a job run, a daemon callback, an APC message) runs BEGIN
//     IMMEDIATE: writers serialise at the database's one write lock, with
//     busy_timeout set to the drain grace, so a writer waits rather than
//     fails while a swap's drain window holds the file;
//   - the fence of a hung step is sqlite3_interrupt, which the driver
//     exposes as the cancellation of the running statement's context: each
//     step's context is cancellable (Interrupt), and the step's next
//     statement fails and unwinds as a dump, its LUW rolled back.
//
// The transaction itself is the kernel's bracket (go/abap DialogStepOn:
// BEGIN by the kind, COMMIT when work returns, ROLLBACK when it dumps), so
// this package lends the connection and owns what belongs to the
// connection: query_only, busy_timeout, the per-work-process statement
// cache, and the fence. A WAIT inside a step gives the work process up and
// takes another on return (Yield); the step keeps working because the
// connection under it is the pool's to swap.
//
// One step of a session at a time is the host's rule, not the pool's: the
// host owns the logical internal sessions (their statics, their turn), and
// what it hands the pool is only the step.
//
// No import of osg/gogen/abap, of generated code or of tools/osd-*.
package workpool

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// DefaultBusyTimeout is the drain grace (go/serving DefaultGrace): a writer
// waits for the write lock that long, so a swap's drain window -- two
// sidecars on one file -- delays writers instead of failing them.
const DefaultBusyTimeout = 55 * time.Second

// Kind is the step's half of the database policy. It is a bool so the
// modifying kind reads as the condition it is: Write for what changes rows.
type Kind bool

const (
	Read  Kind = false // deferred transaction on a query_only connection
	Write Kind = true  // BEGIN IMMEDIATE on the connection as it is
)

func (k Kind) String() string {
	if k {
		return "write"
	}
	return "read"
}

// Options describe the pool to New.
type Options struct {
	// DB is the opened database; every work process takes one connection
	// of it and holds it for the pool's life. The caller sized the pool
	// (SetMaxOpenConns) for the work processes plus what runs outside a
	// step, and WAL mode is the file's own.
	DB *sql.DB
	// Workers is M. Below 1 is one work process (the in-memory database
	// is one database per connection, so M cannot exceed 1 there).
	Workers int
	// BusyTimeout is on every connection; zero is DefaultBusyTimeout.
	BusyTimeout time.Duration
	// ReadOnly forces every step to Read: a swap candidate serves read
	// transactions only until it is promoted (cmd/osgo candidate.go).
	ReadOnly bool
	// Generation is what the work-process rows say (the sidecar's build).
	Generation string
	// ReconnectGrace bounds how long a work process whose connection was
	// discarded (a scrub that could not prove it clean) tries for a new
	// one before it is taken out of service; zero is BusyTimeout, the
	// drain grace. The tries back off from 10 ms to 1 s.
	ReconnectGrace time.Duration
	// Logf reports a work process taken out of service; nil is silent.
	Logf func(format string, args ...any)
}

// Pool is M work processes over one database. The free work processes live
// in a channel of capacity M; a step takes one, runs, returns it, and the
// drain (Locker) empties the channel of all M -- which waits for the steps
// in flight, because they hold theirs until they end.
type Pool struct {
	o       Options
	workers []*worker
	tokens  chan *worker
	// writer is SQLite's one write lock as a token: a modifying step takes
	// it before its work process and holds it until it ends (or WAITs).
	// Without it M writers each ran BEGIN IMMEDIATE and queued inside
	// SQLite's busy handler, which sleeps 1, 2, 5 ... 100 ms between tries
	// instead of waking the next writer: on i10 the write mix through M work
	// processes lost 44 % at 4 clients with a p99 of 34 ms. A channel wakes
	// the next writer when the lock is free, and a writer waiting here holds
	// no work process the readers could use. busy_timeout is left for what
	// writes beside the pool (the state session, another generation).
	writer  chan struct{}
	mu      sync.Mutex // the registry rows and the lending state below
	live    int        // steps running statements now (a Held WAIT is not)
	running map[int]*Step
	stop    chan struct{} // closed while the drain holds the pool
	stopped bool
	closed  bool
	// stopped work processes: out of service for good because no new
	// connection could be had for them within ReconnectGrace. They are in
	// no step and not in the channel; the pool lends M minus these, the
	// drain waits for M minus these, and when it is all M nothing is lent.
	outOfService int
	// changed wakes a drain or a WAIT waiting for work processes when one
	// leaves service (capacity 1, a send never blocks)
	changed chan struct{}
	// dead is closed when the last work process left service
	dead chan struct{}
	// quit is closed by Close; it ends a reconnect in progress
	quit chan struct{}
	// reconnecting counts the giveBacks looking for a new connection; Close
	// waits for them (each ends within ReconnectGrace, at once on quit)
	reconnecting sync.WaitGroup
}

// worker is one work process: its connection, its statement cache, and the
// facts of the row the status tables read (ZOSD_WP).
type worker struct {
	number    int
	conn      *sql.Conn
	stmts     map[string]*sql.Stmt
	queryOnly bool // the mode the connection is in
	// the registry row, guarded by Pool.mu
	state   string // Running, Idle, Reconnect (between a discard and a new connection), Stopped (out of service)
	kind    Kind
	started time.Time
	report  string
}

// New takes the work processes' connections. One that cannot be prepared
// (opened, pragmas set) fails the pool: a serving host would answer nothing
// with it anyway.
func New(o Options) (*Pool, error) {
	if o.DB == nil {
		return nil, errors.New("workpool: no database")
	}
	if o.Workers < 1 {
		o.Workers = 1
	}
	if o.BusyTimeout <= 0 {
		o.BusyTimeout = DefaultBusyTimeout
	}
	if o.ReconnectGrace <= 0 {
		o.ReconnectGrace = o.BusyTimeout
	}
	p := &Pool{o: o, running: map[int]*Step{}, stop: make(chan struct{}),
		changed: make(chan struct{}, 1), dead: make(chan struct{}), quit: make(chan struct{})}
	p.tokens = make(chan *worker, o.Workers)
	p.writer = make(chan struct{}, 1)
	ctx := context.Background()
	for i := 0; i < o.Workers; i++ {
		conn, err := o.DB.Conn(ctx)
		if err != nil {
			p.Close()
			return nil, fmt.Errorf("workpool: work process %d: %w", i+1, err)
		}
		w := &worker{number: i + 1, conn: conn, stmts: map[string]*sql.Stmt{}, state: "Idle"}
		if err := w.prime(ctx, o.BusyTimeout); err != nil {
			conn.Close()
			p.Close()
			return nil, fmt.Errorf("workpool: work process %d: %w", i+1, err)
		}
		p.workers = append(p.workers, w)
		p.tokens <- w
	}
	return p, nil
}

// prime sets what every connection of this database carries: the busy
// timeout of the drain grace, and the store's own case-sensitive LIKE
// (go/abap prepareStore sets it on the pool; a held connection never sees
// it, so each work process takes it itself).
func (w *worker) prime(ctx context.Context, busy time.Duration) error {
	if _, err := w.conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout = %d", busy.Milliseconds())); err != nil {
		return err
	}
	_, err := w.conn.ExecContext(ctx, "PRAGMA case_sensitive_like = ON")
	return err
}

// queryOnly puts the connection in the mode the step kind wants. Read steps
// run query_only so a write inside them is the database's refusal, not a
// lock waited for; the pragma is only written when the mode changes, so a
// work process that serves one kind pays nothing per step.
func (w *worker) setQueryOnly(ctx context.Context, on bool) error {
	if w.queryOnly == on {
		return nil
	}
	if _, err := w.conn.ExecContext(ctx, fmt.Sprintf("PRAGMA query_only = %d", map[bool]int{true: 1, false: 0}[on])); err != nil {
		return err
	}
	w.queryOnly = on
	return nil
}

// ErrNotServing is what a step of a pool that no longer lends answers.
var ErrNotServing = errors.New("workpool: the pool lends no work process (drain or close)")

// ErrNoWorkProcess is what a step answers once every work process is out
// of service (no connection could be had for any of them).
var ErrNoWorkProcess = errors.New("workpool: every work process is out of service")

// Step runs work as one dialog step on a borrowed work process. It returns
// when work has; a dump inside work is work's to handle (the kernel's
// bracket re-panics it). ctx cancelled or expired cancels the step's
// statements, which is the fence.
func (p *Pool) Step(ctx context.Context, kind Kind, work func(*Step)) error {
	if p.o.ReadOnly {
		kind = Read
	}
	gated := kind == Write
	if gated {
		if err := p.acquireWriter(ctx); err != nil {
			return err
		}
	}
	w, err := p.acquire(ctx)
	if err != nil {
		if gated {
			<-p.writer
		}
		return err
	}
	step := &Step{p: p, w: w, held: true, gated: gated}
	step.ctx, step.cancel = context.WithCancel(ctx)
	defer step.cancel()
	if err := p.lend(step, kind); err != nil {
		// lend registered nothing: the work process goes back (or out of
		// service) and the write token goes, but the running count is not
		// the step's to decrement (PR #900 review round 2)
		step.suspect = true
		p.release(step, false)
		return err
	}
	// deferred: a dump that leaves work unrecovered must not take the work
	// process with it (the pool would lend M-1, then M-2, ...)
	defer p.unlend(step)
	work(step)
	return nil
}

// acquire is the dispatcher's hand-over: the next free work process, to a
// step that has none. Once the drain holds the pool, no new step is lent
// one; a work process still out with a step is what the drain waits for.
func (p *Pool) acquire(ctx context.Context) (*worker, error) {
	for {
		p.mu.Lock()
		stopped := p.stopped || p.closed
		p.mu.Unlock()
		if stopped {
			return nil, ErrNotServing
		}
		select {
		case w := <-p.tokens:
			return w, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-p.dead:
			return nil, ErrNoWorkProcess
		default:
		}
		select {
		case w := <-p.tokens:
			return w, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-p.dead:
			return nil, ErrNoWorkProcess
		case <-p.stopNow():
			// the drain began while this waited: the check above decides
		}
	}
}

// acquireWriter is the write token for a new step, refused once the drain
// holds the pool, as acquire is.
func (p *Pool) acquireWriter(ctx context.Context) error {
	for {
		p.mu.Lock()
		stopped := p.stopped || p.closed
		p.mu.Unlock()
		if stopped {
			return ErrNotServing
		}
		select {
		case p.writer <- struct{}{}:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		case <-p.stopNow():
		}
	}
}

// stopNow is the stop channel of the moment (Unlock replaces it).
func (p *Pool) stopNow() chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stop
}

// take is acquire for a step already in flight (a WAIT taking another work
// process back): the step must go on, so it waits for a work process even
// while the drain holds the pool, until Unlock floods the channel again.
// A cancelled context returns nil: the kernel's reopen on the old work
// process fails there as the interrupted statement's own error. So does a
// pool with every work process out of service: there is none to wait for.
func (p *Pool) take(ctx context.Context) *worker {
	select {
	case w := <-p.tokens:
		return w
	case <-ctx.Done():
		return nil
	case <-p.dead:
		return nil
	}
}

// lend gives the step its work process and records it in the row. A work
// process in the channel always has its connection (giveBack keeps it so);
// the check is the invariant's guard, not a path.
func (p *Pool) lend(s *Step, kind Kind) error {
	if p.o.ReadOnly {
		kind = Read
	}
	if s.w.conn == nil {
		return fmt.Errorf("workpool: work process %d lent without a connection", s.w.number)
	}
	if err := s.w.setQueryOnly(s.ctx, kind == Read); err != nil {
		return fmt.Errorf("workpool: work process %d: %w", s.w.number, err)
	}
	s.kind = kind
	p.mu.Lock()
	defer p.mu.Unlock()
	p.live++
	p.running[s.w.number] = s
	s.w.state, s.w.kind, s.w.started = "Running", kind, time.Now()
	return nil
}

// unlend is the step's end: the row says Idle, the work process goes back
// -- unless a WAIT already gave it back and the fence kept the step from
// taking another (held false), when there is nothing to return. A step
// that was fenced, or one a statement of which failed, may have left its
// transaction open (the kernel's ROLLBACK is best-effort): the connection
// is scrubbed first, and replaced when the scrub cannot prove it clean --
// before the write token goes, so the next writer never finds the lock
// still held by a work process nobody runs on (PR #900 review).
func (p *Pool) unlend(s *Step) { p.release(s, true) }

// release is unlend for a step that lend registered as running
// (registered) or one whose lend failed before it did: only the first
// decrements the running count.
func (p *Pool) release(s *Step, registered bool) {
	if s.held && (s.suspect || s.ctx.Err() != nil) {
		p.scrub(s.w)
	}
	s.suspect = false
	if s.gated {
		s.gated = false
		<-p.writer
	}
	if !s.held {
		return
	}
	s.held = false
	p.mu.Lock()
	if registered {
		p.live--
		delete(p.running, s.w.number)
	}
	s.w.state = "Idle"
	p.mu.Unlock()
	p.giveBack(s.w)
}

// Step is what one dialog step runs on: a work process of its own.
type Step struct {
	p      *Pool
	w      *worker
	kind   Kind
	ctx    context.Context
	cancel context.CancelFunc
	// report names the step in its work-process row (the report, as SM50
	// shows one); the host sets it as soon as it knows the route.
	report string
	// held: the step holds w. False between a WAIT's give-up and its take,
	// and after a WAIT the fence ended: the step's statements are refused
	// then rather than run on a connection another step may hold.
	held bool
	// gated: the step holds the write token (a modifying step, between its
	// start or a WAIT's return and its end or the WAIT)
	gated bool
	// suspect: a statement of the step failed on this work process, so its
	// connection may still have a transaction open (unlend scrubs it)
	suspect bool
}

// errNotHeld is a statement of a step that holds no work process: one
// fenced inside a WAIT.
var errNotHeld = errors.New("workpool: the step holds no work process (fenced in a WAIT)")

// Kind is the step's kind as the pool runs it (Read under ReadOnly).
func (s *Step) Kind() Kind { return s.kind }

// WP is the work process's number, 1 to M (ZOSD_WP-WPNO).
func (s *Step) WP() int { return s.w.number }

// Context is the step's; its cancellation is the fence.
func (s *Step) Context() context.Context { return s.ctx }

// Report is the name the row carries for this step.
func (s *Step) Report() string { return s.report }

// SetReport names the step in its work-process row.
func (s *Step) SetReport(report string) {
	s.report = report
	p := s.p
	p.mu.Lock()
	s.w.report = report
	p.mu.Unlock()
}

// Query runs a statement of the step on its work process's connection,
// prepared on it when the same text ran here before. The context is the
// step's: cancelled, the driver interrupts the statement in flight.
func (s *Step) Query(q string, args ...any) (*sql.Rows, error) {
	if !s.held {
		return nil, errNotHeld
	}
	var rows *sql.Rows
	var err error
	if st := s.stmtFor(q); st != nil {
		rows, err = st.QueryContext(s.ctx, args...)
	} else {
		rows, err = s.w.conn.QueryContext(s.ctx, q, args...)
	}
	if err != nil {
		s.suspect = true
	}
	return rows, err
}

// Exec is Query for what returns no rows.
func (s *Step) Exec(q string, args ...any) (sql.Result, error) {
	if !s.held {
		return nil, errNotHeld
	}
	var r sql.Result
	var err error
	if st := s.stmtFor(q); st != nil {
		r, err = st.ExecContext(s.ctx, args...)
	} else {
		r, err = s.w.conn.ExecContext(s.ctx, q, args...)
	}
	if err != nil {
		s.suspect = true
	}
	return r, err
}

// Cleanup runs the end of the step's transaction (the kernel's ROLLBACK)
// on a context of its own: the step's may be cancelled -- that is what the
// fence is -- and a ROLLBACK refused for it would leave the transaction
// open on a work process that goes back to the pool. A ROLLBACK waits for
// no lock, so nothing here can hang the way the fenced work could.
func (s *Step) Cleanup(q string) error {
	if !s.held {
		return errNotHeld
	}
	_, err := s.w.conn.ExecContext(context.Background(), q)
	if err != nil {
		s.suspect = true
	}
	return err
}

// Prepare hands out the statement prepared on this work process, cached
// with its kin (the kernel's adapter calls it).
func (s *Step) Prepare(q string) (*sql.Stmt, error) {
	if !s.held {
		return nil, errNotHeld
	}
	if st := s.stmtFor(q); st != nil {
		return st, nil
	}
	st, err := s.w.conn.PrepareContext(s.ctx, q)
	if err != nil {
		return nil, err
	}
	s.w.stmts[q] = st
	return st, nil
}

// cacheable is the kernel's rule (go/abap luw.go): one SELECT / INSERT /
// UPDATE / DELETE without a ';' is worth preparing.
func cacheable(q string) bool {
	if strings.Contains(q, ";") || len(q) < 7 {
		return false
	}
	switch strings.ToUpper(strings.TrimSpace(q)[:6]) {
	case "SELECT", "INSERT", "UPDATE", "DELETE":
		return true
	}
	return false
}

const stmtCacheMax = 4096

func (s *Step) stmtFor(q string) *sql.Stmt {
	w := s.w
	if st, ok := w.stmts[q]; ok {
		return st
	}
	if len(w.stmts) >= stmtCacheMax || !cacheable(q) {
		return nil
	}
	st, err := w.conn.PrepareContext(s.ctx, q)
	if err != nil {
		return nil
	}
	w.stmts[q] = st
	return st
}

// Yield is a WAIT inside a step: the work process goes back to the
// dispatcher for the sleep and another is lent on return. The step's
// transaction is the kernel's to end and reopen around this (a WAIT ends
// the LUW, as on a system); the statements after a Yield run on the new
// work process's connection, and a prepared statement travelled with the
// work process that made it. The work process given up is free while the
// step waits, as a system's is while its session waits: another step may
// run on it, and the row says Idle in the meantime.
func (s *Step) Yield(d time.Duration) {
	p := s.p
	wasGated := s.gated
	p.unlend(s) // the row says Idle, the write token goes; Interrupt no longer finds the step there
	time.Sleep(d)
	if wasGated {
		select {
		case p.writer <- struct{}{}:
			s.gated = true
		case <-s.ctx.Done():
			return // fenced in the WAIT, as below
		}
	}
	w := p.take(s.ctx)
	if w == nil {
		return // fenced in the WAIT: held stays false, the kernel's reopen fails next
	}
	s.w, s.held = w, true
	p.mu.Lock()
	p.live++
	p.running[w.number] = s
	w.state, w.kind, w.started = "Running", s.kind, time.Now()
	p.mu.Unlock()
	if err := w.setQueryOnly(s.ctx, s.kind == Read); err != nil {
		// the connection is in the other kind's mode: the step must not go
		// on there; it dumps and its end gives the work process back
		panic(fmt.Errorf("workpool: work process %d after a WAIT: %w", w.number, err))
	}
}

// Interrupt is the fence: the step running on work process wp stops at its
// next statement (sqlite3_interrupt through the driver's context
// cancellation). True when a step was running on it. A hung writer fenced
// this way lets the writers waiting on the write lock proceed once its
// rollback has run.
func (p *Pool) Interrupt(wp int) bool {
	p.mu.Lock()
	s := p.running[wp]
	p.mu.Unlock()
	if s == nil {
		return false
	}
	s.cancel()
	return true
}

// Workers is M.
func (p *Pool) Workers() int { return len(p.workers) }

// InFlight is the number of steps running statements now.
func (p *Pool) InFlight() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.live
}

// WPRow is one work process as the status tables read it (ZOSD_WP).
type WPRow struct {
	Number     int
	Kind       string // DIAL: a dialog work process (BTC is a later slice)
	State      string // Running (a step holds it), Idle, Reconnect, or Stopped (out of service)
	Generation string
	Started    time.Time // the running step's start; zero when idle
	Report     string
}

// Snapshot is the work-process rows (ZOSD_WP): what runs, since when, of
// what report -- the SM50 shape over the dispatcher's own table.
func (p *Pool) Snapshot() []WPRow {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]WPRow, 0, len(p.workers))
	for _, w := range p.workers {
		out = append(out, WPRow{Number: w.number, Kind: "DIAL", State: w.state,
			Generation: p.o.Generation, Started: w.started, Report: w.report})
	}
	return out
}

// Locker is the pool as the drain's sync.Locker (go/serving Stop.Lock):
// Lock stops the lending and takes every work process out of circulation --
// the steps in flight finish, because they hold theirs until they end, and
// a WAIT that gave its up waits for one back, as a system's WAIT past the
// shutdown does. Unlock lends them all again.
type Locker struct{ P *Pool }

func (l Locker) Lock() {
	p := l.P
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = true
	p.mu.Unlock()
	close(p.stop)
	p.collect()
}

func (l Locker) Unlock() {
	p := l.P
	p.mu.Lock()
	if !p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = false
	p.stop = make(chan struct{})
	p.mu.Unlock()
	for _, w := range p.workers {
		if w.conn == nil { // stopped: out of service, never lent again
			continue
		}
		select {
		case p.tokens <- w:
		default: // already in circulation
		}
	}
}

// Close ends the pool: the lending stops, a reconnect in progress is ended
// and waited for (it stops its work process and closes whatever connection
// it gets late), and every connection is closed. Close does not wait for
// steps still running: the host ends them first (go/serving Quiesce, the
// drain's Lock), as before.
func (p *Pool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	wasStopped := p.stopped
	p.stopped = true
	p.mu.Unlock()
	if !wasStopped { // the drain's Lock closed it already
		close(p.stop)
	}
	// a work process looking for a new connection gives up now and is
	// stopped; what it would have got is closed, not put into the pool
	close(p.quit)
	p.reconnecting.Wait()
	var err error
	for _, w := range p.workers {
		for _, st := range w.stmts {
			st.Close()
		}
		if w.conn == nil { // stopped (out of service), or New failed before it
			continue
		}
		if e := w.conn.Close(); e != nil {
			err = e
		}
	}
	return err
}
