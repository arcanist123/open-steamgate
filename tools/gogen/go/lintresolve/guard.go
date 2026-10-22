package lintresolve

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
)

func fileType(path string) (string, error) {
	info, err := os.Stat(path)
	if os.IsNotExist(err) || errors.Is(err, syscall.ENOTDIR) {
		return "missing", nil
	}
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "directory", nil
	}
	return "other", nil
}

func digest(path string) (string, error) {
	bytes, err := os.ReadFile(path)
	if os.IsNotExist(err) || errors.Is(err, syscall.ENOTDIR) {
		return "missing", nil
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(bytes)), nil
}

// Manifests observes all discovery candidates, including unselected packs.
// A container with its own manifest is itself a pack: children aren't packs.
func Manifests(root string, places []string) (map[string]string, error) {
	found := map[string]string{}
	for _, place := range places {
		kind, err := fileType(at(root, place))
		if err != nil {
			return nil, err
		}
		if kind != "directory" {
			continue
		}
		own := filepath.Join(place, "osd-pack.json")
		hash, err := digest(at(root, own))
		if err != nil {
			return nil, err
		}
		if hash != "missing" {
			found[filepath.ToSlash(own)] = hash
			continue
		}
		entries, err := os.ReadDir(at(root, place))
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			name := filepath.ToSlash(filepath.Join(place, e.Name(), "osd-pack.json"))
			hash, err := digest(at(root, name))
			if err != nil {
				return nil, err
			}
			if hash != "missing" {
				found[name] = hash
			}
		}
	}
	return found, nil
}

var packageSource = regexp.MustCompile(`\.(clas|intf|prog)\.(abap|xml)$`)
var packagePrefix = regexp.MustCompile(`(?i)^(?:zcl_|zif_|z)?([a-z0-9]+)_`)

func Guard(root string, r *Rules) error {
	if r == nil || r.Version != 1 {
		return fmt.Errorf("rebuild: native lint resolver rules are missing or unsupported")
	}
	env := map[string]*string{}
	for _, key := range []string{"OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_LAYER_DISCOVERY_ONLY"} {
		env[key] = nil
	}
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		if _, tracked := env[key]; tracked || strings.HasPrefix(key, "OSD_LIB_") {
			v := value
			env[key] = &v
		}
	}
	if !reflect.DeepEqual(env, r.Environment) {
		return fmt.Errorf("rebuild: lint layer environment changed")
	}
	for file, want := range r.Guards {
		got, err := digest(at(root, file))
		if err != nil {
			return fmt.Errorf("rebuild: structural input %s: %w", file, err)
		}
		if got != want {
			return fmt.Errorf("rebuild: structural input %s changed", file)
		}
	}
	for file, want := range r.States {
		got, err := fileType(at(root, file))
		if err != nil {
			return fmt.Errorf("rebuild: structural topology %s: %w", file, err)
		}
		if got != want {
			return fmt.Errorf("rebuild: structural topology %s changed", file)
		}
	}
	metadata := map[string]string{}
	for _, dir := range r.MetadataDirs {
		entries, err := os.ReadDir(at(root, dir))
		if os.IsNotExist(err) {
			return fmt.Errorf("rebuild: root package folder disappeared: %s", dir)
		}
		if err != nil {
			return fmt.Errorf("rebuild: package metadata: %w", err)
		}
		if expected, ok := r.Inference[dir]; ok {
			prefixes := map[string]bool{}
			for _, entry := range entries {
				if !packageSource.MatchString(entry.Name()) {
					continue
				}
				match := packagePrefix.FindStringSubmatch(regexUnits(entry.Name()))
				if match != nil {
					prefixes[strings.ToUpper(match[1])] = true
				}
			}
			inferred := "__OSGO_FALLBACK__"
			if len(prefixes) == 1 {
				for prefix := range prefixes {
					inferred = "$Z" + prefix
				}
			}
			if inferred != expected {
				return fmt.Errorf("rebuild: inferred root package changed: %s", dir)
			}
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".devc.xml") {
				file := filepath.ToSlash(filepath.Join(dir, entry.Name()))
				hash, err := digest(at(root, file))
				if err != nil {
					return fmt.Errorf("rebuild: package metadata: %w", err)
				}
				metadata[file] = hash
			}
		}
	}
	if r.Metadata != nil && !reflect.DeepEqual(metadata, r.Metadata) {
		return fmt.Errorf("rebuild: root package metadata changed")
	}
	found, err := Manifests(root, r.Places)
	if err != nil {
		return fmt.Errorf("rebuild: pack discovery: %w", err)
	}
	if !reflect.DeepEqual(found, r.Manifests) {
		return fmt.Errorf("rebuild: pack set or manifest changed")
	}
	return nil
}
