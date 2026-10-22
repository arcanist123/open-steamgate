package cdscheck

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// Facts use the critic reproducer's JSON contract, without parser substitutes.
type factCase struct {
	Objects  map[string]Object
	Expected []Issue
}

func stringPtr(s string) *string { return &s }

func ex(kind, text string, children ...Expression) Expression {
	return Expression{kind, text, children}
}
func fixture(elements ...Expression) factCase {
	root := ex("CDSView", "", ex("CDSSelect", "", append([]Expression{ex("CDSSource", "ztable as t")}, elements...)...))
	return factCase{Objects: map[string]Object{
		"DDLS:ZPROBE": {Found: true, Files: []File{{"/src/zprobe.ddls.asddls", "define view zprobe"}}, Tree: &root, SQLView: stringPtr("ZGEN")},
		"TABL:ZTABLE": {Found: true, Components: []string{"MANDT", "ID"}, Keys: []string{"MANDT", "ID"}},
	}, Expected: []Issue{}}
}
func field(base, alias string) Expression {
	e := ex("CDSElement", "", ex("CDSPrefixedName", base))
	if alias != "" {
		e.Children = append(e.Children, ex("CDSAs", "", ex("CDSName", alias)))
	}
	return e
}
func virtual(by string) Expression {
	e := ex("CDSElement", "", ex("CDSAnnotation", "@ObjectModel.virtualElement: true"), ex("CDSCast", "cast( '' as abap.char(20) )"), ex("CDSAs", "", ex("CDSName", "text")))
	if by != "absent" {
		e.Children = append(e.Children, ex("CDSAnnotation", "@ObjectModel.virtualElementCalculatedBy: 'ABAP:"+by+"'"))
	}
	return e
}
func refuse(s string) []Issue {
	return []Issue{{"/src/zprobe.ddls.asddls", "E", "the generator will not generate this view: " + s}}
}
func TestMustRegressions(t *testing.T) {
	for _, tc := range []struct {
		name     string
		element  Expression
		expected []Issue
	}{
		{"blank calculating class", virtual("   "), refuse("virtual element without an alias or a calculating class")},
		{"aliased client", field("t.mandt", "client"), []Issue{{"/src/zprobe.ddls.asddls", "W", "MANDT is in the generated view ZGEN and no longer in ZPROBE: whatever reads it breaks when this is generated again"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := fixture(field("id", ""), tc.element)
			c.Expected = tc.expected
			if tc.name == "aliased client" {
				c.Objects["VIEW:ZGEN"] = Object{Found: true, Components: []string{"MANDT", "ID"}}
			}
			checkFacts(t, c)
		})
	}
}
func checkFacts(t *testing.T, c factCase) {
	t.Helper()
	// Round trip exactly the Objects/Expected fact shape consumed by the reproducer.
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	got := Issues("ZPROBE", func(typ, name string) Object { return c.Objects[typ+":"+name] })
	if !reflect.DeepEqual(got, c.Expected) {
		t.Fatalf("got %#v; want %#v", got, c.Expected)
	}
}
func TestPolicyBranches(t *testing.T) {
	for _, name := range []string{"valid class", "absent class", "empty class", "second valid annotation", "no alias", "bad virtual type", "implicit client", "explicit client", "duplicate client aliases", "virtual client", "clientless source", "no tree", "no select", "join", "multiple sources", "where", "table function", "function without tree", "missing source", "DDLS source", "VIEW source", "cast column", "cast no alias", "cast literal", "cast bad type", "association", "expression", "unnamed", "missing one key", "missing two keys", "analytical", "write table", "create table", "update table", "delete table", "write view", "no write", "gone plural", "no sql name", "parse error"} {
		t.Run(name, func(t *testing.T) {
			c := fixture(field("id", ""))
			o := c.Objects["DDLS:ZPROBE"]
			sel := &o.Tree.Children[0]
			add := func(e Expression) { sel.Children = append(sel.Children, e) }
			anno := func(s string) { o.Tree.Children = append(o.Tree.Children, ex("CDSAnnotation", s)) }
			warn := func(s string) { c.Expected = []Issue{{o.Files[0].Filename, "W", s}} }
			switch name {
			case "valid class":
				add(virtual(" ZCL_CALC "))
			case "absent class", "empty class":
				by := "absent"
				if name == "empty class" {
					by = ""
				}
				add(virtual(by))
				c.Expected = refuse("virtual element without an alias or a calculating class")
			case "second valid annotation":
				e := virtual("   ")
				e.Children = append(e.Children, ex("CDSAnnotation", "@ObjectModel.virtualElementCalculatedBy: 'ABAP: ZCL_CALC'"))
				add(e)
			case "no alias":
				e := virtual("ZCL_CALC")
				e.Children = append(e.Children[:2], e.Children[3:]...)
				add(e)
				c.Expected = refuse("virtual element without an alias or a calculating class")
			case "bad virtual type":
				e := virtual("ZCL_CALC")
				e.Children[1].Text = "cast( '' as abap.raw(20) )"
				add(e)
				c.Expected = refuse("virtual element TEXT: cannot read the cast type")
			case "implicit client", "explicit client", "duplicate client aliases", "virtual client", "clientless source":
				c.Objects["VIEW:ZGEN"] = Object{Found: true, Components: []string{"MANDT", "ID"}}
				if name == "explicit client" {
					add(field("t.mandt", ""))
				}
				if name == "duplicate client aliases" {
					add(field("mandt", "first"))
					add(field("mandt", "second"))
					c.Objects["VIEW:ZGEN"] = Object{Found: true, Components: []string{"FIRST", "SECOND", "ID"}}
					warn("SECOND is in the generated view ZGEN and no longer in ZPROBE: whatever reads it breaks when this is generated again")
				}
				if name == "virtual client" {
					e := virtual("ZCL_CALC")
					e.Children[2].Children[0].Text = "MANDT"
					add(e)
				}
				if name == "clientless source" {
					c.Objects["TABL:ZTABLE"] = Object{Found: true}
					warn("MANDT is in the generated view ZGEN and no longer in ZPROBE: whatever reads it breaks when this is generated again")
				}
			case "no tree", "function without tree":
				o.Tree = nil
				c.Expected = []Issue{{o.Files[0].Filename, "E", "the view has no parse tree: it is not a CDS view this system can read"}}
				if name == "function without tree" {
					o.Files[0].Raw = "define table function zprobe"
				}
			case "no select":
				o.Tree.Children = nil
				c.Expected = refuse("no select")
			case "join", "multiple sources":
				if name == "join" {
					add(ex("CDSJoin", ""))
				} else {
					add(ex("CDSSource", "other"))
				}
				c.Expected = refuse("joins are not supported yet")
			case "where":
				add(ex("CDSWhere", ""))
				c.Expected = refuse("a WHERE in the view is not carried yet: the DDIC view would return every row, and a write through it could insert a row the view cannot show")
			case "table function":
				o.Files[0].Raw = "DEFINE TABLE FUNCTION zprobe"
				o.Tree.Children = nil
			case "missing source", "DDLS source", "VIEW source", "write view":
				delete(c.Objects, "TABL:ZTABLE")
				if name == "missing source" {
					c.Expected = []Issue{{o.Files[0].Filename, "E", "ZPROBE selects from ZTABLE, which is not a table or a view of this system"}}
				} else {
					typ := "VIEW"
					if name == "DDLS source" {
						typ = "DDLS"
					}
					c.Objects[typ+":ZTABLE"] = Object{Found: true}
				}
				if name == "write view" {
					anno("@ObjectModel.writeEnabled: true")
					warn("the view asks to be written and is not: ZTABLE is not a table")
				}
			case "cast column", "cast no alias", "cast literal", "cast bad type":
				cast := "cast( t.id as abap.char(20) )"
				if name == "cast literal" {
					cast = "cast( '' as abap.char(20) )"
				}
				if name == "cast bad type" {
					cast = "cast( t.id as abap.raw(20) )"
				}
				e := ex("CDSElement", "", ex("CDSCast", cast))
				if name != "cast no alias" {
					e.Children = append(e.Children, ex("CDSAs", "", ex("CDSName", "converted")))
				}
				add(e)
				if name == "cast literal" {
					c.Expected = refuse("CONVERTED: a cast this generator cannot read (no column inside it)")
				}
				if name == "cast bad type" {
					c.Expected = refuse("CONVERTED: a cast this generator cannot read (no ABAP type)")
				}
			case "association":
				add(field("_assoc", ""))
			case "expression":
				add(field("id+1", ""))
				add(field("'literal'", ""))
			case "unnamed":
				add(ex("CDSElement", ""))
			case "missing one key", "missing two keys":
				anno("@ObjectModel.writeEnabled: true")
				keys := []string{"MANDT", "OTHER"}
				if name == "missing two keys" {
					keys = append(keys, "LAST")
				}
				c.Objects["TABL:ZTABLE"] = Object{Found: true, Keys: keys}
				warn("the view asks to be written and is not: the key " + strings.Join(keys[1:], ", ") + " of ZTABLE is not a field of the view")
			case "analytical":
				anno("@ObjectModel.writeEnabled: true")
				anno("@Analytics.dataCategory: #CUBE")
				warn("the view asks to be written and is not: an analytical view is read-only")
			case "write table", "create table", "update table", "delete table":
				anno("@ ObjectModel . " + strings.Split(name, " ")[0] + "Enabled : true")
			case "gone plural":
				c.Objects["VIEW:ZGEN"] = Object{Found: true, Components: []string{"OLD", "OLDER"}}
				warn("OLD, OLDER are in the generated view ZGEN and no longer in ZPROBE: whatever reads them breaks when this is generated again")
			case "no sql name":
				o.SQLView = nil
				c.Objects["VIEW:ZPROBE"] = Object{Found: true, Components: []string{"ID"}}
			case "parse error":
				c.Objects["DDLS:ZPROBE"] = o
				got := Issues("ZPROBE", func(typ, n string) Object {
					if typ == "TABL" {
						panic("broken type")
					}
					return c.Objects[typ+":"+n]
				})
				want := []Issue{{o.Files[0].Filename, "E", "the view cannot be read: broken type"}}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("got %#v", got)
				}
				return
			}
			c.Objects["DDLS:ZPROBE"] = o
			checkFacts(t, c)
		})
	}
}
func TestCastTypes(t *testing.T) {
	for _, kind := range []string{"char", "numc", "sstring", "string", "int1", "int2", "int4", "int8", "dats", "tims", "dec", "curr", "quan", "raw", "missing"} {
		t.Run(kind, func(t *testing.T) {
			s := "cast( id as abap." + kind + "(15,2) )"
			if kind == "missing" {
				s = "id"
			}
			if got, want := validCast(s), kind != "raw" && kind != "missing"; got != want {
				t.Fatalf("validCast(%q) = %v", s, got)
			}
		})
	}
}

func TestFactBoundaries(t *testing.T) {
	for _, name := range []string{"BOM blank class", "NEL class", "unicode spaces", "source child order", "cast without alias refusal", "no files", "client named without client table"} {
		t.Run(name, func(t *testing.T) {
			c := fixture(field("id", ""))
			o := c.Objects["DDLS:ZPROBE"]
			switch name {
			case "BOM blank class":
				o.Tree.Children[0].Children = append(o.Tree.Children[0].Children, virtual("\ufeff"))
				c.Expected = refuse("virtual element without an alias or a calculating class")
			case "NEL class":
				o.Tree.Children[0].Children = append(o.Tree.Children[0].Children, virtual("\u0085"))
			case "unicode spaces":
				o.Tree.Children = append(o.Tree.Children, ex("CDSAnnotation", "@\u00a0ObjectModel\u2003.\u2003writeEnabled\u00a0:\u00a0true"))
				o.Tree.Children[0].Children[0].Text = "\ufeffztable\u00a0as\u00a0t"
			case "source child order":
				o.Tree.Children[0].Children[1] = ex("CDSElement", "", ex("CDSPrefixedName", "t.id"), ex("CDSName", "wrong"))
				c.Objects["VIEW:ZGEN"] = Object{Found: true, Components: []string{"ID"}}
			case "cast without alias refusal":
				o.Tree.Children[0].Children = append(o.Tree.Children[0].Children, ex("CDSElement", "", ex("CDSCast", "cast( '' as abap.char(20) )")))
				c.Expected = refuse("?: a cast this generator cannot read (no column inside it)")
			case "no files":
				o.Files = nil
			case "client named without client table":
				c.Objects["TABL:ZTABLE"] = Object{Found: true}
				o.Tree.Children[0].Children = append(o.Tree.Children[0].Children, field("mandt", "client"))
				c.Objects["VIEW:ZGEN"] = Object{Found: true, Components: []string{"CLIENT", "ID"}}
			}
			c.Objects["DDLS:ZPROBE"] = o
			checkFacts(t, c)
		})
	}
	if find(nil, "anything") != nil || annotations(nil) != "" {
		t.Fatal("nil helper defaults")
	}
}

// parseDDLS uses ??, so only absent SQL names fall back to the object name.
func TestAbsentAndEmptySQLView(t *testing.T) {
	for _, tc := range []struct {
		name string
		sql  *string
		want []Issue
	}{
		{"absent", nil, []Issue{{"/src/zprobe.ddls.asddls", "W", "OLD is in the generated view ZPROBE and no longer in ZPROBE: whatever reads it breaks when this is generated again"}}},
		{"empty", stringPtr(""), []Issue{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := fixture(field("t.ID", ""))
			o := c.Objects["DDLS:ZPROBE"]
			o.SQLView = tc.sql
			c.Objects["DDLS:ZPROBE"] = o
			c.Objects["VIEW:ZPROBE"] = Object{Found: true, Components: []string{"OLD"}}
			c.Expected = tc.want
			checkFacts(t, c)
		})
	}
}
