package objstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
	return captureLintView(storeState.root, storeState.cfg, storeState.excluded, hidden, nil)
}

// CaptureLintView captures newly resolved layer facts without changing the store
// or its active-version proofs. Structural resolution never runs a checker.
func CaptureLintView(root string, cfg *Config, hidden []string) (LintSnapshot, error) {
	return (*LintCache)(nil).Capture(root, cfg, hidden)
}

// Capture retains content only; membership and ordered digest are rebuilt every time.
// Callers serialize access (lintinput uses the storelint compiler mutex).
func (cache *LintCache) Capture(root string, cfg *Config, hidden []string) (LintSnapshot, error) {
	return cache.CaptureFiltered(root, cfg, hidden, nil)
}

// CaptureFiltered accepts the fixed-generation resolver's JS-compatible logical
// exclusion policy. All reads, hidden proofs, cache identity and errors remain
// owned by this package. A nil filter retains the store's default exclusions.
func (cache *LintCache) CaptureFiltered(root string, cfg *Config, hidden []string, filter func(string) bool) (LintSnapshot, error) {
	var excluded []*regexp.Regexp
	for _, pattern := range cfg.Excluded {
		re, err := regexp.Compile(pattern)
		if err != nil {
			return LintSnapshot{}, err
		}
		excluded = append(excluded, re)
	}
	return captureLintView(root, cfg, excluded, hidden, cache, filter)
}

func captureLintView(rootPath string, cfg *Config, excluded []*regexp.Regexp, hidden []string, cache *LintCache, filters ...func(string) bool) (LintSnapshot, error) {
	out := LintSnapshot{Root: rootPath}
	skip := map[string]bool{}
	for _, file := range hidden {
		skip[file] = true
	}
	reader := cache.begin()
	defer reader.finish()
	hash := sha256.New()
	encoder := json.NewEncoder(hash)
	_ = encoder.Encode(cfg)
	roots := append(append([]Root{}, cfg.Roots...), cfg.Libs...)
	for _, root := range roots {
		files := root.Files
		var infos map[string]os.FileInfo
		if cache != nil {
			infos = map[string]os.FileInfo{}
		}
		if !root.Library {
			var err error
			files, err = lintWalkFiltered(rootPath, root.Path, excluded, infos, filters...)
			if err != nil {
				return out, err
			}
		}
		for _, file := range files {
			if !(strings.HasSuffix(file, ".abap") || strings.HasSuffix(file, ".xml") || strings.HasSuffix(file, ".asddls")) {
				continue
			}
			content, err := reader.read(filepath.Join(rootPath, file), infos[file])
			if err != nil {
				return out, fmt.Errorf("ABAP lint input %s: %w", file, err)
			}
			// Include hidden files in identity: an edit/addition could change
			// which layer wins and require full layer resolution and re-prime.
			_ = encoder.Encode([]string{file, content.digest})
			if !skip[file] {
				out.Files = append(out.Files, LintFile{Filename: "/" + file, Raw: content.raw})
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
func lintWalkInfo(base, dir string, patterns []*regexp.Regexp, infos map[string]os.FileInfo) ([]string, error) {
	return lintWalkFiltered(base, dir, patterns, infos)
}

func lintWalkFiltered(base, dir string, patterns []*regexp.Regexp, infos map[string]os.FileInfo, filters ...func(string) bool) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(base, dir))
	if os.IsNotExist(err) {
		return nil, nil // optional roots (notably local/tmp) may not exist yet
	}
	if err != nil {
		return nil, err
	}
	var files []string
	sort.Slice(entries, func(i, j int) bool { return JSStringLess(entries[i].Name(), entries[j].Name()) })
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
			children, err := lintWalkFiltered(base, file, patterns, infos, filters...)
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
		if len(filters) > 0 && filters[0] != nil {
			excluded = filters[0](file)
		}
		if !excluded {
			if infos != nil {
				infos[file] = info
			}
			files = append(files, file)
		}
	}
	return files, nil
}
