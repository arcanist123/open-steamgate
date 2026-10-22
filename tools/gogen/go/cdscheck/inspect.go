// Package cdscheck ports osd-store-ddls.mjs's generator diagnostics.
package cdscheck

// Expression is the original CDS parser expression tree (not a second parser).
type Expression struct {
	Kind, Text string
	Children   []Expression
}
type File struct{ Filename, Raw string }
type Object struct {
	Found            bool
	Files            []File
	Tree             *Expression
	SQLView          string
	Components, Keys []string
}
type Inspector func(typ, name string) Object
type Issue struct{ Filename, Severity, Message string }

func find(n *Expression, kind string) []*Expression {
	if n == nil {
		return nil
	}
	var out []*Expression
	if n.Kind == kind {
		out = append(out, n)
	}
	for i := range n.Children {
		out = append(out, find(&n.Children[i], kind)...)
	}
	return out
}
func direct(n *Expression, kinds ...string) *Expression {
	if n != nil {
		for i := range n.Children {
			for _, kind := range kinds {
				if n.Children[i].Kind == kind {
					return &n.Children[i]
				}
			}
		}
	}
	return nil
}
func text(n *Expression) string {
	if n == nil {
		return ""
	}
	return n.Text
}
