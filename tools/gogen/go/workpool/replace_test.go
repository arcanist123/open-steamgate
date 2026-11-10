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
}

func (d *faultDriver) Open(name string) (driver.Conn, error) {
	if n := d.failOpen.Load(); n < 0 {
		return nil, errors.New("injected: open failed")
	} else if n > 0 {
		d.failOpen.Add(-1)
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
