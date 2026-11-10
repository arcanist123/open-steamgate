package workpool

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// The three database proofs of ADR 0010 slice 5, before the pool is built
// on them ("proof before the pool is built"): what the step-kind policy
// rests on, shown at the SQLite level, with nothing of the ABAP around it.

// scanOne runs a one-row query of a step and scans it.
func scanOne(s *Step, q string, dest ...any) error {
	rows, err := s.Query(q)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		return errors.New("no row")
	}
	return rows.Scan(dest...)
}

// openWAL is the file of a serving sidecar: a WAL file, its pool sized for
// conns connections (the work processes the pool holds, plus what runs
// beside them), the busy timeout of the drain grace (what New primes each
// connection with).
func openWAL(t *testing.T, conns int, busy time.Duration) *sql.DB {
	t.Helper()
	d, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "wl.sqlite")+
		"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	d.SetMaxOpenConns(conns)
	if _, err := d.Exec("CREATE TABLE r (id INTEGER NOT NULL PRIMARY KEY, v TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec("INSERT INTO r VALUES (1, 'one')"); err != nil {
		t.Fatal(err)
	}
	return d
}

// connOf takes one connection of the file, as a work process does.
func connOf(t *testing.T, d *sql.DB) *sql.Conn {
	t.Helper()
	c, err := d.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if _, err := c.ExecContext(context.Background(), "PRAGMA busy_timeout = 5000"); err != nil {
		t.Fatal(err)
	}
	return c
}

// Proof 1: parallel reads beside a held write lock. A writer inside BEGIN
// IMMEDIATE, its write made and not committed, does not stop the readers:
// WAL readers read the file as the last commit left it, so M of them answer
// while the one write lock is held. The pool's read steps are these
// readers, and this is why M work processes help a read-heavy load on
// SQLite and not a write-heavy one.
func TestParallelReadsBesideHeldWriteLock(t *testing.T) {
	d := openWAL(t, 5, 5*time.Second)
	defer d.Close()
	writer := connOf(t, d)
	if _, err := writer.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer writer.ExecContext(context.Background(), "ROLLBACK")
	if _, err := writer.ExecContext(context.Background(), "INSERT INTO r VALUES (2, 'two')"); err != nil {
		t.Fatal(err)
	}
	// four readers beside the held write lock, in parallel, each on its
	// own connection: all answer, and none sees the uncommitted row
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := connOf(t, d)
			var v string
			if err := c.QueryRowContext(context.Background(), "SELECT v FROM r WHERE id = 1").Scan(&v); err != nil {
				errs <- err
				return
			}
			if v != "one" {
				errs <- fmt.Errorf("read %q", v)
				return
			}
			var n int
			if err := c.QueryRowContext(context.Background(), "SELECT count(*) FROM r").Scan(&n); err != nil {
				errs <- err
				return
			}
			if n != 1 {
				errs <- fmt.Errorf("the uncommitted row is visible: %d rows", n)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	// and the same read inside the writer's own transaction sees its row
	var n int
	if err := writer.QueryRowContext(context.Background(), "SELECT count(*) FROM r").Scan(&n); err != nil || n != 2 {
		t.Fatalf("writer reads its own row: %d %v", n, err)
	}
}

// Proof 2: a read-then-write step refused at the upgrade, not replayed. A
// deferred transaction that reads and then writes can fail at the write --
// SQLITE_BUSY_SNAPSHOT -- when another writer committed between the read
// and the write, and busy_timeout does not cover it: the snapshot is stale
// and the step cannot be replayed after its external effects. That is why
// a modifying step opens BEGIN IMMEDIATE, which takes the write lock before
// it reads anything and so cannot hit the upgrade: shown by the same
// schedule succeeding when the begin was immediate.
func TestReadThenWriteRefusedAtTheUpgrade(t *testing.T) {
	d := openWAL(t, 3, 2*time.Second)
	defer d.Close()
	a, b := connOf(t, d), connOf(t, d)

	// the schedule the policy refuses to run: A deferred, reads, then writes
	if _, err := a.ExecContext(context.Background(), "BEGIN"); err != nil {
		t.Fatal(err)
	}
	var one string
	if err := a.QueryRowContext(context.Background(), "SELECT v FROM r WHERE id = 1").Scan(&one); err != nil {
		t.Fatal(err)
	}
	// B commits while A holds its read snapshot
	if _, err := b.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.ExecContext(context.Background(), "UPDATE r SET v = 'uno' WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.ExecContext(context.Background(), "COMMIT"); err != nil {
		t.Fatal(err)
	}
	_, err := a.ExecContext(context.Background(), "UPDATE r SET v = 'eins' WHERE id = 1")
	if err == nil {
		a.ExecContext(context.Background(), "ROLLBACK")
		t.Fatal("the upgrade of the stale snapshot succeeded: SQLITE_BUSY_SNAPSHOT was owed")
	}
	if !strings.Contains(err.Error(), "database is locked") {
		t.Fatalf("the upgrade's error is not the snapshot refusal: %v", err)
	}
	a.ExecContext(context.Background(), "ROLLBACK")

	// the schedule the policy runs: A takes the write lock before it reads,
	// so B's begin waits (busy_timeout) and no upgrade can fail
	if _, err := a.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if err := a.QueryRowContext(context.Background(), "SELECT v FROM r WHERE id = 1").Scan(&one); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	done := make(chan error, 1)
	go func() {
		if _, err := b.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
			done <- err
			return
		}
		done <- nil
	}()
	time.Sleep(100 * time.Millisecond)
	if _, err := a.ExecContext(context.Background(), "UPDATE r SET v = 'eins' WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ExecContext(context.Background(), "COMMIT"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("the second writer did not wait for the first: %v", err)
	}
	if waited := time.Since(began); waited < 90*time.Millisecond {
		t.Fatalf("the second writer did not wait: %v", waited)
	}
	b.ExecContext(context.Background(), "ROLLBACK")
}

// Proof 3: a hung writer with a read and a write beside it. A writer inside
// BEGIN IMMEDIATE whose statement runs long holds the one write lock; a
// read beside it answers (proof 1 again, in the failure table's shape); a
// write beside it waits; the fence -- the cancellation of the hung
// statement's context, sqlite3_interrupt in the driver -- stops the hung
// writer mid-statement, its rollback releases the lock, and the waiting
// write proceeds. Nothing but the hung step is lost.
func TestHungWriterFencedWithReadAndWriteBeside(t *testing.T) {
	d := openWAL(t, 4, 10*time.Second)
	defer d.Close()
	hung := connOf(t, d)
	if _, err := hung.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if _, err := hung.ExecContext(context.Background(), "INSERT INTO r VALUES (9, 'hung')"); err != nil {
		t.Fatal(err)
	}
	// the hung statement: a recursive CTE that counts for a long while
	stmtDone := make(chan error, 1)
	hungCtx, fence := context.WithCancel(context.Background())
	go func() {
		var n int
		err := hung.QueryRowContext(hungCtx,
			"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 400000000) SELECT max(x) FROM c").Scan(&n)
		stmtDone <- err
	}()
	// the read beside the hung writer answers, on its own connection
	reader := connOf(t, d)
	var v string
	if err := reader.QueryRowContext(context.Background(), "SELECT v FROM r WHERE id = 1").Scan(&v); err != nil || v != "one" {
		t.Fatalf("the read beside the hung writer: %q %v", v, err)
	}
	// the write beside it waits for the write lock
	waiter := connOf(t, d)
	writeDone := make(chan error, 1)
	go func() {
		_, err := waiter.ExecContext(context.Background(), "INSERT INTO r VALUES (3, 'three')")
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		t.Fatalf("the waiting write proceeded while the write lock was held: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	// the fence: the hung statement stops, the rollback runs, the waiter in
	fence()
	if err := <-stmtDone; err == nil {
		t.Fatal("the fenced statement reports no error")
	}
	// the hung step's LUW is rolled back with the connection
	if _, err := hung.ExecContext(context.Background(), "ROLLBACK"); err != nil {
		t.Logf("the hung connection after the fence: %v (its step is over)", err)
	}
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("the waiting write failed after the fence: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the waiting write did not proceed after the fence")
	}
	var n int
	if err := d.QueryRow("SELECT count(*) FROM r").Scan(&n); err != nil || n != 2 {
		t.Fatalf("after the fence: %d rows (%v); the hung step's row must be rolled back, the waiter's kept", n, err)
	}
}

// The pool over the same file: read steps run in parallel, a write inside a
// read step is the database's refusal, and writers serialise. The pool
// holds M connections for its life, so the file's pool is M plus the one
// this test reads through -- the host's spare (Database.OpenPool).
func TestPoolReadsParallelWritesRefused(t *testing.T) {
	d := openWAL(t, 5, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	// one write step first, so there is something to read
	if err := p.Step(context.Background(), Write, func(s *Step) {
		if _, err := s.Exec("INSERT INTO r VALUES (2, 'two')"); err != nil {
			t.Error(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	// four read steps at once: with M = 4 none waits for another
	started := make(chan *Step, 4)
	release := make(chan struct{})
	var wg sync.WaitGroup
	wps := make(chan int, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.Step(context.Background(), Read, func(s *Step) {
				started <- s
				var v string
				if err := scanOne(s, "SELECT v FROM r WHERE id = 1", &v); err != nil || v != "one" {
					t.Errorf("read: %q %v", v, err)
				}
				<-release // hold all four read steps out at once
				wps <- s.WP()
			})
		}()
	}
	for i := 0; i < 4; i++ {
		<-started
	}
	// all four ran concurrently: four work processes were lent (numbers
	// distinct), and the fifth read step waits for one to come back
	fifth := make(chan int, 1)
	go p.Step(context.Background(), Read, func(s *Step) { fifth <- s.WP() })
	select {
	case wp := <-fifth:
		t.Fatalf("a fifth step ran with M = 4 work processes (wp %d)", wp)
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	wg.Wait()
	if wp := <-fifth; wp < 1 || wp > 4 {
		t.Fatalf("the fifth step's work process: %d", wp)
	}
	seen := map[int]bool{}
	for i := 0; i < 4; i++ {
		seen[<-wps] = true
	}
	if len(seen) != 4 {
		t.Fatalf("the four read steps shared work processes: %v", seen)
	}

	// a write inside a read step is refused by the connection, not run
	err = p.Step(context.Background(), Read, func(s *Step) {
		_, err := s.Exec("INSERT INTO r VALUES (3, 'three')")
		if err == nil {
			t.Error("a write ran inside a read step")
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := d.QueryRow("SELECT count(*) FROM r").Scan(&n); err != nil || n != 2 {
		t.Fatalf("rows after the refused write: %d %v", n, err)
	}
}

// A WAIT gives the work process up and takes another: the row says Held
// while it sleeps, two other steps run at once on the work processes it and
// its kin held, and the statements after the WAIT run on the one it took.
func TestYieldLendsTheWorkProcessOn(t *testing.T) {
	d := openWAL(t, 3, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	first := make(chan int, 1) // the yielding step's first work process
	resumed := make(chan int, 1)
	inWait := make(chan struct{})
	go p.Step(context.Background(), Read, func(s *Step) {
		first <- s.WP()
		close(inWait)
		s.Yield(250 * time.Millisecond)
		resumed <- s.WP()
	})
	<-inWait
	// the WAIT's step holds no work process now: with M = 2, two fresh
	// steps both lend one while it sleeps
	var ran sync.WaitGroup
	ran.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer ran.Done()
			if err := p.Step(context.Background(), Read, func(s *Step) {
				var v string
				if err := scanOne(s, "SELECT v FROM r WHERE id = 1", &v); err != nil || v != "one" {
					t.Errorf("the step beside the WAIT: %q %v", v, err)
				}
			}); err != nil {
				t.Error(err)
			}
		}()
	}
	waited := make(chan struct{})
	go func() { ran.Wait(); close(waited) }()
	select {
	case <-waited:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("the steps beside the WAIT did not both run: the WAIT kept a work process")
	}
	if again := <-resumed; again < 1 || again > 2 {
		t.Fatalf("the resumed step's work process: %d", again)
	}
	// every row is Idle again once the steps ended
	for _, row := range p.Snapshot() {
		if row.State != "Idle" {
			t.Fatalf("work process %d is %s after the steps ended", row.Number, row.State)
		}
	}
}

// The drain's locker: Lock waits for the steps in flight and refuses new
// ones; Unlock lends again. A WAIT that gave its work process up gets one
// back only after Unlock.
func TestLockerDrainsInFlightAndRefusesNewcomers(t *testing.T) {
	d := openWAL(t, 3, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	inStep := make(chan struct{})
	stepDone := make(chan struct{})
	go p.Step(context.Background(), Read, func(s *Step) {
		close(inStep)
		<-stepDone
	})
	<-inStep
	locked := make(chan struct{})
	go func() {
		Locker{P: p}.Lock()
		close(locked)
	}()
	// a newcomer is refused while the drain waits
	select {
	case <-locked:
		t.Fatal("Lock finished with a step in flight")
	case <-time.After(100 * time.Millisecond):
	}
	err = p.Step(context.Background(), Read, func(*Step) {})
	if !errors.Is(err, ErrNotServing) {
		t.Fatalf("the newcomer's answer: %v", err)
	}
	close(stepDone)
	select {
	case <-locked:
	case <-time.After(5 * time.Second):
		t.Fatal("Lock did not finish after the step in flight ended")
	}
	Locker{P: p}.Unlock()
	if err := p.Step(context.Background(), Read, func(*Step) {}); err != nil {
		t.Fatalf("after Unlock: %v", err)
	}
}

// The fence through the pool: Interrupt stops the step running on that work
// process at its next statement.
func TestInterruptIsTheFence(t *testing.T) {
	d := openWAL(t, 3, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	wp := make(chan int, 1)
	errs := make(chan error, 2)
	go func() {
		errs <- p.Step(context.Background(), Write, func(s *Step) {
			wp <- s.WP()
			// the long statement a hung step would run
			errs <- scanOne(s, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 400000000) SELECT max(x) FROM c", new(int))
		})
	}()
	number := <-wp
	time.Sleep(50 * time.Millisecond)
	if !p.Interrupt(number) {
		t.Fatal("no step was running on the work process")
	}
	if err := <-errs; err == nil {
		t.Fatal("the fenced statement reports no error")
	}
	if err := <-errs; err != nil {
		t.Fatalf("the step after the fence: %v", err)
	}
	// the work process is lent again and answers
	if err := p.Step(context.Background(), Read, func(s *Step) {
		var v string
		if err := scanOne(s, "SELECT v FROM r WHERE id = 1", &v); err != nil || v != "one" {
			t.Errorf("the work process after the fence: %q %v", v, err)
		}
	}); err != nil {
		t.Fatal(err)
	}
}

// The per-work-process statement cache: a text seen twice answers from the
// statement, and the statements live on the work process that made them.
func TestStatementsCachedPerWorkProcess(t *testing.T) {
	d := openWAL(t, 3, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	for i := 0; i < 4; i++ {
		if err := p.Step(context.Background(), Read, func(s *Step) {
			var v string
			if err := scanOne(s, "SELECT v FROM r WHERE id = 1", &v); err != nil {
				t.Error(err)
			}
		}); err != nil {
			t.Fatal(err)
		}
	}
	p.mu.Lock()
	cached := 0
	for _, w := range p.workers {
		cached += len(w.stmts)
	}
	p.mu.Unlock()
	if cached == 0 {
		t.Fatal("no statement was cached on the work processes")
	}
}

// The host's stop is the drain's Lock and then Close (serving.Stop's Lock,
// then its Final): Close after Lock must not close the stop channel twice.
// The first run of the gateway conformance found it as a panic at SIGTERM.
func TestCloseAfterDrainLock(t *testing.T) {
	d := openWAL(t, 3, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	Locker{P: p}.Lock()
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
}

// A dump that leaves work unrecovered gives the work process back: the
// pool still lends all M afterwards. The kernel test of a failed commit in
// a WAIT hung on the lost one.
func TestPanicInStepReturnsTheWorkProcess(t *testing.T) {
	d := openWAL(t, 2, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	func() {
		defer func() { recover() }()
		p.Step(context.Background(), Write, func(*Step) { panic("dump") })
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := p.Step(ctx, Read, func(*Step) {}); err != nil {
		t.Fatalf("the next step after a dump: %v", err)
	}
}

// A step fenced inside its WAIT holds no work process when it ends: its
// end returns nothing (the WAIT gave its one back), its statements are
// refused instead of running on a connection another step holds, and the
// pool lends exactly M afterwards.
func TestFencedWaitReturnsNothingTwice(t *testing.T) {
	d := openWAL(t, 3, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	ctx, cancel := context.WithCancel(context.Background())
	inWait := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- p.Step(ctx, Read, func(s *Step) {
			close(inWait)
			// the only work process is taken by the step below while this
			// one sleeps, so the take waits until the fence cancels it
			s.Yield(50 * time.Millisecond)
			if _, err := s.Exec("SELECT 1"); !errors.Is(err, errNotHeld) {
				t.Errorf("a statement after a fenced WAIT: %v", err)
			}
		})
	}()
	<-inWait
	other := make(chan struct{})
	go p.Step(context.Background(), Read, func(*Step) {
		close(other)
		<-release
	})
	<-other
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	close(release)
	// one work process: two steps in a row, then a third must wait
	for i := 0; i < 2; i++ {
		c, cl := context.WithTimeout(context.Background(), 2*time.Second)
		if err := p.Step(c, Read, func(*Step) {}); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		cl()
	}
	held := make(chan struct{})
	go p.Step(context.Background(), Read, func(*Step) { close(held); time.Sleep(200 * time.Millisecond) })
	<-held
	c, cl := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cl()
	if err := p.Step(c, Read, func(*Step) {}); err == nil {
		t.Fatal("a second step ran beside the first on a one-work-process pool: the fenced WAIT returned its work process twice")
	}
}

// Writers queue on the pool's write token, not in SQLite's busy handler: a
// second modifying step waits without a work process (a read runs beside
// the first writer meanwhile), starts as soon as the first ends, and a
// WAIT in a writer gives the token up with the work process.
func TestWritersQueueOnTheToken(t *testing.T) {
	d := openWAL(t, 4, 5*time.Second)
	defer d.Close()
	p, err := New(Options{DB: d, Workers: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	inFirst := make(chan struct{})
	release := make(chan struct{})
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		p.Step(context.Background(), Write, func(s *Step) {
			close(inFirst)
			<-release
		})
	}()
	<-inFirst
	secondIn := make(chan time.Time, 1)
	go p.Step(context.Background(), Write, func(s *Step) { secondIn <- time.Now() })
	// the second writer holds no work process while it waits: a read runs
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := p.Step(ctx, Read, func(*Step) {}); err != nil {
		t.Fatalf("a read beside a writer and a waiting writer: %v", err)
	}
	select {
	case <-secondIn:
		t.Fatal("the second writer ran while the first held the token")
	case <-time.After(50 * time.Millisecond):
	}
	released := time.Now()
	close(release)
	<-firstDone
	select {
	case at := <-secondIn:
		if waited := at.Sub(released); waited > 20*time.Millisecond {
			t.Errorf("the second writer started %v after the first ended", waited)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the second writer never ran")
	}
	// a WAIT gives the token up: another writer runs during the sleep
	inWait := make(chan struct{})
	waitDone := make(chan struct{})
	go func() {
		defer close(waitDone)
		p.Step(context.Background(), Write, func(s *Step) {
			close(inWait)
			s.Yield(300 * time.Millisecond)
		})
	}()
	<-inWait
	ctx2, cancel2 := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel2()
	if err := p.Step(ctx2, Write, func(*Step) {}); err != nil {
		t.Fatalf("a writer during another writer's WAIT: %v", err)
	}
	<-waitDone
}

// The pool's own half of the cancellation fix (PR #900 review, MUST 1): a
// step fenced with its transaction still open -- whatever ran on the
// connection, the kernel's bracket or not -- goes back scrubbed, so the next
// step on the one work process begins, and the file's write lock is free.
func TestFencedStepWithOpenTransactionIsScrubbed(t *testing.T) {
	d := openWAL(t, 2, 200*time.Millisecond)
	p, err := New(Options{DB: d, Workers: 1, BusyTimeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	ctx, cancel := context.WithCancel(context.Background())
	if err := p.Step(ctx, Write, func(s *Step) {
		if _, err := s.Exec("BEGIN IMMEDIATE"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Exec("UPDATE r SET v = 'fenced'"); err != nil {
			t.Fatal(err)
		}
		cancel()
		if _, err := s.Exec("COMMIT"); err == nil {
			t.Error("a fenced step committed")
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := p.Step(context.Background(), Write, func(s *Step) {
		if _, err := s.Exec("BEGIN IMMEDIATE"); err != nil {
			t.Fatalf("the next step on the fenced work process: %v", err)
		}
		var v string
		if err := scanOne(s, "SELECT v FROM r WHERE id = 1", &v); err != nil || v != "one" {
			t.Errorf("the fenced UPDATE survived: %q %v", v, err)
		}
		if _, err := s.Exec("COMMIT"); err != nil {
			t.Error(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
}
