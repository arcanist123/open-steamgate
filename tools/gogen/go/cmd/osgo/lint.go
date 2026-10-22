package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

type lintSpec struct {
	Config        string
	Hidden, Files []string
	Guards        map[string]string
	Places        []string
	Store         *objstore.Config
}

// Overridden only by the optional generated zz_lint.go adapter. Keeping this
// refusal compiled means -lint-engine=abap never silently selects Node.
var makeLintCompiler = func(_ string, other storecheck.Compiler) (*storelint.Compiler, string) {
	return &storelint.Compiler{Other: other}, ""
}

// Installed by the optional TS-HG bridge, independently of the ABAP build.
var makeGoLintCompiler = func(_ string, other storecheck.Compiler) (*storelint.Compiler, string) {
	return &storelint.Compiler{Other: other, Engine: storelint.Engine{Name: "go"}}, ""
}

func selectCheckCompiler(root string, other storecheck.Compiler, selected string) storecheck.Compiler {
	if selected != "abap" && selected != "go" {
		return other
	}
	factory := makeLintCompiler
	if selected == "go" {
		factory = makeGoLintCompiler
	}
	engine, config := factory(root, other)
	if err := engine.Prime(config); err != nil {
		log.Printf("lint-engine=%s unavailable: %v (CHECKRUN will return notProcessed)", selected, err)
	}
	return engine
}

func selectedLintEngine(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "node"
	}
	if value != "node" && value != "abap" && value != "go" {
		return "", fmt.Errorf("invalid lint engine %q: use node, abap or go", value)
	}
	return value, nil
}

// Only structural changes invoke the existing Node layer/config resolver. It
// returns input facts, never diagnostics. Every prime/check runs in the
// selected in-process engine.
var resolveLintSpec = func(root string) (lintSpec, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "tools", "step3", "lint-inputs.mjs"), root)
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return lintSpec{}, fmt.Errorf("lint: full re-prime needs structural input resolution: %w", err)
	}
	var spec lintSpec
	err = json.Unmarshal(out, &spec)
	if err != nil {
		return spec, fmt.Errorf("lint structural input facts: %w", err)
	}
	if spec.Store == nil || spec.Config == "" {
		return spec, fmt.Errorf("lint structural input facts are incomplete")
	}
	return spec, nil
}

func lintStructure(root string, spec lintSpec) (string, bool, error) {
	guards := map[string]string{}
	changed := false
	for file, expected := range spec.Guards {
		bytes, err := os.ReadFile(filepath.Join(root, file))
		if err != nil && !os.IsNotExist(err) {
			return "", false, err
		}
		value := "missing"
		if err == nil {
			value = fmt.Sprintf("%x", sha256.Sum256(bytes))
		}
		guards[file] = value
		changed = changed || value != expected
	}
	// Detect new/removed packs too, not only edits to manifests known at build.
	for _, place := range spec.Places {
		at := filepath.Join(root, place)
		candidates := []string{filepath.Join(at, "osd-pack.json")}
		entries, err := os.ReadDir(at)
		if err != nil && !os.IsNotExist(err) {
			return "", false, err
		}
		for _, e := range entries {
			candidates = append(candidates, filepath.Join(at, e.Name(), "osd-pack.json"))
		}
		for _, file := range candidates {
			bytes, err := os.ReadFile(file)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				if info, statErr := os.Stat(filepath.Dir(file)); statErr == nil && !info.IsDir() {
					continue
				}
				return "", false, err
			}
			name, err := filepath.Rel(root, file)
			if err != nil {
				return "", false, err
			}
			value := fmt.Sprintf("%x", sha256.Sum256(bytes))
			if spec.Guards[name] != value {
				changed = true
			}
			guards[name] = value
		}
	}
	raw, _ := json.Marshal(struct {
		Guards map[string]string
		Store  *objstore.Config
		Hidden []string
	}{guards, spec.Store, spec.Hidden})
	return fmt.Sprintf("%x", sha256.Sum256(raw)), changed, nil
}

// Ordinary file additions/removals use the direct update bridge. Re-resolve
// membership only if it can change a layer winner or expose a hidden object.
func lintNeedsLayers(root string, spec lintSpec, snapshot objstore.LintSnapshot) bool {
	key := func(file string) string {
		parts := strings.Split(strings.ToLower(filepath.Base(file)), ".")
		if len(parts) < 3 || strings.HasSuffix(file, ".devc.xml") {
			return ""
		}
		return strings.Join(parts[:2], ".")
	}
	dirs := map[string]string{}
	now, before, hidden := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, file := range spec.Files {
		before[file] = true
	}
	for _, file := range spec.Hidden {
		hidden[key(file)] = true
		if _, err := os.Stat(filepath.Join(root, file)); os.IsNotExist(err) {
			return true
		}
	}
	for _, file := range snapshot.Files {
		now[file.Filename] = true
		object, dir := key(file.Filename), filepath.Dir(file.Filename)
		if object == "" {
			continue
		}
		if previous, exists := dirs[object]; exists && previous != dir {
			return true
		}
		dirs[object] = dir
		if !before[file.Filename] && hidden[object] {
			return true
		}
	}
	for file := range before {
		if !now[file] && hidden[key(file)] {
			return true
		}
	}
	return false
}

func configuredLintCompiler(root string, other storecheck.Compiler, engine storelint.Engine, spec lintSpec) *storelint.Compiler {
	absolute, rootErr := filepath.Abs(root)
	root = absolute
	return &storelint.Compiler{Other: other, Engine: engine, Logf: log.Printf,
		Capture: func() (objstore.LintSnapshot, error) {
			if rootErr != nil {
				return objstore.LintSnapshot{}, rootErr
			}
			structure, changed, err := lintStructure(root, spec)
			if err != nil {
				return objstore.LintSnapshot{}, err
			}
			capture := func() (objstore.LintSnapshot, error) {
				if spec.Store != nil {
					return objstore.CaptureLintView(root, spec.Store, spec.Hidden)
				}
				return objstore.CaptureLint(spec.Hidden)
			}
			snapshot, err := capture()
			if err != nil && !changed {
				return snapshot, err
			}
			// File edits retain the existing config/layer decisions.
			if changed || lintNeedsLayers(root, spec, snapshot) {
				resolved, resolveErr := resolveLintSpec(root)
				if resolveErr != nil {
					return snapshot, resolveErr
				}
				spec = resolved
				structure, changed, err = lintStructure(root, spec)
				if err != nil {
					return snapshot, err
				}
				if changed {
					return snapshot, fmt.Errorf("lint structural inputs changed during resolution; retry")
				}
				snapshot, err = capture()
				if err != nil {
					return snapshot, err
				}
			}
			spec.Files = spec.Files[:0]
			for _, f := range snapshot.Files {
				spec.Files = append(spec.Files, f.Filename)
			}
			snapshot.Config, snapshot.Structure = spec.Config, structure
			return snapshot, nil
		},
	}
}
