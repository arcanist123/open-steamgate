package lintresolve

import (
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

func at(root, name string) string {
	if filepath.IsAbs(name) {
		return name
	}
	return filepath.Join(root, name)
}
func relative(root, file string) string { s, _ := filepath.Rel(root, file); return filepath.ToSlash(s) }

// JS .sort() compares UTF-16 code units, not UTF-8 byte order.
func jsLess(a, b string) bool {
	if utf8.RuneCountInString(a) == len(a) && utf8.RuneCountInString(b) == len(b) {
		return a < b
	}
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}

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
		sort.Slice(entries, func(i, j int) bool { return jsLess(entries[i].Name(), entries[j].Name()) })
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
	return strings.ToUpper(parts[1]) + " " + strings.ToUpper(parts[0])
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
			name := strings.ToLower(filepath.Base(file))
			if strings.HasSuffix(name, ".devc.xml") || webSidecar.MatchString(name) {
				continue
			}
			id := objectOf(file)
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
