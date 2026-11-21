package abap

import (
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

// The store as HANA keeps it, which is what the relational IR's renderings
// assume (tools/ir-ranges.mjs, tools/ir-writes.mjs):
//   - LIKE is case-sensitive (SQLite's is not for ASCII unless the
//     connection says so; the connection is kept for the process, db.go);
//   - a CHAR column holds its value right-trimmed. The seed pads CHAR to its
//     DDIC length (test/seed.mjs, for the transpiler's runtime), and a CP
//     pattern without a trailing * does not match a padded value through
//     LIKE, where it does on A4H. The columns COLLATE RTRIM compare equal
//     either way; the trim is for LIKE, and for writes, which bind CHAR
//     right-trimmed.
var charColumn = regexp.MustCompile(`'([^']+)' NCHAR\(\d+\) COLLATE RTRIM`)

// connectionPragmas is the part of prepareStore that writes nothing: a
// read-only candidate (OpenDBCandidate) takes only this.
func connectionPragmas(d *sql.DB) error {
	_, err := d.Exec(`PRAGMA case_sensitive_like = ON`)
	return err
}

func prepareStore(d *sql.DB) error {
	if err := connectionPragmas(d); err != nil {
		return err
	}
	rows, err := d.Query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`)
	if err != nil {
		return err
	}
	var updates []string
	existing := map[string]bool{}
	for rows.Next() {
		var name, text string
		if err := rows.Scan(&name, &text); err != nil {
			rows.Close()
			return err
		}
		existing[strings.ToUpper(name)] = true
		var set []string
		for _, m := range charColumn.FindAllStringSubmatch(text, -1) {
			set = append(set, fmt.Sprintf(`%s = rtrim(%s, ' ')`, quote(m[1]), quote(m[1])))
		}
		if len(set) > 0 {
			updates = append(updates, fmt.Sprintf(`UPDATE %s SET %s`, quote(name), strings.Join(set, ", ")))
		}
	}
	rows.Close()
	updates = append(updates, rawUpdates(existing)...)
	if len(updates) == 0 {
		return nil
	}
	// one transaction: an open that fails partway (a promotion whose
	// normalisation a lock the serving generation holds, or a trigger,
	// refuses) leaves nothing behind -- the file stays as the generation
	// that serves left it, not half-normalised by an open that never
	// finished. Every UPDATE is idempotent, so the next open redoes them.
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	for _, u := range updates {
		if _, err := tx.Exec(u); err != nil {
			tx.Rollback()
			return fmt.Errorf("%w: %s", err, u)
		}
	}
	return tx.Commit()
}

// rawUpdates: a RAW(n) column holds upper-case hex of exactly 2n digits
// (dbraw.go: the length HANA keeps, measured). The seed writes abapGit's
// hex unpadded, so the tables of the registry are brought to that form
// once, at open; a NULL (a row inserted without the column) becomes the
// initial value, n 00 bytes. Tables the registry does not know are left
// as they are, and so are the registry's structures (no table in the store).
func rawUpdates(existing map[string]bool) []string {
	var out []string
	for _, name := range TableNames() {
		t, _ := TableByName(name)
		if t == nil || t.View || !existing[strings.ToUpper(t.Name)] {
			continue
		}
		var set, where []string
		for _, c := range t.Columns {
			if c.Kind != 'X' || c.Len <= 0 {
				continue
			}
			q, zeros := quote(strings.ToLower(c.Name)), strings.Repeat("0", 2*c.Len)
			set = append(set, fmt.Sprintf(`%s = upper(substr(coalesce(%s, '') || '%s', 1, %d))`, q, q, zeros, 2*c.Len))
			where = append(where, fmt.Sprintf(`%s IS NULL OR length(%s) <> %d OR %s <> upper(%s)`, q, q, 2*c.Len, q, q))
		}
		if len(set) > 0 {
			out = append(out, fmt.Sprintf(`UPDATE %s SET %s WHERE %s`, quote(strings.ToLower(t.Name)), strings.Join(set, ", "), strings.Join(where, " OR ")))
		}
	}
	return out
}
