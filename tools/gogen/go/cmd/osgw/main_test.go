package main

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func TestSidecarRoot(t *testing.T) {
	for _, args := range [][]string{{"-adt", "-root", "/tree", "-home", "h"}, {"--root=/tree"}} {
		if got := sidecarRoot(args); got != filepath.Clean("/tree") && runtime.GOOS != "windows" {
			t.Fatalf("%v: %s", args, got)
		}
	}
	if wd, _ := os.Getwd(); sidecarRoot(nil) != wd {
		t.Fatal("no -root is the current directory")
	}
}

// a stashed generation is told where the first one found osd and media
func TestBesideBinary(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "osgo")
	osd := filepath.Join(dir, "osd")
	if runtime.GOOS == "windows" {
		osd += ".exe"
	}
	os.WriteFile(osd, []byte("x"), 0o755)
	os.MkdirAll(filepath.Join(dir, "media"), 0o755)
	os.WriteFile(filepath.Join(dir, "media", "w3mi.json"), []byte("{}"), 0o644)
	none := func(string) string { return "" }
	env, args := besideBinary(bin, []string{"-adt"}, none)
	if !slices.Equal(env, []string{"OSGO_SIDECAR=" + osd}) || !slices.Equal(args, []string{"-adt", "-media", filepath.Join(dir, "media")}) {
		t.Fatalf("%v %v", env, args)
	}
	env, args = besideBinary(bin, []string{"-media", "/m"}, func(string) string { return "/own/osd" })
	if len(env) != 0 || !slices.Equal(args, []string{"-media", "/m"}) {
		t.Fatalf("named ones were overridden: %v %v", env, args)
	}
}
