package storelint

import (
	"path"
	"slices"
	"strings"

	"osg/gogen/objstore"
)

// ObjectIdentity matches @abaplint/core AbstractFile.getObjectName/getObjectType:
// decode the three supported escapes before uppercasing, then abapGit and AFF
// namespaces. Do not URL-decode other spellings (notably uppercase %3E/%3C).
// Physical filenames remain separate for registry membership/order comparisons.
func ObjectIdentity(filename string) string {
	parts := strings.Split(path.Base(strings.ReplaceAll(filename, "\\", "/")), ".")
	if len(parts) < 3 {
		return ""
	}
	name := strings.NewReplacer("%23", "#", "%3e", ">", "%3c", "<").Replace(parts[0])
	name = strings.ReplaceAll(strings.ToUpper(name), "#", "/")
	name = strings.Replace(name, "(", "/", 1)
	name = strings.Replace(name, ")", "/", 1)
	return name + "." + strings.ToUpper(parts[1])
}

// updateFile retains positions, but remove/add appends. Re-prime when an
// object's competing directories change membership or resolved order, so the
// first main file is the same one a fresh registry would select. Byte edits
// and unchanged duplicates keep the incremental path.
func competingOrderChanged(before, after []objstore.LintFile) bool {
	// Content changes cannot change registry order. Avoid allocating two
	// object maps on the overwhelmingly common identical-membership path.
	if slices.EqualFunc(before, after, func(a, b objstore.LintFile) bool { return a.Filename == b.Filename }) {
		return false
	}
	group := func(files []objstore.LintFile) map[string][]string {
		out := map[string][]string{}
		for _, f := range files {
			key := ObjectIdentity(f.Filename)
			if key != "" {
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
