//go:build unix

package osgw

import (
	"os"
	"os/exec"
	"syscall"
)

// ownGroup puts the sidecar in a process group of its own: a Ctrl-C in the
// terminal reaches the gateway, which drains the sidecar, and not both.
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

func signalTerm(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
