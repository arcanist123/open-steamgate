package storelint

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
)

func TestDiagnosticMapping(t *testing.T) {
	for _, tc := range []struct{ typ, name, include, file, uri string }{
		{"CLAS", "ZCL_TEST", "", "/src/zcl_test.clas.abap", "/oo/classes/zcl_test/source/main"},
		{"CLAS", "ZCL_TEST", "main", "/lib/#a#other.clas.LOCALS_DEF.ABAP", "/oo/classes/%2Fa%2Fother/includes/definitions"},
		{"CLAS", "ZCL_TEST", "main", "/src/zcl_test.clas.locals_imp.abap", "/oo/classes/zcl_test/includes/implementations"},
		{"CLAS", "ZCL_TEST", "main", "/src/zcl_test.clas.macros.abap", "/oo/classes/zcl_test/includes/macros"},
		{"CLAS", "ZCL_TEST", "main", "/src/zcl_test.clas.testclasses.abap", "/oo/classes/zcl_test/includes/testclasses"},
		{"CLAS", "ZCL_TEST", "definitions", "/src/zcl_test.clas.xml", "/oo/classes/zcl_test/includes/definitions"},
		{"INTF", "/X/Ä !'()", "", "/src/#x#other.intf.abap", "/oo/interfaces/%2Fx%2F%C3%A4%20!'()/source/main"},
		{"PROG", "ZP", "", "/lib/zother.prog.abap", "/programs/programs/zother/source/main"},
		// frameUri does not decode # for PROG (unlike CLAS).
		{"PROG", "ZP", "", "/lib/#x#p.prog.abap", "/programs/programs/%23x%23p/source/main"},
		{"INCL", "/X/I", "", "/src/#x#i.prog.abap", "/programs/includes/%2Fx%2Fi"},
	} {
		t.Run(tc.uri, func(t *testing.T) {
			in := storecheck.Input{Type: tc.typ, Name: tc.name, Include: tc.include}
			issue := Issue{Filename: tc.file, Row: 12, Column: 5, Key: "syntax", Message: `"undefined" not found, Target`}
			rows := MapIssues(in, []Issue{issue, issue})
			if len(rows) != 2 || !reflect.DeepEqual(rows[0], rows[1]) {
				t.Fatalf("duplicates/order lost: %+v", rows)
			}
			if rows[0].URI != "/sap/bc/adt"+tc.uri || rows[0].Severity != "E" || rows[0].LINE != 12 || rows[0].COL != 5 || rows[0].MESSAGE != issue.Message {
				t.Fatalf("mapping: %+v", rows[0])
			}
			var report storecheck.Report
			if err := json.Unmarshal([]byte(storecheck.Processed(rows).Scalars["EV_JSON"]), &report); err != nil {
				t.Fatal(err)
			}
			if report.Status != "processed" || len(report.Issues) != 2 || report.Issues[0].Column != 5 {
				t.Fatal(report)
			}
		})
	}
}

type otherCompiler struct{ checks, outlines int }

func (o *otherCompiler) Available(context.Context) error { panic("CHECKRUN must not probe Node") }
func (o *otherCompiler) Check(context.Context, storecheck.Input) ([]storecheck.Issue, error) {
	o.checks++
	return nil, fmt.Errorf("Node check")
}
func (o *otherCompiler) Outline(context.Context, storecheck.Input) (json.RawMessage, error) {
	o.outlines++
	return nil, fmt.Errorf("Node outline")
}

func fixture() (*Compiler, *storecheck.Request, *string, *int) {
	digest, primes := "initial", 0
	c := &Compiler{Other: &otherCompiler{}, Capture: func() (objstore.LintSnapshot, error) {
		return objstore.LintSnapshot{Root: "/tree", Digest: digest, Files: []objstore.LintFile{{Filename: "/src/ztest.clas.abap", Raw: "CLASS ztest."}}}, nil
	}, Engine: Engine{Prime: func(files []objstore.LintFile, config string) {
		primes++
		if config != `{"rules":{}}` {
			panic("wrong config")
		}
	}, Check: func(target string) []Issue {
		if target != "/src/ztest.clas.abap" {
			panic(target)
		}
		return []Issue{{Filename: target, Message: "broken", Row: 3, Column: 7}}
	}}}
	req := &storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true, Input: storecheck.Input{Root: "/tree", Type: "CLAS", Name: "ZTEST", Logical: []string{"src/ztest.clas.abap", "src/ztest.clas.locals_def.abap"}}}
	return c, req, &digest, &primes
}

func runReport(t *testing.T, c *Compiler, req storecheck.Request) storecheck.Report {
	t.Helper()
	r, err := storecheck.Run(c, req)
	if err != nil {
		t.Fatal(err)
	}
	var report storecheck.Report
	if err := json.Unmarshal([]byte(r.Scalars["EV_JSON"]), &report); err != nil {
		t.Fatal(err)
	}
	return report
}

func TestLifecycleAndNoFallback(t *testing.T) {
	c, req, digest, primes := fixture()
	if r := runReport(t, c, *req); r.Status != "notProcessed" || !strings.Contains(r.StatusText, "not primed") {
		t.Fatal(r)
	}
	if err := c.Prime(`{"rules":{}}`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if r := runReport(t, c, *req); r.Status != "processed" || len(r.Issues) != 1 {
			t.Fatal(r)
		}
	}
	if *primes != 1 || c.calls != 2 || c.Other.(*otherCompiler).checks != 0 {
		t.Fatalf("primes=%d checks=%d", *primes, c.calls)
	}
	_, err := c.Check(context.Background(), storecheck.Input{})
	if err == nil || c.Other.(*otherCompiler).checks != 1 {
		t.Fatal("ordinary CHECK not delegated")
	}
	_, _ = c.Outline(context.Background(), storecheck.Input{})
	if c.Other.(*otherCompiler).outlines != 1 {
		t.Fatal("outline not delegated")
	}
	*digest = "dependent file changed"
	if r := runReport(t, c, *req); r.Status != "notProcessed" || !strings.Contains(r.StatusText, "baseline changed") {
		t.Fatal(r)
	}
	if c.calls != 2 {
		t.Fatal("stale registry executed")
	}
}

func TestRefusals(t *testing.T) {
	for _, mode := range []string{"missing-build", "prime-trap", "check-trap", "during-check", "config", "SOURCE", "unsupported", "missing-target"} {
		t.Run(mode, func(t *testing.T) {
			c, req, digest, _ := fixture()
			switch mode {
			case "missing-build":
				c.Engine = Engine{}
			case "prime-trap":
				c.Engine.Prime = func([]objstore.LintFile, string) { panic("prime failed") }
			case "check-trap":
				c.Engine.Check = func(string) []Issue { panic("ABAP exception") }
			case "during-check":
				c.Engine.Check = func(string) []Issue { *digest = "external edit"; return nil }
			case "config":
				c.Guard = func() error { return fmt.Errorf("effective config changed") }
			case "SOURCE":
				req.Filter = "SOURCE"
			case "unsupported":
				req.Input.Type = "DDLS"
			case "missing-target":
				req.Input.Logical = nil
			}
			_ = c.Prime(`{"rules":{}}`)
			if r := runReport(t, c, *req); r.Status != "notProcessed" || r.StatusText == "" || len(r.Issues) != 0 {
				t.Fatal(r)
			}
		})
	}
}

func TestCheckerSerialized(t *testing.T) {
	c, req, _, _ := fixture()
	if err := c.Prime(`{"rules":{}}`); err != nil {
		t.Fatal(err)
	}
	// Run under -race: calls and private engine state must never race.
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Go(func() {
			if _, err := c.Check(context.Background(), func() storecheck.Input { in := req.Input; in.CheckRun = true; return in }()); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	if c.calls != 8 {
		t.Fatal(c.calls)
	}
}
