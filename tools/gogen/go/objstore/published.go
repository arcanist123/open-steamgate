package objstore

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// The published index (ADR 0010 slice 4, "the snapshot restored at sidecar
// start"): which files activation published and where each one's snapshot
// is, written beside the snapshots. A process started later from the same
// tree -- a replacement after a crash, a restart, a swap candidate -- reads
// it in RestorePublished, so a published object stays published past the
// process that published it. A snapshot whose digest is the starting
// build's own is not published there: it is active, and the next activation
// of the process that published it writes the index without it. Writers
// merge (ActivateAll): an entry another generation published is kept -- a
// whole-view overwrite would drop what a draining generation cannot see.
const publishedIndex = publishedDir + "/index.json"

type publishedEntry struct {
	Snapshot string `json:"snapshot"`
	Digest   string `json:"digest"`
}

// writePublishedIndex writes the index (file -> entry); storeState.mu held.
// Written beside and renamed.
func writePublishedIndex(index map[string]publishedEntry) error {
	raw, err := json.MarshalIndent(index, "", " ")
	if err != nil {
		return err
	}
	full := filepath.Join(storeState.root, filepath.FromSlash(publishedIndex))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".index-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), full)
}

// readPublishedIndex is the index on disk; no index is none. storeState.mu
// held.
func readPublishedIndex() (map[string]publishedEntry, error) {
	raw, err := os.ReadFile(filepath.Join(storeState.root, filepath.FromSlash(publishedIndex)))
	if os.IsNotExist(err) {
		return map[string]publishedEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	var index map[string]publishedEntry
	if err := json.Unmarshal(raw, &index); err != nil {
		return nil, err
	}
	if index == nil {
		index = map[string]publishedEntry{}
	}
	return index, nil
}

// RestorePublished reads the published index of the tree and makes every
// snapshot in it that this build did not build from the active version of
// its file again, as activation left it. Skipped: a snapshot this build's
// digest names (active now), a file that no longer exists (deleted since),
// and a snapshot whose bytes are not its digest. It answers how many files
// it restored; no index is none.
func RestorePublished() (int, error) {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	if storeState.cfg == nil {
		return 0, nil
	}
	index, err := readPublishedIndex()
	if err != nil {
		return 0, err
	}
	n := 0
	for file, e := range index {
		if built, ok := storeState.cfg.Built[file]; ok && built == e.Digest {
			continue
		}
		if _, err := os.Stat(filepath.Join(storeState.root, file)); err != nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join(storeState.root, filepath.FromSlash(e.Snapshot)))
		if err != nil || storeDigestBytes(b) != e.Digest {
			continue
		}
		storeState.createdActive[file] = b
		storeState.publishedSnapshot[file] = e.Snapshot
		n++
	}
	if n > 0 {
		storeState.revision++
	}
	return n, nil
}
