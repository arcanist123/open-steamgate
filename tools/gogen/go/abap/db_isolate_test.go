//go:build !nodatabase && !wasm

package abap

import "testing"

func TestIsolateDBKeepsTheServingDatabase(t *testing.T) {
	script := []byte(`["CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES ('a', 'seed')"]`)
	if err := OpenDB(script); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(CloseUnitDB)
	image, err := ScriptImage(script)
	if err != nil {
		t.Fatal(err)
	}
	value := func() string {
		t.Helper()
		rows, err := plainConn().Query(`SELECT v FROM t WHERE k = 'a'`)
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
	served := db
	begin() // the serving step's transaction
	if _, err := plainConn().Exec(`UPDATE t SET v = 'step' WHERE k = 'a'`); err != nil {
		t.Fatal(err)
	}
	stepTx := tx
	restore, err := IsolateDB(image)
	if err != nil {
		t.Fatal(err)
	}
	if db == served || tx == stepTx || value() != "seed" {
		t.Fatal("the test class does not run on its own copy")
	}
	if _, err := plainConn().Exec(`UPDATE t SET v = 'test' WHERE k = 'a'`); err != nil {
		t.Fatal(err)
	}
	CommitWork(&Session{})
	restore()
	if db != served || tx != stepTx || value() != "step" {
		t.Fatalf("the serving step was not restored: %q", value())
	}
	end(true)
	if value() != "step" {
		t.Fatal(value())
	}
}
