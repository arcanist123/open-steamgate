package abap

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/dbschema"
)

// a -db file is seeded once and marked; the same build takes it back as it
// is, another build's script (or a file nobody marked) is refused
func TestOpenDBFileMark(t *testing.T) {
	f := filepath.Join(t.TempDir(), "osgo.sqlite")
	one := []byte(`["CREATE TABLE a (x TEXT)", "INSERT INTO a VALUES ('1')"]`)
	two := []byte(`["CREATE TABLE a (x TEXT, y TEXT)"]`)
	d, seeded, err := OpenDBFile(f, one)
	if err != nil || !seeded {
		t.Fatalf("new file: seeded %v, %v", seeded, err)
	}
	d.Close()
	if d, seeded, err := OpenDBFile(f, one); err != nil || seeded {
		t.Fatalf("same build: seeded %v, %v", seeded, err)
	} else {
		d.Close()
	}
	if _, _, err := OpenDBFile(f, two); err == nil || !strings.Contains(err.Error(), "another build") {
		t.Fatalf("another build: %v", err)
	}
	g := filepath.Join(t.TempDir(), "unmarked.sqlite")
	d, _, err = OpenDBFile(g, []byte(`["CREATE TABLE b (x TEXT)"]`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.SQL().Exec("DROP TABLE osd_schema; PRAGMA user_version = 0"); err != nil {
		t.Fatal(err)
	}
	d.Close()
	if _, _, err := OpenDBFile(g, one); err == nil || !strings.Contains(err.Error(), "no mark") {
		t.Fatalf("unmarked: %v", err)
	}
}

// ADR 0010 slice 4: the mark is the DDL only. Another seed with the same
// tables opens the file as it is (no second seed); other tables refuse it.
func TestOpenDBFileSchemaFingerprint(t *testing.T) {
	f := filepath.Join(t.TempDir(), "osgo.sqlite")
	one := []byte(`["CREATE TABLE a (x TEXT)", "INSERT INTO a VALUES ('1')"]`)
	reseeded := []byte(`["CREATE TABLE a (x TEXT)", "INSERT INTO a VALUES ('2')"]`)
	d, _, err := OpenDBFile(f, one)
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	d, seeded, err := OpenDBFile(f, reseeded)
	if err != nil || seeded {
		t.Fatalf("other seed, same tables: seeded %v, %v", seeded, err)
	}
	var x string
	if err := d.SQL().QueryRow("SELECT group_concat(x) FROM a").Scan(&x); err != nil || x != "1" {
		t.Fatalf("rows %q %v: the file must not be seeded again", x, err)
	}
	var fp, seed string
	if err := d.SQL().QueryRow("SELECT fingerprint, seed FROM osd_schema").Scan(&fp, &seed); err != nil {
		t.Fatal(err)
	}
	want, _ := SchemaFingerprint(one)
	if fp != want || seed != fmt.Sprintf("%08x", ScriptVersion(one)) {
		t.Fatalf("stamp %s %s, want %s", fp, seed, want)
	}
	d.Close()
	if a, _ := SchemaFingerprint(one); a != want {
		t.Fatal("fingerprint not stable")
	}
	if b, _ := SchemaFingerprint(reseeded); b != want {
		t.Fatalf("seed rows changed the fingerprint")
	}
	var se *SchemaError
	if _, _, err := OpenDBFile(f, []byte(`["CREATE TABLE a (x TEXT, y TEXT)"]`)); !errors.As(err, &se) || se.Have != want {
		t.Fatalf("other tables: %v", err)
	}
}

// A file seeded before the stamp carries only user_version: the build whose
// whole script made it adopts it (and stamps it); any other is refused.
func TestOpenDBFileAdoptsLegacyMark(t *testing.T) {
	f := filepath.Join(t.TempDir(), "old.sqlite")
	one := []byte(`["CREATE TABLE a (x TEXT)", "INSERT INTO a VALUES ('1')"]`)
	d, _, err := OpenDBFile(f, one)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.SQL().Exec(fmt.Sprintf("DROP TABLE osd_schema; PRAGMA user_version = %d", ScriptVersion(one))); err != nil {
		t.Fatal(err)
	}
	d.Close()
	if _, _, err := OpenDBFile(f, []byte(`["CREATE TABLE a (x TEXT)"]`)); err == nil || !strings.Contains(err.Error(), "before schema fingerprints") {
		t.Fatalf("legacy, other script: %v", err)
	}
	d, _, err = OpenDBFile(f, one)
	if err != nil {
		t.Fatal(err)
	}
	if fp, ok, err := dbschema.StampOf(d.SQL()); !ok || err != nil || fp == "" {
		t.Fatalf("adopted without a stamp: %q %v %v", fp, ok, err)
	}
	d.Close()
}

// The candidate's open (ADR 0010 slice 4, step 3) writes nothing: every row
// of a populated file is as it was after a candidate that tried to write and
// failed; a candidate of other tables is refused with a SchemaError; one on
// a file without tables never seeds it.
func TestOpenDBCandidateLeavesThePopulatedFile(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "osgo.sqlite")
	script := []byte(`["CREATE TABLE a (k TEXT PRIMARY KEY, v TEXT)", "INSERT INTO a VALUES ('seed', 'x')"]`)
	serving, _, err := OpenDBFile(f, script)
	if err != nil {
		t.Fatal(err)
	}
	defer serving.Close()
	// the serving generation's own rows, written after the seed
	for i := 0; i < 50; i++ {
		if _, err := serving.SQL().Exec("INSERT INTO a VALUES (?, ?)", fmt.Sprint("k", i), fmt.Sprint("v", i)); err != nil {
			t.Fatal(err)
		}
	}
	dump := func() string {
		var all string
		if err := serving.SQL().QueryRow("SELECT group_concat(k || '=' || v, ',') FROM (SELECT * FROM a ORDER BY k)").Scan(&all); err != nil {
			t.Fatal(err)
		}
		var st string
		serving.SQL().QueryRow("SELECT fingerprint || seed FROM osd_schema").Scan(&st)
		return all + "|" + st
	}
	before := dump()
	cand, err := OpenDBCandidate(f, []byte(`["CREATE TABLE a (k TEXT PRIMARY KEY, v TEXT)", "INSERT INTO a VALUES ('other seed', 'y')"]`))
	if err != nil {
		t.Fatalf("same tables, other seed: %v", err)
	}
	var n int
	if err := cand.SQL().QueryRow("SELECT count(*) FROM a").Scan(&n); err != nil || n != 51 {
		t.Fatalf("the candidate reads the serving rows: %d %v", n, err)
	}
	for _, w := range []string{"INSERT INTO a VALUES ('cand', 'c')", "UPDATE a SET v = 'z'", "DELETE FROM a", "CREATE TABLE b (x TEXT)"} {
		if _, err := cand.SQL().Exec(w); err == nil {
			t.Fatalf("a candidate wrote: %s", w)
		}
	}
	cand.Close()
	if after := dump(); after != before {
		t.Fatalf("the failed candidate changed the file:\n%s\n%s", before, after)
	}
	var se *SchemaError
	if _, err := OpenDBCandidate(f, []byte(`["CREATE TABLE a (k TEXT PRIMARY KEY, v TEXT, w TEXT)"]`)); !errors.As(err, &se) {
		t.Fatalf("other tables: %v", err)
	}
	if after := dump(); after != before {
		t.Fatal("a refused candidate changed the file")
	}
	empty := filepath.Join(dir, "empty.sqlite")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenDBCandidate(empty, script); err == nil || !strings.Contains(err.Error(), "never seeds") {
		t.Fatalf("empty file: %v", err)
	}
	if _, err := OpenDBCandidate(filepath.Join(dir, "missing.sqlite"), script); err == nil {
		t.Fatal("a candidate created a file")
	}
}

// ADR 0010 slice 4, critic #895 SHOULD 1: the normalising UPDATEs of one
// open are one transaction. The case is a promotion that fails partway (the
// candidate's OpenDBFile of the file the serving generation serves): table
// b's BEFORE UPDATE trigger refuses its rtrim, standing in for the write
// lock the serving generation can hold past the candidate's busy_timeout
// while a pinned session's step runs. Table a's rtrim, already sent, must
// not stay in the file: a promotion that fails leaves it as the serving
// generation left it.
func TestOpenDBFileNormalisationIsOneTransaction(t *testing.T) {
	f := filepath.Join(t.TempDir(), "osgo.sqlite")
	script := []byte(`["CREATE TABLE a ('v' NCHAR(8) COLLATE RTRIM)",
		"CREATE TABLE b ('v' NCHAR(8) COLLATE RTRIM)",
		"CREATE TRIGGER refuse_b BEFORE UPDATE ON b BEGIN SELECT RAISE(ABORT, 'b refuses the normalisation'); END"]`)
	serving, _, err := OpenDBFile(f, script)
	if err != nil {
		t.Fatal(err) // the trigger fires per row; the empty tables normalise
	}
	defer serving.Close()
	if _, err := serving.SQL().Exec("INSERT INTO a VALUES ('keep   '); INSERT INTO b VALUES ('keep   ')"); err != nil {
		t.Fatal(err)
	}
	row := func() string {
		var v string
		if err := serving.SQL().QueryRow("SELECT v FROM a").Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	before := row()
	promoted, _, err := OpenDBFile(f, script) // the candidate's promotion
	if promoted != nil {
		promoted.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "b refuses") {
		t.Fatalf("the failing promotion: %v", err)
	}
	if after := row(); after != before {
		t.Fatalf("a normalisation that failed partway stayed in the file: %q -> %q", before, after)
	}
}
