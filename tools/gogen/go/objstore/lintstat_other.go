//go:build !linux

package objstore

import "os"

// Until a platform has a verified change-time identity, retain full reads.
type fileIdentity struct {
	device            uint64
	modified, changed int64
}

func lintIdentity(os.FileInfo) (fileIdentity, bool) { return fileIdentity{}, false }

func lintFilesystemType(string) (int64, error) { return 0, nil }
