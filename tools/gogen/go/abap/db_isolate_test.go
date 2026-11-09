//go:build !nodatabase && !wasm

package abap

import "testing"

// A test class run inside a serving step (cmd/osgo adt_unit.go) gets a
// session of its own on a copy of the seed image; the serving session's
// database and its open transaction are not touched by its writes, commits
// or rollbacks.
func TestUnitCopyKeepsTheServingDatabase(t *testing.T) {
	script := []byte(`["CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES ('a', 'seed')"]`)
	served, err := OpenDB(script)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { served.Close() })
	image, err := ScriptImage(script)
	if err != nil {
		t.Fatal(err)
	}
	value := func(s *Session) string {
		t.Helper()
		rows, err := s.plainConn().Query(`SELECT v FROM t WHERE k = 'a'`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var v string
		if rows.Next() {
			if err := rows.Scan(&v); err != nil {
				t.Fatal(err)
			}
		}
		return v
	}
	step := &Session{DB: served}
	DialogStep(step, func() {
		if _, err := step.plainConn().Exec(`UPDATE t SET v = 'step' WHERE k = 'a'`); err != nil {
			t.Fatal(err)
		}
		stepTx := step.tx
		unit := &Session{}
		if err := unit.OpenUnitDB(image); err != nil {
			t.Fatal(err)
		}
		if unit.DB == served || unit.tx == stepTx || value(unit) != "seed" {
			t.Fatal("the test class does not run on its own copy")
		}
		if _, err := unit.plainConn().Exec(`UPDATE t SET v = 'test' WHERE k = 'a'`); err != nil {
			t.Fatal(err)
		}
		CommitWork(unit)
		CloseUnitDB(unit)
		if step.tx != stepTx || value(step) != "step" {
			t.Fatalf("the serving step was disturbed: %q", value(step))
		}
	})
	if value(step) != "step" {
		t.Fatal(value(step))
	}
}
