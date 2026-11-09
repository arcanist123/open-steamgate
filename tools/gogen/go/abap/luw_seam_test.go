package abap

import (
	"errors"
	"testing"

	"osg/gogen/hostclass"
)

// The database commits before the host's lock hook runs (GeneratedCommitWork),
// and the order is load-bearing: the hook hands the LUW's locks over
// (adtlock.Host.Commit: Commit, then UpdateDone at once, the update being
// inline), and the gateway's lock server releases a dead sidecar's locks on
// the strength of it (go/enqnet, InlineUpdates). A crash before the commit
// leaves no rows; a crash after it leaves durable rows whose locks go after
// them. Turned round, a crash between the two would free the locks of rows
// not yet written. Do not loosen this test.
func TestGeneratedLUWDatabaseOrder(t *testing.T) {
	_, s := openTestDB(t, `["CREATE TABLE t (id TEXT)"]`)
	defer func() { hostclass.LUW.Commit = nil; hostclass.LUW.Rollback = nil }()
	rows := func() int {
		r, err := s.conn().Query("SELECT COUNT(*) FROM t")
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		r.Next()
		var n int
		if err := r.Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	DialogStep(s, func() {
		s.conn().Exec("INSERT INTO t VALUES ('A')")
		old := s.tx
		s.UpdateTask = true
		hostclass.LUW.Commit = func(step any, u bool) error {
			if step != any(s) || !u || s.UpdateTask || s.tx == old {
				t.Fatal("commit hook preceded database commit/reset")
			}
			RollbackWork(s)
			if rows() != 1 {
				t.Fatal("row was not committed before hook")
			}
			return nil
		}
		GeneratedCommitWork(s)
		s.conn().Exec("INSERT INTO t VALUES ('B')")
		old = s.tx
		s.UpdateTask = true
		hostclass.LUW.Rollback = func(step any) error {
			if step != any(s) || s.UpdateTask || s.tx == old || rows() != 1 {
				t.Fatal("rollback hook preceded database rollback/reset")
			}
			return nil
		}
		GeneratedRollbackWork(s)
	})
}

func TestGeneratedLUWStateAndErrors(t *testing.T) {
	defer func() { hostclass.LUW.Commit = nil; hostclass.LUW.Rollback = nil }()
	s := &Session{}
	boom := errors.New("host failed")
	for _, finish := range []func(*Session){GeneratedCommitWork, GeneratedRollbackWork} {
		s.UpdateTask = true
		finish(s)
		if s.UpdateTask {
			t.Fatal("nil hook left update state")
		}
		hostclass.LUW.Commit = func(any, bool) error { return boom }
		hostclass.LUW.Rollback = func(any) error { return boom }
		s.UpdateTask = true
		var dump any
		func() { defer func() { dump = recover() }(); finish(s) }()
		if dump != boom || s.UpdateTask {
			t.Fatalf("dump=%v state=%v", dump, s.UpdateTask)
		}
		hostclass.LUW.Commit = nil
		hostclass.LUW.Rollback = nil
	}
}
