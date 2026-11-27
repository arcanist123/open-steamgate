//go:build unix

package genbuild

import (
	"os/exec"
	"syscall"
	"time"
)

// ownGroup: the builder runs in a process group of its own, and a cancel
// (Queue.Close at the gateway's stop) kills the group: node and the go build
// it started, not node alone with an orphaned compile behind it.
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
}
