package abap

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

	"osg/gogen/workpool"
)

// The work-process step of ADR 0010 slice 5 at the kernel level: the
// proofs about statics and the LUW that the slice asks for, run against a
// real WAL file and a real pool, with nothing of the generated classes
// around them (the conformance run covers those end to end).

// wpStepConn is the pool's step handle as the kernel sees it (StepConn),
// with the work process's number, so a test can prove which one ran.
type wpStepConn struct {
	*workpool.Step
}

func (c wpStepConn) wp() int { return c.Step.WP() }

// openStepPool is a WAL file with a pool of M work processes over it and
// the spare the kernel's own statements take.
func openStepPool(t *testing.T, workers int) (*Database, *workpool.Pool) {
	t.Helper()
	d, err := openSQL("file:" + filepath.Join(t.TempDir(), "step.sqlite") + "?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	db := newDatabase(d)
	db.OpenPool(workers, 1)
	if _, err := d.Exec("CREATE TABLE r (id INTEGER NOT NULL PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	p, err := workpool.New(workpool.Options{DB: d, Workers: workers, BusyTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close(); db.Close() })
	return db, p
}

// pooledStep runs work as one dialog step of a logical session on a work
// process, the way the host does (cmd/osgo runWorkStep): the session's
// statics travel with the logical session, not with the work process. A
// dump inside work is contained as the host contains it (runWorkStep's
// recover); dumped says there was one.
func pooledStep(t *testing.T, p *workpool.Pool, db *Database, store **Statics, kind StepKind, work func(*Session, wpStepConn)) (dumped bool, err error) {
	t.Helper()
	err = p.Step(context.Background(), workpool.Kind(kind), func(st *workpool.Step) {
		defer func() {
			if recover() != nil {
				dumped = true
			}
		}()
		s := &Session{DB: db, Statics: *store}
		DialogStepOn(s, kind, wpStepConn{st}, func() { work(s, wpStepConn{st}) })
		*store = s.Statics
	})
	return dumped, err
}

// classSlot is a slot the way a generated class registers one: a struct the
// class constructor would fill, reached through Session.Static.
type classState struct {
	value    string
	cctorRan bool
}

var classSlot = RegisterStatics(func() any { return &classState{} })

// holdWP runs a gated read step and returns once it has its work process:
// the caller decides when that work process is free again.
func holdWP(t *testing.T, p *workpool.Pool) (number int, release func()) {
	t.Helper()
	got := make(chan int, 1)
	gate := make(chan struct{})
	go p.Step(context.Background(), workpool.Read, func(st *workpool.Step) {
		got <- st.WP()
		<-gate
	})
	number = <-got
	return number, func() { close(gate) }
}

// Proof: a stateful session's two steps on two work processes see one
// CLASS-DATA, and a second session never inherits the first's. The statics
// belong to the logical internal session; the work process is whoever the
// dispatcher lends.
func TestStaticsOfOneSessionAcrossWorkProcesses(t *testing.T) {
	db, p := openStepPool(t, 2)
	var a, b *Statics

	// occupy one work process, so A's first step lands on the other
	held, free := holdWP(t, p)
	var a1, a2 int
	if _, err := pooledStep(t, p, db, &a, ReadStep, func(s *Session, c wpStepConn) {
		a1 = c.wp()
		if a1 == held {
			t.Fatalf("step A1 ran on the held work process %d", a1)
		}
		s.Static(classSlot).(*classState).value = "session A"
	}); err != nil {
		t.Fatal(err)
	}
	// occupy A1's work process too and free the first: A2 must take the
	// other one, a different work process from its session's first step
	a1Held, releaseA1 := holdWP(t, p)
	if a1Held != a1 {
		t.Fatalf("the second holder took work process %d, not A1's %d", a1Held, a1)
	}
	free()
	if _, err := pooledStep(t, p, db, &a, ReadStep, func(s *Session, c wpStepConn) {
		a2 = c.wp()
		if a2 != held {
			t.Fatalf("step A2 ran on work process %d, not the freed %d", a2, held)
		}
		if got := s.Static(classSlot).(*classState).value; got != "session A" {
			t.Errorf("step A2 on work process %d sees %q", a2, got)
		}
	}); err != nil {
		t.Fatal(err)
	}
	releaseA1()
	if a1 == a2 {
		t.Fatalf("the session's two steps ran on one work process (%d); the proof needs two", a1)
	}
	// session B, on whatever work process is free, sees none of it
	if _, err := pooledStep(t, p, db, &b, ReadStep, func(s *Session, c wpStepConn) {
		if got := s.Static(classSlot).(*classState).value; got != "" {
			t.Errorf("session B inherited session A's CLASS-DATA: %q", got)
		}
	}); err != nil {
		t.Fatal(err)
	}
}

// Proof: the shared slot is one per process -- the runtime's own cache,
// whichever session reads it (the service registry the OData front reads).
func TestSharedSlotIsInstanceWide(t *testing.T) {
	db, p := openStepPool(t, 2)
	shared := &Statics{}
	RegisterSharedStatics(classSlot)
	t.Cleanup(func() { delete(sharedSlots, classSlot) })
	var a, b *Statics
	if _, err := pooledStep(t, p, db, &a, ReadStep, func(s *Session, c wpStepConn) {
		s.Shared = shared
		s.Static(classSlot).(*classState).value = "the registry"
	}); err != nil {
		t.Fatal(err)
	}
	// a second session, another work process, its own statics: the shared
	// slot is the one store's
	if _, err := pooledStep(t, p, db, &b, ReadStep, func(s *Session, c wpStepConn) {
		s.Shared = shared
		if got := s.Static(classSlot).(*classState).value; got != "the registry" {
			t.Errorf("the shared slot is not instance-wide: %q", got)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if a != nil && b != nil && a == b {
		t.Error("the two sessions share their private statics")
	}
}

// Proof (test/dialog-step.mjs, ported): a step that dumps does not roll
// back the half-written rows of the step beside it. Two work processes,
// each its own connection and transaction; the dumper's LUW goes, the
// other's is whole.
func TestDumpingStepDoesNotRollBackTheStepBesideIt(t *testing.T) {
	db, p := openStepPool(t, 2)
	var wg sync.WaitGroup
	halfway := make(chan struct{})
	wg.Add(2)
	go func() {
		defer wg.Done()
		// A: writes one row, waits, writes another
		var store *Statics
		if _, err := pooledStep(t, p, db, &store, WriteStep, func(s *Session, c wpStepConn) {
			if _, err := s.conn().Exec("INSERT INTO r VALUES (1)"); err != nil {
				t.Error(err)
			}
			close(halfway)
			time.Sleep(150 * time.Millisecond)
			if _, err := s.conn().Exec("INSERT INTO r VALUES (2)"); err != nil {
				t.Error(err)
			}
		}); err != nil {
			t.Error(err)
		}
	}()
	<-halfway
	go func() {
		defer wg.Done()
		// B arrives while A is half-way and dumps
		var store *Statics
		if dumped, _ := pooledStep(t, p, db, &store, WriteStep, func(s *Session, c wpStepConn) {
			panic(ClassicException{Name: "UNCAUGHT", Method: "B"})
		}); !dumped {
			t.Error("B's step did not dump")
		}
	}()
	wg.Wait()
	// both LUWs are gone: A's is not (it committed), B's rolled back; A's
	// rows are whole, and the database is usable
	var n int
	if err := db.SQL().QueryRow("SELECT count(*) FROM r").Scan(&n); err != nil || n != 2 {
		t.Fatalf("rows after the dump beside a writer: %d %v (A's two, whole)", n, err)
	}
}

// Proof (test/dialog-step.mjs, ported): a step in a WAIT commits its own
// LUW and lets the others run meanwhile. The WAIT ends the LUW, as on a
// system, and gives the work process up; the statement after it runs on
// another, in a transaction the WAIT opened.
func TestWaitCommitsItsLUWAndLendsTheWorkProcess(t *testing.T) {
	db, p := openStepPool(t, 2)
	var store *Statics
	order := make(chan string, 4)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, err := pooledStep(t, p, db, &store, WriteStep, func(s *Session, c wpStepConn) {
			if _, err := s.conn().Exec("INSERT INTO r VALUES (1)"); err != nil {
				t.Error(err)
			}
			order <- "before wait"
			s.YieldSleep(200 * time.Millisecond) // the runtime's WAIT: the kernel's yield
			order <- "after wait"
			if _, err := s.conn().Exec("INSERT INTO r VALUES (3)"); err != nil {
				t.Error(err)
			}
		})
		if err != nil {
			t.Error(err)
		}
	}()
	if got := <-order; got != "before wait" {
		t.Fatalf("%s", got)
	}
	// the work process is lent on during the WAIT: another write step runs
	var other *Statics
	if _, err := pooledStep(t, p, db, &other, WriteStep, func(s *Session, c wpStepConn) {
		if _, err := s.conn().Exec("INSERT INTO r VALUES (2)"); err != nil {
			t.Error(err)
		}
		order <- "beside"
	}); err != nil {
		t.Fatal(err)
	}
	<-done
	if got := <-order; got != "beside" {
		t.Fatalf("the step beside the WAIT ran %q", got)
	}
	var n int
	if err := db.SQL().QueryRow("SELECT count(*) FROM r").Scan(&n); err != nil || n != 3 {
		t.Fatalf("rows after the WAIT: %d %v (the WAIT committed its 1, the other wrote 2 and 3)", n, err)
	}
}

// Proof (test/dialog-step.mjs, ported): a step inside a step is refused by
// name rather than waiting for itself.
func TestStepInsideAStepIsRefusedByName(t *testing.T) {
	db, p := openStepPool(t, 1)
	var store *Statics
	var inner any
	_, err := pooledStep(t, p, db, &store, ReadStep, func(s *Session, c wpStepConn) {
		defer func() { inner = recover() }()
		DialogStepOn(s, ReadStep, c, func() {})
	})
	if err != nil {
		t.Fatal(err)
	}
	if inner == nil {
		t.Fatal("the nested step ran")
	}
	if text := fmt.Sprint(inner); !strings.Contains(text, "a dialog step is already open") {
		t.Fatalf("the nested step's refusal: %v", inner)
	}
}

// Proof (test/dialog-step.mjs, ported): a WAIT whose commit fails ends the
// step and not the process -- the step unwinds as a dump on the failed
// COMMIT, its LUW rolled back, the work process lent again to a step that
// runs (the Node host's hang: the flag said released before the commit ran).
func TestFailedCommitInWaitEndsTheStep(t *testing.T) {
	db, p := openStepPool(t, 1)
	var dump any
	func() {
		defer func() { dump = recover() }()
		p.Step(context.Background(), workpool.Write, func(st *workpool.Step) {
			s := &Session{DB: db}
			DialogStepOn(s, WriteStep, breakingCommit{Step: st}, func() {
				if _, err := s.conn().Exec("INSERT INTO r VALUES (1)"); err != nil {
					t.Error(err)
				}
				s.YieldSleep(10 * time.Millisecond)
				t.Error("the statement after the failed commit ran")
			})
		})
	}()
	if dump == nil {
		t.Fatal("the step with the failing commit did not dump")
	}
	var n int
	if err := db.SQL().QueryRow("SELECT count(*) FROM r").Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows: %d %v (the failed step rolled back)", n, err)
	}
	// the next step runs, on the same work process, whose transaction the
	// failed commit left nobody's: the kernel rolled it back
	var again *Statics
	if _, err := pooledStep(t, p, db, &again, WriteStep, func(s *Session, c wpStepConn) {
		if _, err := s.conn().Exec("INSERT INTO r VALUES (2)"); err != nil {
			t.Error(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL().QueryRow("SELECT count(*) FROM r").Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows after the next step: %d %v", n, err)
	}
}

// breakingCommit is a lent connection whose first COMMIT (the one a WAIT
// runs) fails, as a commit on a serialization conflict does.
type breakingCommit struct {
	*workpool.Step
	commits int
}

func (b breakingCommit) Query(q string, args ...any) (*sql.Rows, error) {
	return b.Step.Query(q, args...)
}

func (b breakingCommit) Exec(q string, args ...any) (sql.Result, error) {
	if q == "COMMIT" {
		b.commits++
		if b.commits == 1 {
			return nil, errors.New("could not serialize access")
		}
	}
	return b.Step.Exec(q, args...)
}

// Regression (PR #900 review, MUST 1): a step whose context is cancelled
// between two statements -- the client went away, or the fence fired --
// must leave its work process clean. The COMMIT on the way out is refused
// by the cancelled context; the ROLLBACK after it ran on that same context
// and never reached the database, so the work process went back with its
// transaction open: every later step on it dumped "cannot start a
// transaction within a transaction", and its uncommitted UPDATE kept the
// file's write lock from every other connection. One work process, so the
// next steps must land on the one that was cancelled; the dump variant too.
func TestCancelBetweenStatementsLeavesTheWorkProcessClean(t *testing.T) {
	for _, dumps := range []bool{false, true} {
		t.Run(fmt.Sprintf("dump=%v", dumps), func(t *testing.T) {
			db, p := openStepPool(t, 1)
			if _, err := db.SQL().Exec("INSERT INTO r VALUES (1)"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			var dump any
			if err := p.Step(ctx, workpool.Write, func(st *workpool.Step) {
				defer func() { dump = recover() }()
				DialogStepOn(&Session{DB: db}, WriteStep, wpStepConn{st}, func() {
					if _, err := st.Exec("UPDATE r SET id = 2"); err != nil {
						t.Error(err)
					}
					cancel() // between this statement and the step's end
					if dumps {
						panic("the step dumps after the cancellation")
					}
				})
			}); err != nil {
				t.Fatal(err)
			}
			if dump == nil {
				t.Fatal("a cancelled step committed")
			}
			// the next read step on the same work process sees the row as it
			// was, and the next modifying step writes
			var store *Statics
			var id int
			if dumped, err := pooledStep(t, p, db, &store, ReadStep, func(s *Session, c wpStepConn) {
				rows, err := c.Query("SELECT id FROM r")
				Must(err)
				defer rows.Close()
				rows.Next()
				Must(rows.Scan(&id))
			}); dumped || err != nil {
				t.Fatalf("the read step after the cancelled one: dumped=%v err=%v", dumped, err)
			}
			if id != 1 {
				t.Fatalf("the cancelled step's UPDATE is visible: id=%d", id)
			}
			if dumped, err := pooledStep(t, p, db, &store, WriteStep, func(s *Session, c wpStepConn) {
				_, err := c.Exec("UPDATE r SET id = 3")
				Must(err)
			}); dumped || err != nil {
				t.Fatalf("the modifying step after the cancelled one: dumped=%v err=%v", dumped, err)
			}
			// and nothing holds the write lock: another connection writes at once
			other, err := db.SQL().Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			if _, err := other.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
				t.Fatal(err)
			}
			if _, err := other.ExecContext(context.Background(), "UPDATE r SET id = 4"); err != nil {
				t.Fatalf("a writer beside the pool after the cancelled step: %v", err)
			}
		})
	}
}

// The kernel's half of the cancellation cleanup, on its own (PR #900
// review round 2, SHOULD 2): the test above passes with the kernel's
// Cleanup removed, because the pool's scrub ends the transaction before the
// next step looks. Here the look is before the pool gets the work process
// back: still inside the pool's step, once DialogStepOn has unwound, a
// writer beside the pool must find the write lock free -- which it is only
// when the kernel's ROLLBACK reached the database past the cancelled
// context. The pool's scrub has not run yet, so it masks nothing.
func TestCancelledStepRollsBackBeforeThePoolScrubs(t *testing.T) {
	for _, dumps := range []bool{false, true} {
		t.Run(fmt.Sprintf("dump=%v", dumps), func(t *testing.T) {
			db, p := openStepPool(t, 1)
			if _, err := db.SQL().Exec("INSERT INTO r VALUES (1)"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if err := p.Step(ctx, workpool.Write, func(st *workpool.Step) {
				func() {
					defer func() { recover() }()
					DialogStepOn(&Session{DB: db}, WriteStep, wpStepConn{st}, func() {
						if _, err := st.Exec("UPDATE r SET id = 2"); err != nil {
							t.Error(err)
						}
						cancel()
						if dumps {
							panic("the step dumps after the cancellation")
						}
					})
				}()
				other, err := db.SQL().Conn(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				defer other.Close()
				if _, err := other.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
					t.Fatal(err)
				}
				if _, err := other.ExecContext(context.Background(), "UPDATE r SET id = 5 WHERE id = 1"); err != nil {
					t.Errorf("the kernel left the cancelled step's transaction open: %v", err)
				}
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Regression (PR #900 review, MUST 2): a WAIT inside a SELECT loop must not
// carry the open cursor -- and with it the connection's read snapshot --
// past the COMMIT the WAIT runs and onto the work process it gives up. A
// selects 1,2 and WAITs at its first row; B updates them to 11,12 on the
// other work process and commits; C, a new read step after B's commit,
// lands on A's old work process and must see 11,12, not the snapshot A's
// cursor pinned there. A itself, back from the WAIT, cannot go on reading
// a cursor the database commit closed: on a system that is the runtime
// error DBIF_RSQL_INVALID_CURSOR (a WAIT is a database commit, and a
// database commit closes the open cursors).
func TestWaitInsideSelectLeavesNoSnapshotBehind(t *testing.T) {
	db, p := openStepPool(t, 2)
	if _, err := db.SQL().Exec("INSERT INTO r VALUES (1), (2)"); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan struct{})
	aDone := make(chan any, 1)
	var aWP int
	go func() {
		var store *Statics
		var dump any
		p.Step(context.Background(), workpool.Read, func(st *workpool.Step) {
			defer func() { dump = recover() }()
			s := &Session{DB: db, Statics: store}
			aWP = st.WP()
			DialogStepOn(s, ReadStep, wpStepConn{st}, func() {
				Select(s, "SELECT id FROM r ORDER BY id", nil, nil, func(scan func(...any) error) {
					var v int
					Must(scan(&v))
					if v == 1 {
						close(waiting)
						s.YieldSleep(400 * time.Millisecond)
					}
				})
			})
		})
		aDone <- dump
	}()
	<-waiting
	for p.InFlight() != 0 {
		time.Sleep(time.Millisecond)
	}
	var store *Statics
	if dumped, err := pooledStep(t, p, db, &store, WriteStep, func(s *Session, c wpStepConn) {
		_, err := c.Exec("UPDATE r SET id = id + 10")
		Must(err)
	}); dumped || err != nil {
		t.Fatalf("B: dumped=%v err=%v", dumped, err)
	}
	var got []int
	var cWP int
	if dumped, err := pooledStep(t, p, db, &store, ReadStep, func(s *Session, c wpStepConn) {
		cWP = c.wp()
		Select(s, "SELECT id FROM r ORDER BY id", nil, nil, func(scan func(...any) error) {
			var v int
			Must(scan(&v))
			got = append(got, v)
		})
	}); dumped || err != nil {
		t.Fatalf("C: dumped=%v err=%v", dumped, err)
	}
	if cWP != aWP {
		t.Fatalf("C ran on work process %d, not A's %d: the schedule did not happen", cWP, aWP)
	}
	if fmt.Sprint(got) != "[11 12]" {
		t.Errorf("C, a step begun after B's commit, read %v: A's cursor left its snapshot on the work process", got)
	}
	dump := <-aDone
	if dump == nil || !strings.Contains(fmt.Sprint(dump), "DBIF_RSQL_INVALID_CURSOR") {
		t.Errorf("A went on reading a cursor its WAIT closed: %v", dump)
	}
}
