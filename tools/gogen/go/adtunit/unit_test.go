package adtunit

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
)

// fakeExec runs closures directly; a panic with an *Alert is that alert.
type fakeExec struct{ begun, ended int }

func (f *fakeExec) Begin() (any, func(), error) { f.begun++; return "step", func() { f.ended++ }, nil }
func (f *fakeExec) Catch(fn func()) (a *Alert) {
	defer func() {
		if x := recover(); x != nil {
			if al, ok := x.(*Alert); ok {
				a = al
				return
			}
			a = &Alert{Kind: "shortDump", Severity: "fatal", Title: "boom"}
		}
	}()
	fn()
	return nil
}

var deliberate = &Alert{Kind: "failedAssertion", Severity: "critical", Title: "ZOSD_TEST: this assertion fails on purpose",
	Message: "ZOSD_TEST: this assertion fails on purpose", AssertMethod: "assert_equals", Expected: "Open", Actual: "Closed",
	Stack: []Frame{{"cl_abap_unit_assert.clas.abap", 467}, {"zcl_zosd_test_demo.clas.testclasses.abap", 34}}}

func demo() map[string][]Class {
	return map[string][]Class{"ZCL_ZOSD_TEST_DEMO": {{
		Name: "LTCL_ZOSD_TEST_DEMO", Include: "testclasses", Risk: "harmless", Duration: "short", Line: 1, Column: 6,
		Methods: []Method{{"GREETING_PASSES", 12, 2}, {"DELIBERATE_FAILURE", 27, 2}},
		New: func(step any) Instance {
			if step != "step" {
				panic("wrong step")
			}
			return Instance{Methods: map[string]func(){
				"GREETING_PASSES":    func() {},
				"DELIBERATE_FAILURE": func() { panic(deliberate) },
			}}
		},
	}}}
}

const config = `<?xml version="1.0" encoding="UTF-8"?><aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit"><options><withNavigationUri enabled="%s"/></options><adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="%s"/></adtcore:objectReferences></objectSet></adtcore:objectSets></aunit:runConfiguration>`

func body(uri, navigation string) []byte {
	return []byte(strings.Replace(strings.Replace(config, "%s", navigation, 1), "%s", uri, 1))
}

var times = regexp.MustCompile(`executionTime="[0-9.]+"`)

func serve(t *testing.T, h Host, path, uri string) Response {
	t.Helper()
	r, ok := h.Serve(Request{Method: "POST", Path: path, Headers: [][2]string{{"Accept", "application/vnd.sap.adt.abapunit.testruns.result.v2+xml"}}, Body: body(uri, "true")})
	if !ok {
		t.Fatal("not handled")
	}
	return r
}

func TestRunMatchesTheNodeDocument(t *testing.T) {
	exec := &fakeExec{}
	h := Host{Owners: demo(), Exec: exec, Live: func(string, string) bool { return true }}
	r := serve(t, h, "/sap/bc/adt/abapunit/testruns", "/sap/bc/adt/oo/classes/zcl_zosd_test_demo")
	want, err := os.ReadFile("testdata/node-demo-run.xml")
	if err != nil {
		t.Fatal(err)
	}
	got := times.ReplaceAllString(string(r.Body), `executionTime="0"`)
	if r.Status != 200 || got != string(want) {
		t.Fatalf("status %d\n--- got\n%s\n--- want\n%s", r.Status, got, want)
	}
	if r.Headers[0][1] != "application/vnd.sap.adt.abapunit.testruns.result.v2+xml; charset=utf-8" || exec.begun != 1 || exec.ended != 1 {
		t.Fatal(r.Headers, exec)
	}
}

func TestSelectorsAndRefusals(t *testing.T) {
	live := true
	h := Host{Owners: demo(), Exec: &fakeExec{}, Live: func(string, string) bool { return live },
		HasTests: func(name string) bool { return name == "ZCL_UNBUILT" }, Build: "build with --unit-owners"}
	base := "/sap/bc/adt/oo/classes/zcl_zosd_test_demo"
	r := serve(t, h, "/sap/bc/adt/abapunit/testruns", base+"#testclass=ltcl_zosd_test_demo;testmethod=greeting_passes")
	if s := string(r.Body); r.Status != 200 || strings.Contains(s, "DELIBERATE_FAILURE") || !strings.Contains(s, "GREETING_PASSES") || strings.Contains(s, "<alert ") {
		t.Fatal(s)
	}
	r = serve(t, h, "/sap/bc/adt/abapunit/testruns", base+"#testclass=ltcl_zosd_test_demo;testmethod=deliberate_failure")
	if s := string(r.Body); strings.Count(s, "<alert ") != 1 || strings.Contains(s, "GREETING_PASSES") {
		t.Fatal(s)
	}
	for uri, status := range map[string]int32{
		base + "#testclass=nope":                             404,
		base + "#testclass=ltcl_zosd_test_demo;testmethod=x": 404,
		base + "#junk":                       400,
		"/sap/bc/adt/oo/classes/zcl_unbuilt": 409,
		"/sap/bc/adt/programs/programs/zp":   409,
		"/sap/bc/adt/ddic/tables/zt":         400,
	} {
		if r := serve(t, h, "/sap/bc/adt/abapunit/testruns", uri); r.Status != status {
			t.Fatal(uri, r.Status, string(r.Body))
		}
	}
	r = serve(t, h, "/sap/bc/adt/abapunit/testruns", "/sap/bc/adt/oo/classes/zcl_no_tests")
	if r.Status != 200 || strings.Contains(string(r.Body), "<testClass ") {
		t.Fatal(string(r.Body))
	}
	live = false
	r = serve(t, h, "/sap/bc/adt/abapunit/testruns", base)
	if r.Status != 409 || !strings.Contains(string(r.Body), "Rebuild osgo from this tree") {
		t.Fatal(r.Status, string(r.Body))
	}
	live = true
	r = serve(t, h, "/sap/bc/adt/abapunit/testruns/evaluation", base+"#testclass=ltcl_zosd_test_demo;testmethod=greeting_passes")
	if r.Status != 200 || !strings.Contains(string(r.Body), "DELIBERATE_FAILURE") || !strings.HasPrefix(r.Headers[0][1], "application/vnd.sap.adt.abapunit.testruns.evaluation.result.v2+xml") {
		t.Fatal(r.Status, r.Headers, string(r.Body))
	}
	two := []byte(strings.Replace(string(body(base, "true")), "</adtcore:objectReferences>", `<adtcore:objectReference adtcore:uri="`+base+`"/></adtcore:objectReferences>`, 1))
	if r, _ := h.Serve(Request{Method: "POST", Path: "/sap/bc/adt/abapunit/testruns", Body: two}); r.Status != 400 {
		t.Fatal(r.Status)
	}
	if _, ok := h.Serve(Request{Method: "GET", Path: "/sap/bc/adt/abapunit/testruns"}); ok {
		t.Fatal("GET handled")
	}
}

func TestClassSetupFailureAndNavigationOff(t *testing.T) {
	owners := demo()
	c := owners["ZCL_ZOSD_TEST_DEMO"][0]
	c.ClassSetup = func(any) {
		panic(&Alert{Kind: "exception", Severity: "critical", Title: "Exception CX_X was not caught"})
	}
	owners["ZCL_ZOSD_TEST_DEMO"][0] = c
	h := Host{Owners: owners, Exec: &fakeExec{}}
	r, _ := h.Serve(Request{Method: "POST", Path: "/sap/bc/adt/abapunit/testruns", Body: body("/sap/bc/adt/oo/classes/zcl_zosd_test_demo", "false")})
	s := string(r.Body)
	if strings.Contains(s, "navigationUri") || !strings.Contains(s, "Exception CX_X was not caught") || strings.Contains(s, "<testMethod ") ||
		!strings.Contains(s, "Test 'LTCL_ZOSD_TEST_DEMO-&gt;CLASS_SETUP'") {
		t.Fatal(s)
	}
}

func TestResultTypeAndBeginError(t *testing.T) {
	if ResultType("application/vnd.sap.adt.api.junit.run-result.v1+xml", "result") != "application/vnd.sap.adt.api.junit.run-result.v1+xml" ||
		ResultType("application/vnd.sap.adt.abapunit.testruns.result.v1+xml", "result") != "application/vnd.sap.adt.abapunit.testruns.result.v1+xml" {
		t.Fatal("result type")
	}
	h := Host{Owners: demo(), Exec: failing{}}
	r, _ := h.Serve(Request{Method: "POST", Path: "/sap/bc/adt/abapunit/testruns", Body: body("/sap/bc/adt/oo/classes/zcl_zosd_test_demo", "true")})
	if r.Status != 500 || !strings.Contains(string(r.Body), "no database") {
		t.Fatal(r.Status, string(r.Body))
	}
}

type failing struct{}

func (failing) Begin() (any, func(), error) { return nil, nil, errors.New("no database") }
func (failing) Catch(f func()) *Alert       { return nil }
