//go:build unix

package genbuild

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// a cancelled build ends the builder's whole process group
func TestCommandCancelKillsTheGroup(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := (Command{Argv: []string{"sh", "-c", "sleep 30 & echo $! > child.pid; wait"}, Output: "x"}).Build(ctx, Request{Root: root})
		done <- err
	}()
	var pid int
	for deadline := time.Now().Add(5 * time.Second); pid == 0; {
		if time.Now().After(deadline) {
			t.Fatal("no child")
		}
		if b, err := os.ReadFile(filepath.Join(root, "child.pid")); err == nil {
			fmt.Sscan(string(b), &pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("a cancelled build succeeded")
	}
	for deadline := time.Now().Add(5 * time.Second); syscall.Kill(pid, 0) == nil; {
		if time.Now().After(deadline) {
			t.Fatalf("the builder's child %d outlived the cancel", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
