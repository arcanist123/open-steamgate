package abap

import (
	"errors"
	"fmt"
	"strings"
)

// INSERT / UPDATE / MODIFY / DELETE on a database table (the front end's
// dbWriteStatement). A statement whose SQL is known at build time (UPDATE
// SET ... WHERE, DELETE FROM ... WHERE) comes lowered by lower() and runs
// through ExecWrite; one whose rows are a work area or an internal table
// comes as a WriteSpec and its rows, and is rendered here by the port of
// the write lowering (irsql.go, checked against writes.json).
//
// sy-subrc and sy-dbcnt as measured on A4H (ZCL_GOGEN_T_DBW, 2026-09-23,
// ANORMALIES dbwrite-*):
//   INSERT FROM wa               0/1, a duplicate key 4/0 and nothing written
//   INSERT FROM TABLE            0/n; with a duplicate every other row written
//                                and CX_SY_OPEN_SQL_DB, sy untouched; an
//                                empty table 0/0
//   ... ACCEPTING DUPLICATE KEYS 4 and the rows written when one was skipped
//   UPDATE / DELETE FROM wa, FROM TABLE   by the primary key, row by row, the
//                                counts summed; 4 when a row was missing
//   MODIFY FROM wa, FROM TABLE   0 and the rows written, row by row
//   UPDATE SET, DELETE WHERE     0 and the rows, 4/0 when none

// WriteCol is a column of the table: its name and the IR type it binds as.
type WriteCol struct {
	Name string
	Type *IRType
}

// WriteSpec is the table a row-wise write goes to: its columns in order and
// its primary key.
type WriteSpec struct {
	Table string
	Cols  []WriteCol
	Key   []string
}

// DBC is a c value bound as its column binds it: right-trimmed.
func DBC(s string) string { return strings.TrimRight(s, " ") }

// DBCFit is a character host value (a string, or a c longer than the
// column) compared with or written into a CHAR column of n characters:
// right-trimmed when it fits. One that does not fit is refused here rather
// than cut: A4H raises CX_SY_OPEN_SQL_DATA_ERROR for such a range LOW, the
// plain comparison and the SET are not measured, and a cut value can match
// (or overwrite) a row A4H would not touch.
func DBCFit(s string, n int) string {
	t := strings.TrimRight(s, " ")
	if jsLen(t) > n {
		panic(NotCompiled("Open SQL host value", fmt.Sprintf("%q is longer than the column's %d characters (CX_SY_OPEN_SQL_DATA_ERROR for a range on A4H; a plain comparison or SET is not measured)", t, n)))
	}
	return t
}

// bindValue is ir-writes.mjs' bindValue for a value the work area holds.
func bindValue(v any, t *IRType, where string) *IR {
	switch t.Abap {
	case "I", "INT8":
		switch n := v.(type) {
		case int32:
			return Lit(int64(n), t)
		case int64:
			return Lit(n, t)
		case int:
			return Lit(int64(n), t)
		}
	case "C":
		if s, ok := v.(string); ok {
			s = DBC(s)
			if t.Len > 0 && jsLen(s) > t.Len {
				panic(NotCompiled(where, fmt.Sprintf("value %q is longer than the column's %d", s, t.Len)))
			}
			return Lit(s, t)
		}
	case "STRING":
		if s, ok := v.(string); ok {
			return Lit(s, t)
		}
	// a RAW(n) column: the work area's x as n bytes of upper-case hex; a
	// RAWSTRING: the xstring's hex (dbraw.go). ir-writes.mjs has no byte
	// type in bindValue yet (ultra/zvdb report)
	case "X":
		if s, ok := v.(string); ok {
			return Lit(DBXHex(s, t.Len), t)
		}
	case "XSTRING":
		if s, ok := v.(string); ok {
			return Lit(DBXString(s), t)
		}
	case "P":
		// a p field holds its decimal text (packed.go); bound as that text,
		// as ir-writes.mjs packedText binds it, and the DEC column's
		// affinity makes it a number (ultra/demodata)
		if s, ok := v.(string); ok {
			return Lit(FmtP(s, t.Dec), t)
		}
	}
	panic(NotCompiled(where, fmt.Sprintf("a %T for a column of type %s", v, t.seam())))
}

func (w WriteSpec) row(values []any) []*IR {
	if len(values) != len(w.Cols) {
		panic(NotCompiled(w.Table, "a row does not have one value per column"))
	}
	out := make([]*IR, len(values))
	for i, v := range values {
		out[i] = bindValue(v, w.Cols[i].Type, w.Table+"-"+w.Cols[i].Name)
	}
	return out
}

func (w WriteSpec) isKey(name string) bool {
	for _, k := range w.Key {
		if k == name {
			return true
		}
	}
	return false
}

// keyPred is the primary key of a row as a condition.
func (w WriteSpec) keyPred(row []*IR) *IR {
	var pred *IR
	for i, c := range w.Cols {
		if !w.isKey(c.Name) {
			continue
		}
		eq := Bin("=", Col(c.Name, c.Type), row[i], TBool)
		if pred == nil {
			pred = eq
		} else {
			pred = Bin("AND", pred, eq, TBool)
		}
	}
	return pred
}

func (w WriteSpec) names() []string {
	out := make([]string, len(w.Cols))
	for i, c := range w.Cols {
		out[i] = c.Name
	}
	return out
}

// exec renders a write and runs it in the step's transaction, answering the
// rows it touched; dup says the engine refused a duplicate key.
func exec(s *Session, st *IRWrite) (n int64, dup bool) {
	text, params, err := LowerWrite(st)
	if err != nil {
		panic(NotCompiled(st.Table, err.Error()))
	}
	res, err := s.conn().Exec(text, values(params)...)
	if err != nil {
		if duplicateKey(err) {
			return 0, true
		}
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	n, err = res.RowsAffected()
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	return n, false
}

// duplicateKey: SQLITE_CONSTRAINT_PRIMARYKEY or _UNIQUE, and nothing else
// (a NOT NULL is a database error, not a duplicate)
func duplicateKey(err error) bool {
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		return coded.Code() == 1555 || coded.Code() == 2067
	}
	return false
}

// the rows of one INSERT statement: a big table goes in parts, the counts
// summed (ON CONFLICT DO NOTHING is per row, so parts answer what one
// statement would). A part is sized by its parameters, not its rows, which
// keeps it under SQLite's parameter limit at any width. It was also what
// kept modernc.org/sqlite's bind linear: before v1.60.1 it scanned the
// arguments for every parameter (modernc-org/sqlite#8), and 500 rows of 15
// columns cost 28 million comparisons. Parts of the same size share one
// cached prepared statement.
const insertParams = 256

func insertChunk(columns int) int {
	return max(1, insertParams/max(1, columns))
}

// InsertRows is INSERT dbtab FROM wa (onDuplicate "error", one row),
// FROM TABLE ("raise") and FROM TABLE ... ACCEPTING DUPLICATE KEYS ("ignore").
func InsertRows(s *Session, w WriteSpec, rows [][]any, onDuplicate string) {
	if len(rows) == 0 {
		s.Sy.Subrc, s.Sy.Dbcnt = 0, 0
		return
	}
	if onDuplicate == "error" {
		if len(rows) != 1 {
			panic(NotCompiled("INSERT "+w.Table, "a work area is one row"))
		}
		n, dup := exec(s, &IRWrite{Write: "insert", Table: w.Table, Columns: w.names(), Rows: [][]*IR{w.row(rows[0])}, OnDuplicate: "error"})
		if dup {
			s.Sy.Subrc, s.Sy.Dbcnt = 4, 0
			return
		}
		s.Sy.Subrc, s.Sy.Dbcnt = 0, int32(n)
		return
	}
	var written int64
	chunk := insertChunk(len(w.Cols))
	for at := 0; at < len(rows); at += chunk {
		part := rows[at:min(at+chunk, len(rows))]
		bound := make([][]*IR, len(part))
		for i, r := range part {
			bound[i] = w.row(r)
		}
		st := &IRWrite{Write: "insert", Table: w.Table, Columns: w.names(), Rows: bound, OnDuplicate: onDuplicate}
		if onDuplicate == "raise" {
			st.Expected = len(bound)
		}
		n, dup := exec(s, st)
		if dup {
			panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: "INSERT " + w.Table + ": a duplicate key although duplicates are skipped"})
		}
		written += n
	}
	if written < int64(len(rows)) {
		if onDuplicate == "raise" {
			// every other row is written, sy is left as it was (A4H)
			panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: fmt.Sprintf("INSERT %s FROM TABLE: %d of %d rows have a key that exists", w.Table, int64(len(rows))-written, len(rows))})
		}
		s.Sy.Subrc = 4
	} else {
		s.Sy.Subrc = 0
	}
	s.Sy.Dbcnt = int32(written)
}

// rowByRow runs one statement per row and sets sy: the rows touched summed,
// sy-subrc 4 when one row touched none (missing4) or 0.
func rowByRow(s *Session, rows [][]any, missing4 bool, one func(row []any) int64) {
	var total int64
	missing := false
	for _, r := range rows {
		n := one(r)
		if n == 0 {
			missing = true
		}
		total += n
	}
	s.Sy.Subrc = 0
	if missing && missing4 {
		s.Sy.Subrc = 4
	}
	s.Sy.Dbcnt = int32(total)
}

// UpdateRows is UPDATE dbtab FROM wa / FROM TABLE: every non-key column set,
// the row found by its primary key.
func UpdateRows(s *Session, w WriteSpec, rows [][]any) {
	rowByRow(s, rows, true, func(values []any) int64 {
		row := w.row(values)
		var set []IRSet
		for i, c := range w.Cols {
			if !w.isKey(c.Name) {
				set = append(set, IRSet{Col: c.Name, Expr: row[i]})
			}
		}
		if len(set) == 0 {
			panic(NotCompiled("UPDATE "+w.Table, "every column is a key column"))
		}
		n, _ := exec(s, &IRWrite{Write: "update", Table: w.Table, Set: set, Pred: w.keyPred(row)})
		return n
	})
}

// DeleteRows is DELETE dbtab FROM wa / FROM TABLE: by the primary key only.
func DeleteRows(s *Session, w WriteSpec, rows [][]any) {
	rowByRow(s, rows, true, func(values []any) int64 {
		n, _ := exec(s, &IRWrite{Write: "delete", Table: w.Table, Pred: w.keyPred(w.row(values))})
		return n
	})
}

// ModifyRows is MODIFY dbtab FROM wa / FROM TABLE: each row inserted, or the
// row of its key updated, one after the other as ABAP writes them.
func ModifyRows(s *Session, w WriteSpec, rows [][]any) {
	rowByRow(s, rows, false, func(values []any) int64 {
		n, _ := exec(s, &IRWrite{Write: "upsert", Table: w.Table, Columns: w.names(), Rows: [][]*IR{w.row(values)}, Key: w.Key})
		return n
	})
}

// ExecWrite runs an UPDATE SET / DELETE WHERE lowered at build time, its
// ranges filled now: sy-subrc 0 with rows, 4 without, sy-dbcnt the rows.
func ExecWrite(s *Session, text string, args []any, preds []HostPred) {
	text, bound := SpliceRanges(text, args, preds)
	res, err := s.conn().Exec(text, bound...)
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	n, err := res.RowsAffected()
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	s.Sy.Subrc = 0
	if n == 0 {
		s.Sy.Subrc = 4
	}
	s.Sy.Dbcnt = int32(n)
}
