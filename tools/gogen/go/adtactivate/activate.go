// Package adtactivate is POST /sap/bc/adt/activation on a host that cannot
// build (docs/osgo-adt-activation.md): the named objects are syntax-checked,
// a clean set becomes active in the object store, and the answer says when
// the running code is still the generation the binary was built from. The
// documents are those of tools/adt-documents.mjs. No ABAP-generated types.
package adtactivate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"osg/gogen/adtref"
	"osg/gogen/objstore"
)

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

// Issue is one finding of a check run (storecheck.ReportIssue).
type Issue struct {
	Severity string `json:"severity"`
	Line     int32  `json:"line"`
	Column   int32  `json:"column"`
	Message  string `json:"message"`
	URI      string `json:"uri,omitempty"`
}

// Report is a CHECKRUN answer: processed with its issues, or notProcessed and why.
type Report struct {
	Status     string  `json:"status"`
	Issues     []Issue `json:"issues"`
	StatusText string  `json:"statusText,omitempty"`
}

// Store is what activation needs of the object store; Default is objstore's.
type Store struct {
	Check  func(typ, name string) Report
	Source func(typ, name string) (string, bool)
	// Activate publishes the whole batch or nothing (objstore.ActivateAll).
	Activate func(objects []adtref.Object) error
	Live     func(typ, name string) bool
}

var Default = Store{Check: checkRun, Source: source, Activate: activateAll, Live: objstore.Live}

func activateAll(objects []adtref.Object) error {
	batch := make([]objstore.Object, len(objects))
	for i, o := range objects {
		batch[i] = objstore.Object{Type: o.Type, Name: o.Name}
	}
	return objstore.ActivateAll(batch)
}

func call(command, typ, name string) objstore.Answer {
	return objstore.Call(map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name})
}

func checkRun(typ, name string) Report {
	a := call("CHECKRUN", typ, name)
	var r Report
	if err := json.Unmarshal([]byte(a.Scalars["EV_JSON"]), &r); err != nil || r.Status == "" {
		why := a.Scalars["EV_ERROR"]
		if why == "" {
			why = "the check run gave no report"
		}
		return Report{Status: "notProcessed", StatusText: why}
	}
	return r
}

func source(typ, name string) (string, bool) {
	a := call("READ", typ, name)
	return a.Scalars["EV_SOURCE"], a.Scalars["EV_ERROR"] == ""
}

const path = "/sap/bc/adt/activation"

// The exact A4H bytes the Node host answers a request without a method with.
const noMethod = `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><namespace id="com.sap.adt"/><type id="ExceptionParameterNotFound"/><message lang="EN">Parameter method could not be found.</message><localizedMessage lang="EN">Parameter method could not be found.</localizedMessage><properties><entry key="T100KEY-ID">SADT_RESOURCE</entry><entry key="T100KEY-NO">017</entry><entry key="T100KEY-V1">method</entry></properties></exc:exception>`

// BuildHeader is the X-OSD-Build value of an activation that published
// source this binary does not run.
const BuildHeader = "published; rebuild osgo to run it"

func xml(status int32, body string) Response {
	return Response{Status: status, Headers: [][2]string{{"content-type", "application/xml; charset=utf-8"}}, Body: []byte(body)}
}

func refuse(status int32, typ, message string) Response {
	return Response{Status: status, Headers: [][2]string{{"content-type", "application/xml; charset=utf-8"}}, Body: adtref.ExceptionDocument(typ, message)}
}

// Serve answers the activation route; handled is false for any other request.
func (st Store) Serve(r Request) (Response, bool) {
	if r.Method != "POST" || strings.TrimSuffix(r.Path, "/") != path {
		return Response{}, false
	}
	methods := adtref.Query(r.Query, "method")
	if len(methods) == 0 {
		return xml(400, noMethod), true
	}
	if methods[0] != "activate" {
		return Response{Status: 200}, true
	}
	// forced is not a boolean (measured 2026-10-04): "false", empty and
	// absent keep the check; anything else skips it
	forced := false
	for _, v := range adtref.Query(r.Query, "forced") {
		if v != "" && v != "false" {
			forced = true
		}
	}
	named := adtref.References(r.Body)
	if len(named) == 0 {
		return refuse(400, "ExceptionInvalidRequest", "no object references in the request"), true
	}
	if expected, ok := adtref.Header(r.Headers, "if-match"); ok {
		if len(named) != 1 {
			return refuse(400, "ExceptionInvalidRequest", "If-Match activation requires exactly one object reference"), true
		}
		tag := strings.Trim(strings.TrimPrefix(strings.TrimSpace(expected), "W/"), `"`)
		current, _ := st.Source(named[0].Type, named[0].Name)
		sum := sha256.Sum256([]byte(current))
		if tag != "*" && tag != hex.EncodeToString(sum[:])[:32] {
			return refuse(412, "ExceptionResourceIsModified", "source changed after it was checked; check and activate again"), true
		}
	}
	var failed []failure
	if !forced {
		for _, o := range named {
			report := st.Check(o.Type, o.Name)
			if report.Status != "processed" {
				why := report.StatusText
				if why == "" {
					why = "the check did not run"
				}
				failed = append(failed, failure{o, []Issue{{Severity: "E", Line: 1, Column: 1,
					Message: "not activated: the syntax check could not run (" + why + "); activate with forced to skip it"}}})
				continue
			}
			for _, i := range report.Issues {
				if isError(i.Severity) {
					failed = append(failed, failure{o, report.Issues})
					break
				}
			}
		}
	}
	if len(failed) > 0 {
		return xml(200, FailureDocument(failed, !forced)), true
	}
	// all or nothing: a batch that cannot be published leaves every object
	// as it was, which is what "Activation was cancelled" says
	if err := st.Activate(named); err != nil {
		var cancelled []failure
		for _, o := range named {
			cancelled = append(cancelled, failure{o, []Issue{{Severity: "E", Line: 1, Column: 1, Message: "not activated: " + err.Error()}}})
		}
		return xml(200, FailureDocument(cancelled, !forced)), true
	}
	var published []adtref.Object
	for _, o := range named {
		if !st.Live(o.Type, o.Name) {
			published = append(published, o)
		}
	}
	response := xml(200, SuccessDocument(!forced, published))
	if len(published) > 0 {
		response.Headers = append(response.Headers, [2]string{"x-osd-build", BuildHeader})
	}
	return response, true
}

var warningOrInfo = regexp.MustCompile(`(?i)^[wi]`)

func isError(severity string) bool { return !warningOrInfo.MatchString(severity) }

type failure struct {
	Object adtref.Object
	Issues []Issue
}

// Observed type words (ACTIVATION_TYPE_WORD); the rest stay name-only.
var typeWord = map[string]string{"PROG": "Program", "CLAS": "Class"}

func describe(o adtref.Object) string {
	if w := typeWord[o.Type]; w != "" {
		return w + " " + o.Name
	}
	return o.Name
}

func properties(checkExecuted, activated, generated bool) string {
	return `<chkl:properties checkExecuted="` + strconv.FormatBool(checkExecuted) + `" activationExecuted="` + strconv.FormatBool(activated) +
		`" generationExecuted="` + strconv.FormatBool(generated) + `"/>`
}

const head = `<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">`

// SuccessDocument is activationSuccessDocument when every object is live.
// Objects published but not live get generationExecuted="false" and a
// warning each, which clients count as a successful activation.
func SuccessDocument(checkExecuted bool, published []adtref.Object) string {
	var b strings.Builder
	b.WriteString(head + properties(checkExecuted, true, len(published) == 0))
	for _, o := range published {
		b.WriteString(`<msg objDescr="` + adtref.Escape(describe(o)) + `" type="W" line="1" href="` + adtref.Escape(adtref.URIOf(o.Type, o.Name)+"/source/main") +
			`" forceSupported="true"><shortText><txt>` + adtref.Escape(o.Name+" is active in the object store; this osgo binary keeps running the code it was built with until it is rebuilt from this tree") +
			`</txt></shortText></msg>`)
	}
	b.WriteString("</chkl:messages>")
	return b.String()
}

// FailureDocument is activationFailureDocument: the cancellation warning and
// one message per issue, linked to its line and column.
func FailureDocument(objects []failure, checkExecuted bool) string {
	var b strings.Builder
	b.WriteString(head + properties(checkExecuted, false, false))
	b.WriteString(`<msg objDescr="" type="W" line="0" href=""><shortText><txt>Activation was cancelled.</txt><txt>"Editing canceled" (EU 202)</txt></shortText></msg>`)
	for _, f := range objects {
		for _, i := range f.Issues {
			typ := "E"
			if s := strings.ToUpper(i.Severity); strings.HasPrefix(s, "W") || strings.HasPrefix(s, "I") {
				typ = s[:1]
			}
			line, column := i.Line, i.Column
			if line < 1 {
				line = 1
			}
			if column < 1 {
				column = 1
			}
			href := i.URI
			if !strings.Contains(href, "#start=") {
				href = adtref.URIOf(f.Object.Type, f.Object.Name) + "/source/main#start=" + strconv.Itoa(int(line)) + "," + strconv.Itoa(int(column))
			}
			b.WriteString(`<msg objDescr="` + adtref.Escape(describe(f.Object)) + `" type="` + typ + `" line="1" href="` + adtref.Escape(href) +
				`" forceSupported="true"><shortText><txt>` + adtref.Escape(i.Message) + `</txt></shortText></msg>`)
		}
	}
	b.WriteString("</chkl:messages>")
	return b.String()
}
