// Package adtref names ADT repository objects: the URI of an object, the
// object of a URI, and the elements of a request body that carry one. It is
// the Go side of uriOf/objectFromUri/requestElements in tools/adt-documents.mjs
// and tools/adt-request-xml.mjs, for the source types the host serves.
package adtref

import (
	"bytes"
	"encoding/xml"
	"net/url"
	"strings"
)

// The ADT core namespace (adtcore:uri, adtcore:name).
const Core = "http://www.sap.com/adt/core"

var collections = [][2]string{{"CLAS", "oo/classes"}, {"INTF", "oo/interfaces"}, {"PROG", "programs/programs"},
	{"INCL", "programs/includes"}, {"DDLS", "ddic/ddl/sources"}, {"SRVD", "ddic/srvd/sources"}}

var adtTypes = map[string]string{"CLAS": "CLAS/OC", "INTF": "INTF/OI", "PROG": "PROG/P", "INCL": "PROG/I",
	"DDLS": "DDLS/DF", "SRVD": "SRVD/SRV"}

// Object is a repository object by type (CLAS, PROG, ...) and upper-case name.
type Object struct{ Type, Name string }

// EncodeURIComponent is JavaScript's, for a name in a URI.
func EncodeURIComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}

// URIOf is /sap/bc/adt/<collection>/<lower-case name>, "" for another type.
func URIOf(typ, name string) string {
	for _, c := range collections {
		if c[0] == typ {
			return "/sap/bc/adt/" + c[1] + "/" + EncodeURIComponent(strings.ToLower(name))
		}
	}
	return ""
}

// ADTType is the ADT type of an object type (CLAS -> CLAS/OC), else the type.
func ADTType(typ string) string {
	if t, ok := adtTypes[typ]; ok {
		return t
	}
	return typ
}

// FromURI is the object a URI names; a fragment, a query and /source/main
// are ignored. ok is false for a URI outside the source collections.
func FromURI(uri string) (Object, bool) {
	path, _, _ := strings.Cut(uri, "#")
	path, _, _ = strings.Cut(path, "?")
	path = strings.TrimSuffix(path, "/source/main")
	for _, c := range collections {
		prefix := "/sap/bc/adt/" + c[1] + "/"
		if strings.HasPrefix(path, prefix) {
			name, err := url.PathUnescape(path[len(prefix):])
			if err != nil || name == "" {
				return Object{}, false
			}
			return Object{c[0], strings.ToUpper(name)}, true
		}
	}
	return Object{}, false
}

// Element is one element of a request body: its namespace, local name,
// attributes by "namespace local", and the index of its parent (-1 for the root).
type Element struct {
	Space, Local string
	Attrs        map[string]string
	Parent       int
}

// Attr is an attribute by namespace ("" for none) and local name.
func (e Element) Attr(space, local string) (string, bool) {
	v, ok := e.Attrs[space+" "+local]
	return v, ok
}

// Elements reads a request body into its elements in document order. The
// shared ABAP front has already admitted the body; an unreadable rest is
// cut off, never guessed at.
func Elements(body []byte) []Element {
	d := xml.NewDecoder(bytes.NewReader(body))
	var out []Element
	var stack []int
	for {
		tok, err := d.Token()
		if err != nil {
			return out
		}
		switch t := tok.(type) {
		case xml.StartElement:
			parent := -1
			if len(stack) > 0 {
				parent = stack[len(stack)-1]
			}
			attrs := map[string]string{}
			for _, a := range t.Attr {
				attrs[a.Name.Space+" "+a.Name.Local] = a.Value
			}
			out = append(out, Element{t.Name.Space, t.Name.Local, attrs, parent})
			stack = append(stack, len(out)-1)
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
}

// References are the objects of every element with an adtcore:uri, in order
// (objectReferencesIn): what an activation names.
func References(body []byte) []Object {
	var out []Object
	for _, e := range Elements(body) {
		if uri, ok := e.Attr(Core, "uri"); ok {
			if o, ok := FromURI(uri); ok {
				out = append(out, o)
			}
		}
	}
	return out
}

// Escape is XML attribute and text escaping.
var Escape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace

// Header is the first value of a request header, case-insensitively.
func Header(headers [][2]string, name string) (string, bool) {
	for _, h := range headers {
		if strings.EqualFold(h[0], name) {
			return h[1], true
		}
	}
	return "", false
}

// Query is the values of one query parameter.
func Query(query, name string) []string {
	values, err := url.ParseQuery(query)
	if err != nil {
		return nil
	}
	return values[name]
}

// ExceptionDocument is the exc:exception of exceptionDocument in
// tools/adt-documents.mjs, with no properties.
func ExceptionDocument(typ, message string) []byte {
	return []byte(`<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="` + Escape(typ) + `"/>
  <message lang="EN">` + Escape(message) + `</message>
  <localizedMessage lang="EN">` + Escape(message) + `</localizedMessage>
  <properties/>
</exc:exception>
`)
}
