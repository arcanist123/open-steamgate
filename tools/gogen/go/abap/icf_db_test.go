package abap

import (
	"path/filepath"
	"strings"
	"testing"
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
	if _, err := d.SQL().Exec("PRAGMA user_version = 0"); err != nil {
		t.Fatal(err)
	}
	d.Close()
	if _, _, err := OpenDBFile(g, one); err == nil || !strings.Contains(err.Error(), "no mark") {
		t.Fatalf("unmarked: %v", err)
	}
}
