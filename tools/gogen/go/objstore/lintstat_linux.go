package objstore

import (
	"os"
	"syscall"
)

type fileIdentity struct {
	device, inode     uint64
	size              int64
	mode              uint32
	modified, changed int64
}

func lintIdentity(info os.FileInfo) (fileIdentity, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() {
		return fileIdentity{}, false
	}
	return fileIdentity{uint64(stat.Dev), stat.Ino, stat.Size, stat.Mode, stat.Mtim.Nano(), stat.Ctim.Nano()}, true
}

func lintFilesystemType(file string) (int64, error) {
	var stat syscall.Statfs_t
	err := syscall.Statfs(file, &stat)
	return int64(uint32(stat.Type)), err
}

// storeStampIdentity is a folder's or a file's identity for the index cache
// (indexcache.go): unlike lintIdentity it accepts folders.
func storeStampIdentity(info os.FileInfo) (fileIdentity, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, false
	}
	return fileIdentity{uint64(stat.Dev), stat.Ino, stat.Size, stat.Mode, stat.Mtim.Nano(), stat.Ctim.Nano()}, true
}
