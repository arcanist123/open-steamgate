package adtpreview

import (
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"

	"osg/gogen/objstore"
)

// Querier is the calling step's connection: its open transaction, or the
// database when none is open.
type Querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	Exec(query string, args ...any) (sql.Result, error)
	Prepare(query string) (*sql.Stmt, error)
}

// Provider answers SYSTEM SQL and SQLCHECK; every other kind is not its
// own (nil, nil), so it composes behind the request's other providers.
type Provider struct{ DB func() Querier }

type input struct {
	Statement *string `json:"statement"`
	Limit     string  `json:"limit"`
	Fallback  string  `json:"fallback"`
	Trim      bool    `json:"trim"`
}

// Column is one column of the preview, its cells rendered as text.
type Column struct {
	Name   string   `json:"name"`
	Upper  string   `json:"upper"`
	Letter string   `json:"letter"`
	Cells  []string `json:"cells"`
}

// Cells is the answer to SQL: the statement run, the row count, the columns.
type Cells struct {
	SQL     string   `json:"sql"`
	Count   int      `json:"count"`
	Columns []Column `json:"columns"`
	MS      int64    `json:"ms"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Failure is what a refused or failed statement answers; the front shows
// rawMessage for freestyle SQL and message otherwise.
type Failure struct {
	Error      errorBody `json:"error"`
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	Statement  string    `json:"statement"`
	RawMessage string    `json:"rawMessage"`
}

// Behind answers what the request's own provider leaves unanswered.
func (p Provider) Behind(request objstore.SystemProvider) objstore.SystemProvider {
	return behind{request, p}
}

type behind struct {
	request objstore.SystemProvider
	preview Provider
}

func (b behind) System(kind, name, input string) (any, error) {
	if value, err := b.request.System(kind, name, input); value != nil || err != nil {
		return value, err
	}
	return b.preview.System(kind, name, input)
}

func (p Provider) System(kind, _, raw string) (any, error) {
	if kind != "SQL" && kind != "SQLCHECK" || p.DB == nil {
		return nil, nil
	}
	var in input
	if json.Unmarshal([]byte(raw), &in) != nil || in.Statement == nil {
		return nil, nil
	}
	statement := *in.Statement
	if in.Trim {
		if statement = strings.TrimSpace(statement); statement == "" {
			statement = in.Fallback
		}
	}
	limit := 100
	if in.Limit != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(in.Limit)); err == nil && n >= 0 {
			limit = n
		}
	}
	return Run(p.DB(), kind, statement, limit), nil
}

// Run checks or runs one statement inside a savepoint, so a failure leaves
// the step's transaction as it was.
func Run(db Querier, kind, statement string, limit int) any {
	started := time.Now()
	fenced := false
	answer, err := func() (any, error) {
		checked, err := SingleSelect(statement)
		if err != nil {
			return nil, err
		}
		if _, err := db.Exec("SAVEPOINT osd_adt_preview"); err != nil {
			return nil, err
		}
		fenced = true
		if kind == "SQLCHECK" {
			return map[string]any{"ok": true}, Check(db, checked)
		}
		return Query(db, checked, limit)
	}()
	if err == nil {
		_, err = db.Exec("RELEASE SAVEPOINT osd_adt_preview")
	}
	if err != nil {
		if fenced {
			_, _ = db.Exec("ROLLBACK TO SAVEPOINT osd_adt_preview")
			_, _ = db.Exec("RELEASE SAVEPOINT osd_adt_preview")
		}
		code, message := "SQL_ERROR", sqliteMessage(err.Error())
		if r, ok := err.(*Refusal); ok {
			code = r.Code
		}
		return Failure{Error: errorBody{code, message}, Code: code, Message: message, Statement: statement, RawMessage: message}
	}
	ms := time.Since(started).Milliseconds()
	if cells, ok := answer.(*Cells); ok {
		cells.MS = ms
		return cells
	}
	return map[string]any{"ok": true, "ms": ms}
}

// sqliteMessage drops the driver's wrapping ("SQL logic error: ... (1)"),
// leaving the engine's message as sql.js reports it on Node.
func sqliteMessage(m string) string {
	m = strings.TrimPrefix(m, "SQL logic error: ")
	if i := strings.LastIndex(m, " ("); i > 0 && strings.HasSuffix(m, ")") {
		if _, err := strconv.Atoi(m[i+2 : len(m)-1]); err == nil {
			m = m[:i]
		}
	}
	return m
}

func prepared(statement string) (string, error) {
	text := OpenSQLToSQL(strings.TrimSuffix(strings.TrimSpace(statement), ";"))
	if !selectWord.MatchString(text) {
		word := ""
		if f := strings.Fields(text); len(f) > 0 {
			word = f[0]
		}
		return "", notAllowed(word)
	}
	return text, nil
}

// Check compiles the statement without fetching a row (Data.check).
func Check(db Querier, statement string) error {
	text, err := prepared(statement)
	if err != nil {
		return err
	}
	stmt, err := db.Prepare(strings.ReplaceAll(SQLite(text), limitZeroes, ""))
	if err != nil {
		return err
	}
	return stmt.Close()
}

// Query runs the statement, at most limit rows (Data.query + previewCells).
func Query(db Querier, statement string, limit int) (*Cells, error) {
	text, err := prepared(statement)
	if err != nil {
		return nil, err
	}
	if !limitAtEnd.MatchString(text) {
		text += " LIMIT " + strconv.Itoa(limit)
	}
	rows, err := db.Query(SQLite(text))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	// a JavaScript row object keeps the first position and the last value
	// of a repeated column name
	order, at := []string{}, map[string]int{}
	slot := make([]int, len(names))
	for i, n := range names {
		if _, seen := at[n]; !seen {
			at[n] = len(order)
			order = append(order, n)
		}
		slot[i] = at[n]
	}
	var table [][]any
	for len(table) < limit && rows.Next() {
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := make([]any, len(order))
		for i, v := range values {
			row[slot[i]] = trimmed(v)
		}
		table = append(table, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	cells := &Cells{SQL: text, Count: len(table), Columns: []Column{}}
	if len(table) == 0 {
		return cells, nil
	}
	for c, name := range order {
		column := Column{Name: name, Upper: strings.ToUpper(name), Letter: "C", Cells: make([]string, len(table))}
		letter := ""
		for r, row := range table {
			column.Cells[r] = Render(row[c])
			if letter == "" && row[c] != nil {
				letter = Letter(row[c])
			}
		}
		if letter != "" {
			column.Letter = letter
		}
		cells.Columns = append(cells.Columns, column)
	}
	return cells, nil
}

func trimmed(v any) any {
	if s, ok := v.(string); ok {
		return strings.TrimRightFunc(s, unicode.IsSpace)
	}
	return v
}

// Letter is the cell type a client is told: I for numbers, X for bytes,
// C for the rest.
func Letter(v any) string {
	switch v.(type) {
	case int64, int32, int, float64, float32:
		return "I"
	case []byte:
		return "X"
	}
	return "C"
}

// Render is a cell as text: bytes as upper-case hex, numbers as JavaScript
// prints them, NULL as nothing.
func Render(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case []byte:
		return strings.ToUpper(hex.EncodeToString(x))
	case string:
		return x
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		if math.Abs(x) < 1e21 {
			return strconv.FormatFloat(x, 'f', -1, 64)
		}
		return strconv.FormatFloat(x, 'g', -1, 64)
	case time.Time:
		return x.UTC().Format(time.RFC3339)
	}
	return fmt.Sprint(v)
}
