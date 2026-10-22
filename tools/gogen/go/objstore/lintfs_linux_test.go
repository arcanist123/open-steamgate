package objstore

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLintCacheStaleAttributesFreshOpen(t *testing.T) {
	file := filepath.Join(t.TempDir(), "dep.intf.abap")
	if err := os.WriteFile(file, []byte("old bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2100 * time.Millisecond)
	oldStat, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	cache := &LintCache{fsType: coherentTestFS}
	reader := cache.begin()
	if _, err := reader.read(file, oldStat); err != nil {
		t.Fatal(err)
	}
	reader.finish()
	if err := os.WriteFile(file, []byte("new bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	full, err := (*LintCache)(nil).begin().read(file, oldStat)
	if err != nil || full.raw != "new bytes" {
		t.Fatal("disabled cache did not open fresh content", full, err)
	}
	// The walk still sees cached pre-edit attributes, but open reads fresh bytes.
	// A coherent control demonstrates that the fixture would otherwise reuse.
	for _, tc := range []struct {
		name    string
		kind    int64
		failure bool
		off     bool
		want    string
	}{
		{name: "coherent-control", kind: 0xef53, want: "old bytes"},
		{name: "nfs", kind: 0x6969, want: "new bytes"},
		{name: "cifs", kind: 0xff534d42, want: "new bytes"},
		{name: "smb2", kind: 0xfe534d42, want: "new bytes"},
		{name: "9p", kind: 0x01021997, want: "new bytes"},
		{name: "fuse", kind: 0x65735546, want: "new bytes"},
		{name: "overlay", kind: 0x794c7630, want: "new bytes"},
		{name: "unknown", kind: 123, want: "new bytes"},
		{name: "probe-error", kind: 0xef53, failure: true, want: "new bytes"},
		{name: "off", kind: 0xef53, off: true, want: "new bytes"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := &LintCache{entries: cache.entries, fsType: func(string) (int64, error) {
				if tc.off {
					t.Fatal("disabled cache probed filesystem")
				}
				if tc.failure {
					return tc.kind, fmt.Errorf("statfs failed")
				}
				return tc.kind, nil
			}}
			if tc.off {
				current.Granularity = -1
			}
			r := current.begin()
			got, err := r.read(file, oldStat)
			if err != nil || got.raw != tc.want {
				t.Fatal(got, err)
			}
			if tc.name != "coherent-control" && len(r.next) != 0 {
				t.Fatal("unproven bytes retained")
			}
		})
	}
}

func TestLintFilesystemAllowlist(t *testing.T) {
	for _, kind := range []int64{0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x2fc12fc1, 0xf2f52010} {
		if !lintCoherentFilesystem(kind) {
			t.Fatalf("local filesystem %#x refused", kind)
		}
	}
}

func TestLintFilesystemPerDirectoryDeviceCapture(t *testing.T) {
	calls := 0
	kind := int64(0xef53)
	cache := &LintCache{fsType: func(string) (int64, error) { calls++; return kind, nil }}
	r := cache.begin()
	for _, file := range []string{"/project/a.abap", "/project/b.abap", "/project/nested/c.abap"} {
		if !r.coherent(file, fileIdentity{device: 1}) {
			t.Fatal("local filesystem refused")
		}
	}
	if calls != 2 {
		t.Fatal("expected two directory probes", calls)
	}
	// A symlink into another device in the same lexical directory needs its own
	// target-following probe, rather than inheriting the local directory result.
	kind = 0x6969
	if r.coherent("/project/link.abap", fileIdentity{device: 2}) || calls != 3 {
		t.Fatal("target device inherited local result", calls)
	}
	r = cache.begin()
	if r.coherent("/project/a.abap", fileIdentity{device: 1}) || calls != 4 {
		t.Fatal("filesystem decision persisted across captures", calls)
	}
}
