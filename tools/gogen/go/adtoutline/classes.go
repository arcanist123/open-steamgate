package adtoutline

import (
	"regexp"
	"strings"
)

type part struct {
	node   *Node
	token  Token
	source string
}
type declaration struct {
	node, statement          *Node
	kind, visibility, source string
}
type body struct {
	name string
	part *part
}
type owner struct {
	name                       string
	definition, implementation *part
	declarations               []declaration
	bodies                     []body
}

func (o *owner) putBody(name string, p *part) {
	for i := range o.bodies {
		if o.bodies[i].name == name {
			o.bodies[i].part = p
			return
		}
	}
	o.bodies = append(o.bodies, body{name, p})
}
func (o *owner) body(name string) *part {
	for _, b := range o.bodies {
		if b.name == name {
			return b.part
		}
	}
	return nil
}

var includeRE = regexp.MustCompile(`(?i)\.clas\.(locals_def|locals_imp|testclasses|macros)\.abap$`)

func partLinks(def, imp *part, methodType string) []object {
	out := []object{}
	if def != nil {
		out = append(out, link("definitionIdentifier", def.token.Start, def.token.End, def.source, methodType))
	}
	if imp != nil {
		t := ""
		if methodType == "CLAS/OLD" {
			t = methodType
		}
		out = append(out, link("implementationIdentifier", imp.token.Start, imp.token.End, imp.source, t))
	}
	if def != nil {
		out = append(out, link("definitionBlock", def.node.Start, def.node.End, def.source, ""))
	}
	if imp != nil {
		out = append(out, link("implementationBlock", imp.node.Start, imp.node.End, imp.source, ""))
	}
	return out
}
func classParts(files []FileTree, globalName, code string) *element {
	classes := []*owner{}
	get := func(name string) *owner {
		for _, o := range classes {
			if o.name == name {
				return o
			}
		}
		o := &owner{name: name}
		classes = append(classes, o)
		return o
	}
	for _, f := range files {
		source := "./source/main"
		if m := includeRE.FindStringSubmatch(f.Filename); m != nil {
			source = "./includes/" + map[string]string{"locals_def": "definitions", "locals_imp": "implementations", "testclasses": "testclasses", "macros": "macros"}[strings.ToLower(m[1])]
		}
		for _, n := range find(f.Structure, []string{"ClassDefinition", "ClassImplementation", "Interface"}, false) {
			if n.Statement {
				continue
			}
			header := first(n)
			if header == nil || len(header.Tokens) < 2 {
				continue
			}
			token := header.Tokens[1]
			o := get(upper(token.Str))
			p := &part{n, token, source}
			if n.Kind == "ClassImplementation" {
				o.implementation = p
				for _, m := range find(n, []string{"Method"}, false) {
					s := first(m)
					if s == nil || len(s.Tokens) < 2 {
						continue
					}
					t := s.Tokens[1]
					o.putBody(upper(t.Str), &part{m, t, source})
				}
			} else {
				o.definition = p
				visibility := "public"
				for _, d := range find(n, []string{"Public", "Protected", "Private", "MethodDef", "InterfaceDef", "Aliases", "Data", "ClassData", "Constant", "Constants"}, true) {
					s := first(d)
					if s == nil {
						continue
					}
					kind := s.Kind
					if has(kind, "Public", "Protected", "Private") {
						visibility = strings.ToLower(kind)
						continue
					}
					o.declarations = append(o.declarations, declaration{d, s, kind, visibility, source})
				}
			}
		}
	}
	var root *owner
	for _, o := range classes {
		if o.name == globalName {
			root = o
			break
		}
	}
	result := elem(globalName, code).with("children", nil)
	if root != nil {
		result = buildClass(root, false, code)
	}
	for _, o := range classes {
		if o != root {
			result.children = append(result.children, buildClass(o, true, code))
		}
	}
	return result
}
func buildClass(o *owner, local bool, code string) *element {
	methodType := "CLAS/OM"
	if local {
		methodType = "CLAS/OLD"
	}
	children := []*element{}
	listed := map[string]bool{}
	interfaces := map[string]*part{}
	for _, d := range o.declarations {
		tokens := d.statement.Tokens
		if len(tokens) < 2 {
			continue
		}
		at := 1
		keyword := ""
		if has(d.kind, "DataBegin", "ClassDataBegin", "ConstantBegin") {
			keyword = "OF"
		} else if d.kind == "MethodDef" {
			keyword = "METHODS"
		} else if d.kind == "ClassData" {
			keyword = "DATA"
		}
		if keyword != "" {
			at = 0
			for i, t := range tokens {
				if upper(t.Str) == keyword {
					at = i + 1
					break
				}
			}
		}
		if at >= len(tokens) {
			continue
		}
		token := tokens[at]
		name := upper(token.Str)
		declared := &part{d.node, token, d.source}
		var child *element
		if d.kind == "InterfaceDef" {
			interfaces[name] = declared
			child = elem(name, "CLAS/OR").with("links", nil)
			child.links = append(child.links, link("definitionIdentifier", token.Start, token.End, d.source, ""))
			for _, b := range o.bodies {
				if strings.HasPrefix(b.name, name+"~") {
					p := b.part
					child.links = append(child.links, link("implementationIdentifier", p.token.Start, p.token.End, p.source, methodType))
				}
			}
			child.links = append(child.links, link("definitionBlock", d.statement.Start, d.statement.End, d.source, ""))
		} else if d.kind == "MethodDef" {
			listed[name] = true
			level := "instance"
			if upper(tokens[0].Str) == "CLASS" {
				level = "static"
			}
			child = elem(name, methodType).with("visibility", d.visibility).with("level", level).with("clif_name", o.name)
			if strings.Contains(upper(ConcatTokens(tokens)), "FOR TESTING") {
				child.with("testmethod", "true")
			}
			child.with("links", nil)
			child.links = partLinks(declared, o.body(name), methodType)
		} else {
			typ := "CLAS/OA"
			if d.kind == "Aliases" {
				typ = "CLAS/OB"
			}
			child = elem(name, typ).with("visibility", d.visibility)
			if d.kind != "Aliases" {
				level := "instance"
				if has(d.kind, "ClassData", "Constant", "ClassDataBegin", "ConstantBegin") {
					level = "static"
				}
				child.with("level", level)
			}
			child.with("links", nil)
			child.links = partLinks(declared, nil, "")
		}
		children = append(children, child)
	}
	for _, b := range o.bodies {
		if listed[b.name] {
			continue
		}
		p := b.part
		child := elem(b.name, methodType).with("visibility", "public").with("level", "instance").with("clif_name", o.name).with("links", nil)
		if intf := interfaces[strings.Split(b.name, "~")[0]]; intf != nil {
			child.links = append(child.links, link("definitionIdentifier", intf.token.Start, intf.token.End, intf.source, "CLAS/OR"))
		}
		child.links = append(child.links, link("implementationIdentifier", p.token.Start, p.token.End, p.source, methodType), link("implementationBlock", p.node.Start, p.node.End, p.source, ""))
		children = append(children, child)
	}
	header := ""
	if o.definition != nil {
		if s := first(o.definition.node); s != nil {
			header = upper(ConcatTokens(s.Tokens))
		}
	}
	typ := code
	if local {
		typ = "CLAS/OCL"
	}
	result := elem(o.name, typ)
	if !local {
		result.with("visibility", "public")
	}
	if strings.Contains(header, " FINAL") {
		result.with("final", "true")
	}
	if strings.Contains(header, "FOR TESTING") {
		result.with("testclass", "true")
	}
	result.with("links", nil).with("children", nil)
	result.links = partLinks(o.definition, o.implementation, "")
	result.children = children
	return result
}
