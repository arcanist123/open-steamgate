package main

import (
	"fmt"
	"log"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
	"strings"
)

// Overridden only by the optional generated zz_lint.go adapter. Keeping this
// refusal compiled means -lint-engine=abap never silently selects Node.
var makeLintCompiler = func(_ string, other storecheck.Compiler) (*storelint.Compiler, string) {
	return &storelint.Compiler{Other: other}, ""
}

// Installed by the optional TS-HG bridge, independently of the ABAP build.
var makeGoLintCompiler func(string, storecheck.Compiler) (*storelint.Compiler, string)

func selectCheckCompiler(root string, other storecheck.Compiler, selected string) storecheck.Compiler {
	if selected != "abap" && selected != "go" {
		return other
	}
	factory := makeLintCompiler
	if selected == "go" {
		factory = makeGoLintCompiler
	}
	engine, config := &storelint.Compiler{Other: other, Engine: storelint.Engine{Name: selected}}, ""
	if factory != nil {
		engine, config = factory(root, other)
	}
	if err := engine.Prime(config); err != nil {
		log.Printf("lint-engine=%s unavailable: %v (CHECKRUN will return notProcessed)", selected, err)
	}
	return engine
}

func selectedLintEngine(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "node"
		reason := "Go lint library not linked"
		if makeGoLintCompiler != nil {
			value, reason = "go", "Go lint library linked"
		}
		log.Printf("lint-engine=%s default: %s", value, reason)
	}
	if value != "node" && value != "abap" && value != "go" {
		return "", fmt.Errorf("invalid lint engine %q: use node, abap or go", value)
	}
	return value, nil
}
