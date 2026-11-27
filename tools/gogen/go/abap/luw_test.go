package abap

import (
	"testing"
	"time"
)

// openTestDB opens a database for one test and gives it back to the test's
// cleanup; the session is one the test hands its steps.
func openTestDB(t *testing.T, script string) (*Database, *Session) {
	t.Helper()
	d, err := OpenDB([]byte(script))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d, &Session{DB: d}
}

func countRows(t *testing.T, s *Session, query string) int {
	t.Helper()
	r, err := s.conn().Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	n := 0
	r.Next()
	if err := r.Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// The rows written stand in for what an INSERT of ABAP would write; the
// statements are raw here because the test is about the LUW, not the SQL.
func TestLUW(t *testing.T) {
	_, s := openTestDB(t, `["CREATE TABLE t (id TEXT PRIMARY KEY)"]`)
	put := func(id string) {
		if _, err := s.conn().Exec("INSERT INTO t VALUES (?)", id); err != nil {
			t.Fatal(err)
		}
	}
	rows := func() int { return countRows(t, s, "SELECT COUNT(*) FROM t") }
	// A4H: INSERT; ROLLBACK WORK -> 0 rows; INSERT; COMMIT WORK; ROLLBACK
	// WORK -> 1 row; sy-subrc 0 after each (set to 7 before)
	DialogStep(s, func() {
		put("A")
		s.Sy.Subrc = 7
		RollbackWork(s)
		if s.Sy.Subrc != 0 || rows() != 0 {
			t.Fatalf("rollback: subrc %d rows %d", s.Sy.Subrc, rows())
		}
		put("A")
		s.Sy.Subrc = 7
		CommitWork(s)
		if s.Sy.Subrc != 0 {
			t.Fatalf("commit: subrc %d", s.Sy.Subrc)
		}
		RollbackWork(s)
		if rows() != 1 {
			t.Fatalf("after commit and rollback: %d rows", rows())
		}
		put("B")
	})
	if rows() != 2 {
		t.Fatalf("a step that ends normally commits: %d rows", rows())
	}
	// a step that dumps leaves nothing behind, and the dump goes on
	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("the dump did not go on")
			}
		}()
		DialogStep(s, func() {
			put("C")
			panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
		})
	}()
	if s.tx != nil || rows() != 2 {
		t.Fatalf("a step that dumps rolls back: tx %v rows %d", s.tx != nil, rows())
	}
}

// Outside a dialog step every statement autocommits, so ROLLBACK WORK
// could undo nothing: it is refused, not answered 0. COMMIT WORK there is
// a no-op. Without a database both answer 0.
func TestLUWOutsideStep(t *testing.T) {
	s := &Session{}
	RollbackWork(s) // no database: nothing written, nothing to undo
	CommitWork(s)
	_, s = openTestDB(t, `["CREATE TABLE t (id TEXT PRIMARY KEY)"]`)
	CommitWork(s)
	func() {
		defer func() {
			r := recover()
			if e, ok := r.(ArithmeticError); !ok || e.Class != "NOT_COMPILED" {
				t.Fatalf("ROLLBACK WORK outside a step: %v", r)
			}
		}()
		RollbackWork(s)
	}()
}

// A dialog step inside a dialog step fails at once instead of waiting
// forever for the one connection the outer step holds, and the outer step
// is rolled back by its own end, not by the inner one.
func TestLUWNested(t *testing.T) {
	_, s := openTestDB(t, `["CREATE TABLE t (id TEXT PRIMARY KEY)"]`)
	var inner any
	func() {
		defer func() { inner = recover() }()
		DialogStep(s, func() {
			if _, err := s.conn().Exec("INSERT INTO t VALUES ('A')"); err != nil {
				t.Fatal(err)
			}
			DialogStep(s, func() {})
		})
	}()
	if e, ok := inner.(ArithmeticError); !ok || e.Class != "NOT_COMPILED" {
		t.Fatalf("nested step: %v", inner)
	}
	if s.tx != nil {
		t.Fatal("the outer step left its transaction open")
	}
	if n := countRows(t, s, "SELECT COUNT(*) FROM t"); n != 0 {
		t.Fatalf("the outer step's row survived its dump: %d", n)
	}
}

// When the rollback of a dumped step fails as well, the dump is what goes
// on, not the rollback's error.
func TestLUWDumpSurvivesRollbackError(t *testing.T) {
	_, s := openTestDB(t, `[]`)
	var got any
	func() {
		defer func() { got = recover() }()
		DialogStep(s, func() {
			s.tx.Rollback() // the step's own rollback will now fail
			panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
		})
	}()
	if e, ok := got.(ArithmeticError); !ok || e.Class != "CX_SY_ZERODIVIDE" {
		t.Fatalf("the dump was replaced: %v", got)
	}
}

// The statement cache (parity-wave2): a text run twice in a step is
// prepared after it and reused by the steps after; a dumped step still
// takes back what it wrote through a cached statement, and COMMIT WORK in
// the middle of a step keeps it
func TestLUWStatementCache(t *testing.T) {
	d, s := openTestDB(t, `["CREATE TABLE t (id TEXT PRIMARY KEY)"]`)
	const ins, cnt = "INSERT INTO t VALUES (?)", "SELECT COUNT(*) FROM t"
	count := func() int { return countRows(t, s, cnt) }
	DialogStep(s, func() {
		s.conn().Exec(ins, "A")
		s.conn().Exec(ins, "B")
		if count()+count() != 4 {
			t.Fatal("first step")
		}
	})
	if d.stmtCache[ins] == nil || d.stmtCache[cnt] == nil {
		t.Fatalf("not prepared after the step: %v", d.stmtCache)
	}
	func() {
		defer func() { recover() }()
		DialogStep(s, func() {
			if _, err := s.conn().Exec(ins, "C"); err != nil {
				t.Fatal(err)
			}
			if count() != 3 {
				t.Fatal("the cached insert is not in the step")
			}
			panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
		})
	}()
	DialogStep(s, func() {
		if count() != 2 {
			t.Fatalf("the dumped step's row stayed: %d", count())
		}
		s.conn().Exec(ins, "D")
		CommitWork(s)
		s.conn().Exec(ins, "E")
		RollbackWork(s)
	})
	if n := count(); n != 3 {
		t.Fatalf("after COMMIT WORK and ROLLBACK WORK: %d rows, want 3", n)
	}
	if _, err := s.conn().Exec(ins, "A"); err == nil {
		t.Fatal("a duplicate key through a cached statement is still refused")
	}
	// another session on the same database runs the prepared statements
	// of the database through a transaction of its own
	other := &Session{DB: d}
	DialogStep(other, func() {
		if n := countRows(t, other, cnt); n != 3 {
			t.Fatalf("other session: %d rows, want 3", n)
		}
	})
	if len(other.txStmts) != 0 {
		t.Fatal("the step's transaction-bound statements outlived it")
	}
}

// A waiting step ends its transaction so another full SQLite step can run.
func TestYieldSleepSQLiteSteps(t *testing.T) {
	d, s := openTestDB(t, `["CREATE TABLE t (id TEXT PRIMARY KEY)"]`)
	done := make(chan any, 1)
	WorkProcess.Lock()
	DialogStepIn(s, func() {
		go func() {
			WorkProcess.Lock()
			defer WorkProcess.Unlock()
			var dump any
			func() {
				defer func() { dump = recover() }()
				b := &Session{DB: d}
				DialogStep(b, func() {
					if _, err := b.conn().Exec("INSERT INTO t VALUES ('B')"); err != nil {
						panic(err)
					}
				})
			}()
			done <- dump
		}()
		s.YieldSleep(50 * time.Millisecond)
		select {
		case dump := <-done:
			if dump != nil {
				t.Errorf("step B dumped: %v", dump)
			}
		default:
			t.Error("step B did not run during the yield")
		}
		if s.tx == nil {
			t.Error("step A resumed without a transaction")
		}
		if _, err := s.conn().Exec("INSERT INTO t VALUES ('A')"); err != nil {
			t.Fatal(err)
		}
	})
	WorkProcess.Unlock()
	var count int
	if err := d.SQL().QueryRow("SELECT COUNT(*) FROM t").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("rows = %d, want 2", count)
	}
	if s.HoldsWorkProcess {
		t.Fatal("step left ownership set")
	}
}
