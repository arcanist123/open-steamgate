package objstore

import (
	"os"
	"path/filepath"
	"strings"

	"osg/gogen/storecheck"
)

// Only saved ABAP checks on the in-process provider use a targeted index.
// Other commands, source overlays and non-ABAP types keep the general index.
func checkRunIndex(command, typ, name string, _ *string, filter string) *storeIndex {
	capable, ok := compilerState.provider.(storecheck.SourceCompiler)
	if command == "CHECKRUN" && !storecheck.UsesSource(command, filter, true, compilerState.provider) && ok && capable.SupportsSource() {
		switch typ {
		case "CLAS", "INTF", "PROG", "INCL":
			ext, _ := storeTypeExt(typ)
			// Keep the requested identity: lowercasing is lossy for names such
			// as capital sharp S and Kelvin sign.
			return storeBuildFor(strings.ReplaceAll(name, "/", "#") + ext)
		}
	}
	return storeBuild()
}

// Match the full builder's exact extension admission and canonical object name.
// Unicode simple folding is not the identity relation defined by storeNameOf.
func storeTargetMatches(name, target string) bool {
	for _, typ := range storeTypes {
		if typ.SameFileAs == "" && strings.HasSuffix(target, typ.Ext) {
			return strings.HasSuffix(name, typ.Ext) &&
				storeNameOf(strings.TrimSuffix(name, typ.Ext)) == storeNameOf(strings.TrimSuffix(target, typ.Ext))
		}
	}
	return false
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
		if entry.Type()&os.ModeSymlink != 0 || storeTargetMatches(name, target) {
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
		if !storeTargetMatches(name, target) {
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
