//go:build !unix

package osgw

import (
	"errors"
	"os"
	"os/exec"
)

func ownGroup(*exec.Cmd) {}

// no SIGTERM to send: terminate kills (the sidecar's LUW rolls back with
// its connection, as at a grace that ran out)
func signalTerm(*os.Process) error { return errors.New("no SIGTERM on this system") }
