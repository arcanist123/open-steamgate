package abap

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"osg/gogen/castdiag"
	"runtime"
	"testing"
)

func TestCastDiagnostics(t *testing.T) {
	RegisterClass("CAST_DIAGNOSTIC_TEST", (*int)(nil), func(*Session) any {
		t.Fatal("incompatible CREATE ran its constructor")
		return nil
	})
	defer delete(classes, "CAST_DIAGNOSTIC_TEST")
	for _, create := range []bool{false, true} {
		t.Run(fmt.Sprint("create=", create), func(t *testing.T) {
			var recovered any
			var file string
			var line int
			func() {
				defer func() { recovered = recover() }()
				if create {
					_, file, line, _ = runtime.Caller(0)
					CreateAs[*string](&Session{}, "CAST_DIAGNOSTIC_TEST")
				} else {
					_, file, line, _ = runtime.Caller(0)
					Cast[*string](new(int))
				}
			}()
			e, ok := AsError(recovered)
			if !ok {
				t.Fatalf("expected cast error, got %#v", recovered)
			}
			op := "?="
			if create {
				op = "CREATE OBJECT TYPE (CAST_DIAGNOSTIC_TEST)"
			}
			want := "CX_SY_MOVE_CAST_ERROR in " + op
			if e.Op != op || e.Error() != want {
				t.Fatalf("error text changed: %#v", e)
			}
			detail := fmt.Sprintf("*int -> *string at %s:%d", file, line+1)
			if e.Detail != detail {
				t.Fatalf("detail = %q, want %q", e.Detail, detail)
			}
			caught := CaughtException(recovered)
			if caught.Text() != want || caught.TextOf(&Session{}) != want || caught.Detail != detail {
				t.Fatalf("caught text/detail changed: %#v", caught)
			}
			raised := Raise(caught, "")
			wrapped := &Rethrown{V: raised}
			roundtrip, ok := AsError(wrapped)
			if !ok || roundtrip != e || CaughtException(wrapped) != caught || !RefEq(caught, CaughtException(wrapped)) {
				t.Fatal("rethrow lost fields or reference identity")
			}
			for _, value := range []any{e, caught, raised, wrapped, &Rethrown{V: e}} {
				if got := castdiag.DumpText(value); got != want+" ["+detail+"]" {
					t.Fatalf("dump = %q", got)
				}
			}
			// Materialising the ABAP object must keep the diagnostic on a rethrow.
			obj := new(int)
			caught.Obj = obj
			if !RefEq(caught, obj) || RefEq(caught, &Exception{Class: caught.Class, Obj: new(int)}) {
				t.Fatal("object identity changed")
			}
			if got := castdiag.DumpText(raised); got != "UNCAUGHT_EXCEPTION CX_SY_MOVE_CAST_ERROR ["+detail+"]" {
				t.Fatalf("materialised dump = %q", got)
			}
		})
	}
}

func TestCastSuccess(t *testing.T) {
	value := new(int)
	if Cast[*int](value) != value || Cast[*int](nil) != nil {
		t.Fatal("cast changed identity or initial reference")
	}
}

func TestDumpTextWithoutDetail(t *testing.T) {
	e := ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"}
	for _, value := range []any{e, &Rethrown{V: e}, Raise(CaughtException(e), ""), HostError{Where: "host", Text: "error"}, "panic"} {
		if castdiag.DumpText(value) != fmt.Sprint(value) {
			t.Fatalf("dump without detail changed: %v", value)
		}
	}
	if got := castdiag.DumpText(CctorDump{Class: "CL_TEST", Cause: ArithmeticError{Class: e.Class, Op: e.Op, Detail: "context"}}); got != "RUNTIME_ERROR in CL_TEST=>CLASS_CONSTRUCTOR: CX_SY_ZERODIVIDE in / [context]" {
		t.Fatal(got)
	}
}

// Host serialization must not expose diagnostic paths, even through carriers.
func TestDiagnosticVisibility(t *testing.T) {
	e := ArithmeticError{Class: "CX_SY_MOVE_CAST_ERROR", Op: "?=", Detail: "private-host-site"}
	caught := CaughtException(e)
	raised := Raise(caught, "")
	for _, value := range []any{e, caught, raised, &Rethrown{V: raised}} {
		for _, marshal := range []func(any) ([]byte, error){json.Marshal, xml.Marshal} {
			encoded, err := marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(encoded, []byte(e.Detail)) || bytes.Contains(encoded, []byte("Detail")) {
				t.Fatalf("diagnostic leaked into serialization: %s", encoded)
			}
		}
		if bytes.Contains([]byte(fmt.Sprint(value)), []byte(e.Detail)) {
			t.Fatalf("diagnostic leaked into default text: %T", value)
		}
	}
	before := caught.TextOf(&Session{})
	caught.Detail = "other-site"
	if caught.TextOf(&Session{}) != before || !RefEq(caught, caught) || RefEq(caught, &Exception{Class: caught.Class, Op: caught.Op, Detail: caught.Detail}) {
		t.Fatal("host context changed ABAP text or reference comparison")
	}
}

var castSink *int

func TestCastSuccessAllocations(t *testing.T) {
	value := new(int)
	if got := testing.AllocsPerRun(1000, func() { castSink = Cast[*int](value) }); got != 0 {
		t.Fatalf("successful cast allocated %g times", got)
	}
}

func TestDiagnosticMaterializedRethrow(t *testing.T) {
	caught := CaughtException(ArithmeticError{Class: "CX_SY_MOVE_CAST_ERROR", Op: "?=", Detail: "host site"})
	obj := &kernelReadProbe{kernel: caught}
	caught.Obj = obj
	raised := Raise(obj, caught.Class)
	if CaughtException(raised) != caught || !RefEq(caught, obj) {
		t.Fatal("materialized rethrow lost carrier identity")
	}
	if got := castdiag.DumpText(raised); got != "UNCAUGHT_EXCEPTION CX_SY_MOVE_CAST_ERROR [host site]" {
		t.Fatal(got)
	}
	for _, value := range []any{(*Exception)(nil), (*Raised)(nil)} {
		if got := castdiag.DumpText(value); got != "<nil>" {
			t.Fatal(got)
		}
	}
}
