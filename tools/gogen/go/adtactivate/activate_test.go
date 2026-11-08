package adtactivate

import (
	"errors"

	"osg/gogen/adtref"
	"strings"
	"testing"
)

const body = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a" adtcore:name="ZCL_A"/></adtcore:objectReferences>`

type fake struct {
	report    Report
	live      bool
	activated []string
	batches   int
	fail      error
}

func (f *fake) store() Store {
	return Store{
		Check:  func(typ, name string) Report { return f.report },
		Source: func(typ, name string) (string, bool) { return "src", true },
		Activate: func(objects []adtref.Object) error {
			f.batches++
			if f.fail != nil {
				return f.fail
			}
			for _, o := range objects {
				f.activated = append(f.activated, o.Type+" "+o.Name)
			}
			return nil
		},
		Live: func(typ, name string) bool { return f.live },
	}
}

func post(st Store, query string, headers [][2]string) Response {
	r, ok := st.Serve(Request{Method: "POST", Path: "/sap/bc/adt/activation", Query: query, Headers: headers, Body: []byte(body)})
	if !ok {
		panic("not handled")
	}
	return r
}

func TestRoutesAndParameters(t *testing.T) {
	f := &fake{report: Report{Status: "processed"}, live: true}
	if _, ok := f.store().Serve(Request{Method: "GET", Path: "/sap/bc/adt/activation"}); ok {
		t.Fatal("GET handled")
	}
	if r := post(f.store(), "", nil); r.Status != 400 || !strings.Contains(string(r.Body), "ExceptionParameterNotFound") {
		t.Fatal(r.Status, string(r.Body))
	}
	if r := post(f.store(), "method=other", nil); r.Status != 200 || len(r.Body) != 0 || len(f.activated) != 0 {
		t.Fatal(r)
	}
	r, _ := f.store().Serve(Request{Method: "POST", Path: "/sap/bc/adt/activation", Query: "method=activate", Body: []byte("<x/>")})
	if r.Status != 400 || !strings.Contains(string(r.Body), "no object references") {
		t.Fatal(r.Status, string(r.Body))
	}
}

func TestLiveActivationIsTheNodeSuccessDocument(t *testing.T) {
	f := &fake{report: Report{Status: "processed", Issues: []Issue{{Severity: "W", Line: 2, Message: "a warning"}}}, live: true}
	r := post(f.store(), "method=activate&preauditRequested=true", nil)
	want := `<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><chkl:properties checkExecuted="true" activationExecuted="true" generationExecuted="true"/></chkl:messages>`
	if r.Status != 200 || string(r.Body) != want || len(f.activated) != 1 || f.activated[0] != "CLAS ZCL_A" {
		t.Fatal(r.Status, string(r.Body), f.activated)
	}
	for _, h := range r.Headers {
		if h[0] == "x-osd-build" {
			t.Fatal("live activation says rebuild")
		}
	}
}

func TestPublishedActivationWarnsThatARebuildIsNeeded(t *testing.T) {
	f := &fake{report: Report{Status: "processed"}, live: false}
	r := post(f.store(), "method=activate", nil)
	s := string(r.Body)
	if !strings.Contains(s, `generationExecuted="false"`) || !strings.Contains(s, `activationExecuted="true"`) ||
		!strings.Contains(s, `type="W"`) || !strings.Contains(s, "rebuilt from this tree") || strings.Contains(s, `type="E"`) {
		t.Fatal(s)
	}
	if r.Headers[len(r.Headers)-1] != [2]string{"x-osd-build", BuildHeader} {
		t.Fatal(r.Headers)
	}
}

func TestSyntaxErrorCancelsActivation(t *testing.T) {
	f := &fake{report: Report{Status: "processed", Issues: []Issue{{Severity: "E", Line: 3, Column: 5, Message: `"X" is <unknown>`}}}}
	r := post(f.store(), "method=activate", nil)
	s := string(r.Body)
	if r.Status != 200 || len(f.activated) != 0 || !strings.Contains(s, `activationExecuted="false"`) ||
		!strings.Contains(s, `Activation was cancelled.`) ||
		!strings.Contains(s, `<msg objDescr="Class ZCL_A" type="E" line="1" href="/sap/bc/adt/oo/classes/zcl_a/source/main#start=3,5" forceSupported="true"><shortText><txt>&quot;X&quot; is &lt;unknown&gt;</txt>`) {
		t.Fatal(s)
	}
}

func TestUncheckedIsRefusedUnlessForced(t *testing.T) {
	f := &fake{report: Report{Status: "notProcessed", StatusText: "no compiler"}, live: false}
	r := post(f.store(), "method=activate", nil)
	if len(f.activated) != 0 || !strings.Contains(string(r.Body), "could not run (no compiler)") {
		t.Fatal(string(r.Body))
	}
	r = post(f.store(), "method=activate&forced=true", nil)
	if len(f.activated) != 1 || !strings.Contains(string(r.Body), `checkExecuted="false" activationExecuted="true"`) {
		t.Fatal(string(r.Body), f.activated)
	}
	f.fail = errors.New("CLAS ZCL_A does not exist")
	r = post(f.store(), "method=activate&forced=false&forced=", nil)
	if f.report.Status == "processed" || !strings.Contains(string(r.Body), "could not run") {
		t.Fatal(string(r.Body))
	}
}

func TestIfMatch(t *testing.T) {
	f := &fake{report: Report{Status: "processed"}, live: true}
	if r := post(f.store(), "method=activate", [][2]string{{"If-Match", `"nope"`}}); r.Status != 412 {
		t.Fatal(r.Status)
	}
	// sha256("src")[:32]
	if r := post(f.store(), "method=activate", [][2]string{{"If-Match", `W/"25a6634263c1b1f6fc4697a04e2b9904"`}}); r.Status != 200 {
		t.Fatal(r.Status, string(r.Body))
	}
	if r := post(f.store(), "method=activate", [][2]string{{"If-Match", "*"}}); r.Status != 200 {
		t.Fatal(r.Status)
	}
}

// critic #863 MUST 2: one batch call; a batch that fails is cancelled whole.
func TestBatchIsAllOrNothing(t *testing.T) {
	two := `<?xml version="1.0"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a"/><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_missing"/></adtcore:objectReferences>`
	f := &fake{report: Report{Status: "processed"}, live: false, fail: errors.New("CLAS ZCL_MISSING does not exist")}
	r, _ := f.store().Serve(Request{Method: "POST", Path: "/sap/bc/adt/activation", Query: "method=activate&forced=true", Body: []byte(two)})
	s := string(r.Body)
	if f.batches != 1 || len(f.activated) != 0 || !strings.Contains(s, `activationExecuted="false"`) ||
		strings.Count(s, `type="E"`) != 2 || !strings.Contains(s, "not activated: CLAS ZCL_MISSING does not exist") {
		t.Fatal(f.batches, f.activated, s)
	}
	f.fail = nil
	r, _ = f.store().Serve(Request{Method: "POST", Path: "/sap/bc/adt/activation", Query: "method=activate", Body: []byte(two)})
	if f.batches != 2 || len(f.activated) != 2 || !strings.Contains(string(r.Body), `activationExecuted="true"`) {
		t.Fatal(f.batches, f.activated, string(r.Body))
	}
}
