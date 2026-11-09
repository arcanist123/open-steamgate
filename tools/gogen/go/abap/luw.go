package abap

import (
	"database/sql"
	"strings"
	"time"

	"osg/gogen/hostclass"
)

// The database LUW of the kernel. A dialog step opens one database
// transaction; COMMIT WORK and ROLLBACK WORK end it and open the next; the
// step's end commits when the work ended normally and rolls back when it
// dumped. That last half is the kernel's job, not the application's: on a
// system an exception nobody caught is a short dump, and a dump ends the
// LUW, so a half-write never waits on the connection for the next step's
// COMMIT WORK to adopt it (docs/luw-buffer.md, tools/osd-dialog-step.mjs,
// which is the same rule for the three Node hosts). It lives here so that
// every Go host gets it by calling DialogStep rather than by copying it.
//
// The transaction is the Session's (ADR 0010 slice 2): a step runs in a
// Session, the Session holds the database it runs on (Session.DB) and the
// transaction of its open step (Session.tx), and a statement of generated
// code reaches both through the Session it was handed. Two Sessions never
// share a transaction; whether they share a database is the host's
// choice. With the one connection a Database has today, a step of another
// Session on the same database while one is open is refused at begin, so
// hosts serialise their steps (WorkProcess) as before.
//
// Measured on A4H (2026-09-23): COMMIT WORK, COMMIT WORK AND WAIT and
// ROLLBACK WORK set sy-subrc to 0 and leave sy-dbcnt as it was; ROLLBACK
// WORK undoes what the LUW wrote, a COMMIT WORK before it keeps its rows.
// Neither PERFORM ... ON COMMIT nor CALL FUNCTION ... IN UPDATE TASK
// compiles in this subset, so there is nothing else for a COMMIT to run.

// querier is what a statement runs on: the step's transaction when one is
// open, the database otherwise (a host that runs no step, or a tool).
type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	Exec(query string, args ...any) (sql.Result, error)
}

func (s *Session) conn() querier {
	return cachedQuerier{s}
}

// StepQuerier is the calling step's transaction, or the database (adtpreview).
func (s *Session) StepQuerier() any { return s.plainConn() }

func (s *Session) plainConn() querier {
	// database may lazily open the Unit class's image and its transaction.
	d := s.database()
	if s.tx != nil {
		return s.tx
	}
	d.usable(s)
	return d.sql
}

// usable refuses, by name, a statement outside a step that the pool could
// only queue forever or that would reach a closed pool: the one connection
// (db.go) held by another session's step is refused, not queued, as begin
// refuses a second step.
func (d *Database) usable(s *Session) {
	if d.sql == nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: "database is closed"})
	}
	if d.inStep != nil && d.inStep != s {
		panic(NotCompiled("database", "a dialog step of another session holds this database's one connection"))
	}
}

// The statement cache (parity-wave2). SQLite parsed every statement again:
// a quarter of an ImportSet was sqlite3_prepare. A text run at least twice
// in a step is prepared on the database once that step has ended (the pool
// has one connection, which the step's transaction holds while it runs),
// and later steps run it through tx.Stmt, which database/sql keeps prepared
// on that same connection. Only one SELECT / INSERT / UPDATE / DELETE
// without a ';' is cached (a prepare takes the first statement of a text
// only), at most stmtCacheMax of them; the answers are the statement's
// either way, and SQLite prepares again by itself when the schema changed.
// The prepared statements belong to the Database (they are its
// connection's); the transaction-bound copies belong to the step.
const stmtCacheMax = 4096

type cachedQuerier struct{ s *Session }

func (c cachedQuerier) Query(q string, args ...any) (*sql.Rows, error) {
	if st := c.s.stmtFor(q); st != nil {
		return st.Query(args...)
	}
	return c.s.plainConn().Query(q, args...)
}

func (c cachedQuerier) Exec(q string, args ...any) (sql.Result, error) {
	if st := c.s.stmtFor(q); st != nil {
		return st.Exec(args...)
	}
	return c.s.plainConn().Exec(q, args...)
}

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

func (s *Session) stmtFor(q string) *sql.Stmt {
	d := s.DB
	// outside a step while another session's step holds the connection,
	// the pool would queue: plainConn refuses it instead
	if d == nil || d.sql == nil || (s.tx == nil && d.inStep != nil) {
		return nil
	}
	if p, ok := d.stmtCache[q]; ok {
		if s.tx == nil {
			return p
		}
		if st, ok := s.txStmts[q]; ok {
			return st
		}
		st := s.tx.Stmt(p)
		if s.txStmts == nil {
			s.txStmts = map[string]*sql.Stmt{}
		}
		s.txStmts[q] = st
		return st
	}
	if len(d.stmtCache)+len(d.stmtPending) >= stmtCacheMax || !cacheable(q) {
		return nil
	}
	if len(d.stmtSeen) > 4*stmtCacheMax {
		clear(d.stmtSeen)
	}
	d.stmtSeen[q]++
	if d.stmtSeen[q] == 2 {
		d.stmtPending = append(d.stmtPending, q)
	}
	return nil
}

// prepareSeen prepares what the step that just ended ran twice, on the
// connection its transaction gave back; a text that does not prepare stays
// uncached
func (d *Database) prepareSeen() {
	if d.inStep != nil || d.sql == nil {
		return
	}
	for _, q := range d.stmtPending {
		if p, err := d.sql.Prepare(q); err == nil {
			d.stmtCache[q] = p
		}
		delete(d.stmtSeen, q)
	}
	d.stmtPending = d.stmtPending[:0]
}

func (s *Session) begin() {
	d := s.DB
	if d == nil {
		return
	}
	if d.sql == nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: "database is closed"})
	}
	// one connection in the pool (db.go): a second Begin would wait for the
	// first forever rather than fail
	if s.tx != nil {
		panic(NotCompiled("dialog step", "a dialog step is already open"))
	}
	if d.inStep != nil {
		panic(NotCompiled("dialog step", "a dialog step of another session is open on this database"))
	}
	t, err := d.sql.Begin()
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	s.tx = t
	d.inStep = s
}

func (s *Session) end(commit bool) {
	if s.tx == nil {
		return
	}
	t := s.tx
	s.tx = nil
	clear(s.txStmts)
	var err error
	if commit {
		err = t.Commit()
	} else {
		err = t.Rollback()
	}
	if d := s.DB; d != nil {
		if d.inStep == s {
			d.inStep = nil
		}
		d.prepareSeen()
	}
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
}

// InStep says whether the session's dialog step is open (its transaction).
func (s *Session) InStep() bool { return s.tx != nil }

// DialogStep runs one step of work of the session in a database LUW of its
// own: committed when work returns, rolled back when it panics (the panic
// goes on).
func DialogStep(s *Session, work func()) {
	s.begin()
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
			s.end(false)
		}()
		if dump != nil { // nil: runtime.Goexit, which goes on by itself
			panic(dump)
		}
	}()
	work()
	ok = true
	s.end(true)
}

// DialogStepIn runs work for a Session while marking that its host owns
// WorkProcess. The host has already taken the mutex; this only records that
// ownership so an in-step yield can give the work process up selectively.
func DialogStepIn(s *Session, work func()) {
	s.HoldsWorkProcess = true
	defer func() { s.HoldsWorkProcess = false }()
	DialogStep(s, work)
}

func (s *Session) YieldSleep(d time.Duration) {
	if s == nil {
		time.Sleep(d)
		return
	}
	if !s.HoldsWorkProcess {
		CommitWork(s)
		time.Sleep(d)
		return
	}
	// End the database step before handing the work process to another
	// session. COMMIT WORK alone immediately opens another transaction.
	s.end(true)
	s.Sy.Subrc = 0
	s.HoldsWorkProcess = false
	WorkProcess.Unlock()
	time.Sleep(d)
	WorkProcess.Lock()
	s.HoldsWorkProcess = true
	s.begin()
}

// BeginUnitLUW opens the LUW a unit run works in, which is how the Node
// unit run behaves: its SQLite client opens a transaction and only COMMIT
// WORK or ROLLBACK WORK ends it (the next begins with the next write), with
// nothing committed or rolled back between test methods. So a ROLLBACK
// undoes back to the last COMMIT, as there. The unit runner calls it after
// each OpenUnitDB; a transaction the session still had is rolled back
// first.
func BeginUnitLUW(s *Session) {
	if s.tx != nil {
		s.end(false)
	}
	s.begin()
}

// CommitWork is COMMIT WORK [AND WAIT]. Outside a dialog step it has
// nothing to do: autocommit already made every write durable.
func CommitWork(s *Session) {
	if s.tx != nil {
		s.end(true)
		s.begin()
	}
	s.Sy.Subrc = 0
}

// RollbackWork is ROLLBACK WORK. With a database open and no dialog step
// running every statement ran in autocommit, so there is nothing a rollback
// could undo: refused rather than answered 0 as if it had undone it. Without
// a database (a harness that runs no SQL) there is nothing written either.
func RollbackWork(s *Session) {
	if s.tx == nil && s.DB != nil {
		panic(NotCompiled("ROLLBACK WORK", "outside a dialog step, where every statement already committed"))
	}
	if s.tx != nil {
		s.end(false)
		s.begin()
	}
	s.Sy.Subrc = 0
}

// GeneratedCommitWork is only for an explicit generated COMMIT WORK.
// YieldSleep and dialog-step completion use the database functions directly.
func GeneratedCommitWork(s *Session) {
	CommitWork(s)
	updated := s.UpdateTask
	s.UpdateTask = false
	if hook := hostclass.LUW.Commit; hook != nil {
		if err := hook(s, updated); err != nil {
			panic(err)
		}
	}
}

// GeneratedRollbackWork notifies the host after the database rollback.
func GeneratedRollbackWork(s *Session) {
	RollbackWork(s)
	s.UpdateTask = false
	if hook := hostclass.LUW.Rollback; hook != nil {
		if err := hook(s); err != nil {
			panic(err)
		}
	}
}
