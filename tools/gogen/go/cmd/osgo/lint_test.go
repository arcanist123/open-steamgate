package main

import (
	"strings"
	"testing"

	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

func TestLintSelection(t *testing.T) {
	saved := makeGoLintCompiler
	defer func() { makeGoLintCompiler = saved }()
	for _, linked := range []bool{false, true} {
		makeGoLintCompiler = nil
		wantDefault := "node"
		if linked {
			wantDefault = "go"
			makeGoLintCompiler = func(string, storecheck.Compiler) (*storelint.Compiler, string) {
				t.Fatal("selection must not construct or prime the engine")
				return nil, ""
			}
		}
		for value, want := range map[string]string{"": wantDefault, "  ": wantDefault, "node": "node", " NODE ": "node", "abap": "abap", "go": "go", " GO ": "go"} {
			selected, err := selectedLintEngine(value)
			if err != nil || selected != want {
				t.Fatalf("linked=%v %q: got %q %v, want %q", linked, value, selected, err, want)
			}
		}
	}
	if _, err := selectedLintEngine("automatic"); err == nil {
		t.Fatal("invalid engine accepted")
	}
}

func TestGoLintSelectionAndMissingBuild(t *testing.T) {
	other := &storelint.Compiler{}
	if got := selectCheckCompiler("/tree", other, "node"); got != other {
		t.Fatal("default compiler changed")
	}
	saved := makeGoLintCompiler
	defer func() { makeGoLintCompiler = saved }()
	makeGoLintCompiler = func(root string, delegate storecheck.Compiler) (*storelint.Compiler, string) {
		if root != "/tree" || delegate != other {
			t.Fatal("wrong factory inputs")
		}
		return &storelint.Compiler{Other: delegate, Engine: storelint.Engine{Name: "go"}}, ""
	}
	selected := selectCheckCompiler("/tree", other, "go")
	if selected == other {
		t.Fatal("Go CHECKRUN fell back")
	}
	c := selected.(*storelint.Compiler)
	req := storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true,
		Input: storecheck.Input{Root: "/tree", Type: "PROG", Name: "ZTEST", Logical: []string{"/src/ztest.prog.abap"}}}
	result, err := storecheck.Run(c, req)
	if err != nil || !strings.Contains(result.Scalars["EV_JSON"], "notProcessed") || !strings.Contains(result.Scalars["EV_JSON"], "Go lint engine not compiled") {
		t.Fatal(result, err)
	}
}
