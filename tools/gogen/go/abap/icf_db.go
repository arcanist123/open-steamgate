package abap

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
)

// ScriptVersion is the mark a seeded file carries of the script that seeded
// it (PRAGMA user_version): 31 bits of the script's SHA-256, never 0, which
// is what a file nobody marked has.
func ScriptVersion(script []byte) int32 {
	sum := sha256.Sum256(script)
	v := int32(binary.BigEndian.Uint32(sum[:4]) & 0x7fffffff)
	if v == 0 {
		v = 1
	}
	return v
}

// OpenDBFile is OpenDB on an SQLite file in WAL mode, for a host that keeps
// its rows between runs (osgo --db). The script (tables, views, seed rows)
// runs once, in one transaction, when the file has no tables yet, and marks
// the file with ScriptVersion. A file that has tables is taken as it is only
// when it carries this script's mark: one seeded by another build (other
// tables, other seed rows) or by nobody is refused, since its differences
// would show up only later, as SQL errors inside a dialog step.
func OpenDBFile(path string, script []byte) (db *Database, seeded bool, err error) {
	var stmts []string
	if err := json.Unmarshal(script, &stmts); err != nil {
		return nil, false, err
	}
	if _, err := os.Stat(path); err != nil && !os.IsNotExist(err) {
		return nil, false, err
	}
	d, err := openSQL("file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, false, err
	}
	db = newDatabase(d)
	var tables int
	if err := d.QueryRow("SELECT count(*) FROM sqlite_master").Scan(&tables); err != nil {
		d.Close()
		return nil, false, err
	}
	want := ScriptVersion(script)
	if tables > 0 {
		var have int32
		if err := d.QueryRow("PRAGMA user_version").Scan(&have); err != nil {
			d.Close()
			return nil, false, err
		}
		if have != want {
			d.Close()
			if have == 0 {
				return nil, false, fmt.Errorf("-db %s has tables but no mark of the build that seeded it (this build: %08x); remove the file or name a new one", path, want)
			}
			return nil, false, fmt.Errorf("-db %s was seeded by another build (its mark %08x, this build %08x): the tables or seed rows differ; remove the file or name a new one", path, have, want)
		}
	}
	if tables == 0 {
		tx, err := d.Begin()
		if err != nil {
			d.Close()
			return nil, false, err
		}
		for i, st := range stmts {
			if _, err := tx.Exec(st); err != nil {
				tx.Rollback()
				d.Close()
				return nil, false, fmt.Errorf("statement %d: %w: %.200s", i, err, st)
			}
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", want)); err != nil {
			tx.Rollback()
			d.Close()
			return nil, false, err
		}
		if err := tx.Commit(); err != nil {
			d.Close()
			return nil, false, err
		}
		seeded = true
	}
	// the store as the in-memory one keeps it (dbstore.go): LIKE
	// case-sensitive on this connection, CHAR right-trimmed (idempotent, so a
	// file seeded before is brought to the same state)
	if err := prepareStore(d); err != nil {
		d.Close()
		return nil, false, err
	}
	return db, seeded, nil
}
