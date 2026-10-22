package abap

import "fmt"

// DumpText formats an uncaught exception for the host. Keep diagnostics out of
// Error(), Text() and TextOf(), which also serve semantic comparisons/get_text.
func DumpText(r any) string {
	switch x := r.(type) {
	case *Rethrown:
		return DumpText(x.V)
	case CctorDump:
		return "RUNTIME_ERROR in " + x.Class + "=>CLASS_CONSTRUCTOR: " + DumpText(x.Cause)
	case ArithmeticError:
		return withDetail(x.Error(), x.Detail)
	case *Exception:
		if x != nil {
			return withDetail(x.Text(), x.Detail)
		}
	case *Raised:
		if x != nil && x.Caught != nil {
			return withDetail(x.Error(), x.Caught.Detail)
		}
	}
	return fmt.Sprint(r)
}

func withDetail(text, detail string) string {
	if detail != "" {
		return text + " [" + detail + "]"
	}
	return text
}
