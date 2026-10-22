// Package lintinput resolves and captures ordered checker inputs.
package lintinput

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"osg/gogen/lintresolve"
	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

// Spec includes build-time rules plus refreshable checker facts.
type Spec = lintresolve.Facts

// Resolve is an optional test injection. Production binds embedded rules to
// each compiler instance; no process-global root/rules registry is involved.
var Resolve func(root string) (Spec, error)

func Structure(root string, spec Spec) (string, bool, error) {
	if spec.Rules != nil {
		if err := lintresolve.Guard(root, spec.Rules); err != nil {
			return "", false, err
		}
	}
	guards := map[string]string{}
	sources, changed, err := packSources(root, spec.PackSources)
	if err != nil {
		return "", false, err
	}
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
	places := spec.Places
	if spec.Rules != nil {
		places = nil
	} // Guard already checked the complete manifest inventory.
	for _, place := range places {
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
		Guards      map[string]string
		PackSources map[string]string
		Store       *objstore.Config
		Hidden      []string
	}{guards, sources, spec.Store, spec.Hidden})
	return fmt.Sprintf("%x", sha256.Sum256(raw)), changed, nil
}

// Ordinary file additions/removals use the direct update bridge. Re-resolve
// membership only if it can change a layer winner or expose a hidden object.
func NeedsLayers(root string, spec Spec, snapshot objstore.LintSnapshot) bool {
	return newMembership(spec).needs(root, spec, snapshot)
}

func New(root string, other storecheck.Compiler, engine storelint.Engine, spec Spec) *storelint.Compiler {
	return newWithCache(root, other, engine, spec, statCacheFromEnv())
}

func newWithCache(root string, other storecheck.Compiler, engine storelint.Engine, spec Spec, cache *objstore.LintCache) *storelint.Compiler {
	absolute, rootErr := filepath.Abs(root)
	root = absolute
	var previousMembership string
	initialized := false
	members := newMembership(spec)
	return &storelint.Compiler{Other: other, Engine: engine, Logf: log.Printf,
		Capture: func() (objstore.LintSnapshot, error) {
			if rootErr != nil {
				return objstore.LintSnapshot{}, rootErr
			}
			structure, changed, err := Structure(root, spec)
			if err != nil {
				return objstore.LintSnapshot{}, err
			}
			membership, err := libraryMembership(root, libraryPlaces(spec))
			if err != nil {
				return objstore.LintSnapshot{}, err
			}
			// Resolve once at startup as embedded lists may already be stale.
			// Later snapshots only resolve after a namespace change.
			changed = changed || (initialized && membership != previousMembership) || (!initialized && spec.LibraryPlaces != nil)
			capture := func() (objstore.LintSnapshot, error) {
				if spec.Store != nil {
					if spec.Rules != nil {
						filter, err := lintresolve.ExclusionFilter(root, spec.Rules)
						if err != nil {
							return objstore.LintSnapshot{}, err
						}
						return cache.CaptureFiltered(root, spec.Store, spec.Hidden, filter)
					}
					return cache.Capture(root, spec.Store, spec.Hidden)
				}
				return objstore.CaptureLint(spec.Hidden)
			}
			snapshot, err := capture()
			if err != nil && !changed {
				return snapshot, err
			}
			// File edits retain the existing config/layer decisions.
			resolvedInputs := changed || members.needs(root, spec, snapshot)
			if resolvedInputs {
				resolve := Resolve
				if resolve == nil {
					resolve = func(root string) (Spec, error) { return lintresolve.Resolve(root, spec.Rules) }
				}
				resolved, resolveErr := resolve(root)
				if resolveErr != nil {
					return snapshot, resolveErr
				}
				spec = resolved
				members = newMembership(spec)
				structure, changed, err = Structure(root, spec)
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
			var afterMembership string
			// Only structural resolution needs a second directory scan. Ordinary
			// captures pay for one scan; the post-check capture catches races.
			if resolvedInputs {
				afterMembership, err = libraryMembership(root, libraryPlaces(spec))
				if err != nil {
					return snapshot, err
				}
				if membership != afterMembership {
					return snapshot, fmt.Errorf("lint library membership changed during resolution; retry")
				}
			}
			members = members.advance(snapshot)
			previousMembership, initialized = membership, true
			structure += ":" + membership
			spec.Files = spec.Files[:0]
			for _, f := range snapshot.Files {
				spec.Files = append(spec.Files, f.Filename)
			}
			snapshot.Config, snapshot.Structure = spec.Config, structure
			return snapshot, nil
		},
	}
}
