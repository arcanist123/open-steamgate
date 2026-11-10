//go:build !unix

package genbuild

import (
	"os/exec"
	"time"
)

func ownGroup(cmd *exec.Cmd) { cmd.WaitDelay = 5 * time.Second }
