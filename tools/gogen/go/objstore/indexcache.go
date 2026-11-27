package objstore

import (
	"os"
	"sync/atomic"
	"time"
)

// The cached full index (ADR 0010, after slice 5). Building the index walks
// every root, stats every file and computes every package chain: the ADT
// source read spent most of its CPU there, under the store mutex, on every
// call. The index is a function of a few things only -- the names in the
// roots' folders, the existence of the libraries' files, the package.devc.xml
// files of abapGit roots, local/tmp/tadir.json, and the configuration
// SetStore installed -- so it is built once and reused while none of them
// changed:
//
//   - the configuration and every write through the store bump
//     storeState.revision (SetStore, SetCompiler, WRITE, CreateSource,
//     DeleteSource, ActivateAll, RestorePublished); an index of another
//     revision is never used;
//   - every folder is stamped before it is read (device, inode, size, mode,
//     mtime, ctime), and so is every symlink's target, every library file's
//     folder, every package.devc.xml read or looked for and tadir.json: an
//     editor or a git pull that adds, removes or renames a file changes its
//     folder's stamp, and the next call walks again. A content edit of a
//     source changes no stamp and needs none: the index holds no content.
//   - racy stamps are not trusted, as LintCache does it: an index whose
//     stamps are not older than the walk's start minus the window is not
//     reused, so a change inside one timestamp tick of the walk cannot hide;
//   - only the filesystems LintCache trusts (ext2/3/4, XFS, Btrfs, tmpfs, ZFS,
//     F2FS) are cached; elsewhere, and on platforms without a change-time
//     identity, every call walks as before.
//
// The index is immutable once published: callers read its entries and never
// change them (find copies the ones it alters). Readers share it under the
// store's read lock; builds may run concurrently and the last one wins, which
// is safe because every use checks the stamps again.

// storeIndexWindow is the racy window; negative disables the cache.
var storeIndexWindow = 2 * time.Second

// storeIndexFSType is the statfs probe (injectable for tests).
var storeIndexFSType = lintFilesystemType

// storeIndexWalks counts full walks (tests).
var storeIndexWalks atomic.Int64

var storeIndexCurrent atomic.Pointer[cachedIndex]

type cachedIndex struct {
	ix       *storeIndex
	revision uint64
	root     string
	cfg      *Config
	stamps   []indexStamp
}

type indexStamp struct {
	path    string
	present bool
	id      fileIdentity
}

type indexRecorder struct {
	start  time.Time
	stamps []indexStamp
	seen   map[string]bool
	fs     map[uint64]bool
	ok     bool
}

// path stamps a path before it is read; nil records nothing.
func (r *indexRecorder) path(full string) {
	if r == nil || !r.ok || r.seen[full] {
		return
	}
	info, err := os.Stat(full)
	r.stat(full, info, err)
}

// stat stamps a path with a stat taken before the path was read.
func (r *indexRecorder) stat(full string, info os.FileInfo, err error) {
	if r == nil || !r.ok || r.seen[full] {
		return
	}
	r.seen[full] = true
	s := indexStamp{path: full}
	if err != nil {
		if !os.IsNotExist(err) {
			r.ok = false
			return
		}
		r.stamps = append(r.stamps, s)
		return
	}
	id, ok := storeStampIdentity(info)
	if !ok || !r.coherent(full, id.device) {
		r.ok = false
		return
	}
	window := storeIndexWindow
	if !time.Unix(0, id.modified).Before(r.start.Add(-window)) || !time.Unix(0, id.changed).Before(r.start.Add(-window)) {
		r.ok = false // racy: changed too close to the walk to be told apart
		return
	}
	s.present, s.id = true, id
	r.stamps = append(r.stamps, s)
}

func (r *indexRecorder) coherent(full string, device uint64) bool {
	if ok, found := r.fs[device]; found {
		return ok
	}
	kind, err := storeIndexFSType(full)
	ok := err == nil && lintCoherentFilesystem(kind)
	r.fs[device] = ok
	return ok
}

func (c *cachedIndex) fresh() bool {
	if c == nil || c.revision != storeState.revision || c.root != storeState.root || c.cfg != storeState.cfg {
		return false
	}
	for _, s := range c.stamps {
		info, err := os.Stat(s.path)
		if err != nil {
			if s.present || !os.IsNotExist(err) {
				return false
			}
			continue
		}
		if !s.present {
			return false
		}
		if id, ok := storeStampIdentity(info); !ok || id != s.id {
			return false
		}
	}
	return true
}

// storeCachedIndex is the full index: the cached one when its stamps still
// hold, else a new walk (cached when its stamps can be trusted).
// storeState.mu held, shared or exclusive.
func storeCachedIndex() *storeIndex {
	if c := storeIndexCurrent.Load(); c.fresh() {
		return c.ix
	}
	storeIndexWalks.Add(1)
	if storeIndexWindow < 0 {
		return storeWalkIndex("", nil)
	}
	rec := &indexRecorder{start: time.Now(), seen: map[string]bool{}, fs: map[uint64]bool{}, ok: true}
	ix := storeWalkIndex("", rec)
	if rec.ok {
		storeIndexCurrent.Store(&cachedIndex{ix: ix, revision: storeState.revision, root: storeState.root, cfg: storeState.cfg, stamps: rec.stamps})
	} else {
		storeIndexCurrent.Store(nil)
	}
	return ix
}
