package objstore

import (
	"os"
	"path/filepath"
	"strings"

	"osg/gogen/storecheck"
)

// Only saved ABAP checks on the in-process provider use a targeted index.
// Other commands, source overlays and non-ABAP types keep the general index.
func checkRunIndex(command, typ, name string, source *string, filter string) *storeIndex {
	capable, ok := compilerState.provider.(storecheck.SourceCompiler)
	if command == "CHECKRUN" && source == nil && filter != "SOURCE" && ok && capable.SupportsSource() {
		switch typ {
		case "CLAS", "INTF", "PROG", "INCL":
			ext, _ := storeTypeExt(typ)
			return storeBuildFor(storeFileOf(name) + ext)
		}
	}
	return storeBuild()
}

// ReadDir supplies the same lexical traversal as storeWalk. Stat directories
// only when following links, and stat matching files to preserve existence and
// dangling-link behavior. No directory inventory survives a request.
func storeTargetWalk(base, dir, target string, out []string) []string {
	entries, err := os.ReadDir(filepath.Join(base, dir))
	if err != nil {
		return out
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "node_modules" || name == ".git" {
			continue
		}
		rel := filepath.ToSlash(filepath.Join(dir, name))
		isDir := entry.IsDir()
		if entry.Type()&os.ModeSymlink != 0 || strings.EqualFold(name, target) {
			info, err := os.Stat(filepath.Join(base, rel))
			if err != nil {
				continue
			}
			isDir = info.IsDir()
		}
		if isDir {
			out = storeTargetWalk(base, rel, target, out)
			continue
		}
		if !strings.EqualFold(name, target) {
			continue
		}
		skip := false
		for _, re := range storeState.excluded {
			if re.MatchString("/" + rel) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, rel)
		}
	}
	return out
}
