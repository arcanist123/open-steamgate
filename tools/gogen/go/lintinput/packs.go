package lintinput

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// Stat follows symlinks, like canonical pack resolution. Only existence/type
// matters here; source bytes and membership are captured by the store walker.
func packSources(root string, expected map[string]string) (map[string]string, bool, error) {
	current := map[string]string{}
	changed := false
	for candidate, before := range expected {
		info, err := os.Stat(filepath.Join(root, candidate))
		kind := "missing"
		if err == nil {
			kind = "other"
			if info.IsDir() {
				kind = "directory"
			}
		} else if !os.IsNotExist(err) && !errors.Is(err, syscall.ENOTDIR) {
			return nil, false, err
		}
		current[candidate] = kind
		changed = changed || before != kind
	}
	return current, changed, nil
}
