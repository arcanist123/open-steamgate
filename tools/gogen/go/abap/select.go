package abap

import (
	"database/sql"
	"strings"
)

// Mandt is the logon client, the transpiler runtime's constant (ANORMALIES:
// sy-mandt = 123), so both hosts read the same rows.
const Mandt = "123"

// DBString and DBInt are what a column is scanned into.
type (
	DBString = sql.NullString
	DBInt    = sql.NullInt64
)

// Select runs a SELECT lowered at build time: the SQL and its arguments
// from the build, each range filled into its hostPred marker now
// (SpliceRanges), each row handed to row with a scan function. It returns
// the number of rows.
func Select(s *Session, text string, args []any, preds []HostPred, row func(scan func(dest ...any) error)) int {
	text, bound := SpliceRanges(text, args, preds)
	rows, err := s.conn().Query(text, bound...)
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	defer rows.Close()
	epoch, tracked := s.openCursor(rows)
	if tracked {
		defer s.dropCursor(rows)
	}
	n := 0
	for rows.Next() {
		row(rows.Scan)
		n++
		if tracked {
			s.cursorValid(epoch)
		}
	}
	if err := rows.Err(); err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	return n
}

// DBChar is a CHAR column read into ABAP: stored padded, carried without
// trailing blanks like every c here.
func DBChar(v DBString) string { return strings.TrimRight(v.String, " ") }

// DBStr is a STRING column: as stored.
func DBStr(v DBString) string { return v.String }

// DBI is an INT column.
func DBI(v DBInt) int32 { return int32(v.Int64) }

// Must turns a scan error into a database dump.
func Must(err error) {
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
}
