package adtoutline

import (
	"encoding/json"
	"reflect"
	"testing"
)

func statement(kind string, words ...string) Node {
	n := Node{Kind: kind, Statement: true, Start: Pos{1, 1}, End: Pos{1, 40}}
	col := int32(1)
	for _, s := range words {
		n.Tokens = append(n.Tokens, Token{Str: s, Start: Pos{1, col}, End: Pos{1, col + int32(len(s))}})
		col += int32(len(s)) + 1
	}
	return n
}
func structure(kind string, children ...Node) Node {
	return Node{Kind: kind, Start: Pos{1, 1}, End: Pos{4, 10}, Children: children}
}

type outlineRow struct {
	Found                                       bool
	Name, Type, URI, Version, Visibility, Level string
	Testclass, Testmethod, Final                string
	Links                                       []struct{ Rel, Href, Type string }
	Children                                    []outlineRow
}

func document(t *testing.T, typ, name string, files []FileTree) outlineRow {
	t.Helper()
	var out outlineRow
	if err := json.Unmarshal(Document(typ, name, "inactive", files), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestProgramEvents(t *testing.T) {
	tree := structure("Any", structure("Form", statement("Form", "FORM", "run", ".")), structure("ClassDefinition", statement("ClassDefinition", "CLASS", "lcl_local", "DEFINITION", ".")))
	events := []Node{statement("Initialization", "INITIALIZATION", "."), statement("StartOfSelection", "START-OF-SELECTION", "."), statement("AtSelectionScreen", "AT", "SELECTION-SCREEN", "."), statement("Write", "WRITE", "1", ".")}
	row := document(t, "PROG", "ZPROBE", []FileTree{{Structure: &tree, Statements: events}})
	var names, types []string
	for _, c := range row.Children {
		names = append(names, c.Name)
		types = append(types, c.Type)
	}
	if !row.Found || row.URI != "source/main" || !reflect.DeepEqual(names, []string{"RUN", "LCL_LOCAL", "INITIALIZATION ", "START-OF-SELECTION ", "AT SELECTION-SCREEN ", "ZPROBE"}) || !reflect.DeepEqual(types, []string{"PROG/PU", "PROG/PL", "PROG/PE", "PROG/PE", "PROG/PE", "PROG/PX"}) {
		t.Fatalf("%+v", row)
	}
	if row.Children[0].URI != "source/main#start=1,1;end=4,10" {
		t.Fatal(row.Children[0].URI)
	}
}
func TestClassIncludesAndOwners(t *testing.T) {
	global := structure("Any", structure("ClassDefinition", statement("ClassDefinition", "CLASS", "zprobe", "DEFINITION", "PUBLIC", "FINAL", "."), statement("MethodDef", "METHODS", "run", ".")), structure("ClassImplementation", statement("ClassImplementation", "CLASS", "zprobe", "IMPLEMENTATION", "."), structure("Method", statement("MethodImplementation", "METHOD", "run", "."))))
	local := structure("Any", structure("ClassDefinition", statement("ClassDefinition", "CLASS", "lcl_local", "DEFINITION", "."), statement("MethodDef", "METHODS", "run", ".")), structure("ClassImplementation", statement("ClassImplementation", "CLASS", "lcl_local", "IMPLEMENTATION", "."), structure("Method", statement("MethodImplementation", "METHOD", "run", "."))))
	tests := structure("Any", structure("ClassDefinition", statement("ClassDefinition", "CLASS", "ltcl_test", "DEFINITION", "FOR", "TESTING", "."), statement("MethodDef", "METHODS", "verify", "FOR", "TESTING", ".")))
	row := document(t, "CLAS", "ZPROBE", []FileTree{{Filename: "zprobe.clas.abap", Structure: &global}, {Filename: "zprobe.clas.locals_def.abap", Structure: &local}, {Filename: "zprobe.clas.testclasses.abap", Structure: &tests}})
	if row.Final != "true" || row.Visibility != "public" || len(row.Children) != 4 {
		t.Fatalf("%+v", row)
	}
	method := row.Children[0]
	localRow := row.Children[1]
	testRow := row.Children[2]
	if method.Name != "RUN" || method.Type != "CLAS/OM" || len(method.Links) != 4 || method.Links[0].Href != "./source/main#start=1,8;end=1,11" || method.Links[1].Href != "./source/main#start=1,7;end=1,10" {
		t.Fatalf("global method %+v", method)
	}
	if localRow.Name != "LCL_LOCAL" || localRow.Type != "CLAS/OCL" || localRow.Children[0].Type != "CLAS/OLD" || localRow.Children[0].Links[1].Type != "CLAS/OLD" || localRow.Children[0].Links[1].Href != "./includes/definitions#start=1,7;end=1,10" {
		t.Fatalf("local %+v", localRow)
	}
	if testRow.Testclass != "true" || testRow.Children[0].Testmethod != "true" || testRow.Children[0].Links[0].Href != "./includes/testclasses#start=1,8;end=1,14" {
		t.Fatalf("test %+v", testRow)
	}
	if row.Children[3].Type != "CLAS/OCX" {
		t.Fatal("text elements missing")
	}
}
func TestEmptyAndMacros(t *testing.T) {
	for _, tc := range []struct {
		name, typ string
		tree      Node
	}{
		{"empty Any", "PROG", structure("Any")},
		{"macros", "CLAS", structure("Any", structure("Define", statement("Define", "DEFINE", "macro", ".")))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := string(Document(tc.typ, "ZPROBE", "inactive", []FileTree{{Filename: "zprobe.clas.macros.abap", Structure: &tc.tree}}))
			want := `{"found":true,"name":"ZPROBE","type":"PROG/P","uri":"source/main","children":[{"name":"ZPROBE","type":"PROG/PX","uri":"source/main","extra":[],"links":[],"children":[]}],"extra":[],"links":[]}`
			if tc.typ == "CLAS" {
				want = `{"found":true,"name":"ZPROBE","type":"CLAS/OC","children":[{"name":"ZPROBE","type":"CLAS/OCX","extra":[{"name":"isExternalRef","value":"true"},{"name":"description","value":"Text Elements"}],"links":[{"rel":"definitionIdentifier","href":"/sap/bc/adt/textelements/classes/zprobe"}],"children":[]}],"extra":[],"links":[]}`
			}
			if got != want {
				t.Fatalf("got %s\nwant %s", got, want)
			}
		})
	}
}
