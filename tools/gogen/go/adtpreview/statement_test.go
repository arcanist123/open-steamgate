package adtpreview

import (
	"math/rand"
	"strings"
	"testing"
	"time"

	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"
)

// sqliteSemicolons are the ';' that end a statement as the SQLite library
// itself decides it: sqlite3_complete of the prefix up to each one.
func sqliteSemicolons(t *testing.T, tls *libc.TLS, sql string) bool {
	for i := 0; i < len(sql); i++ {
		if sql[i] != ';' {
			continue
		}
		z, err := libc.CString(sql[:i+1])
		if err != nil {
			t.Fatal(err)
		}
		complete := sqlite3.Xsqlite3_complete(tls, z)
		libc.Xfree(tls, z)
		if complete != 0 {
			return true
		}
	}
	return false
}

func TestOneStatementIsSQLiteTokenizer(t *testing.T) {
	tls := libc.NewTLS()
	defer tls.Close()
	alphabet := []string{";", "'", "\"", "`", "[", "]", "/", "*", "-", "\n", " ", "a", "E", "$", "\\", "/*", "*/", "--"}
	r := rand.New(rand.NewSource(859))
	for n := 0; n < 20000; n++ {
		var b strings.Builder
		b.WriteString("SELECT ")
		for k := r.Intn(14); k >= 0; k-- {
			b.WriteString(alphabet[r.Intn(len(alphabet))])
		}
		sql := b.String()
		if got, want := oneStatement(sql) != nil, sqliteSemicolons(t, tls, sql); got != want {
			t.Fatalf("%q: port says second statement %v, SQLite %v", sql, got, want)
		}
	}
	for _, in := range smuggled {
		if !sqliteSemicolons(t, tls, SQLite(in)) {
			t.Errorf("SQLite itself sees one statement in %q", in)
		}
	}
}

// The guard runs inside the work-process lock: it stays linear and capped.
func TestGuardIsLinearAndCapped(t *testing.T) {
	huge := "SELECT '" + strings.Repeat(";", 200<<10) + "'"
	comments := "SELECT 1 " + strings.Repeat("/**/", 50000)
	for _, in := range []string{huge, comments, strings.Repeat(" ", 200<<10)} {
		started := time.Now()
		_, err := SingleSelect(in)
		_ = oneStatement(in)
		if took := time.Since(started); took > 500*time.Millisecond {
			t.Errorf("%d bytes took %v", len(in), took)
		}
		if r, ok := err.(*Refusal); !ok || !strings.Contains(r.Message, "longer than 65536 bytes") {
			t.Errorf("%d bytes: %v", len(in), err)
		}
	}
	within := "SELECT '" + strings.Repeat(";", MaxStatement-30) + "'" + strings.Repeat("/**/", 3)
	started := time.Now()
	if _, err := SingleSelect(within); err != nil {
		t.Errorf("a text under the cap: %v", err)
	}
	if err := oneStatement(within); err != nil {
		t.Errorf("a text under the cap: %v", err)
	}
	if took := time.Since(started); took > 500*time.Millisecond {
		t.Errorf("%d bytes took %v", len(within), took)
	}
	if _, err := SingleSelect("SELECT 1\x00; DELETE FROM item"); err == nil {
		t.Error("a NUL is admitted")
	}
}
