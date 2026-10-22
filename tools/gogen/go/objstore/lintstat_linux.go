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
