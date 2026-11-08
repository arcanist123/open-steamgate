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
// Measured on A4H (2026-09-23): COMMIT WORK, COMMIT WORK AND WAIT and
// ROLLBACK WORK set sy-subrc to 0 and leave sy-dbcnt as it was; ROLLBACK
// WORK undoes what the LUW wrote, a COMMIT WORK before it keeps its rows.
// Neither PERFORM ... ON COMMIT nor CALL FUNCTION ... IN UPDATE TASK
// compiles in this subset, so there is nothing else for a COMMIT to run.

var tx *sql.Tx

// querier is what a statement runs on: the step's transaction when one is
// open, the database otherwise (a host that runs no step, or a tool).
type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	Exec(query string, args ...any) (sql.Result, error)
}

func conn() querier {
	return cachedQuerier{}
}

// StepQuerier is the calling step's transaction, or the database (adtpreview).
func StepQuerier() any { return plainConn() }

func plainConn() querier {
	// DB may lazily open the Unit class's image and its transaction.
	DB()
	if tx != nil {
		return tx
	}
	return DB()
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
const stmtCacheMax = 4096

var (
	stmtCache   = map[string]*sql.Stmt{}
	stmtSeen    = map[string]int{}
	stmtPending []string
	txStmts     = map[string]*sql.Stmt{}
	// the database the cache belongs to: another one (OpenDB again) starts
	// it empty
	stmtDB *sql.DB
)

func stmtCacheFor(d *sql.DB) {
	if stmtDB == d {
		return
	}
	for _, p := range stmtCache {
		p.Close()
	}
	clear(stmtCache)
	clear(stmtSeen)
	clear(txStmts)
	stmtPending = stmtPending[:0]
	stmtDB = d
}

type cachedQuerier struct{}

func (cachedQuerier) Query(q string, args ...any) (*sql.Rows, error) {
	if st := stmtFor(q); st != nil {
		return st.Query(args...)
	}
	return plainConn().Query(q, args...)
}

func (cachedQuerier) Exec(q string, args ...any) (sql.Result, error) {
	if st := stmtFor(q); st != nil {
		return st.Exec(args...)
	}
	return plainConn().Exec(q, args...)
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

func stmtFor(q string) *sql.Stmt {
	if db == nil {
		return nil
	}
	stmtCacheFor(db)
	if p, ok := stmtCache[q]; ok {
		if tx == nil {
			return p
		}
		if st, ok := txStmts[q]; ok {
			return st
		}
		st := tx.Stmt(p)
		txStmts[q] = st
		return st
	}
	if len(stmtCache)+len(stmtPending) >= stmtCacheMax || !cacheable(q) {
		return nil
	}
	if len(stmtSeen) > 4*stmtCacheMax {
		clear(stmtSeen)
	}
	stmtSeen[q]++
	if stmtSeen[q] == 2 {
		stmtPending = append(stmtPending, q)
	}
	return nil
}

// prepareSeen prepares what the step that just ended ran twice, on the
// connection its transaction gave back; a text that does not prepare stays
// uncached
func prepareSeen() {
	clear(txStmts)
	if tx != nil || db == nil {
		return
	}
	stmtCacheFor(db)
	for _, q := range stmtPending {
		if p, err := db.Prepare(q); err == nil {
			stmtCache[q] = p
		}
		delete(stmtSeen, q)
	}
	stmtPending = stmtPending[:0]
}

func begin() {
	if db == nil {
		return
	}
	// one connection in the pool (db.go): a second Begin would wait for the
	// first forever rather than fail
	if tx != nil {
		panic(NotCompiled("dialog step", "a dialog step is already open"))
	}
	t, err := db.Begin()
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	tx = t
}

func end(commit bool) {
	if tx == nil {
		return
	}
	t := tx
	tx = nil
	var err error
	if commit {
		err = t.Commit()
	} else {
		err = t.Rollback()
	}
	prepareSeen()
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
}

// DialogStep runs one step of work in a database LUW of its own: committed
// when work returns, rolled back when it panics (the panic goes on).
func DialogStep(work func()) {
	begin()
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
			end(false)
		}()
		if dump != nil { // nil: runtime.Goexit, which goes on by itself
			panic(dump)
		}
	}()
	work()
	ok = true
	end(true)
}

// DialogStepIn runs work for a known Session while marking that its host owns
// WorkProcess. The host has already taken the mutex; this only records that
// ownership so an in-step yield can give the work process up selectively.
func DialogStepIn(s *Session, work func()) {
	if s == nil {
		DialogStep(work)
		return
	}
	s.HoldsWorkProcess = true
	defer func() { s.HoldsWorkProcess = false }()
	DialogStep(work)
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
	end(true)
	s.Sy.Subrc = 0
	s.HoldsWorkProcess = false
	WorkProcess.Unlock()
	time.Sleep(d)
	WorkProcess.Lock()
	s.HoldsWorkProcess = true
	begin()
}

// BeginUnitLUW opens the LUW a unit run works in, which is how the Node
// unit run behaves: its SQLite client opens a transaction and only COMMIT
// WORK or ROLLBACK WORK ends it (the next begins with the next write), with
// nothing committed or rolled back between test methods. So a ROLLBACK
// undoes back to the last COMMIT, as there. The unit runner calls it after
// each OpenDB; a transaction left on the database OpenDB replaced is
// rolled back first.
func BeginUnitLUW() {
	if tx != nil {
		end(false)
	}
	begin()
}

// CommitWork is COMMIT WORK [AND WAIT]. Outside a dialog step it has
// nothing to do: autocommit already made every write durable.
func CommitWork(s *Session) {
	if tx != nil {
		end(true)
		begin()
	}
	s.Sy.Subrc = 0
}

// RollbackWork is ROLLBACK WORK. With a database open and no dialog step
// running every statement ran in autocommit, so there is nothing a rollback
// could undo: refused rather than answered 0 as if it had undone it. Without
// a database (a harness that runs no SQL) there is nothing written either.
func RollbackWork(s *Session) {
	if tx == nil && db != nil {
		panic(NotCompiled("ROLLBACK WORK", "outside a dialog step, where every statement already committed"))
	}
	if tx != nil {
		end(false)
		begin()
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
