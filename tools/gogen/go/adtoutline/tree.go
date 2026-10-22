// Package adtoutline ports adt-documents.mjs structureOf over copied parser trees.
package adtoutline

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf16"
)

type Pos struct{ Row, Col int32 }
type Token struct {
	Str        string
	Start, End Pos
	Pragma     bool
}
type Node struct {
	Kind           string
	Statement      bool
	Start, End     Pos
	Tokens         []Token
	Children       []Node
	FirstStatement *Node
}
type FileTree struct {
	Filename   string
	Structure  *Node
	Statements []Node
}

// ConcatTokens is StatementNode.concatTokens, including UTF-16 adjacency and pragmas.
func ConcatTokens(tokens []Token) string {
	var out strings.Builder
	var prev *Token
	for i := range tokens {
		t := &tokens[i]
		if t.Pragma {
			continue
		}
		if out.Len() != 0 && (prev == nil || prev.Start.Row != t.Start.Row || int64(prev.Start.Col)+int64(len(utf16.Encode([]rune(prev.Str)))) != int64(t.Start.Col)) {
			out.WriteByte(' ')
		}
		out.WriteString(t.Str)
		prev = t
	}
	return out.String()
}
func first(n *Node) *Node {
	if n == nil || n.Statement {
		return n
	}
	if n.FirstStatement != nil {
		return n.FirstStatement
	}
	if len(n.Children) == 0 {
		return nil
	}
	return first(&n.Children[0])
}
func find(n *Node, kinds []string, stop bool) []*Node {
	if n == nil {
		return nil
	}
	var out []*Node
	for _, k := range kinds {
		if n.Kind == k {
			out = append(out, n)
			if stop {
				return out
			}
			break
		}
	}
	for i := range n.Children {
		out = append(out, find(&n.Children[i], kinds, stop)...)
	}
	return out
}
func upper(s string) string { return strings.ToUpper(s) }
func has(s string, list ...string) bool {
	for _, v := range list {
		if s == v {
			return true
		}
	}
	return false
}

// Objects retain JavaScript insertion order: OUTLINE is also an RFC JSON document.
type field struct {
	key   string
	value any
}
type object []field

func (o *object) set(k string, v any) {
	for i := range *o {
		if (*o)[i].key == k {
			(*o)[i].value = v
			return
		}
	}
	*o = append(*o, field{k, v})
}
func encode(v any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
func (o object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, f := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(encode(f.key))
		b.WriteByte(':')
		b.Write(encode(f.value))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

type element struct {
	props    object
	links    []object
	children []*element
	extra    []object
}

func elem(name, typ string) *element {
	return &element{props: object{{"name", name}, {"type", typ}}, links: []object{}, children: []*element{}, extra: []object{}}
}
func (e *element) with(k string, v any) *element { e.props.set(k, v); return e }
func (e *element) rows() object {
	o := append(object{}, e.props...)
	o.set("extra", e.extra)
	o.set("links", e.links)
	children := make([]object, 0, len(e.children))
	for _, c := range e.children {
		children = append(children, c.rows())
	}
	o.set("children", children)
	return o
}
func rangeURI(start, end Pos, source string) string {
	return fmt.Sprintf("%s#start=%d,%d;end=%d,%d", source, start.Row, start.Col, end.Row, end.Col)
}
func link(rel string, start, end Pos, source, typ string) object {
	start.Col--
	end.Col -= 2
	if strings.HasSuffix(rel, "Identifier") {
		end.Col++
	}
	o := object{{"rel", rel}, {"href", rangeURI(start, end, source)}}
	if typ != "" {
		o.set("type", typ)
	}
	return o
}

var adtTypes = map[string]string{"CLAS": "CLAS/OC", "INTF": "INTF/OI", "PROG": "PROG/P", "INCL": "PROG/I", "DDLS": "DDLS/DF", "SRVD": "SRVD/SRV", "FUGR": "FUGR/F", "TABL": "TABL/DT", "STRU": "TABL/DS", "DTEL": "DTEL/DE", "DOMA": "DOMA/DD", "TTYP": "TTYP/DA", "VIEW": "VIEW/DV", "SHLP": "SHLP/DH", "MSAG": "MSAG/N", "SICF": "SICF", "SAPC": "SAPC", "SAMC": "SAMC", "DEVC": "DEVC/K"}

// Document matches PARSE_KINDS.OUTLINE's rows(structureOf(...)) serialization.
// An indexed object can have no parser object; structureOf still emits its shell.
func Document(typ, name, version string, files []FileTree) json.RawMessage {
	code := adtTypes[typ]
	if code == "" {
		code = typ
	}
	var root *element
	if has(typ, "CLAS", "INTF") {
		root = classParts(files, name, code)
	} else {
		root = elem(name, code).with("uri", "source/main").with("children", nil)
	}
	if typ == "CLAS" {
		text := elem(name, "CLAS/OCX").with("extra", nil).with("links", nil)
		text.extra = []object{{{"name", "isExternalRef"}, {"value", "true"}}, {{"name", "description"}, {"value", "Text Elements"}}}
		text.links = []object{{{"rel", "definitionIdentifier"}, {"href", "/sap/bc/adt/textelements/classes/" + strings.ToLower(name)}}}
		root.children = append(root.children, text)
	}
	if has(typ, "PROG", "INCL") {
		root.children = append(root.children, programParts(files)...)
		root.children = append(root.children, elem(name, "PROG/PX").with("uri", "source/main"))
	}
	if has(typ, "INCL", "SRVD") {
		root.with("version", version)
	}
	out := object{{"found", true}}
	out = append(out, root.rows()...)
	return encode(out)
}
func programParts(files []FileTree) []*element {
	var out []*element
	if len(files) == 0 || files[0].Structure == nil {
		return out
	}
	kinds := []string{"Form", "ClassDefinition", "ClassImplementation"}
	codes := map[string]string{"Form": "PROG/PU", "ClassDefinition": "PROG/PL", "ClassImplementation": "PROG/PP"}
	for _, n := range find(files[0].Structure, kinds, false) {
		if n.Statement {
			continue
		}
		s := first(n)
		if s == nil || len(s.Tokens) < 2 {
			continue
		}
		name := upper(s.Tokens[1].Str)
		if name != "" {
			out = append(out, elem(name, codes[n.Kind]).with("uri", rangeURI(n.Start, n.End, "source/main")))
		}
	}
	for _, s := range files[0].Statements {
		if has(s.Kind, "Initialization", "StartOfSelection", "EndOfSelection", "AtSelectionScreen", "AtSelectionScreenOutput", "TopOfPage", "EndOfPage", "AtLineSelection", "AtUserCommand", "LoadOfProgram") {
			out = append(out, elem(strings.TrimSuffix(upper(ConcatTokens(s.Tokens)), "."), "PROG/PE").with("uri", rangeURI(s.Start, s.End, "source/main")))
		}
	}
	return out
}
