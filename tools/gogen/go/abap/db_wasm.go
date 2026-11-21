//go:build wasm

package abap

import (
	"database/sql"
	"errors"
)

// openSQL has no driver to open in a wasm build (js/wasm and wasip1/wasm):
// modernc.org/libc, under modernc.org/sqlite, has no wasm files. So OpenDB
// and OpenDBFile answer this error, and a statement then panics in Session.database with
// NOT_COMPILED "the host did not open a database": the code that needs no
// database runs, the code that does says so instead of answering nothing.
//
// The seam: a database/sql driver registered here (for example one that
// calls sql.js through syscall/js under GOOS=js, the database the browser
// preview already uses) and opened by name is all that is missing; nothing
// above openSQL knows which driver it got.
func openSQL(dsn string) (*sql.DB, error) {
	return nil, errors.New("no database in this build (wasm): no database/sql driver is registered for it")
}
