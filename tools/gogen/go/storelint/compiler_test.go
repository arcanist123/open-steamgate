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

var fixtureGo bool

func fixture() (*Compiler, *storecheck.Request, *string, *int) {
	digest, primes := "initial", 0
	c := &Compiler{Other: &otherCompiler{}, Capture: func() (objstore.LintSnapshot, error) {
		return objstore.LintSnapshot{Root: "/tree", Digest: digest, Files: []objstore.LintFile{{Filename: "/src/ztest.clas.abap", Raw: "CLASS ztest."}}}, nil
	}, Engine: Engine{Prime: func(files []objstore.LintFile, config string) {
		primes++
		if config != `{"rules":{}}` {
			panic("wrong config")
		}
	}, Update: func(string, *string) {}, Check: func(target string) []Issue {
		if target != "/src/ztest.clas.abap" {
			panic(target)
		}
		return []Issue{{Filename: target, Message: "broken", Row: 3, Column: 7}}
	}}}
	req := &storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true, Input: storecheck.Input{Root: "/tree", Type: "CLAS", Name: "ZTEST", Logical: []string{"src/ztest.clas.abap", "src/ztest.clas.locals_def.abap"}}}
	if fixtureGo {
		c.Engine = NewGoEngine(fakeGoLibrary{c.Engine})
	}
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
	if r := runReport(t, c, *req); r.Status != "processed" {
		t.Fatal(r)
	}
	if c.calls != 3 {
		t.Fatal("saved edit was not checked")
	}
}

func TestRefusals(t *testing.T) {
	for _, mode := range []string{"missing-build", "prime-trap", "check-trap", "during-check", "config", "unsupported", "missing-target"} {
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

func TestSavedUpdatesOverlayAndRestore(t *testing.T) {
	for _, thrown := range []bool{false, true} {
		for _, newObject := range []bool{false, true} {
			t.Run(fmt.Sprintf("throw=%t/new=%t", thrown, newObject), func(t *testing.T) {
				files := []objstore.LintFile{{Filename: "/src/ztest.clas.abap", Raw: "original"}, {Filename: "/lib/zdep.intf.abap", Raw: "old"}, {Filename: "/src/removed.prog.abap", Raw: "gone"}}
				digest := "one"
				registry := map[string]string{}
				events := []string{}
				c, req, _, primes := fixture()
				c.Capture = func() (objstore.LintSnapshot, error) {
					return objstore.LintSnapshot{Root: "/tree", Digest: digest, Files: append([]objstore.LintFile{}, files...)}, nil
				}
				prime := c.Engine.Prime
				c.Engine.Prime = func(f []objstore.LintFile, config string) {
					prime(f, config)
					for _, file := range f {
						registry[file.Filename] = file.Raw
					}
				}
				c.Engine.Update = func(target string, raw *string) {
					if raw == nil {
						events = append(events, "remove "+target)
						delete(registry, target)
					} else {
						events = append(events, "update "+target+"="+*raw)
						registry[target] = *raw
					}
				}
				c.Engine.Check = func(target string) []Issue {
					events = append(events, "check "+target+"="+registry[target])
					if thrown {
						panic("thrown check")
					}
					return nil
				}
				if err := c.Prime(`{"rules":{}}`); err != nil {
					t.Fatal(err)
				}
				files = []objstore.LintFile{{Filename: "/src/ztest.clas.abap", Raw: "saved edit"}, {Filename: "/lib/zdep.intf.abap", Raw: "edited dependency"}, {Filename: "/src/added.prog.abap", Raw: "added"}}
				digest = "two"
				overlay := "buffer"
				req.Filter, req.Input.Source = "SOURCE", &overlay
				target := "/src/ztest.clas.abap"
				restore := "update " + target + "=saved edit"
				if newObject {
					target = "/src/osd/znew.clas.abap"
					req.Exists = false
					req.Input.Name, req.Input.Target, req.Input.Logical = "ZNEW", target, nil
					restore = "remove " + target
				}
				r := runReport(t, c, *req)
				if thrown && r.Status != "notProcessed" || !thrown && r.Status != "processed" {
					t.Fatal(r)
				}
				expected := []string{"remove /src/removed.prog.abap", "update /src/ztest.clas.abap=saved edit", "update /lib/zdep.intf.abap=edited dependency", "update /src/added.prog.abap=added", "update " + target + "=buffer", "check " + target + "=buffer", restore}
				if !reflect.DeepEqual(events, expected) {
					t.Fatalf("events %q want %q", events, expected)
				}
				if c.failure != nil || *primes != 1 {
					t.Fatal("check failure poisoned restored registry", c.failure, *primes)
				}
				// Retry after a thrown check and verify saved bytes (or removal) survived.
				thrown = false
				req.Filter, req.Exists, req.Input.Source = "", true, nil
				req.Input.Name, req.Input.Target, req.Input.Logical = "ZTEST", "", []string{"src/ztest.clas.abap"}
				if r := runReport(t, c, *req); r.Status != "processed" {
					t.Fatal(r)
				}
				if registry["/src/ztest.clas.abap"] != "saved edit" {
					t.Fatal(registry)
				}
				if newObject {
					if _, exists := registry[target]; exists {
						t.Fatal("new overlay leaked")
					}
				}
			})
		}
	}
}

func TestStructuralReprimeAndGenerationEdit(t *testing.T) {
	c, req, _, primes := fixture()
	structure, config, digest := "layers1", `{"rules":{}}`, "one"
	c.Capture = func() (objstore.LintSnapshot, error) {
		return objstore.LintSnapshot{Root: "/tree", Digest: digest, Structure: structure, Config: config, Files: []objstore.LintFile{{Filename: "/src/ztest.clas.abap", Raw: "saved"}}}, nil
	}
	if err := c.Prime(config); err != nil {
		t.Fatal(err)
	}
	req.Input.Generation = "new-generation"
	if r := runReport(t, c, *req); r.Status != "processed" || *primes != 1 {
		t.Fatal(r, *primes)
	}
	structure = "layers2"
	if r := runReport(t, c, *req); r.Status != "processed" || !strings.Contains(r.StatusText, "full re-prime") || *primes != 2 {
		t.Fatal(r, *primes)
	}
	if r := runReport(t, c, *req); r.StatusText != "" || *primes != 2 {
		t.Fatal(r, *primes)
	}
}

func TestRestoreFailurePoisonsAndEmptyOverlay(t *testing.T) {
	c, req, _, _ := fixture()
	updates := 0
	c.Engine.Update = func(target string, raw *string) {
		updates++
		if updates == 1 && (raw == nil || *raw != "") {
			t.Fatal("empty source must update, not remove")
		}
		if updates == 2 {
			panic("restore failed")
		}
	}
	if err := c.Prime(`{"rules":{}}`); err != nil {
		t.Fatal(err)
	}
	req.Filter = "SOURCE"
	req.Input.Source = new(string)
	if r := runReport(t, c, *req); r.Status != "notProcessed" || !strings.Contains(r.StatusText, "restore failed") {
		t.Fatal(r)
	}
	if c.failure == nil {
		t.Fatal("restore failure must poison registry")
	}
	before := c.calls
	if r := runReport(t, c, *req); r.Status != "notProcessed" || c.calls != before {
		t.Fatal(r)
	}
}

func TestStructuralWinnerIsChecked(t *testing.T) {
	c, req, _, _ := fixture()
	structure, target := "base", "/src/ztest.clas.abap"
	c.Capture = func() (objstore.LintSnapshot, error) {
		return objstore.LintSnapshot{Root: "/tree", Digest: target, Structure: structure, Files: []objstore.LintFile{{Filename: target, Raw: "saved"}}}, nil
	}
	c.Engine.Check = func(file string) []Issue {
		if file != target {
			t.Fatalf("stale winner %s want %s", file, target)
		}
		return nil
	}
	if err := c.Prime(`{"rules":{}}`); err != nil {
		t.Fatal(err)
	}
	structure, target = "new-pack", "/packs/new/src/ztest.clas.abap"
	if r := runReport(t, c, *req); r.Status != "processed" || !strings.Contains(r.StatusText, "full re-prime") {
		t.Fatal(r)
	}
}

func TestOverlayWorkLogs(t *testing.T) {
	c, req, _, _ := fixture()
	var stats Stats
	var logs []string
	c.Logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
	c.Engine.Stats = func() Stats { return stats }
	c.Engine.Update = func(string, *string) { stats.Updates++; stats.DirtiedObjects++ }
	c.Engine.Check = func(string) []Issue { stats.ParseRuns++; stats.ParseObjects++; return nil }
	if err := c.Prime(`{"rules":{}}`); err != nil {
		t.Fatal(err)
	}
	req.Filter = "SOURCE"
	source := "buffer"
	req.Input.Source = &source
	if r := runReport(t, c, *req); r.Status != "processed" {
		t.Fatal(r)
	}
	if len(logs) != 6 {
		t.Fatal(logs)
	}
	for i, expected := range []string{
		"phase=install updates=1 noops=0 indexed=0 reader-visits=0 dirtied=1 parse-runs=0 parse-objects=0",
		"phase=check updates=0 noops=0 indexed=0 reader-visits=0 dirtied=0 parse-runs=1 parse-objects=1",
		"phase=restore updates=1 noops=0 indexed=0 reader-visits=0 dirtied=1 parse-runs=0 parse-objects=0",
		"check=1 issues=0 elapsed=",
	} {
		if !strings.Contains(logs[i+2], expected) {
			t.Fatalf("log %d: %s, want %s", i+2, logs[i+2], expected)
		}
	}
}
