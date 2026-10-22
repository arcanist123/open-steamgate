// Package lintresolve refreshes checker facts for a fixed compiled generation.
package lintresolve

import (
	"encoding/json"
	"osg/gogen/objstore"
)

// Facts preserves ordered arrays and the effective config's original JSON bytes.
// Rules is build policy, never inferred from mutable runtime configuration.
type Facts struct {
	Config        string            `json:"config"`
	Hidden        []string          `json:"hidden"`
	Files         []string          `json:"files"`
	Guards        map[string]string `json:"guards"`
	PackSources   map[string]string `json:"packSources"`
	Places        []string          `json:"places"`
	LibraryPlaces []string          `json:"libraryPlaces"`
	Store         *objstore.Config  `json:"store"`
	Rules         *Rules            `json:"rules,omitempty"`
}

type Library struct {
	Folder   string   `json:"folder"`
	Dir      string   `json:"dir"`
	Logical  string   `json:"logical"`
	Patterns []string `json:"patterns"`
	Excluded []string `json:"excluded"`
}

type Pack struct {
	Name       string   `json:"name"`
	Candidates []string `json:"abapCandidates"`
	Default    bool     `json:"default"`
	Package    string   `json:"package"`
}

type Mapping struct {
	Physical string `json:"physical"`
	Logical  string `json:"logical"`
}

type Rules struct {
	FactGuards  map[string]string  `json:"factGuards"`
	Version     int                `json:"version"`
	Config      string             `json:"config"`
	Roots       []objstore.Root    `json:"roots"`
	Plan        []Slot             `json:"plan"`
	Excluded    []string           `json:"excluded"`
	Libraries   []Library          `json:"libraries"`
	Packs       []Pack             `json:"packs"`
	Places      []string           `json:"places"`
	Guards      map[string]string  `json:"guards"`
	Environment map[string]*string `json:"environment"`
	// States guard topology (e.g. $TMP existence); unlike guards they need no bytes.
	States    map[string]string `json:"states"`
	Manifests map[string]string `json:"manifests"`
	Mappings  []Mapping         `json:"mappings"`
	System    bool              `json:"system"`
}

// MarshalJSON emits exactly the Node facts projection: optional root metadata
// stays absent, libraries don't acquire root-only fields, empty arrays stay [].
func (f Facts) MarshalJSON() ([]byte, error) {
	type plain Facts
	roots, libs := []map[string]any{}, []map[string]any{}
	if f.Store == nil {
		return json.Marshal(plain(f))
	}
	for _, r := range f.Store.Roots {
		row := map[string]any{"path": r.Path, "writable": r.Writable, "library": false, "imported": r.Imported, "package": r.Package, "tmp": r.Tmp, "overlay": r.Overlay, "overlayOf": r.OverlayOf}
		if r.Abapgit != nil {
			row["abapgit"] = r.Abapgit
		}
		roots = append(roots, row)
	}
	for _, r := range f.Store.Libs {
		libs = append(libs, map[string]any{"path": r.Path, "writable": false, "library": true, "imported": false, "package": "", "files": r.Files})
	}
	return json.Marshal(struct {
		*plain
		Store any `json:"store"`
	}{(*plain)(&f), struct {
		Roots    any      `json:"roots"`
		Libs     any      `json:"libs"`
		Excluded []string `json:"excluded"`
	}{roots, libs, f.Store.Excluded}})
}

// Slot preserves pack insertion position even when all its candidates are absent.
type Slot struct {
	Root   *objstore.Root `json:"root,omitempty"`
	Pack   *Pack          `json:"pack,omitempty"`
	Listed []string       `json:"listed,omitempty"`
}
