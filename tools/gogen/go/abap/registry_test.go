package abap

import (
	"fmt"
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
				if got := DumpText(value); got != want+" ["+detail+"]" {
					t.Fatalf("dump = %q", got)
				}
			}
			// Materialising the ABAP object must keep the diagnostic on a rethrow.
			obj := new(int)
			caught.Obj = obj
			if !RefEq(caught, obj) || RefEq(caught, &Exception{Class: caught.Class, Obj: new(int)}) {
				t.Fatal("object identity changed")
			}
			if got := DumpText(raised); got != "UNCAUGHT_EXCEPTION CX_SY_MOVE_CAST_ERROR ["+detail+"]" {
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
		if DumpText(value) != fmt.Sprint(value) {
			t.Fatalf("dump without detail changed: %v", value)
		}
	}
	if got := DumpText(CctorDump{Class: "CL_TEST", Cause: ArithmeticError{Class: e.Class, Op: e.Op, Detail: "context"}}); got != "RUNTIME_ERROR in CL_TEST=>CLASS_CONSTRUCTOR: CX_SY_ZERODIVIDE in / [context]" {
		t.Fatal(got)
	}
}
