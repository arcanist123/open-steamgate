package abap

import (
	"testing"
	"time"
)

type sessionStateStatics struct{ hits int }

var sessionStateSlot = RegisterStatics(func() any { return &sessionStateStatics{} })

// ADR 0010 slice 2: a Session owns its database handle, its transaction and
// its statics; nothing of a step is in a package variable. The Node host
// (tools/osd-dialog-step.mjs) has one connection, one LUW and one set of
// statics per process and serialises its steps on a work-process queue; a
// system gives every internal session its own, and a step that dumps ends
// its LUW. The Go kernel now has the system's shape with the Node host's
// policy on top (one Instance, one WorkProcess): two sessions never share
// a transaction, and share statics only when the host says so.
func TestSessionsOwnTheirState(t *testing.T) {
	const script = `["CREATE TABLE t (id TEXT PRIMARY KEY)"]`
	// two databases, a session each: a step open on one is not open on the
	// other, a write inside it is not seen there, a rollback there undoes
	// nothing here
	da, a := openTestDB(t, script)
	db, b := openTestDB(t, script)
	DialogStep(a, func() {
		if _, err := a.conn().Exec("INSERT INTO t VALUES ('A')"); err != nil {
			t.Fatal(err)
		}
		if b.InStep() || db.inStep != nil {
			t.Fatal("a step of session A is open on session B's database")
		}
		DialogStep(b, func() {
			if n := countRows(t, b, "SELECT COUNT(*) FROM t"); n != 0 {
				t.Fatalf("B sees A's uncommitted row: %d", n)
			}
			if _, err := b.conn().Exec("INSERT INTO t VALUES ('B')"); err != nil {
				t.Fatal(err)
			}
			RollbackWork(b)
		})
		if n := countRows(t, a, "SELECT COUNT(*) FROM t"); n != 1 {
			t.Fatalf("B's rollback reached A's transaction: %d rows", n)
		}
	})
	if a.InStep() || da.inStep != nil || b.InStep() || db.inStep != nil {
		t.Fatal("a step outlived DialogStep")
	}
	if n := countRows(t, a, "SELECT COUNT(*) FROM t"); n != 1 {
		t.Fatalf("A: %d rows, want 1", n)
	}
	if n := countRows(t, b, "SELECT COUNT(*) FROM t"); n != 0 {
		t.Fatalf("B: %d rows, want 0", n)
	}

	// sequential sessions on one database: the next step starts with no
	// transaction of the last one, a dumped step's rows are gone, and the
	// one connection is never held by two sessions at once -- refused,
	// not queued (Node: the work-process queue; here the hosts' WorkProcess)
	c := &Session{DB: da}
	func() {
		defer func() { recover() }()
		DialogStep(c, func() {
			c.conn().Exec("INSERT INTO t VALUES ('C')")
			panic(ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
		})
	}()
	d2 := &Session{DB: da}
	DialogStep(d2, func() {
		if n := countRows(t, d2, "SELECT COUNT(*) FROM t"); n != 1 {
			t.Fatalf("the dumped session's row reached the next session: %d rows", n)
		}
		var refused any
		func() {
			defer func() { refused = recover() }()
			DialogStep(&Session{DB: da}, func() {})
		}()
		if e, ok := refused.(ArithmeticError); !ok || e.Class != "NOT_COMPILED" {
			t.Fatalf("a second session's step on the held connection: %v", refused)
		}
		if !d2.InStep() {
			t.Fatal("the refused step ended the open one")
		}
	})

	// statics: private per session unless minted from one Instance, where
	// sessions share the store across steps as the Node host's process does;
	// a fresh Instance starts clean (the class constructor runs again)
	first := NewInstance(da)
	s1, s2 := first.NewSession(), first.NewSession()
	s1.Static(sessionStateSlot).(*sessionStateStatics).hits++
	if hits := s2.Static(sessionStateSlot).(*sessionStateStatics).hits; hits != 1 {
		t.Fatalf("sessions of one instance do not share statics: %d", hits)
	}
	if hits := (&Session{DB: da}).Static(sessionStateSlot).(*sessionStateStatics).hits; hits != 0 {
		t.Fatalf("a private session inherited an instance's statics: %d", hits)
	}
	if hits := NewInstance(da).NewSession().Static(sessionStateSlot).(*sessionStateStatics).hits; hits != 0 {
		t.Fatalf("a new instance inherited another's statics: %d", hits)
	}
	if s1.DB != da || s2.DB != da {
		t.Fatal("instance sessions did not get the instance's database")
	}
}

// A session the host gave no database refuses its first statement by name
// (a host error, not a nil dereference), and its steps have no LUW.
func TestSessionWithoutDatabase(t *testing.T) {
	s := &Session{}
	DialogStep(s, func() {
		if s.InStep() {
			t.Fatal("a step without a database opened a transaction")
		}
	})
	var got any
	func() {
		defer func() { got = recover() }()
		s.conn().Exec("SELECT 1")
	}()
	if e, ok := got.(ArithmeticError); !ok || e.Class != "NOT_COMPILED" {
		t.Fatalf("statement without a database: %v", got)
	}
}

// A statement outside a step, on a database whose one connection another
// session's step holds, is refused by name rather than queued forever on
// the pool -- the same rule as a second step at begin (db.go). Both the
// plain path and a statement the cache has already prepared are covered.
func TestStatementOutsideStepWhileAnotherHoldsConnection(t *testing.T) {
	d, a := openTestDB(t, `["CREATE TABLE t (k TEXT)"]`)
	b := &Session{DB: d}
	const ins = "INSERT INTO t VALUES ('b')"
	// two sightings in steps of b, then a step end: the text is prepared
	for range 2 {
		DialogStep(b, func() { b.conn().Exec(ins) })
	}
	if _, ok := d.stmtCache[ins]; !ok {
		t.Fatal("the statement was not prepared")
	}
	for _, q := range []string{ins, "INSERT INTO t VALUES ('plain')"} {
		done := make(chan any, 1)
		DialogStep(a, func() {
			go func() {
				defer func() { done <- recover() }()
				b.conn().Exec(q)
			}()
			select {
			case got := <-done:
				if e, ok := got.(ArithmeticError); !ok || e.Class != "NOT_COMPILED" {
					t.Fatalf("%s: %v", q, got)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("%s: queued on the held connection", q)
			}
		})
	}
	// with the step over, the same session runs it in autocommit
	if _, err := b.conn().Exec(ins); err != nil {
		t.Fatal(err)
	}
}

// After Database.Close, a statement and a step are refused as
// CX_SY_OPEN_SQL_DB "database is closed", not a nil dereference.
func TestClosedDatabaseRefuses(t *testing.T) {
	d, s := openTestDB(t, `["CREATE TABLE t (k TEXT)"]`)
	d.Close()
	for name, f := range map[string]func(){
		"statement": func() { s.conn().Exec("SELECT 1") },
		"step":      func() { DialogStep(s, func() {}) },
	} {
		var got any
		func() {
			defer func() { got = recover() }()
			f()
		}()
		if e, ok := got.(ArithmeticError); !ok || e.Class != "CX_SY_OPEN_SQL_DB" || e.Op != "database is closed" {
			t.Fatalf("%s after Close: %v", name, got)
		}
	}
}
