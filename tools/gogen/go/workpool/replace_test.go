package workpool

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	sqlite "modernc.org/sqlite"
)

// A work process whose connection the scrub could not prove clean gets a
// new one; when none can be had, it must never be lent or parked without
// one (PR #900 review round 2). These tests wrap the real SQLite driver so
// a scrub's ROLLBACK, a new connection's open or a mode pragma can be made
// to fail on demand -- fault injection, not a claim that SQLite fails so.

type faultDriver struct {
	inner        sqlite.Driver
	failRollback atomic.Bool  // the next ROLLBACK fails (the scrub's)
	failOpen     atomic.Int32 // that many opens fail; below 0, every open
	failPragma   atomic.Bool  // the next PRAGMA query_only fails
	closed       atomic.Int32
	// hang, when set, makes every open wait for it to be closed -- a
	// driver that ignores the caller's deadline (driver.Open has no
	// context), as a hung open or a held file lock would
	hang atomic.Pointer[chan struct{}]
	// openFails counts the injected open failures
	openFails atomic.Int32
}

func (d *faultDriver) Open(name string) (driver.Conn, error) {
	if h := d.hang.Load(); h != nil {
		<-*h
	}
	if n := d.failOpen.Load(); n < 0 {
		d.openFails.Add(1)
		return nil, errors.New("injected: open failed")
	} else if n > 0 {
		d.failOpen.Add(-1)
		d.openFails.Add(1)
		return nil, errors.New("injected: open failed")
	}
	c, err := d.inner.Open(name)
	if err != nil {
		return nil, err
	}
	return &faultConn{Conn: c, d: d}, nil
}

type faultConn struct {
	driver.Conn
	d *faultDriver
}

func (c *faultConn) ExecContext(ctx context.Context, q string, a []driver.NamedValue) (driver.Result, error) {
	if q == "ROLLBACK" && c.d.failRollback.Swap(false) {
		return nil, errors.New("injected: rollback failed")
	}
	if strings.HasPrefix(q, "PRAGMA query_only") && c.d.failPragma.Swap(false) {
		return nil, errors.New("injected: pragma failed")
	}
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, q, a)
}

func (c *faultConn) Close() error { c.d.closed.Add(1); return c.Conn.Close() }

var faultSeq atomic.Int32

func faultPool(t *testing.T, workers int, grace time.Duration) (*Pool, *faultDriver, *[]string) {
	t.Helper()
	drv := &faultDriver{}
	name := fmt.Sprintf("workpool-fault-%d", faultSeq.Add(1))
	sql.Register(name, drv)
	db, err := sql.Open(name, "file:"+filepath.Join(t.TempDir(), "fault.sqlite")+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(workers)
	var mu sync.Mutex
	logs := &[]string{}
	p, err := New(Options{DB: db, Workers: workers, BusyTimeout: 2 * time.Second, ReconnectGrace: grace,
		Logf: func(f string, a ...any) { mu.Lock(); *logs = append(*logs, fmt.Sprintf(f, a...)); mu.Unlock() }})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Step(context.Background(), Write, func(s *Step) {
		if _, err := s.Exec("CREATE TABLE r (id INTEGER NOT NULL PRIMARY KEY)"); err != nil {
			t.Fatal(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	return p, drv, logs
}

// poison runs a modifying step that leaves its transaction open and a
// failed statement behind, with the scrub's ROLLBACK and failOpen opens
// set to fail: the step's end discards the connection and has to find a
// new one.
func poison(t *testing.T, p *Pool, d *faultDriver, failOpen int32) {
	t.Helper()
	if err := p.Step(context.Background(), Write, func(s *Step) {
		if _, err := s.Exec("BEGIN IMMEDIATE"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Exec("not sql"); err == nil {
			t.Fatal("expected a statement error")
		}
		d.failRollback.Store(true)
		d.failOpen.Store(failOpen)
	}); err != nil {
		t.Fatal(err)
	}
}

func checkResources(t *testing.T, p *Pool, lendable int) {
	t.Helper()
	if n := p.InFlight(); n != 0 {
		t.Errorf("InFlight %d after the steps ended", n)
	}
	if n := len(p.writer); n != 0 {
		t.Errorf("the write token is still held (%d)", n)
	}
	if n := len(p.tokens); n != lendable {
		t.Errorf("%d work processes lendable, want %d", n, lendable)
	}
	for _, w := range p.workers {
		if w.conn == nil && w.state != "Stopped" {
			t.Errorf("work process %d has no connection and is %s", w.number, w.state)
		}
	}
}

func writeStep(t *testing.T, p *Pool, id int) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return p.Step(ctx, Write, func(s *Step) {
		if _, err := s.Exec("BEGIN IMMEDIATE"); err != nil {
			t.Errorf("BEGIN on WP %d: %v", s.WP(), err)
			return
		}
		if _, err := s.Exec("INSERT INTO r VALUES (?)", id); err != nil {
			t.Errorf("INSERT on WP %d: %v", s.WP(), err)
		}
		if _, err := s.Exec("COMMIT"); err != nil {
			t.Errorf("COMMIT on WP %d: %v", s.WP(), err)
		}
	})
}

// A new connection that fails a few times is retried with a backoff within
// the grace: the work process comes back, nothing is taken out of service.
func TestFailedReplacementIsRetried(t *testing.T) {
	p, d, logs := faultPool(t, 1, 5*time.Second)
	defer p.Close()
	poison(t, p, d, 3)
	checkResources(t, p, 1)
	if n := p.OutOfService(); n != 0 {
		t.Fatalf("%d out of service after a reconnect that succeeded on retry", n)
	}
	if err := writeStep(t, p, 1); err != nil {
		t.Fatal(err)
	}
	checkResources(t, p, 1)
	if len(*logs) != 0 {
		t.Errorf("logged: %v", *logs)
	}
}

// No new connection within the grace: the work process is stopped --
// counted, logged, its row says so -- the pool serves with M-1, and the
// drain and Close handle the stopped one.
func TestFailedReplacementStopsTheWorkProcess(t *testing.T) {
	p, d, logs := faultPool(t, 2, 150*time.Millisecond)
	poison(t, p, d, -1)
	d.failOpen.Store(0)
	checkResources(t, p, 1)
	if n := p.OutOfService(); n != 1 {
		t.Fatalf("OutOfService %d, want 1", n)
	}
	stopped := 0
	for _, row := range p.Snapshot() {
		if row.State == "Stopped" {
			stopped++
		}
	}
	if stopped != 1 {
		t.Fatalf("rows: %+v", p.Snapshot())
	}
	if len(*logs) != 1 || !strings.Contains((*logs)[0], "out of service") {
		t.Fatalf("logged: %v", *logs)
	}
	// the pool serves on with the other: writes and reads, in parallel too
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := writeStep(t, p, 10+i); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	checkResources(t, p, 1)
	// the drain takes the ones in service and gives them back
	done := make(chan struct{})
	go func() { l := Locker{P: p}; l.Lock(); l.Unlock(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the drain waits for a stopped work process")
	}
	checkResources(t, p, 1)
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("Close panics over a stopped work process: %v", r)
			}
		}()
		if err := p.Close(); err != nil {
			t.Fatal(err)
		}
	}()
}

// A drain already waiting when the work process is stopped stops waiting
// for it.
func TestDrainWaitingWhileTheWorkProcessIsStopped(t *testing.T) {
	p, d, _ := faultPool(t, 2, 300*time.Millisecond)
	defer p.Close()
	stepDone := make(chan struct{})
	go func() {
		poison(t, p, d, -1)
		close(stepDone)
	}()
	time.Sleep(50 * time.Millisecond) // the step's end is retrying now
	drained := make(chan struct{})
	go func() { Locker{P: p}.Lock(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(3 * time.Second):
		t.Fatal("the drain never ended: it waits for the stopped work process")
	}
	<-stepDone
	d.failOpen.Store(0)
	Locker{P: p}.Unlock()
	checkResources(t, p, 1)
	if err := writeStep(t, p, 1); err != nil {
		t.Fatal(err)
	}
}

// A WAIT gives up a work process whose scrub discards the connection: back
// from the WAIT the step runs on a work process with a connection (the
// retried one), never on the nil one.
func TestWaitAfterFailedScrubResumesOnAConnection(t *testing.T) {
	p, d, _ := faultPool(t, 1, 5*time.Second)
	defer p.Close()
	if err := p.Step(context.Background(), Write, func(s *Step) {
		if _, err := s.Exec("BEGIN IMMEDIATE"); err != nil {
			t.Fatal(err)
		}
		_, _ = s.Exec("not sql") // the failed statement marks the work process suspect
		if _, err := s.Exec("COMMIT"); err != nil {
			t.Fatal(err)
		}
		d.failRollback.Store(true)
		d.failOpen.Store(2)
		s.Yield(0)
		if _, err := s.Exec("BEGIN IMMEDIATE"); err != nil {
			t.Errorf("back from the WAIT: %v", err)
		}
		if _, err := s.Exec("INSERT INTO r VALUES (7)"); err != nil {
			t.Errorf("back from the WAIT: %v", err)
		}
		if _, err := s.Exec("COMMIT"); err != nil {
			t.Errorf("back from the WAIT: %v", err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	checkResources(t, p, 1)
}

// The same with no connection to be had and one work process: the step
// back from the WAIT holds none and its statements are refused (no nil
// dereference); later steps answer ErrNoWorkProcess rather than wait
// forever; Close is clean.
func TestWaitWithEveryWorkProcessStopped(t *testing.T) {
	p, d, _ := faultPool(t, 1, 100*time.Millisecond)
	var after error
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("WAIT over a stopped work process panics: %v", r)
			}
		}()
		if err := p.Step(context.Background(), Write, func(s *Step) {
			if _, err := s.Exec("BEGIN IMMEDIATE"); err != nil {
				t.Fatal(err)
			}
			_, _ = s.Exec("not sql")
			if _, err := s.Exec("COMMIT"); err != nil {
				t.Fatal(err)
			}
			d.failRollback.Store(true)
			d.failOpen.Store(-1)
			s.Yield(0)
			_, after = s.Exec("BEGIN IMMEDIATE")
		}); err != nil {
			t.Fatal(err)
		}
	}()
	if !errors.Is(after, errNotHeld) {
		t.Fatalf("a statement after the WAIT: %v, want errNotHeld", after)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := p.Step(ctx, Read, func(*Step) { t.Error("lent a stopped work process") }); !errors.Is(err, ErrNoWorkProcess) {
		t.Fatalf("a step with every work process stopped: %v", err)
	}
	checkResources(t, p, 0)
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
}

// A lend that fails (the mode pragma refused) registered nothing, so its
// unwinding must not decrement the running count; the work process and the
// write token go back.
func TestFailedLendKeepsTheCount(t *testing.T) {
	p, d, _ := faultPool(t, 1, time.Second)
	defer p.Close()
	d.failPragma.Store(true)
	if err := p.Step(context.Background(), Read, func(*Step) { t.Error("ran on a failed lend") }); err == nil {
		t.Fatal("expected the lend to fail")
	}
	checkResources(t, p, 1)
	if err := writeStep(t, p, 1); err != nil {
		t.Fatal(err)
	}
	checkResources(t, p, 1)
}

// PR #900 review round 3: ReconnectGrace bounds the caller, whatever the
// attempt waits on.

// stepWithin runs poison on a goroutine and says how long its Step took,
// failing when it is still blocked after limit.
func stepWithin(t *testing.T, p *Pool, d *faultDriver, failOpen int32, limit time.Duration) (time.Duration, chan struct{}) {
	t.Helper()
	done := make(chan struct{})
	start := time.Now()
	go func() { poison(t, p, d, failOpen); close(done) }()
	select {
	case <-done:
	case <-time.After(limit):
		t.Errorf("Step still blocked after %s (grace %s); row %s, InFlight %d",
			limit, p.o.ReconnectGrace, p.Snapshot()[0].State, p.InFlight())
	}
	return time.Since(start), done
}

func awaitState(t *testing.T, p *Pool, wp int, state string) {
	t.Helper()
	until := time.Now().Add(2 * time.Second)
	for time.Now().Before(until) {
		if p.Snapshot()[wp-1].State == state {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("work process %d never reached %s (is %s)", wp, state, p.Snapshot()[wp-1].State)
}

func awaitInUse(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	until := time.Now().Add(2 * time.Second)
	for db.Stats().InUse != want && time.Now().Before(until) {
		time.Sleep(time.Millisecond)
	}
	if n := db.Stats().InUse; n != want {
		t.Errorf("%d connections in use, want %d", n, want)
	}
}

// An open that never returns (the driver ignores every deadline): the work
// process is stopped when the grace ends, the step answers, and the
// connection the open delivers later is closed rather than published.
func TestReconnectWithAHungOpenEndsWithinTheGrace(t *testing.T) {
	const grace = 150 * time.Millisecond
	p, d, logs := faultPool(t, 2, grace)
	defer p.Close()
	h := make(chan struct{})
	d.hang.Store(&h)
	took, _ := stepWithin(t, p, d, 0, grace+500*time.Millisecond)
	if took < grace {
		t.Errorf("Step returned after %s, before the grace %s: the reconnect was not tried", took, grace)
	}
	if n := p.OutOfService(); n != 1 {
		t.Fatalf("OutOfService %d, want 1", n)
	}
	if len(*logs) != 1 {
		t.Errorf("logged %v, want one out-of-service line", *logs)
	}
	checkResources(t, p, 1)
	if err := writeStep(t, p, 1); err != nil { // the other work process serves
		t.Fatal(err)
	}
	d.hang.Store(nil)
	close(h)                 // the hung open returns now: its connection must not survive
	awaitInUse(t, p.o.DB, 1) // the other work process's own
	if n := p.o.DB.Stats().OpenConnections; n != 1 {
		t.Errorf("%d connections open after the late open returned, want 1", n)
	}
	if p.workers[0].conn != nil && p.workers[1].conn != nil {
		t.Error("the late connection was given to the stopped work process")
	}
	checkResources(t, p, 1)
}

// database/sql's own admission: the freed slot is taken by someone else
// during the backoff, so DB.Conn waits; the grace still ends the wait
// (the critic's reproducer, kept).
func TestReconnectGraceBoundsConnectionAdmission(t *testing.T) {
	const grace = 600 * time.Millisecond
	p, d, _ := faultPool(t, 1, grace)
	defer p.Close()
	done := make(chan struct{})
	go func() { poison(t, p, d, -1); close(done) }()
	// the fourth failed open is followed by an 80 ms backoff: the slot is
	// taken inside it, so the next attempt waits in DB.Conn's admission
	until := time.Now().Add(2 * time.Second)
	for d.openFails.Load() < 4 && time.Now().Before(until) {
		time.Sleep(100 * time.Microsecond)
	}
	d.failOpen.Store(0)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	other, err := p.o.DB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(grace + 500*time.Millisecond):
		t.Errorf("Step still blocked in admission after the grace; row %s", p.Snapshot()[0].State)
	}
	if p.o.DB.Stats().WaitCount == 0 {
		t.Error("the reconnect never waited for admission: the test did not test it")
	}
	other.Close()
	<-done
	if n := p.OutOfService(); n != 1 {
		t.Errorf("OutOfService %d, want 1", n)
	}
	awaitInUse(t, p.o.DB, 0)
}

// Close during a reconnect ends it at once and waits for it: the work
// process is stopped, and a connection the attempt gets afterwards is
// closed, never parked in the closed pool.
func TestCloseEndsAReconnectInProgress(t *testing.T) {
	for _, hung := range []bool{false, true} {
		t.Run(fmt.Sprintf("hung=%v", hung), func(t *testing.T) {
			p, d, _ := faultPool(t, 1, 10*time.Second)
			h := make(chan struct{})
			done := make(chan struct{})
			if hung {
				d.hang.Store(&h)
				go func() { poison(t, p, d, 0); close(done) }()
			} else {
				go func() { poison(t, p, d, -1); close(done) }()
			}
			awaitState(t, p, 1, "Reconnect")
			start := time.Now()
			if err := p.Close(); err != nil {
				t.Error(err)
			}
			if took := time.Since(start); took > time.Second {
				t.Errorf("Close took %s with a reconnect in progress (grace 10s)", took)
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("the step did not return after Close")
			}
			if n := p.OutOfService(); n != 1 {
				t.Errorf("OutOfService %d, want 1", n)
			}
			if len(p.tokens) != 0 {
				t.Errorf("%d work processes parked in the closed pool", len(p.tokens))
			}
			d.hang.Store(nil)
			close(h)
			d.failOpen.Store(0)
			awaitInUse(t, p.o.DB, 0)
		})
	}
}
