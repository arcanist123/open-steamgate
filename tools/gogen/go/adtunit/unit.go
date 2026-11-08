// Package adtunit is POST /sap/bc/adt/abapunit/testruns (and its
// evaluation) on a host that runs the test classes compiled into it
// (docs/osgo-adt-activation.md). The host supplies the classes and an
// Executor that runs ABAP in isolation; this package selects, runs and
// answers with the aunit:runResult of tools/adt-unit-result.mjs (the class
// protocol). No ABAP-generated types.
package adtunit

import (
	"regexp"
	"sort"
	"strings"
	"time"

	"osg/gogen/adtref"
)

// Method is a test method and where its body is.
type Method struct {
	Name         string
	Line, Column int
}

// Class is one local test class of an owner, as the build compiled it.
// ClassSetup and ClassTeardown are nil when the class has none; New makes
// a fresh instance for one method, ABAP Unit's way.
type Class struct {
	Name, Include, Risk, Duration string
	Line, Column                  int
	Methods                       []Method
	ClassSetup, ClassTeardown     func(step any)
	New                           func(step any) Instance
}

// Instance is one test object: its setup and teardown (nil when absent) and
// a call for each test method by upper-case name.
type Instance struct {
	Setup, Teardown func()
	Methods         map[string]func()
}

// Frame is one stack entry, as a file name and line of ABAP source.
type Frame struct {
	File string
	Line int
}

// Alert is what failed: kind failedAssertion, exception or shortDump.
type Alert struct {
	Kind, Severity, Title string
	// Message is the assertion's own msg; AssertMethod the assert_* method.
	Message, AssertMethod string
	Expected, Actual      string
	Details               []string
	Stack                 []Frame
}

// Executor runs ABAP for a test class. Begin isolates one class (a fresh
// session on its own database) and returns its step and the end of it;
// Catch runs f and turns what it raised into an alert, nil when it returned.
type Executor interface {
	Begin() (step any, end func(), err error)
	Catch(f func()) *Alert
}

// Host is what the routes need of the binary.
type Host struct {
	// Owners: the test classes compiled into this binary, by owner class.
	Owners map[string][]Class
	Exec   Executor
	// Live: the object is the source this binary was built from.
	Live func(typ, name string) bool
	// HasTests: the class has a test include in the object store.
	HasTests func(name string) bool
	// Build says how to compile an owner's tests into the binary.
	Build string
}

type Request struct {
	Method, Path string
	Headers      [][2]string
	Body         []byte
}
type Response struct {
	Status  int32
	Headers [][2]string
	Body    []byte
}

const aunit = "http://www.sap.com/adt/aunit"

// MethodResult and ClassResult are a run's outcome.
type MethodResult struct {
	Method
	Seconds float64
	Alerts  []Alert
}
type ClassResult struct {
	Class
	Alerts  []Alert
	Results []MethodResult
}

type refusal struct {
	status int32
	typ    string
	msg    string
}

func refuse(status int32, typ, msg string) Response {
	return Response{Status: status, Headers: [][2]string{{"content-type", "application/xml; charset=utf-8"}}, Body: adtref.ExceptionDocument(typ, msg)}
}

var selector = regexp.MustCompile(`(?i)^#testclass=([^;"#]+)(?:;testmethod=([^;"#]+))?$`)

// Serve answers the two routes; handled is false for any other request.
func (h Host) Serve(r Request) (Response, bool) {
	p := strings.TrimSuffix(r.Path, "/")
	if r.Method != "POST" || p != "/sap/bc/adt/abapunit/testruns" && p != "/sap/bc/adt/abapunit/testruns/evaluation" {
		return Response{}, false
	}
	elements := adtref.Elements(r.Body)
	var references []string
	for _, e := range elements {
		if e.Space == adtref.Core && e.Local == "objectReference" {
			if uri, ok := e.Attr(adtref.Core, "uri"); ok {
				references = append(references, uri)
			}
		}
	}
	var named []adtref.Object
	for _, uri := range references {
		if o, ok := adtref.FromURI(uri); ok {
			named = append(named, o)
		}
	}
	accept, _ := adtref.Header(r.Headers, "accept")
	kind := "result"
	var testClass, method string
	if strings.HasSuffix(p, "/evaluation") {
		if len(named) == 0 {
			return refuse(400, "ExceptionInvalidRequest", "no object references in the request"), true
		}
		kind = "evaluation.result"
	} else {
		if len(named) != 1 || len(references) != 1 {
			msg := "one object reference is required"
			if len(references) > 1 {
				msg = "exactly one object reference is supported"
			}
			return refuse(400, "ExceptionInvalidRequest", msg), true
		}
		if i := strings.Index(references[0], "#"); i >= 0 {
			m := selector.FindStringSubmatch(references[0][i:])
			if m == nil {
				return refuse(400, "ExceptionInvalidRequest", "invalid ABAP Unit testclass/testmethod selector"), true
			}
			testClass, method = decode(m[1]), decode(m[2])
			if testClass == "\x00" || method == "\x00" {
				return refuse(400, "ExceptionInvalidRequest", "URI malformed"), true
			}
		}
	}
	results, fail := h.run(named[0], testClass, method)
	if fail != nil {
		return refuse(fail.status, fail.typ, fail.msg), true
	}
	body := Document(named[0].Name, results, withNavigation(elements))
	return Response{Status: 200, Headers: [][2]string{{"content-type", ResultType(accept, kind) + "; charset=utf-8"}}, Body: []byte(body)}, true
}

func decode(s string) string {
	if s == "" {
		return ""
	}
	v, err := urlUnescape(s)
	if err != nil {
		return "\x00"
	}
	return strings.ToUpper(v)
}

// withNavigation is the run configuration's options/withNavigationUri enabled.
func withNavigation(elements []adtref.Element) bool {
	config := -1
	for i, e := range elements {
		if e.Space == aunit && e.Local == "runConfiguration" {
			config = i
			break
		}
	}
	for i, o := range elements {
		if o.Parent != config || config < 0 || o.Local != "options" || o.Space != "" && o.Space != aunit {
			continue
		}
		for _, e := range elements {
			if e.Parent == i && e.Local == "withNavigationUri" && (e.Space == "" || e.Space == aunit) {
				v, _ := e.Attr("", "enabled")
				return v != "false" && v != "0"
			}
		}
	}
	return true
}

var version = regexp.MustCompile(`testruns\.(?:evaluation\.)?result\.v(\d)`)

// ResultType is the media type a run result is named by, after the Accept
// header (unitResultType in tools/adt-facade.mjs).
func ResultType(accept, kind string) string {
	if strings.Contains(accept, "junit.run-result") {
		return "application/vnd.sap.adt.api.junit.run-result.v1+xml"
	}
	v := "2"
	if m := version.FindStringSubmatch(accept); m != nil {
		v = m[1]
	}
	return "application/vnd.sap.adt.abapunit.testruns." + kind + ".v" + v + "+xml"
}

func (h Host) run(o adtref.Object, testClass, method string) ([]ClassResult, *refusal) {
	if o.Type != "CLAS" {
		return nil, &refusal{409, "ExceptionTestRunFailed", o.Type + " " + o.Name + ": ABAP Unit on osgo runs the test include of a class only"}
	}
	classes, compiled := h.Owners[o.Name]
	if !compiled && (h.HasTests == nil || !h.HasTests(o.Name)) {
		if testClass != "" {
			return nil, &refusal{404, "ExceptionResourceNotFound", "test class " + testClass + " does not belong to " + o.Name}
		}
		return nil, nil
	}
	if !compiled {
		return nil, &refusal{409, "ExceptionTestRunFailed", "the tests of " + o.Name + " are not compiled into this osgo binary; " + h.Build}
	}
	if h.Live != nil && !h.Live("CLAS", o.Name) {
		return nil, &refusal{409, "ExceptionTestRunFailed", o.Name + " changed since this osgo binary was built: its tests would run the old code. Rebuild osgo from this tree to run them"}
	}
	var selected []Class
	for _, c := range classes {
		if testClass == "" || c.Name == testClass {
			selected = append(selected, c)
		}
	}
	if testClass != "" && len(selected) == 0 {
		return nil, &refusal{404, "ExceptionResourceNotFound", "test class " + testClass + " does not belong to " + o.Name}
	}
	if method != "" {
		found := false
		for _, m := range selected[0].Methods {
			found = found || m.Name == method
		}
		if !found {
			return nil, &refusal{404, "ExceptionResourceNotFound", "test method " + testClass + "=>" + method + " does not belong to " + o.Name}
		}
	}
	var out []ClassResult
	for _, c := range selected {
		res, err := h.runClass(c, method)
		if err != nil {
			return nil, &refusal{500, "ExceptionTestRunFailed", err.Error()}
		}
		out = append(out, res)
	}
	return out, nil
}

func (h Host) runClass(c Class, only string) (ClassResult, error) {
	res := ClassResult{Class: c}
	step, end, err := h.Exec.Begin()
	if err != nil {
		return res, err
	}
	defer end()
	if c.ClassSetup != nil {
		if a := h.Exec.Catch(func() { c.ClassSetup(step) }); a != nil {
			res.Alerts = append(res.Alerts, where(*a, "class_setup"))
			return res, nil
		}
	}
	for _, m := range c.Methods {
		if only != "" && m.Name != only {
			continue
		}
		started := time.Now()
		var alerts []Alert
		var test Instance
		if a := h.Exec.Catch(func() {
			test = c.New(step)
			if test.Setup != nil {
				test.Setup()
			}
		}); a != nil {
			alerts = append(alerts, where(*a, "setup"))
		} else {
			if a := h.Exec.Catch(func() {
				call, ok := test.Methods[m.Name]
				if !ok {
					panic("test method " + m.Name + " is not compiled")
				}
				call()
			}); a != nil {
				alerts = append(alerts, where(*a, m.Name))
			}
			if test.Teardown != nil {
				if a := h.Exec.Catch(test.Teardown); a != nil {
					alerts = append(alerts, where(*a, "teardown"))
				}
			}
		}
		res.Results = append(res.Results, MethodResult{Method: m, Seconds: time.Since(started).Seconds(), Alerts: alerts})
	}
	if c.ClassTeardown != nil {
		if a := h.Exec.Catch(func() { c.ClassTeardown(step) }); a != nil {
			res.Alerts = append(res.Alerts, where(*a, "class_teardown"))
		}
	}
	sort.SliceStable(res.Results, func(i, j int) bool { return res.Results[i].Name < res.Results[j].Name })
	return res, nil
}

// where adds "Raised in <stage>" as the Node runner's alertOf does.
func where(a Alert, stage string) Alert {
	a.Details = append(append([]string(nil), a.Details...), "Raised in "+strings.ToLower(stage))
	return a
}
