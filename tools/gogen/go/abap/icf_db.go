package abap

import (
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

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

// The stamp a file carries since ADR 0010 slice 4: the schema fingerprint
// (the DDL only) and, apart from it, which seed went in and when. The table
// is the Node host's (tools/osd-persist.mjs stamp: fingerprint, at), with
// the seed column added; the fingerprint is computed the same way.
const schemaStamp = "osd_schema"

// isDDL: a statement of the schema (a table, a view, an index), not a row
func isDDL(st string) bool {
	up := strings.ToUpper(strings.TrimSpace(st))
	for _, p := range []string{"CREATE ", "DROP ", "ALTER "} {
		if strings.HasPrefix(up, p) {
			return true
		}
	}
	return false
}

// SchemaFingerprint is the 16 hex of the SHA-256 of the script's DDL
// statements joined by a newline (osd-persist.mjs fingerprintOf). Seed rows
// do not count: a generation whose tables are the same opens the file
// whatever its seed says, and the seed runs only into an empty file.
func SchemaFingerprint(script []byte) (string, error) {
	var stmts []string
	if err := json.Unmarshal(script, &stmts); err != nil {
		return "", err
	}
	return fingerprintOf(stmts), nil
}

func fingerprintOf(stmts []string) string {
	var ddl []string
	for _, st := range stmts {
		if isDDL(st) {
			ddl = append(ddl, st)
		}
	}
	sum := sha256.Sum256([]byte(strings.Join(ddl, "\n")))
	return hex.EncodeToString(sum[:])[:16]
}

// SchemaError: the file's tables are not the ones this build describes. A
// host refuses the file (a restart with a fresh -home, or a migration, is
// the way on); a candidate generation refuses the swap.
type SchemaError struct {
	Path string
	Have string // the file's fingerprint; "" when it has none
	Want string // this build's
	// Legacy: the file predates the stamp; Have is then its user_version mark
	Legacy bool
}

func (e *SchemaError) Error() string {
	switch {
	case e.Legacy && e.Have == "00000000":
		return fmt.Sprintf("-db %s has tables but no mark of the build that seeded it (this build's schema %s); remove the file or name a new one", e.Path, e.Want)
	case e.Legacy:
		return fmt.Sprintf("-db %s was seeded by another build before schema fingerprints (its mark %s): remove the file or name a new one", e.Path, e.Have)
	}
	return fmt.Sprintf("-db %s was seeded by another build: the tables differ (its schema %s, this build %s); remove the file or name a new one", e.Path, e.Have, e.Want)
}

// stampOf reads the file's fingerprint; ok is false when it has no stamp
func stampOf(d *sql.DB) (fingerprint string, ok bool, err error) {
	var n int
	if err := d.QueryRow("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?", schemaStamp).Scan(&n); err != nil || n == 0 {
		return "", false, err
	}
	err = d.QueryRow("SELECT fingerprint FROM " + schemaStamp + " LIMIT 1").Scan(&fingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return strings.TrimSpace(fingerprint), err == nil, err
}

func stamp(x interface {
	Exec(string, ...any) (sql.Result, error)
}, fingerprint, seed string) error {
	if _, err := x.Exec("CREATE TABLE IF NOT EXISTS " + schemaStamp + " ('fingerprint' NCHAR(16), 'at' NCHAR(32), 'seed' NCHAR(16))"); err != nil {
		return err
	}
	if _, err := x.Exec("DELETE FROM " + schemaStamp); err != nil {
		return err
	}
	_, err := x.Exec("INSERT INTO "+schemaStamp+" ('fingerprint', 'at', 'seed') VALUES (?, ?, ?)", fingerprint, time.Now().UTC().Format(time.RFC3339), seed)
	return err
}

// checkSchema compares the file with this build. A file from before the
// stamp is taken when its user_version is this script's whole mark (then
// the tables are this build's too); adopt says that it still needs a stamp.
func checkSchema(d *sql.DB, path string, stmts []string, script []byte) (adopt bool, err error) {
	want := fingerprintOf(stmts)
	have, ok, err := stampOf(d)
	if err != nil {
		return false, err
	}
	if ok {
		if have != want {
			return false, &SchemaError{Path: path, Have: have, Want: want}
		}
		return false, nil
	}
	var mark int32
	if err := d.QueryRow("PRAGMA user_version").Scan(&mark); err != nil {
		return false, err
	}
	if mark != ScriptVersion(script) {
		return false, &SchemaError{Path: path, Have: fmt.Sprintf("%08x", mark), Want: want, Legacy: true}
	}
	return true, nil
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
		adopt, err := checkSchema(d, path, stmts, script)
		if err == nil && adopt {
			err = stamp(d, fingerprintOf(stmts), seed)
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
		if err := stamp(tx, fingerprintOf(stmts), seed); err != nil {
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
	if _, err := checkSchema(d, path, stmts, script); err != nil {
		d.Close()
		return nil, err
	}
	if err := connectionPragmas(d); err != nil {
		d.Close()
		return nil, err
	}
	return newDatabase(d), nil
}
