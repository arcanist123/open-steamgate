// Package abaperr defines host and ABAP error values shared by pure packages.
package abaperr

type HostError struct{ Where, Text string }

func (e HostError) Error() string { return e.Where + ": " + e.Text }

type ArithmeticError struct {
	Class, Op string
	// Detail is host-only diagnostic context; Error and ABAP text exclude it.
	Detail string `json:"-" xml:"-"`
}

func (e ArithmeticError) Error() string { return e.Class + " in " + e.Op }
func NotCompiled(method, reason string) ArithmeticError {
	return ArithmeticError{Class: "NOT_COMPILED", Op: method + ": " + reason}
}

func (e ArithmeticError) DiagnosticDetail() string { return e.Detail }
