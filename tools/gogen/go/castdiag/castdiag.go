// Package castdiag formats diagnostics exclusively for host dump reporters.
package castdiag

import (
	"fmt"
	"runtime"
)

// Context records the caller of the binding that rejected a cast.
// Call only on failure: source and target are their existing typed values.
func Context(source, target any) string {
	_, file, line, _ := runtime.Caller(2)
	return fmt.Sprintf("%T -> %T at %s:%d", source, target, file, line)
}

// WithDetail appends optional host context to a reporter's existing text.
func WithDetail(text, detail string) string {
	if detail != "" {
		return text + " [" + detail + "]"
	}
	return text
}

// DumpText formats a recovered value using narrow, host-only carrier seams.
// Ordinary Error/Text methods retain their ABAP-visible semantics.
func DumpText(r any) string {
	if x, ok := r.(interface{ DiagnosticCause() (string, any) }); ok {
		prefix, cause := x.DiagnosticCause()
		return prefix + DumpText(cause)
	}
	text := fmt.Sprint(r)
	if x, ok := r.(interface{ DiagnosticDetail() string }); ok {
		return WithDetail(text, x.DiagnosticDetail())
	}
	return text
}
