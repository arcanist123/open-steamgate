package lintresolve

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"osg/gogen/objstore"
)

var webSidecar = regexp.MustCompile(`\.(js|html?|json|properties|css)\.trace(?:\.meta)?\.json$`)

func logical(root, file string, r *Rules) string {
	for _, m := range r.Mappings {
		rel := relative(at(root, m.Physical), at(root, file))
		if rel != ".." && !strings.HasPrefix(rel, "../") {
			return at(root, m.Logical) + "/" + rel
		}
	}
	return at(root, file)
}

func glob(pattern string) string {
	var b strings.Builder
	b.WriteByte('^')
	for i := 0; i < len(pattern); i++ {
		if pattern[i] == '*' {
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				b.WriteString(`[^\n\r\x{2028}\x{2029}]*`)
				i++
			} else {
				b.WriteString("[^/]*")
			}
		} else {
			b.WriteString(regexp.QuoteMeta(string(pattern[i])))
		}
	}
	b.WriteString(`\z`)
	return b.String()
}

// Resolve reads only mutable file membership. Structural policy changes refuse
// with rebuild; no config parsing, discovery, materialization or subprocesses.
// candidatePath is a root descriptor spelling; packSources retains the exact
// producer key (the root candidate is "", while its root path is ".").
func candidatePath(candidate string) string {
	if candidate == "" {
		return "."
	}
	return candidate
}

func Resolve(root string, r *Rules) (Facts, error) {
	if err := Guard(root, r); err != nil {
		return Facts{}, err
	}
	excluded, err := patterns(r.Excluded, false)
	if err != nil {
		return Facts{}, err
	}
	cfg := &objstore.Config{Roots: []objstore.Root{}, Libs: []objstore.Root{}, Excluded: r.Excluded}
	sources := map[string]string{}
	for _, p := range r.Packs {
		for _, c := range p.Candidates {
			kind, err := fileType(at(root, c))
			if err != nil {
				return Facts{}, err
			}
			sources[c] = kind
		}
	}
	// rootsOf assigns metadata by path: later pack declarations win, then
	// explicit user layer metadata wins, even for roots repeated in the list.
	metadata := map[string]objstore.Root{}
	for _, p := range r.Packs {
		for _, c := range p.Candidates {
			if sources[c] != "directory" {
				continue
			}
			path := candidatePath(c)
			metadata[path] = objstore.Root{Path: path, Writable: !r.System, Imported: true, Package: p.Package}
			if p.Default {
				break
			}
		}
	}
	for _, override := range r.Overrides {
		metadata[override.Path] = override
	}
	rootFor := func(root objstore.Root) objstore.Root {
		if selected, ok := metadata[root.Path]; ok {
			return selected
		}
		return root
	}
	if r.Plan == nil {
		cfg.Roots = append(cfg.Roots, r.Roots...)
	} else {
		for _, slot := range r.Plan {
			if slot.Root != nil {
				cfg.Roots = append(cfg.Roots, rootFor(*slot.Root))
				continue
			}
			if slot.Pack == nil {
				return Facts{}, fmt.Errorf("rebuild: invalid lint root plan")
			}
			p := slot.Pack
			for _, c := range p.Candidates {
				if sources[c] != "directory" {
					continue
				}
				listed := false
				for _, s := range slot.Listed {
					listed = listed || s == candidatePath(c)
				}
				if !listed {
					cfg.Roots = append(cfg.Roots, rootFor(objstore.Root{Path: candidatePath(c), Writable: !r.System, Imported: true, Package: p.Package}))
				}
				if p.Default {
					break
				}
			}
		}
	}
	places := []string{}
	groups := map[string]int{}
	for _, lib := range r.Libraries {
		places = append(places, lib.Dir)
		files, err := walk(root, lib.Dir, true, false)
		if err != nil {
			return Facts{}, err
		}
		includes := []*regexp.Regexp{}
		for _, p := range lib.Patterns {
			includes = append(includes, regexp.MustCompile(glob(at(root, lib.Logical)+p)))
		}
		excludes, err := patterns(lib.Excluded, true)
		if err != nil {
			return Facts{}, err
		}
		base := strings.TrimPrefix(lib.Folder, "/")
		src := base + "/src"
		for _, file := range files {
			full := logical(root, file, r)
			if r.System && (filepath.Base(file) == ".osd-layer.json" || filepath.Base(file) == ".abapgit.xml") {
				continue
			}
			included := false
			for _, re := range includes {
				included = included || re.MatchString(full)
			}
			if !included || lib.ExcludeTestclasses && strings.HasSuffix(file, ".clas.testclasses.abap") || matches(excludes, full, true) {
				continue
			}
			path := base
			if strings.HasPrefix(file, src+"/") {
				path = src
			}
			index, ok := groups[path]
			if !ok {
				index = len(cfg.Libs)
				groups[path] = index
				cfg.Libs = append(cfg.Libs, objstore.Root{Path: path, Library: true, Files: []string{}})
			}
			cfg.Libs[index].Files = append(cfg.Libs[index].Files, file)
		}
	}
	folders := []string{}
	for _, r := range cfg.Roots {
		folders = append(folders, r.Path)
	}
	hidden, err := hiddenFiles(root, folders)
	if err != nil {
		return Facts{}, err
	}
	skip := map[string]bool{}
	for _, f := range hidden {
		skip[f] = true
	}
	files := []string{}
	for _, rroot := range append(append([]objstore.Root{}, cfg.Roots...), cfg.Libs...) {
		selected := rroot.Files
		if selected == nil {
			selected, err = walk(root, rroot.Path, false, false)
			if err != nil {
				return Facts{}, err
			}
			filtered := []string{}
			for _, f := range selected {
				name := "/" + f
				if r.System {
					name = logical(root, f, r)
				}
				if !matches(excluded, name, false) {
					filtered = append(filtered, f)
				}
			}
			selected = filtered
		}
		for _, f := range selected {
			if !skip[f] && (strings.HasSuffix(f, ".abap") || strings.HasSuffix(f, ".xml") || strings.HasSuffix(f, ".asddls")) {
				files = append(files, "/"+f)
			}
		}
	}
	if err := Guard(root, r); err != nil {
		return Facts{}, err
	}
	return Facts{Config: r.Config, Hidden: hidden, Files: files, Guards: r.FactGuards, PackSources: sources, Places: r.Places, LibraryPlaces: places, Store: cfg, Rules: r}, nil
}
