// Package dbschema is the schema stamp of a database file (ADR 0010 slice
// 4, "The database across generations"): the fingerprint of the DDL a build
// describes, kept apart from the mark of the seed rows that went in, so a
// generation whose tables are the same opens a file another generation
// serves, whatever its seed says, and one whose tables differ is refused.
//
// The stamp is the Node host's table (tools/osd-persist.mjs: osd_schema with
// fingerprint and at) with a seed column added, and the fingerprint is
// computed the same way: the first 16 hex of the SHA-256 of the DDL
// statements joined by a newline.
//
// No import of osg/gogen/abap: it works on a *sql.DB of any SQLite file.
package dbschema

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Table is the stamp's table.
const Table = "osd_schema"

// IsDDL: a statement of the schema (a table, a view, an index), not a row.
func IsDDL(st string) bool {
	up := strings.ToUpper(strings.TrimSpace(st))
	for _, p := range []string{"CREATE ", "DROP ", "ALTER "} {
		if strings.HasPrefix(up, p) {
			return true
		}
	}
	return false
}

// Fingerprint of a script's DDL statements; seed rows do not count.
func Fingerprint(stmts []string) string {
	var ddl []string
	for _, st := range stmts {
		if IsDDL(st) {
			ddl = append(ddl, st)
		}
	}
	sum := sha256.Sum256([]byte(strings.Join(ddl, "\n")))
	return hex.EncodeToString(sum[:])[:16]
}

// Error: the file's tables are not the ones this build describes. A host
// refuses the file (a fresh -home, or a migration, is the way on); a
// candidate generation refuses the swap.
type Error struct {
	Path string
	Have string // the file's fingerprint; with Legacy its user_version mark
	Want string // this build's
	// Legacy: the file predates the stamp
	Legacy bool
}

func (e *Error) Error() string {
	switch {
	case e.Legacy && e.Have == "00000000":
		return fmt.Sprintf("-db %s has tables but no mark of the build that seeded it (this build's schema %s); remove the file or name a new one", e.Path, e.Want)
	case e.Legacy:
		return fmt.Sprintf("-db %s was seeded by another build before schema fingerprints (its mark %s): remove the file or name a new one", e.Path, e.Have)
	}
	return fmt.Sprintf("-db %s was seeded by another build: the tables differ (its schema %s, this build %s); remove the file or name a new one", e.Path, e.Have, e.Want)
}

// StampOf reads the file's fingerprint; ok is false when it has none.
func StampOf(d *sql.DB) (fingerprint string, ok bool, err error) {
	var n int
	if err := d.QueryRow("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?", Table).Scan(&n); err != nil || n == 0 {
		return "", false, err
	}
	err = d.QueryRow("SELECT fingerprint FROM " + Table + " LIMIT 1").Scan(&fingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return strings.TrimSpace(fingerprint), err == nil, err
}

// Execer is a *sql.DB or a *sql.Tx.
type Execer interface {
	Exec(string, ...any) (sql.Result, error)
}

// Stamp writes the one row: the fingerprint, now, and the seed's mark.
func Stamp(x Execer, fingerprint, seed string) error {
	if _, err := x.Exec("CREATE TABLE IF NOT EXISTS " + Table + " ('fingerprint' NCHAR(16), 'at' NCHAR(32), 'seed' NCHAR(16))"); err != nil {
		return err
	}
	if _, err := x.Exec("DELETE FROM " + Table); err != nil {
		return err
	}
	_, err := x.Exec("INSERT INTO "+Table+" ('fingerprint', 'at', 'seed') VALUES (?, ?, ?)", fingerprint, time.Now().UTC().Format(time.RFC3339), seed)
	return err
}

// Check compares a file that has tables with this build's script. A file
// from before the stamp carries only PRAGMA user_version; it is taken when
// that is the whole script's mark (then its tables are this build's too),
// and adopt says that it still needs a Stamp. Anything else is an *Error.
func Check(d *sql.DB, path string, stmts []string, scriptMark int32) (adopt bool, err error) {
	want := Fingerprint(stmts)
	have, ok, err := StampOf(d)
	if err != nil {
		return false, err
	}
	if ok {
		if have != want {
			return false, &Error{Path: path, Have: have, Want: want}
		}
		return false, nil
	}
	var mark int32
	if err := d.QueryRow("PRAGMA user_version").Scan(&mark); err != nil {
		return false, err
	}
	if mark != scriptMark {
		return false, &Error{Path: path, Have: fmt.Sprintf("%08x", mark), Want: want, Legacy: true}
	}
	return true, nil
}
