package lintresolve

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var overlayMember = regexp.MustCompile(`(?i)\.(clas|intf)\.`)

// ZIP discovery checks every prospective overlay target with strict writable().
// Recheck links natively; missing seeded members require Node's build-time seed.
func overlayTarget(root, target string, required bool) error {
	path := root
	for _, step := range strings.Split(filepath.FromSlash(target), string(filepath.Separator)) {
		path = filepath.Join(path, step)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) && !required {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("overlay path is redirected through a link: %s", target)
		}
	}
	return nil
}

func topology(root string, r *Rules) error {
	for _, layer := range r.ZipLayers {
		if err := overlayTarget(root, layer.Overlay+"/.osd-overlay.txt", false); err != nil {
			return fmt.Errorf("rebuild: %w", err)
		}
		var seed func(string) error
		seed = func(dir string) error {
			entries, err := os.ReadDir(at(root, dir))
			if err != nil {
				return err
			}
			for _, entry := range entries {
				name := filepath.ToSlash(filepath.Join(dir, entry.Name()))
				if entry.IsDir() {
					if err := seed(name); err != nil {
						return err
					}
				} else if strings.HasSuffix(entry.Name(), ".devc.xml") || overlayMember.MatchString(entry.Name()) {
					target := filepath.ToSlash(filepath.Join(layer.Overlay, relative(at(root, layer.Source), at(root, name))))
					if err := overlayTarget(root, target, true); err != nil {
						return err
					}
				}
			}
			return nil
		}
		if err := seed(layer.Source); err != nil {
			return fmt.Errorf("rebuild: ZIP overlay seed topology: %w", err)
		}
	}
	// layers() computes shadows even when only hidden files are requested.
	// The shadow values aren't checker facts, but failed reads/stats still refuse.
	local := at(root, "local")
	if _, err := os.Stat(local); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("rebuild: shadow topology: %w", err)
	}
	entries, err := os.ReadDir(local)
	if err != nil {
		return fmt.Errorf("rebuild: shadow topology: %w", err)
	}
	for _, entry := range entries {
		candidate := "local/" + entry.Name()
		listed := false
		for _, descriptor := range r.Roots {
			listed = listed || descriptor.Path == candidate
		}
		if listed {
			continue
		}
		kind, err := fileType(at(root, candidate))
		if err != nil || kind == "missing" {
			return fmt.Errorf("rebuild: shadow stat failed: %s (%v)", candidate, err)
		}
		if kind == "directory" {
			if _, err := walk(root, candidate, false, true); err != nil {
				return fmt.Errorf("rebuild: shadow topology: %w", err)
			}
		}
	}
	return nil
}
