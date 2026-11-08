// Package adtwrite implements the Go host continuation for ADT source mutations.
package adtwrite

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"net/url"
	"strings"

	"osg/gogen/objstore"
)

// Session is the request's resolved ABAP session. The host invokes Serve in
// the same serialized dialog step as the ABAP front and the ENQ check.
type Session interface {
	Holds(handle, typ, name string) bool
	Release(handle, typ, name string)
}

type Request struct {
	Method, Path, Query string
	Headers             [][2]string
	Body                []byte
}
type Response struct {
	Status  int32
	Headers [][2]string
	Body    []byte
}

func refuse(status int32, kind, message string) Response {
	var escaped strings.Builder
	_ = xml.EscapeText(&escaped, []byte(message))
	return Response{Status: status, Headers: [][2]string{{"content-type", "application/xml; charset=utf-8"}}, Body: []byte(`<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><namespace id="com.sap.adt"/><type id="` + kind + `"/><message lang="EN">` + escaped.String() + `</message><localizedMessage lang="EN">` + escaped.String() + `</localizedMessage><properties/></exc:exception>`)}
}
func failure(err error) Response {
	var e *objstore.MutationError
	if errors.As(err, &e) {
		switch e.Code {
		case "NOT_FOUND":
			return refuse(404, "ExceptionResourceNotFound", e.Message)
		case "CONFLICT":
			return refuse(409, "ExceptionResourceAlreadyExists", e.Message)
		case "READ_ONLY":
			return refuse(405, "ExceptionResourceNoAccess", e.Message)
		case "INVALID_NAME":
			return refuse(400, "ExceptionInvalidRequest", e.Message)
		case "NOT_SUPPORTED":
			return refuse(501, "ExceptionNotSupported", e.Message)
		}
	}
	return refuse(500, "ExceptionInternalError", "source mutation failed")
}
func call(command, typ, name, include string, source *string) objstore.Answer {
	return objstore.Call(map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name, "IV_INCLUDE": &include, "IV_SOURCE": source})
}
func tag(source string) string {
	sum := sha256.Sum256([]byte(source))
	return hex.EncodeToString(sum[:])[:32]
}

// Match the CRLF templates served for absent includes by zcl_osd_adt_source.
var classIncludeTemplates = map[string]string{
	"definitions":     "*\"* use this source file for any type of declarations (class\r\n*\"* definitions, interfaces or type declarations) you need for\r\n*\"* components in the private section\r\n",
	"macros":          "*\"* use this source file for any macro definitions you need\r\n*\"* in the implementation part of the class\r\n",
	"implementations": "*\"* use this source file for the definition and implementation of\r\n*\"* local helper classes, interface definitions and type\r\n*\"* declarations\r\n",
}

func normalizedTag(s string) string {
	return strings.Trim(strings.TrimPrefix(strings.TrimSpace(s), "W/"), `"`)
}
func attribute(start xml.StartElement, space, name string) string {
	for _, a := range start.Attr {
		if a.Name.Space == space && a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

const core = "http://www.sap.com/adt/core"

// ABAP has already validated the envelope. Parse by namespace as Node does,
// rather than depending on the caller's prefix spelling.
func envelope(body []byte) (name, home, description, include string, err error) {
	d := xml.NewDecoder(strings.NewReader(string(body)))
	first := true
	for {
		t, e := d.Token()
		if e == io.EOF {
			return
		}
		if e != nil {
			err = e
			return
		}
		if s, ok := t.(xml.StartElement); ok {
			if first {
				name = attribute(s, core, "name")
				description = attribute(s, core, "description")
				include = attribute(s, "http://www.sap.com/adt/oo/classes", "includeType")
				first = false
			}
			if s.Name.Space == core && s.Name.Local == "packageRef" {
				home = attribute(s, core, "name")
				if home == "" {
					home = attribute(s, core, "packageName")
				}
			}
		}
	}
}

// Serve returns false for HOST operations outside this package's scope. It
// must only run after the ABAP handler returned HOST (CSRF/XML validation).
func Serve(r Request, session Session) (Response, bool) {
	path := strings.TrimPrefix(r.Path, "/sap/bc/adt/")
	typ, collection, tail := "", "", ""
	for _, c := range []struct{ path, typ string }{{"oo/classes", "CLAS"}, {"oo/interfaces", "INTF"}, {"programs/programs", "PROG"}} {
		if path == c.path || strings.HasPrefix(path, c.path+"/") {
			typ, collection = c.typ, c.path
			tail = strings.TrimPrefix(strings.TrimPrefix(path, c.path), "/")
			break
		}
	}
	if typ == "" {
		return Response{}, false
	}
	query, _ := url.ParseQuery(r.Query)
	if r.Method == "POST" && tail == "" {
		name, home, description, _, err := envelope(r.Body)
		if err != nil || name == "" {
			return refuse(400, "ExceptionInvalidRequest", "the create body names no object"), true
		}
		if err = objstore.CreateSource(typ, name, home, description); err != nil {
			var e *objstore.MutationError
			if errors.As(err, &e) && e.Code == "CONFLICT" {
				if typ == "CLAS" {
					return refuse(400, "ExceptionResourceAlreadyExists", "Class "+strings.ToUpper(name)+" already exists"), true
				}
				if typ == "PROG" {
					return refuse(500, "ExceptionResourceCreationFailure", "A program or include already exists with the name "+strings.ToUpper(name)), true
				}
			}
			return failure(err), true
		}
		if typ == "CLAS" || typ == "PROG" {
			return Response{Status: 200}, true
		}
		return Response{Status: 201, Headers: [][2]string{{"location", "/sap/bc/adt/" + collection + "/" + url.PathEscape(strings.ToLower(name))}}}, true
	}
	parts := strings.Split(tail, "/")
	name, err := url.PathUnescape(parts[0])
	if err != nil {
		return refuse(400, "ExceptionInvalidRequest", "invalid object name"), true
	}
	name = strings.ToUpper(name)
	include := "main"
	isPut := r.Method == "PUT" && len(parts) == 3 && parts[1] == "source" && parts[2] == "main"
	isInclude := typ == "CLAS" && len(parts) >= 3 && parts[1] == "includes" && (len(parts) == 3 || len(parts) == 5 && parts[3] == "source" && parts[4] == "main")
	if isInclude {
		include = parts[2]
		isPut = r.Method == "PUT"
	}
	isCreateInclude := typ == "CLAS" && r.Method == "POST" && len(parts) == 2 && parts[1] == "includes"
	isDelete := r.Method == "DELETE" && len(parts) == 1 && name != ""
	if !isPut && !isDelete && !isCreateInclude {
		return Response{}, false
	}
	handle := query.Get("lockHandle")
	if typ == "CLAS" && include == "testclasses" && handle == "" {
		return refuse(400, "ExceptionParameterNotFound", "Parameter lockHandle could not be found"), true
	}
	if session == nil || !session.Holds(handle, typ, name) {
		status, kind := int32(409), "ExceptionResourceNotLocked"
		if typ == "CLAS" && (include == "main" || include == "testclasses") {
			status, kind = 423, "ExceptionResourceInvalidLockHandle"
		}
		return refuse(status, kind, "the lock handle does not hold this object in this session"), true
	}
	if isDelete {
		if err := objstore.DeleteSource(typ, name); err != nil {
			return failure(err), true
		}
		session.Release(handle, typ, name)
		return Response{Status: 200}, true
	}
	if isCreateInclude {
		_, _, _, include, err = envelope(r.Body)
		if err != nil || include == "" || include == "main" {
			return refuse(400, "ExceptionInvalidRequest", "the create body names no include type"), true
		}
	}
	part := call("READ", typ, name, include, nil)
	if part.Scalars["EV_ERROR"] != "" {
		return refuse(404, "ExceptionResourceNotFound", "source does not exist"), true
	}
	var info struct{ Empty bool }
	_ = json.Unmarshal([]byte(part.Scalars["EV_JSON"]), &info)
	if isCreateInclude && !info.Empty {
		return refuse(409, "ExceptionResourceAlreadyExists", "include already exists"), true
	}
	if !isCreateInclude && typ == "CLAS" && include == "testclasses" && info.Empty {
		return refuse(500, "ExceptionResourceSaveFailure", "create the testclasses include before saving it"), true
	}
	current := part.Scalars["EV_SOURCE"]
	if typ == "CLAS" && info.Empty {
		current = classIncludeTemplates[include]
	}
	for _, h := range r.Headers {
		if strings.EqualFold(h[0], "if-match") && normalizedTag(h[1]) != "*" && normalizedTag(h[1]) != tag(current) {
			return refuse(412, "ExceptionResourceIsModified", "source changed since it was opened; reload before saving"), true
		}
	}
	source := string(r.Body)
	if isCreateInclude {
		source = ""
	}
	written := call("WRITE", typ, name, include, &source)
	if written.Scalars["EV_ERROR"] != "" {
		return refuse(405, "ExceptionResourceNoAccess", "source cannot be changed here"), true
	}
	if isCreateInclude {
		return Response{Status: 201, Headers: [][2]string{{"location", "/sap/bc/adt/" + collection + "/" + url.PathEscape(strings.ToLower(name)) + "/includes/" + include}}}, true
	}
	stored := call("READ", typ, name, include, nil)
	return Response{Status: 200, Headers: [][2]string{{"etag", `"` + tag(stored.Scalars["EV_SOURCE"]) + `"`}}}, true
}
