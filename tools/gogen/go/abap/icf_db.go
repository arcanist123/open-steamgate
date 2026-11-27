package abap

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"

	"osg/gogen/dbschema"
)

// SchemaError is dbschema's: the file's tables are not this build's.
type SchemaError = dbschema.Error

// SchemaFingerprint is dbschema.Fingerprint of a JSON script.
func SchemaFingerprint(script []byte) (string, error) {
	var stmts []string
	if err := json.Unmarshal(script, &stmts); err != nil {
		return "", err
	}
	return dbschema.Fingerprint(stmts), nil
}

// ScriptVersion is the mark of a whole script, tables and seed rows: 31 bits
// of its SHA-256, never 0. A file seeded before ADR 0010 slice 4 carries it
// in PRAGMA user_version and nothing else; since then it is the seed column
// of osd_schema (which seed went into the file), and what a file is checked
// against is SchemaFingerprint.
func ScriptVersion(script []byte) int32 {
	sum := sha256.Sum256(script)
	v := int32(binary.BigEndian.Uint32(sum[:4]) & 0x7fffffff)
	if v == 0 {
		v = 1
	}
	return v
}

// OpenDBFile is OpenDB on an SQLite file in WAL mode, for a host that keeps
// its rows between runs (osgo -db). The script (tables, views, seed rows)
// runs once, in one transaction, when the file has no tables yet, and the
// file is stamped (osd_schema) with the schema fingerprint of the script's
// DDL and the mark of the seed that went in. A file that has tables is taken
// as it is when its fingerprint is this build's: a build whose seed rows
// differ but whose tables are the same opens it and does not seed it again
// (ADR 0010 "The database across generations"). One whose tables differ,
// or a file nobody stamped, is refused with a *SchemaError, since its
// differences would show up only later, as SQL errors inside a dialog step.
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
	seed := fmt.Sprintf("%08x", ScriptVersion(script))
	if tables > 0 {
		adopt, err := dbschema.Check(d, path, stmts, ScriptVersion(script))
		if err == nil && adopt {
			err = dbschema.Stamp(d, dbschema.Fingerprint(stmts), seed)
		}
		if err != nil {
			d.Close()
			return nil, false, err
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
		if err := dbschema.Stamp(tx, dbschema.Fingerprint(stmts), seed); err != nil {
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

// OpenDBCandidate opens a file another generation serves, for a candidate
// generation before its promotion (ADR 0010 slice 4, step 3): read only
// (query_only on the connection, so a write inside a step fails and the
// step dumps), nothing seeded, nothing normalised, nothing stamped. The file
// must exist with tables and this build's schema fingerprint; anything else
// is a *SchemaError (or the open's own error) and the swap is refused. At
// promotion the host opens the file again with OpenDBFile, which does the
// writes a boot does, and drops this one.
func OpenDBCandidate(path string, script []byte) (*Database, error) {
	var stmts []string
	if err := json.Unmarshal(script, &stmts); err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("candidate: %w", err)
	}
	d, err := openSQL("file:" + path + "?_pragma=busy_timeout(5000)&_pragma=query_only(1)")
	if err != nil {
		return nil, err
	}
	var tables int
	if err := d.QueryRow("SELECT count(*) FROM sqlite_master").Scan(&tables); err != nil {
		d.Close()
		return nil, err
	}
	if tables == 0 {
		d.Close()
		return nil, fmt.Errorf("candidate: -db %s has no tables: a candidate never seeds", path)
	}
	if _, err := dbschema.Check(d, path, stmts, ScriptVersion(script)); err != nil {
		d.Close()
		return nil, err
	}
	if err := connectionPragmas(d); err != nil {
		d.Close()
		return nil, err
	}
	return newDatabase(d), nil
}
