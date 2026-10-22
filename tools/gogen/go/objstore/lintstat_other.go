//go:build !linux

package objstore

import "os"

// Until a platform has a verified change-time identity, retain full reads.
type fileIdentity struct{ modified, changed int64 }

func lintIdentity(os.FileInfo) (fileIdentity, bool) { return fileIdentity{}, false }
