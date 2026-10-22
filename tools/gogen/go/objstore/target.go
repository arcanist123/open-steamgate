package objstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"osg/gogen/storecheck"
)

// Targeted native checks retain a fresh walk and the full builder's layer rules.
func checkRunIndex(command, typ, name string, _ *string, filter string) *storeIndex {
	capable, ok := compilerState.provider.(storecheck.SourceCompiler)
	native, linked := compilerState.provider.(interface{ SupportsCheckSource() bool })
	check := command == "CHECK" && linked && native.SupportsCheckSource()
	if check || (command == "CHECKRUN" && !storecheck.UsesSource(command, filter, true, compilerState.provider) && ok && capable.SupportsSource()) {
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

func outlineIndex(raw string) *storeIndex {
	native, ok := compilerState.provider.(interface{ NativeCheckOutline() bool })
	var in struct{ Kind, Type, Name string }
	if ok && native.NativeCheckOutline() && json.Unmarshal([]byte(raw), &in) == nil && in.Kind == "OUTLINE" {
		typ := strings.ToUpper(in.Type)
		switch typ {
		case "CLAS", "INTF", "PROG", "INCL":
			ext, _ := storeTypeExt(typ)
			return storeBuildFor(strings.ReplaceAll(strings.ToUpper(in.Name), "/", "#") + ext)
		}
	}
	return storeBuild()
}
