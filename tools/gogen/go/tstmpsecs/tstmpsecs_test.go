package tstmpsecs

import (
	"testing"

	"osg/gogen/abap"
)

func TestSubtractSecs(t *testing.T) {
	for _, c := range []struct {
		in   string
		secs int32
		want string
	}{
		{"20260930120000", 60, "20260930115900"},
		{"20260930120000.5000000", 3600, "20260930110000"},
		{"20260101000000", 1, "20251231235959"},
		{"20260930120000", -30, "20260930120030"},
	} {
		if got := SubtractSecs(&abap.Session{}, c.in, c.secs); got != c.want {
			t.Fatalf("%s - %d: %s, want %s", c.in, c.secs, got, c.want)
		}
	}
	defer func() {
		if recover() == nil {
			t.Fatal("a value that is not a time stamp must be refused")
		}
	}()
	SubtractSecs(&abap.Session{}, "20261399000000", 1)
}

func TestSubtract(t *testing.T) {
	for _, c := range []struct{ t1, t2, want string }{
		{"20261003123456.9980000", "19700101000000.0000000", "1791030896.9980000"},
		{"20260101000000", "20260101000001", "-1.0000000"},
		{"20260101000000.0000001", "20260101000000", "0.0000001"},
		{"20260101000000.1234567", "20260101000000.1234568", "-0.0000001"},
		{"20260101000000.5", "20251231235959", "1.5000000"},
		{"20260101000000", "20260101000000", "0.0000000"},
	} {
		if got := Subtract(&abap.Session{}, c.t1, c.t2); got != c.want {
			t.Fatalf("%s - %s: %s, want %s", c.t1, c.t2, got, c.want)
		}
	}
	for _, bad := range []string{"20261399000000", "20260101000000.12a"} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("%s is not a time stamp and must be refused", bad)
				}
			}()
			Subtract(&abap.Session{}, bad, "20260101000000")
		}()
	}
}
