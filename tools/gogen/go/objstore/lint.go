package objstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LintFile is a registry input, including metadata and local class includes.
// Libraries are checkable files too, matching buildRegistry on the Node host.
type LintFile struct{ Filename, Raw string }

type LintSnapshot struct {
	Root, Digest string
	Files        []LintFile
}

// CaptureLint reads the store's configured roots and library lists in registry
// order. hidden is the Node layer resolver's build-time answer. A caller must
// compare Digest before AND after checking; this slice never updates a registry.
func CaptureLint(hidden []string) (LintSnapshot, error) {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	out := LintSnapshot{Root: storeState.root}
	if storeState.cfg == nil {
		return out, fmt.Errorf("ABAP lint: no object store configured")
	}
	skip := map[string]bool{}
	for _, file := range hidden {
		skip[file] = true
	}
	hash := sha256.New()
	encoder := json.NewEncoder(hash)
	_ = encoder.Encode(storeState.cfg)
	roots := append(append([]Root{}, storeState.cfg.Roots...), storeState.cfg.Libs...)
	for _, root := range roots {
		files := root.Files
		if !root.Library {
			var err error
			files, err = lintWalk(storeState.root, root.Path)
			if err != nil {
				return out, err
			}
		}
		for _, file := range files {
			if !(strings.HasSuffix(file, ".abap") || strings.HasSuffix(file, ".xml") || strings.HasSuffix(file, ".asddls")) {
				continue
			}
			bytes, err := os.ReadFile(filepath.Join(storeState.root, file))
			if err != nil {
				return out, fmt.Errorf("ABAP lint input %s: %w", file, err)
			}
			// Include hidden files in identity: an edit/addition could change
			// which layer wins, which needs a new build in this first slice.
			_ = encoder.Encode([]string{file, storeDigestBytes(bytes)})
			if !skip[file] {
				out.Files = append(out.Files, LintFile{Filename: "/" + file, Raw: string(bytes)})
			}
		}
	}
	if len(out.Files) == 0 {
		return out, fmt.Errorf("ABAP lint: store registry inputs are empty")
	}
	out.Digest = hex.EncodeToString(hash.Sum(nil))
	return out, nil
}

// Like storeWalk, but IO failures must never become a clean, partial registry.
func lintWalk(base, dir string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(base, dir))
	if os.IsNotExist(err) {
		return nil, nil // optional roots (notably local/tmp) may not exist yet
	}
	if err != nil {
		return nil, err
	}
	var files []string
	for _, entry := range entries { // ReadDir is sorted, like Node's walk
		if entry.Name() == "node_modules" || entry.Name() == ".git" {
			continue
		}
		file := filepath.ToSlash(filepath.Join(dir, entry.Name()))
		info, err := os.Stat(filepath.Join(base, file))
		if err != nil {
			return nil, err
		}
		if info.IsDir() {
			children, err := lintWalk(base, file)
			if err != nil {
				return nil, err
			}
			files = append(files, children...)
			continue
		}
		excluded := false
		for _, re := range storeState.excluded {
			excluded = excluded || re.MatchString("/"+file)
		}
		if !excluded {
			files = append(files, file)
		}
	}
	return files, nil
}
