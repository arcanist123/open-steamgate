package objstore

import (
	"os"
	"path/filepath"
	"strings"
)

// Activate makes the working source of an object its active version in this
// process and takes it off the inactive list (docs/osgo-adt-activation.md).
// Nothing is built: the running generation keeps the code it was built with,
// which Live reports. The active version is held in memory beside the
// skeletons CreateSource keeps, so it lasts until the process ends; the
// files on disk are not touched. The caller checks the source first.
func Activate(typ, name string) error {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	if storeState.cfg == nil {
		return mutationError("NOT_SUPPORTED", "no object store here: "+storeState.reason)
	}
	e := storeBuild().find(strings.ToUpper(typ), strings.ToUpper(name))
	if e == nil {
		return mutationError("NOT_FOUND", strings.ToUpper(typ)+" "+strings.ToUpper(name)+" does not exist")
	}
	if storeSourceTypes[e.Type] {
		if storeState.createdActive == nil {
			storeState.createdActive = map[string][]byte{}
		}
		for _, file := range storeFilesOf(e) {
			b, err := os.ReadFile(filepath.Join(storeState.root, file))
			if os.IsNotExist(err) {
				// an absent include has no source to publish
				delete(storeState.createdActive, file)
				continue
			}
			if err != nil {
				return mutationError("INTERNAL", err.Error())
			}
			if digest, built := storeState.cfg.Built[file]; built && digest == storeDigestBytes(b) && storeState.cfg.Active[file] != "" {
				// the build's own bytes: its snapshot stays the proof
				delete(storeState.createdActive, file)
				continue
			}
			storeState.createdActive[file] = b
		}
	}
	delete(storeState.written, e.Type+" "+e.Name)
	storeState.revision++
	return nil
}

// Live reports whether an object's files are still the ones this binary was
// built from: every file of a writable root hashes to the build's digest, and
// a file the build did not have does not exist. A library object is always
// live (it cannot change here). An object this store does not know is not.
func Live(typ, name string) bool {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	if storeState.cfg == nil {
		return false
	}
	e := storeBuild().find(strings.ToUpper(typ), strings.ToUpper(name))
	if e == nil {
		return false
	}
	if !storeWritable(e) {
		return true
	}
	for _, file := range storeFilesOf(e) {
		built, known := storeState.cfg.Built[file]
		working := storeDigest(file)
		if working != built || working == "" && known {
			return false
		}
	}
	return true
}
