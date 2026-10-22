package lintinput

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// libraryMembership reads names/types, not file contents or file metadata.
// Any namespace change re-runs the embedded native glob/exclusion resolver;
// excluded additions can cause one harmless resolution, but never enter the
// checker. Watch configured folders, including empty/missing library roots.
func libraryMembership(root string, places []string) (string, error) {
	hash := sha256.New()
	for _, place := range places {
		hash.Write([]byte(place))
		hash.Write([]byte{0})
		err := filepath.WalkDir(filepath.Join(root, place), func(file string, entry fs.DirEntry, err error) error {
			if os.IsNotExist(err) && file == filepath.Join(root, place) {
				hash.Write([]byte("missing\x00"))
				return nil
			}
			if err != nil {
				return err
			}
			if entry.IsDir() && (entry.Name() == ".git" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			name, err := filepath.Rel(root, file)
			if err != nil {
				return err
			}
			hash.Write([]byte(filepath.ToSlash(name)))
			var kind [5]byte
			binary.LittleEndian.PutUint32(kind[:4], uint32(entry.Type()))
			hash.Write(kind[:])
			if entry.Type()&os.ModeSymlink != 0 {
				target, err := os.Readlink(file)
				if err != nil {
					return err
				}
				hash.Write([]byte(target))
				hash.Write([]byte{0})
				info, err := os.Stat(file)
				if err != nil {
					return err
				}
				if info.IsDir() {
					return fmt.Errorf("lint: library directory symlink %s cannot be watched; use a physical library root", name)
				}
			}
			return nil
		})
		if err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func libraryPlaces(spec Spec) []string {
	if spec.LibraryPlaces != nil {
		return spec.LibraryPlaces
	}
	var places []string
	if spec.Store != nil {
		for _, lib := range spec.Store.Libs {
			places = append(places, lib.Path)
		}
	}
	return places
}
