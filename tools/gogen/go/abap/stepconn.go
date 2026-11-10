package abap

import (
	"database/sql"
	"time"
)

// The work-process step (ADR 0010 slice 5): a dialog step that runs on a
// connection a work process of the pool lent (go/workpool), with the
// step-kind policy the ADR decides by the kind of step, not by the
// transaction:
//
//   - a read step opens BEGIN (deferred) on a connection the pool put in
//     query_only mode: it takes no write lock, so M of them run in
//     parallel beside a writer, and a write attempt inside one is the
//     database's refusal -- a dump, as a write in a GET is already outside
//     the LUW bracket (docs/luw-buffer.md);
//   - a modifying step opens BEGIN IMMEDIATE: the write lock before the
//     first statement, so the read-then-write upgrade that could fail
//     SQLITE_BUSY_SNAPSHOT -- not covered by busy_timeout, and an ABAP
//     step cannot be replayed after its external effects -- cannot happen;
//     writers wait for one another by the connection's busy_timeout, which
//     the pool sets to the drain grace.
//
// The bracket is the kernel's rule as ever (commit when the work returns,
// roll back when it dumps); COMMIT WORK, ROLLBACK WORK and a WAIT
// (YieldSleep) end and reopen the transaction on the lent connection, and a
// WAIT gives the work process up and takes another, which is the pool's
// Yield under the step handle. The fence (sqlite3_interrupt) is the step's
// context: the pool cancels it, the next statement fails, and the bracket
// rolls the LUW back on the way out.

// StepKind is the step's half of the database policy. It is a bool so the
// modifying kind reads as the condition it is.
type StepKind bool

const (
	ReadStep  StepKind = false // deferred transaction on a query_only connection
	WriteStep StepKind = true  // BEGIN IMMEDIATE
)

// StepConn is a work process's connection lent to one step: what the
// step's statements run on, with the transaction the kernel opens on it.
// The pool's step handle implements it; Prepare is what a host that
// prepares beside the kernel (adtpreview) needs.
type StepConn interface {
	Query(query string, args ...any) (*sql.Rows, error)
	Exec(query string, args ...any) (sql.Result, error)
	Prepare(query string) (*sql.Stmt, error)
}

// DialogStepOn runs one step of work of the session on a lent connection:
// the kind's transaction, work, COMMIT on return, ROLLBACK on a dump (the
// panic goes on), exactly as DialogStep does on the database's own
// connection. The pool has put the connection in the kind's mode.
func DialogStepOn(s *Session, kind StepKind, c StepConn, work func()) {
	if s.tx != nil || s.stepOpen {
		panic(NotCompiled("dialog step", "a dialog step is already open"))
	}
	s.stepConn, s.stepKind = c, kind
	s.HoldsWorkProcess = true
	defer func() {
		s.stepConn, s.stepKind = nil, ReadStep
		s.HoldsWorkProcess = false
	}()
	if y, ok := c.(interface{ Yield(time.Duration) }); ok {
		s.Yield = func(d time.Duration) {
			// a WAIT ends the LUW, as on a system; the work process goes
			// back for the sleep and another is lent on return
			s.pooledEnd(true)
			s.Sy.Subrc = 0
			y.Yield(d)
			s.pooledBegin()
		}
		defer func() { s.Yield = nil }()
	}
	s.pooledBegin()
	ok := false
	defer func() {
		if ok {
			return
		}
		// the dump is what gets reported: a rollback that fails too must
		// not replace it
		dump := recover()
		func() {
			defer func() { recover() }()
			s.pooledEnd(false)
		}()
		if dump != nil { // nil: runtime.Goexit, which goes on by itself
			panic(dump)
		}
	}()
	work()
	ok = true
	s.pooledEnd(true)
}

// pooledBegin opens the step's transaction on the lent connection with the
// kind's mode.
func (s *Session) pooledBegin() {
	c := s.stepConn
	if c == nil {
		panic(NotCompiled("dialog step", "no connection is lent to this step"))
	}
	begin := "BEGIN" // deferred: a read step takes no lock until it writes, and it cannot write
	if s.stepKind == WriteStep {
		begin = "BEGIN IMMEDIATE"
	}
	if _, err := c.Exec(begin); err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	s.stepOpen = true
}

// pooledEnd ends it; a step whose transaction a WAIT or a COMMIT WORK
// already ended, or whose connection the fence broke, has nothing to end,
// and the error that broke it is the step's own to report. A COMMIT that
// fails leaves the transaction open on the connection, so the rollback
// after it is best-effort: the step dumps either way, and the work process
// lends a clean connection to the next step or one whose next BEGIN fails
// loudly -- never one with a half-ended transaction nobody knows about.
func (s *Session) pooledEnd(commit bool) {
	if !s.stepOpen {
		return
	}
	s.stepOpen = false
	end := "ROLLBACK"
	if commit {
		end = "COMMIT"
	}
	if _, err := s.stepConn.Exec(end); err != nil {
		if commit {
			func() {
				defer func() { recover() }()
				_, _ = s.stepConn.Exec("ROLLBACK")
			}()
		}
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
}

// InWriteStep says the session runs a modifying step on a lent connection:
// its connection holds SQLite's one write lock from BEGIN IMMEDIATE to the
// step's end, so nothing the step waits for may write on another
// connection of the file -- it would wait for this step's own lock.
func (s *Session) InWriteStep() bool {
	return s.stepConn != nil && s.stepKind == WriteStep
}
