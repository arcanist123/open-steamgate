package objstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// LintFile is a registry input, including metadata and local class includes.
// Libraries are checkable files too, matching buildRegistry on the Node host.
type LintFile struct{ Filename, Raw string }

type LintSnapshot struct {
	Root, Digest      string
	Config, Structure string
	Files             []LintFile
}

// CaptureLint reads the store's configured roots and library lists in registry
// order. hidden is the Node layer resolver's build-time answer. A caller must
// compare Digest before AND after checking; Files retain bytes for incremental updates.
func CaptureLint(hidden []string) (LintSnapshot, error) {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	out := LintSnapshot{Root: storeState.root}
	if storeState.cfg == nil {
		return out, fmt.Errorf("ABAP lint: no object store configured")
	}
	return captureLintView(storeState.root, storeState.cfg, storeState.excluded, hidden)
}

// CaptureLintView captures newly resolved layer facts without changing the store
// or its active-version proofs. Structural resolution never runs a checker.
func CaptureLintView(root string, cfg *Config, hidden []string) (LintSnapshot, error) {
	var excluded []*regexp.Regexp
	for _, pattern := range cfg.Excluded {
		re, err := regexp.Compile(pattern)
		if err != nil {
			return LintSnapshot{}, err
		}
		excluded = append(excluded, re)
	}
	return captureLintView(root, cfg, excluded, hidden)
}

func captureLintView(rootPath string, cfg *Config, excluded []*regexp.Regexp, hidden []string) (LintSnapshot, error) {
	out := LintSnapshot{Root: rootPath}
	skip := map[string]bool{}
	for _, file := range hidden {
		skip[file] = true
	}
	hash := sha256.New()
	encoder := json.NewEncoder(hash)
	_ = encoder.Encode(cfg)
	roots := append(append([]Root{}, cfg.Roots...), cfg.Libs...)
	for _, root := range roots {
		files := root.Files
		if !root.Library {
			var err error
			files, err = lintWalk(rootPath, root.Path, excluded)
			if err != nil {
				return out, err
			}
		}
		for _, file := range files {
			if !(strings.HasSuffix(file, ".abap") || strings.HasSuffix(file, ".xml") || strings.HasSuffix(file, ".asddls")) {
				continue
			}
			bytes, err := os.ReadFile(filepath.Join(rootPath, file))
			if err != nil {
				return out, fmt.Errorf("ABAP lint input %s: %w", file, err)
			}
			// Include hidden files in identity: an edit/addition could change
			// which layer wins and require full layer resolution and re-prime.
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
func lintWalk(base, dir string, patterns []*regexp.Regexp) ([]string, error) {
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
			children, err := lintWalk(base, file, patterns)
			if err != nil {
				return nil, err
			}
			files = append(files, children...)
			continue
		}
		excluded := false
		for _, re := range patterns {
			excluded = excluded || re.MatchString("/"+file)
		}
		if !excluded {
			files = append(files, file)
		}
	}
	return files, nil
}
