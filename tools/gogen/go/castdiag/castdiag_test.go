package castdiag

import "testing"

type diagnostic struct{ detail string }

func (d diagnostic) Error() string            { return "semantic text" }
func (d diagnostic) DiagnosticDetail() string { return d.detail }

type wrapper struct {
	prefix string
	cause  any
}

func (w wrapper) DiagnosticCause() (string, any) { return w.prefix, w.cause }

func TestDumpText(t *testing.T) {
	for _, tc := range []struct {
		value any
		want  string
	}{
		{nil, "<nil>"}, {"panic", "panic"},
		{diagnostic{}, "semantic text"},
		{diagnostic{"context"}, "semantic text [context]"},
		{wrapper{"constructor: ", wrapper{"", diagnostic{"context"}}}, "constructor: semantic text [context]"},
	} {
		if got := DumpText(tc.value); got != tc.want {
			t.Fatalf("got %q, want %q", got, tc.want)
		}
	}
}
