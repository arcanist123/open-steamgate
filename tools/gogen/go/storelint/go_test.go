package storelint

import (
	"fmt"
	"strings"
	"testing"

	"osg/gogen/objstore"
)

type fakeGoLibrary struct{ Engine }

func (f fakeGoLibrary) Prime(files, deps []objstore.LintFile, config string) {
	if len(deps) != 0 {
		panic("OSG libraries must remain checkable")
	}
	f.Engine.Prime(files, config)
}
func (f fakeGoLibrary) Check(file string) []Issue       { return f.Engine.Check(file) }
func (f fakeGoLibrary) Update(file string, raw *string) { f.Engine.Update(file, raw) }
func (f fakeGoLibrary) Stats() Stats {
	if f.Engine.Stats == nil {
		return Stats{}
	}
	return f.Engine.Stats()
}

func TestGoLifecycle(t *testing.T) {
	c, req, _, _ := fixture()
	var logs []string
	c.Engine = NewGoEngine(fakeGoLibrary{c.Engine})
	c.Logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
	if err := c.Prime(`{"rules":{}}`); err != nil {
		t.Fatal(err)
	}
	if r := runReport(t, c, *req); r.Status != "processed" || len(r.Issues) != 1 || r.Issues[0].Severity != "E" || r.Issues[0].URI != "/sap/bc/adt/oo/classes/ztest/source/main" {
		t.Fatal(r)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "lint-engine=go check=1 target=/src/ztest.clas.abap entered=abaplint.Checker.Check") {
		t.Fatal(logs)
	}
	if !strings.Contains(logs[0], "lint-engine=go prime=1 files=") {
		t.Fatal(logs)
	}
}

func TestGoCompilerContract(t *testing.T) {
	fixtureGo = true
	defer func() { fixtureGo = false }()
	for _, tc := range []struct {
		name string
		run  func(*testing.T)
	}{
		{"mapping", TestDiagnosticMapping},
		{"lifecycle", TestLifecycleAndNoFallback},
		{"refusals", TestRefusals},
		{"serialized", TestCheckerSerialized},
		{"saved-overlay-restore", TestSavedUpdatesOverlayAndRestore},
		{"structural", TestStructuralReprimeAndGenerationEdit},
		{"restore-failure-empty-source", TestRestoreFailurePoisonsAndEmptyOverlay},
		{"winner", TestStructuralWinnerIsChecked},
		{"work-logs", TestOverlayWorkLogs},
	} {
		t.Run(tc.name, tc.run)
	}
}
