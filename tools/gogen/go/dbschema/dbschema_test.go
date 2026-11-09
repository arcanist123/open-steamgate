package dbschema

import "testing"

func TestFingerprint(t *testing.T) {
	a := Fingerprint([]string{"CREATE TABLE a (x TEXT)", "INSERT INTO a VALUES ('1')"})
	b := Fingerprint([]string{"CREATE TABLE a (x TEXT)", "INSERT INTO a VALUES ('2')", "insert into a values ('3')"})
	c := Fingerprint([]string{"CREATE TABLE a (x TEXT, y TEXT)"})
	if a != b || a == c || len(a) != 16 {
		t.Fatalf("%s %s %s", a, b, c)
	}
	// the Node host's fingerprintOf: sha256 of the DDL joined by \n, 16 hex
	if got := Fingerprint([]string{"CREATE TABLE a (x TEXT)", "CREATE VIEW v AS SELECT 1"}); got != "1d3086ccaa4653a1" {
		t.Fatalf("fingerprint %s", got)
	}
	for st, want := range map[string]bool{" create index i on a(x)": true, "ALTER TABLE a ADD y": true, "INSERT INTO a": false, "PRAGMA x": false} {
		if IsDDL(st) != want {
			t.Fatalf("IsDDL(%q)", st)
		}
	}
}
