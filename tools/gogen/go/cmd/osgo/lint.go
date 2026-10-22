package main

import (
	"crypto/sha256"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

type lintSpec struct {
	Config        string
	Hidden, Files []string
	Guards        map[string]string
}

// Overridden only by the optional generated zz_lint.go adapter. Keeping this
// refusal compiled means -lint-engine=abap never silently selects Node.
var makeLintCompiler = func(_ string, other storecheck.Compiler) (*storelint.Compiler, string) {
	return &storelint.Compiler{Other: other}, ""
}

func selectCheckCompiler(root string, other storecheck.Compiler, selected string) storecheck.Compiler {
	if selected != "abap" {
		return other
	}
	engine, config := makeLintCompiler(root, other)
	if err := engine.Prime(config); err != nil {
		log.Printf("lint-engine=abap unavailable: %v (CHECKRUN will return notProcessed)", err)
	}
	return engine
}

func selectedLintEngine(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "node"
	}
	if value != "node" && value != "abap" {
		return "", fmt.Errorf("invalid lint engine %q: use node or abap", value)
	}
	return value, nil
}

func configuredLintCompiler(root string, other storecheck.Compiler, engine storelint.Engine, spec lintSpec) *storelint.Compiler {
	generation := liveGeneration(root)
	return &storelint.Compiler{Other: other, Engine: engine, Logf: log.Printf,
		Guard: func() error {
			if liveGeneration(root) != generation {
				return fmt.Errorf("ABAP lint: active generation changed; restart and re-prime")
			}
			for file, expected := range spec.Guards {
				bytes, err := os.ReadFile(filepath.Join(root, file))
				if err != nil {
					return fmt.Errorf("ABAP lint config %s: %w", file, err)
				}
				if fmt.Sprintf("%x", sha256.Sum256(bytes)) != expected {
					return fmt.Errorf("ABAP lint config %s changed since build; rebuild and re-prime", file)
				}
			}
			return nil
		},
		Capture: func() (objstore.LintSnapshot, error) {
			snapshot, err := objstore.CaptureLint(spec.Hidden)
			if err != nil {
				return snapshot, err
			}
			names := make([]string, 0, len(snapshot.Files))
			for _, file := range snapshot.Files {
				names = append(names, file.Filename)
			}
			if !slices.Equal(names, spec.Files) {
				return snapshot, fmt.Errorf("ABAP lint: registry file membership/order differs from build's Node store view; rebuild and re-prime")
			}
			return snapshot, nil
		},
	}
}
