package main

import (
	"database/sql"
	"testing"

	"osg/gogen/abap"
)

type fakeAssert struct{ msg, expected, actual string }

func TestCatchTurnsPanicsIntoAlerts(t *testing.T) {
	var u unitExecutor
	if a := u.Catch(func() {}); a != nil {
		t.Fatal(a)
	}
	a := u.Catch(func() { panic("boom") })
	if a == nil || a.Kind != "shortDump" || a.Severity != "fatal" || a.Title != "boom" {
		t.Fatal(a)
	}
	a = u.Catch(func() { panic(&abap.Raised{Obj: &fakeAssert{"mine", "Open", "Closed"}, Class: "KERNEL_CX_ASSERT"}) })
	if a == nil || a.Kind != "failedAssertion" || a.Title != "mine" || a.Message != "mine" || a.Expected != "Open" || a.Actual != "Closed" {
		t.Fatal(a)
	}
	a = u.Catch(func() {
		panic(&abap.Raised{Obj: &fakeAssert{"Expected different values", "", ""}, Class: "KERNEL_CX_ASSERT"})
	})
	if a.Message != "" || a.Title != "Expected different values" {
		t.Fatal(a)
	}
	a = u.Catch(func() { panic(&abap.Raised{Obj: &fakeAssert{}, Class: "CX_SY_ZERODIVIDE"}) })
	if a.Kind != "exception" || a.Title != "Exception CX_SY_ZERODIVIDE was not caught" {
		t.Fatal(a)
	}
}

func TestFrames(t *testing.T) {
	stack := "main.X()\n\tcl_abap_unit_assert.clas.abap:467 +0x1\nmain.Y()\n\tcl_abap_unit_assert.clas.abap:467 +0x2\n\tzcl_a.clas.testclasses.abap:34 +0x3\n\tadt_unit.go:9\n"
	f := frames(stack)
	if len(f) != 2 || f[0].File != "cl_abap_unit_assert.clas.abap" || f[0].Line != 467 || f[1].File != "zcl_a.clas.testclasses.abap" || f[1].Line != 34 {
		t.Fatal(f)
	}
}

func TestBeginIsolatesAndEnds(t *testing.T) {
	u := unitExecutor{Script: []byte(`["CREATE TABLE t (k TEXT)"]`)}
	step, end, err := u.Begin()
	if err != nil || step.(*abap.Session) == nil {
		t.Fatal(err)
	}
	// the unit LUW holds the one connection: write through the step's transaction
	if _, err := step.(*abap.Session).StepQuerier().(interface {
		Exec(string, ...any) (sql.Result, error)
	}).Exec(`INSERT INTO t VALUES ('x')`); err != nil {
		t.Fatal(err)
	}
	end()
	bad := unitExecutor{Script: []byte(`["NOT SQL"]`)}
	if _, _, err := bad.Begin(); err == nil {
		t.Fatal("bad script began")
	}
}
