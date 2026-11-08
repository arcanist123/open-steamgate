//go:build !wasm && !nodatabase

package adtpreview

import (
	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
)

// oneStatement proves with SQLite's own tokenizer (sqlite3_complete) that
// the text holds a single statement: no ';' inside it ends one. The driver
// runs every statement of a text, so this is what keeps a guard that lexes
// differently from SQLite from ever running a second one.
func oneStatement(sql string) error {
	tls := libc.NewTLS()
	defer tls.Close()
	for i := 0; i < len(sql); i++ {
		if sql[i] != ';' {
			continue
		}
		z, err := libc.CString(sql[:i+1])
		if err != nil {
			return err
		}
		complete := sqlite3.Xsqlite3_complete(tls, z)
		libc.Xfree(tls, z)
		if complete != 0 {
			return notAllowed("a second statement")
		}
	}
	return nil
}
