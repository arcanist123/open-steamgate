package adtpreview

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSingleSelect(t *testing.T) {
	for in, want := range map[string]string{
		"SELECT * FROM t;":                    "SELECT * FROM t",
		"select a -- ; drop\n from t":         "select a  \n from t",
		"SELECT ';DELETE' FROM t /* ; x */":   "SELECT ';DELETE' FROM t",
		"SELECT \"a;b\" FROM t":               "SELECT \"a;b\" FROM t",
		"SELECT 'it''s;' FROM t":              "SELECT 'it''s;' FROM t",
		"SELECT [a;] FROM t":                  "SELECT [a;] FROM t",
		"  SELECT 'a''b' FROM t ;  -- tail\n": "SELECT 'a''b' FROM t",
	} {
		got, err := SingleSelect(in)
		if err != nil || got != want {
			t.Errorf("SingleSelect(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for in, word := range map[string]string{
		"DELETE FROM t":           "DELETE",
		"SELECT 1; DELETE FROM t": "DELETE",
		"SELECT 1; ;":             ";",
		"SELECT /* open":          "UNTERMINATED COMMENT",
		"":                        "",
	} {
		_, err := SingleSelect(in)
		r, ok := err.(*Refusal)
		if !ok || r.Code != "NOT_ALLOWED" || r.Message != "only SELECT is allowed here, not "+word {
			t.Errorf("SingleSelect(%q) = %v; want refusal of %q", in, err, word)
		}
	}
}

func TestRewrites(t *testing.T) {
	if got := OpenSQLToSQL("SELECT a b c FROM t UP TO 5 ROWS WHERE x = 1"); got != "SELECT a, b, c FROM t WHERE x = 1 LIMIT 5" {
		t.Errorf("OpenSQLToSQL = %q", got)
	}
	if got := OpenSQLToSQL("SELECT COUNT( * ) FROM t"); got != "SELECT COUNT( * ) FROM t" {
		t.Errorf("COUNT kept: %q", got)
	}
	if got := SQLite("SELECT t~a FROM t ORDER BY PRIMARY KEY"); got != "SELECT t.a FROM t" {
		t.Errorf("SQLite = %q", got)
	}
	if got := SQLite("SELECT LEFT( a , 2 ), RIGHT(b,3) FROM t ORDER BY a DESCENDING"); got != "SELECT substr(a, 1, 2), substr(b, -3) FROM t ORDER BY a DESC" {
		t.Errorf("SQLite = %q", got)
	}
}

func fixture(t *testing.T) *sql.Tx {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	for _, s := range []string{
		"CREATE TABLE item (id NCHAR(3), name NCHAR(10), qty INT, raw BLOB)",
		"INSERT INTO item VALUES ('001', 'apple   ', 3, x'0aff'), ('002', NULL, NULL, NULL), ('003', 'pear', 7, NULL)",
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func system(t *testing.T, tx *sql.Tx, kind string, in map[string]any) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(in)
	answer, err := Provider{DB: func() Querier { return tx }}.System(kind, "", string(raw))
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(answer)
	var out map[string]any
	_ = json.Unmarshal(encoded, &out)
	return out
}

func TestQueryCells(t *testing.T) {
	tx := fixture(t)
	out := system(t, tx, "SQL", map[string]any{"statement": "SELECT * FROM item ORDER BY id", "limit": "2"})
	if out["count"] != 2.0 || out["sql"] != "SELECT * FROM item ORDER BY id LIMIT 2" {
		t.Fatalf("answer %v", out)
	}
	columns := out["columns"].([]any)
	want := []string{`{"cells":["001","002"],"letter":"C","name":"id","upper":"ID"}`,
		`{"cells":["apple",""],"letter":"C","name":"name","upper":"NAME"}`,
		`{"cells":["3",""],"letter":"I","name":"qty","upper":"QTY"}`,
		`{"cells":["0AFF",""],"letter":"X","name":"raw","upper":"RAW"}`}
	for i, c := range columns {
		got, _ := json.Marshal(c)
		if string(got) != want[i] {
			t.Errorf("column %d = %s; want %s", i, got, want[i])
		}
	}
	empty := system(t, tx, "SQL", map[string]any{"statement": "  ", "trim": true, "fallback": "SELECT id FROM item WHERE id = 'x'"})
	if empty["count"] != 0.0 || len(empty["columns"].([]any)) != 0 {
		t.Errorf("empty answer %v", empty)
	}
}

func TestCheckAndRefusals(t *testing.T) {
	tx := fixture(t)
	if ok := system(t, tx, "SQLCHECK", map[string]any{"statement": "SELECT id FROM item UP TO 0 ROWS"}); ok["ok"] != true {
		t.Errorf("check %v", ok)
	}
	bad := system(t, tx, "SQLCHECK", map[string]any{"statement": "SELECT nope FROM item"})
	if bad["code"] != "SQL_ERROR" || !strings.Contains(bad["message"].(string), "no such column: nope") {
		t.Errorf("check failure %v", bad)
	}
	refused := system(t, tx, "SQL", map[string]any{"statement": "DELETE FROM item"})
	if refused["code"] != "NOT_ALLOWED" || refused["error"].(map[string]any)["code"] != "NOT_ALLOWED" {
		t.Errorf("refusal %v", refused)
	}
	// the savepoint left the step's transaction usable and unchanged
	var n int
	if err := tx.QueryRow("SELECT COUNT(*) FROM item").Scan(&n); err != nil || n != 3 {
		t.Errorf("after failures: %d, %v", n, err)
	}
	if answer, err := (Provider{DB: func() Querier { return tx }}).System("SESSION", "", "{}"); answer != nil || err != nil {
		t.Errorf("other kinds are not this provider's: %v %v", answer, err)
	}
}

type fixed map[string]any

func (f fixed) System(kind, _, _ string) (any, error) { return f[kind], nil }

func TestBehind(t *testing.T) {
	tx := fixture(t)
	chain := Provider{DB: func() Querier { return tx }}.Behind(fixed{"SESSION": "request", "SQL": "request"})
	if v, _ := chain.System("SESSION", "", "{}"); v != "request" {
		t.Errorf("the request's provider answers first: %v", v)
	}
	if v, _ := chain.System("SQL", "", `{"statement":"SELECT 1"}`); v != "request" {
		t.Errorf("an answered kind is not previewed: %v", v)
	}
	chain = Provider{DB: func() Querier { return tx }}.Behind(fixed{})
	if v, _ := chain.System("SQLCHECK", "", `{"statement":"SELECT 1"}`); v.(map[string]any)["ok"] != true {
		t.Errorf("an unanswered kind is previewed: %v", v)
	}
}

// What a PostgreSQL-minded lexer lets through on SQLite, where the driver
// runs every statement of a text.
var smuggled = []string{
	"SELECT 1 AS a$q$; DELETE FROM item; SELECT 2 AS b$q$",
	"SELECT CAST(1 AS E'\\'); DELETE FROM item; --'",
	"SELECT 1 AS a$q$; PRAGMA user_version=7; SELECT 2 AS b$q$",
	"SELECT 1 AS a$q$; COMMIT; SELECT 2 AS b$q$",
	"SELECT 1 /* /* */; DELETE FROM item; /* */ */",
	"SELECT [a]]; DELETE FROM item; --]",
}

func untouched(t *testing.T, tx *sql.Tx) {
	t.Helper()
	var n, version int
	if err := tx.QueryRow("SELECT COUNT(*) FROM item").Scan(&n); err != nil || n != 3 {
		t.Errorf("rows after the preview: %d, %v", n, err)
	}
	if err := tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 0 {
		t.Errorf("user_version after the preview: %d, %v", version, err)
	}
	var only int
	if err := tx.QueryRow("PRAGMA query_only").Scan(&only); err != nil || only != 0 {
		t.Errorf("query_only left on: %d, %v", only, err)
	}
	// the step still owns its transaction and commits its own row
	if _, err := tx.Exec("INSERT INTO item VALUES ('009', 'own', 1, NULL)"); err != nil {
		t.Errorf("step write after the preview: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Errorf("step commit after the preview: %v", err)
	}
}

func TestSmuggledStatementsAreRefused(t *testing.T) {
	for _, in := range smuggled {
		if _, err := SingleSelect(in); err == nil {
			t.Errorf("lexer admitted %q", in)
		}
		if err := oneStatement(SQLite(in)); err == nil {
			t.Errorf("statement proof admitted %q", in)
		}
		for _, kind := range []string{"SQL", "SQLCHECK"} {
			tx := fixture(t)
			out := system(t, tx, kind, map[string]any{"statement": in})
			if out["code"] != "NOT_ALLOWED" {
				t.Errorf("%s %q answered %v", kind, in, out)
			}
			untouched(t, tx)
		}
	}
	// a ';' inside quotes or a comment is not a second statement
	for _, in := range []string{"SELECT ';' FROM item", "SELECT 1 /* ; */", "SELECT \"a;\" FROM item", "SELECT [a;] FROM item"} {
		if err := oneStatement(in); err != nil {
			t.Errorf("statement proof refused %q: %v", in, err)
		}
	}
}

func TestQueryOnlyFenceHoldsWithoutTheGuards(t *testing.T) {
	saved := guard
	defer func() { guard = saved }()
	guard.lex = func(s string) (string, error) { return s, nil }
	guard.one = func(string) error { return nil }
	for _, in := range []string{
		"SELECT 1; DELETE FROM item; SELECT 2",
		"SELECT 1; PRAGMA user_version = 7; SELECT 2",
		"SELECT 1; INSERT INTO item VALUES ('004', 'x', 1, NULL); SELECT 2",
	} {
		tx := fixture(t)
		out := system(t, tx, "SQL", map[string]any{"statement": in})
		if out["code"] != "SQL_ERROR" {
			t.Errorf("%q answered %v", in, out)
		}
		untouched(t, tx)
	}
}

func TestLimitParsing(t *testing.T) {
	tx := fixture(t)
	for limit, want := range map[string]float64{"": 0, "1": 1, " 2 ": 2, "-5": 3, "abc": 3} {
		out := system(t, tx, "SQL", map[string]any{"statement": "SELECT id FROM item", "limit": limit})
		if out["count"] != want {
			t.Errorf("limit %q gave %v rows; want %v", limit, out["count"], want)
		}
	}
	if out := system(t, tx, "SQL", map[string]any{"statement": "SELECT id FROM item"}); out["count"] != 3.0 {
		t.Errorf("absent limit: %v", out)
	}
}
