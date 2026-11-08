// Package adtread serves the read-only ADT routes that the shared ABAP front
// leaves to its host (an x-osd-served-by HOST verdict), as the Node facade
// does in tools/adt-facade.mjs. It has no ABAP-generated types.
package adtread

import (
	"encoding/base64"
	"net/url"
	"regexp"
	"strings"

	"osg/gogen/objstore"
)

type Request struct {
	Method, Path string
	Headers      [][2]string
}
type Response struct {
	Status  int32
	Headers [][2]string
	Body    []byte
}

// Inactive is the source of the inactive set; objstore.Inactive by default.
var Inactive = objstore.Inactive

// Serve answers a request it owns; handled is false for every other one.
func Serve(r Request) (response Response, handled bool) {
	if r.Method == "GET" && strings.TrimSuffix(r.Path, "/") == "/sap/bc/adt/activation/inactiveobjects" {
		return Response{Status: 200,
			Headers: [][2]string{{"content-type", "application/vnd.sap.adt.inactivectsobjects.v1+xml; charset=utf-8"}},
			Body:    []byte(InactiveObjectsDocument(Inactive(), user(r.Headers)))}, true
	}
	return Response{}, false
}

var basic = regexp.MustCompile(`(?i)^Basic\s+(\S+)`)

// user is the logon user Basic credentials name, DEVELOPER without them;
// the inactive set is the system's, so every user sees all of it.
func user(headers [][2]string) string {
	for _, h := range headers {
		if strings.EqualFold(h[0], "authorization") {
			if m := basic.FindStringSubmatch(strings.TrimSpace(h[1])); m != nil {
				if raw, err := base64.StdEncoding.DecodeString(m[1]); err == nil {
					if name, _, _ := strings.Cut(string(raw), ":"); name != "" {
						return strings.ToUpper(name)
					}
				}
			}
		}
	}
	return "DEVELOPER"
}

var collections = map[string]string{"CLAS": "oo/classes", "INTF": "oo/interfaces", "PROG": "programs/programs",
	"INCL": "programs/includes", "DDLS": "ddic/ddl/sources", "SRVD": "ddic/srvd/sources"}
var adtTypes = map[string]string{"CLAS": "CLAS/OC", "INTF": "INTF/OI", "PROG": "PROG/P", "INCL": "PROG/I",
	"DDLS": "DDLS/DF", "SRVD": "SRVD/SRV"}

var escaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

// encodeURIComponent as JavaScript has it, for an object or package name.
func encodeURIComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}

// InactiveObjectsDocument is the ioc:inactiveObjects feed of tools/adt-documents.mjs.
func InactiveObjectsDocument(rows []objstore.Row, user string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
`)
	for i, o := range rows {
		if i > 0 {
			b.WriteString("\n")
		}
		uri := ""
		if c, ok := collections[o.TYPE]; ok {
			uri = "/sap/bc/adt/" + c + "/" + encodeURIComponent(strings.ToLower(o.NAME))
		}
		parent := ""
		if o.PACKAGE != "" {
			parent = ` adtcore:parentUri="/sap/bc/adt/packages/` + escaper.Replace(encodeURIComponent(strings.ToLower(o.PACKAGE))) + `"`
		}
		typ := adtTypes[o.TYPE]
		if typ == "" {
			typ = o.TYPE
		}
		b.WriteString(`    <ioc:entry>
      <ioc:object ioc:user="` + escaper.Replace(user) + `" ioc:linked="" ioc:deleted="false">
        <ioc:ref adtcore:uri="` + escaper.Replace(uri) + `" adtcore:type="` + escaper.Replace(typ) + `" adtcore:name="` + escaper.Replace(o.NAME) + `"` + parent + `/>
      </ioc:object>
      <ioc:transport/>
    </ioc:entry>`)
	}
	b.WriteString("\n</ioc:inactiveObjects>\n")
	return b.String()
}
