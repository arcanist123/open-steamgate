package objstore

import (
	"os"
	"path/filepath"
	"strings"
)

// Object names one object of an activation batch.
type Object struct{ Type, Name string }

// The published snapshot of a file: an immutable copy of its active bytes
// that a compiler can read by path (compilerInput), named by content.
const publishedDir = "build/osgo-published"

// Activate publishes one object; ActivateAll is the batch form.
func Activate(typ, name string) error { return ActivateAll([]Object{{typ, name}}) }

// ActivateAll makes the working source of every object its active version in
// this process and takes the objects off the inactive list
// (docs/osgo-adt-activation.md). It is all or nothing: every object is
// resolved, every file read and every snapshot written before any active
// version or the inactive set changes, so a missing object or an unreadable
// file leaves the store as it was. Nothing is built: the running generation
// keeps the code it was built with, which Live reports. The active versions
// are held in memory beside the skeletons CreateSource keeps, so they last
// until the process ends; the working files are not touched. The caller
// checks the source first.
func ActivateAll(objects []Object) error {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	if storeState.cfg == nil {
		return mutationError("NOT_SUPPORTED", "no object store here: "+storeState.reason)
	}
	type change struct {
		file, snapshot string
		bytes          []byte
		digest         string // the working bytes' digest ("" for an absent include)
		drop           bool
	}
	var changes []change
	var keys []string
	ix := storeBuild()
	for _, o := range objects {
		e := ix.find(strings.ToUpper(o.Type), strings.ToUpper(o.Name))
		if e == nil {
			return mutationError("NOT_FOUND", strings.ToUpper(o.Type)+" "+strings.ToUpper(o.Name)+" does not exist")
		}
		keys = append(keys, e.Type+" "+e.Name)
		if !storeSourceTypes[e.Type] {
			continue
		}
		for _, file := range storeFilesOf(e) {
			b, err := os.ReadFile(filepath.Join(storeState.root, file))
			if os.IsNotExist(err) {
				// an absent include has no source to publish
				changes = append(changes, change{file: file, drop: true})
				continue
			}
			if err != nil {
				return mutationError("INTERNAL", err.Error())
			}
			digest := storeDigestBytes(b)
			if built, ok := storeState.cfg.Built[file]; ok && built == digest && storeState.cfg.Active[file] != "" {
				// the build's own bytes: its snapshot stays the proof
				changes = append(changes, change{file: file, digest: digest, drop: true})
				continue
			}
			snapshot := publishedDir + "/" + digest[:32] + "/" + filepath.Base(file)
			full := filepath.Join(storeState.root, filepath.FromSlash(snapshot))
			if existing, err := os.ReadFile(full); err != nil || storeDigestBytes(existing) != digest {
				if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
					return mutationError("INTERNAL", err.Error())
				}
				if err := os.WriteFile(full, b, 0o644); err != nil {
					return mutationError("INTERNAL", err.Error())
				}
			}
			changes = append(changes, change{file: file, snapshot: snapshot, bytes: b, digest: digest})
		}
	}
	if storeState.createdActive == nil {
		storeState.createdActive = map[string][]byte{}
	}
	if storeState.publishedSnapshot == nil {
		storeState.publishedSnapshot = map[string]string{}
	}
	// the index a later process restores from (published.go), written
	// before anything changes here, so a failed write cancels the batch.
	// It is merged with the index on disk, not written from this process's
	// own view: two generations can activate inside one drain window (a
	// session pinned to the old one), and a whole-view overwrite would drop
	// what the other published and this process never saw. Where both have
	// an entry the disk's wins (its writer published after this one did);
	// the batch's own changes then apply on top.
	next, err := readPublishedIndex()
	if err != nil {
		return mutationError("INTERNAL", "the published index: "+err.Error())
	}
	for f, snap := range storeState.publishedSnapshot {
		if _, onDisk := next[f]; !onDisk {
			next[f] = publishedEntry{Snapshot: snap, Digest: storeDigestBytes(storeState.createdActive[f])}
		}
	}
	for _, c := range changes {
		if c.drop {
			mine, own := false, false
			if snap, ok := storeState.publishedSnapshot[c.file]; ok && next[c.file].Snapshot == snap {
				mine = true // this process published the entry and now reverts it
			}
			if c.digest != "" && next[c.file].Digest == c.digest {
				own = true // the entry names the bytes this build was built from
			}
			if !mine && !own {
				continue // another generation published the file in between: kept
			}
			delete(next, c.file)
			continue
		}
		next[c.file] = publishedEntry{Snapshot: c.snapshot, Digest: c.digest}
	}
	if err := writePublishedIndex(next); err != nil {
		return mutationError("INTERNAL", "the published index: "+err.Error())
	}
	for _, c := range changes {
		if c.drop {
			delete(storeState.createdActive, c.file)
			delete(storeState.publishedSnapshot, c.file)
			continue
		}
		storeState.createdActive[c.file] = c.bytes
		storeState.publishedSnapshot[c.file] = c.snapshot
	}
	for _, key := range keys {
		delete(storeState.written, key)
	}
	storeState.revision++
	return nil
}

// Live reports whether an object's files are still the ones this binary was
// built from: every file of a writable root hashes to the build's digest, and
// a file the build did not have does not exist. A library object is always
// live (it cannot change here). An object this store does not know is not.
func Live(typ, name string) bool {
	storeState.mu.RLock()
	defer storeState.mu.RUnlock()
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

// activeSnapshot is the path and digest a compiler reads for a file's active
// version: the published snapshot when activation set one, else the build's.
func activeSnapshot(file string) (path, digest string, ok bool) {
	if snap, published := storeState.publishedSnapshot[file]; published {
		if b, proven := storeState.createdActive[file]; proven {
			return snap, storeDigestBytes(b), true
		}
	}
	if _, proven := storeActiveBytes(file); proven && storeState.cfg.Active[file] != "" {
		return storeState.cfg.Active[file], storeState.cfg.Built[file], true
	}
	return "", "", false
}
