package lintinput

import (
	"os"
	"path/filepath"
	"strings"

	"osg/gogen/lintresolve"
	"osg/gogen/objstore"
	"osg/gogen/storelint"
)

// Retained by one compiler under its capture mutex. Physical membership and
// canonical identities are independent of source digests (and byte edits).
type membership struct {
	key    func(string) string
	layers *membership
	files  map[string]string
	dirs   map[string]map[string]int
	hidden map[string]bool
}

func membershipKey(file string) string {
	key := storelint.ObjectIdentity(file)
	if strings.HasSuffix(key, ".DEVC") {
		return ""
	}
	return key
}

func newMembership(spec Spec) *membership {
	m := membershipWithKey(spec, membershipKey)
	if spec.Rules != nil {
		m.layers = membershipWithKey(spec, lintresolve.CompetitionIdentity)
	}
	return m
}

func membershipWithKey(spec Spec, key func(string) string) *membership {
	m := &membership{key: key, files: map[string]string{}, dirs: map[string]map[string]int{}, hidden: map[string]bool{}}
	for _, file := range spec.Files {
		m.add(file)
	}
	for _, file := range spec.Hidden {
		m.hidden[m.key(file)] = true
	}
	return m
}

func (m *membership) add(file string) {
	key := m.key(file)
	m.files[file] = key
	if key == "" {
		return
	}
	if m.dirs[key] == nil {
		m.dirs[key] = map[string]int{}
	}
	m.dirs[key][filepath.Dir(file)]++
}

func (m *membership) needs(root string, spec Spec, snapshot objstore.LintSnapshot) bool {
	// Hidden observations must still happen even when visible membership matches.
	for _, file := range spec.Hidden {
		if _, err := os.Stat(filepath.Join(root, file)); os.IsNotExist(err) {
			return true
		}
	}
	if m.layers != nil {
		layerSpec := spec
		layerSpec.Hidden = nil // Original map already observed hidden files above.
		if m.layers.needs(root, layerSpec, snapshot) {
			return true
		}
	}
	now := make(map[string]bool, len(snapshot.Files))
	added := map[string]map[string]bool{}
	for _, f := range snapshot.Files {
		file := f.Filename
		now[file] = true
		if _, exists := m.files[file]; exists {
			continue
		}
		key := m.key(file)
		if key == "" {
			continue
		}
		if m.hidden[key] {
			return true
		}
		dir := filepath.Dir(file)
		for previous := range m.dirs[key] {
			if previous != dir {
				return true
			}
		}
		for previous := range added[key] {
			if previous != dir {
				return true
			}
		}
		if added[key] == nil {
			added[key] = map[string]bool{}
		}
		added[key][dir] = true
	}
	for file, key := range m.files {
		if !now[file] && (m.hidden[key] || len(m.dirs[key]) > 1) {
			return true
		}
	}
	return false
}

func (m *membership) advance(snapshot objstore.LintSnapshot) *membership {
	if m.layers != nil {
		m.layers.advance(snapshot)
	}
	// Reuse identities for survivors; classify only additions. Remove vanished
	// names so a later recreation is a delta, even with identical content bytes.
	now := make(map[string]bool, len(snapshot.Files))
	for _, f := range snapshot.Files {
		now[f.Filename] = true
		if _, exists := m.files[f.Filename]; !exists {
			m.add(f.Filename)
		}
	}
	for file, key := range m.files {
		if now[file] {
			continue
		}
		delete(m.files, file)
		if key == "" {
			continue
		}
		dirs := m.dirs[key]
		dir := filepath.Dir(file)
		dirs[dir]--
		if dirs[dir] == 0 {
			delete(dirs, dir)
		}
		if len(dirs) == 0 {
			delete(m.dirs, key)
		}
	}
	return m
}
