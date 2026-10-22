package lintresolve

import (
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"net/url"
	"os"
	"osg/gogen/objstore"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

func at(root, name string) string {
	if filepath.IsAbs(name) {
		return name
	}
	return filepath.Join(root, name)
}
func relative(root, file string) string { s, _ := filepath.Rel(root, file); return filepath.ToSlash(s) }

// The Node library/store walkers swallow directory-read failures but propagate
// failed stats. Hidden-layer discovery propagates both, including broken links.
func walk(root, folder string, library, hidden bool) ([]string, error) {
	out := []string{}
	var visit func(string) error
	visit = func(dir string) error {
		entries, err := os.ReadDir(at(root, dir))
		if err != nil {
			if !hidden {
				return nil
			}
			return err
		}
		sort.Slice(entries, func(i, j int) bool { return objstore.JSStringLess(entries[i].Name(), entries[j].Name()) })
		for _, e := range entries {
			if !hidden && (e.Name() == ".git" || e.Name() == "node_modules" || (library && e.Name() == "output")) {
				continue
			}
			name := dir + "/" + e.Name()
			if !hidden {
				name = filepath.ToSlash(filepath.Join(dir, e.Name()))
			}
			info, err := os.Stat(at(root, name))
			if err != nil {
				return err
			}
			if info.IsDir() {
				if err := visit(name); err != nil {
					return err
				}
			} else {
				out = append(out, name)
			}
		}
		return nil
	}
	if _, err := os.Stat(at(root, folder)); os.IsNotExist(err) {
		return out, nil
	} else if err != nil {
		return nil, err
	}
	return out, visit(folder)
}

func objectOf(file string) string {
	name := filepath.Base(file)
	if name == ".osd-source.json" || name == ".osd-layer.json" || name == ".osd-system.json" {
		return ""
	}
	parts := strings.Split(name, ".")
	if len(parts) < 3 {
		return ""
	}
	decoded, err := url.PathUnescape(parts[0])
	if err == nil && utf8.ValidString(decoded) {
		parts[0] = decoded
	}
	return cases.Upper(language.Und).String(parts[1]) + " " + cases.Upper(language.Und).String(parts[0])
}

// CompetitionIdentity is the layers policy, distinct from the checker's more
// restricted namespace decoder. Lifecycle detection must conservatively track
// both identities, or a newly added XML/Unicode/percent-encoded winner is missed.
func CompetitionIdentity(file string) string {
	name := strings.ToLower(filepath.Base(file))
	if strings.HasSuffix(name, ".devc.xml") || webSidecar.MatchString(name) {
		return ""
	}
	return objectOf(file)
}

func hiddenFiles(root string, folders []string) ([]string, error) {
	type entry struct{ folder, file string }
	order := []string{}
	all := map[string][]entry{}
	owner := map[string]string{}
	for _, folder := range folders {
		files, err := walk(root, folder, false, true)
		if err != nil {
			return nil, err
		}
		for _, file := range files {
			id := CompetitionIdentity(file)
			if id == "" {
				continue
			}
			if _, ok := all[id]; !ok {
				order = append(order, id)
			}
			all[id] = append(all[id], entry{folder, file})
			owner[id] = folder
		}
	}
	out := []string{}
	for _, id := range order {
		for _, e := range all[id] {
			if e.folder != owner[id] {
				out = append(out, e.file)
			}
		}
	}
	return out, nil
}
