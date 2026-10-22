package objstore

import "path/filepath"

type lintDirectory struct {
	path   string
	device uint64
}

// Cache by containing directory AND followed-file device, so nested/bind
// mounts and symlink targets do not inherit the checkout root's decision.
// Probe the file to follow symlinks; statfs on its lexical parent would not.
// Decisions live for one capture only, including failures and unknown types.
func (r *lintReader) coherent(file string, id fileIdentity) bool {
	key := lintDirectory{filepath.Dir(file), id.device}
	if ok, found := r.dirs[key]; found {
		return ok
	}
	probe := r.cache.fsType
	if probe == nil {
		probe = lintFilesystemType
	}
	kind, err := probe(file)
	ok := err == nil && lintCoherentFilesystem(kind)
	r.dirs[key] = ok
	return ok
}

func lintCoherentFilesystem(kind int64) bool {
	switch kind {
	case 0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x2fc12fc1, 0xf2f52010:
		// ext2/3/4, xfs, btrfs, tmpfs, zfs, f2fs.
		return true
	}
	// Overlayfs is deliberately excluded: statfs identifies the overlay, not
	// its backing layers, whose metadata coherence we cannot establish here.
	// NFS, CIFS/SMB, 9p, FUSE and all unknown types also retain full reads.
	return false
}
