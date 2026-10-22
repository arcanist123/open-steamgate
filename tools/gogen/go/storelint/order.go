package storelint

import (
	"path"
	"slices"
	"strings"

	"osg/gogen/objstore"
)

// updateFile retains positions, but remove/add appends. Re-prime when an
// object's competing directories change membership or resolved order, so the
// first main file is the same one a fresh registry would select. Byte edits
// and unchanged duplicates keep the incremental path.
func competingOrderChanged(before, after []objstore.LintFile) bool {
	group := func(files []objstore.LintFile) map[string][]string {
		out := map[string][]string{}
		for _, f := range files {
			parts := strings.Split(strings.ToLower(path.Base(f.Filename)), ".")
			if len(parts) >= 3 {
				key := strings.Join(parts[:2], ".")
				out[key] = append(out[key], f.Filename)
			}
		}
		return out
	}
	old, current := group(before), group(after)
	competing := func(files []string) bool {
		for _, f := range files[min(1, len(files)):] {
			if path.Dir(f) != path.Dir(files[0]) {
				return true
			}
		}
		return false
	}
	for key, files := range old {
		if (competing(files) || competing(current[key])) && !slices.Equal(files, current[key]) {
			return true
		}
	}
	return false
}
