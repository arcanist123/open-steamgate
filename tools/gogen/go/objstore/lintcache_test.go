package objstore

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestLintCacheMutations(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "src/z.prog.abap")
	write := func(raw string) {
		t.Helper()
		if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("REPORT z.")
	time.Sleep(2100 * time.Millisecond)
	cfg := &Config{Roots: []Root{{Path: "src"}}}
	cache := &LintCache{}
	capture := func() LintSnapshot {
		t.Helper()
		got, err := cache.Capture(root, cfg, nil)
		if err != nil {
			t.Fatal(err)
		}
		want, err := CaptureLintView(root, cfg, nil)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatal("cached/full mismatch", got, want, err)
		}
		return got
	}
	first := capture()
	initial := cache.entries[file]
	capture()
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := lintIdentity(info); ok && cache.entries[file].observed != initial.observed {
		t.Fatal("stable file reread")
	}
	// Same size and restored mtime must still miss (ctime changes).
	write("REPORT x.")
	if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if capture().Digest == first.Digest {
		t.Fatal("restored mtime edit missed")
	}
	before := capture()
	replacement := filepath.Join(root, "replacement")
	if err := os.WriteFile(replacement, []byte("REPORT y."), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, file); err != nil {
		t.Fatal(err)
	}
	if capture().Digest == before.Digest {
		t.Fatal("atomic replacement missed")
	}
	// Membership and hidden bytes remain in the digest, and removed entries are evicted.
	other := filepath.Join(root, "src/hidden.prog.abap")
	if err := os.WriteFile(other, []byte("hidden"), 0600); err != nil {
		t.Fatal(err)
	}
	hidden, err := cache.Capture(root, cfg, []string{"src/hidden.prog.abap"})
	if err != nil || len(hidden.Files) != 1 {
		t.Fatal(hidden, err)
	}
	if err := os.WriteFile(other, []byte("edited"), 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := cache.Capture(root, cfg, []string{"src/hidden.prog.abap"})
	if err != nil || changed.Digest == hidden.Digest {
		t.Fatal("hidden edit missed", err)
	}
	if err := os.Remove(other); err != nil {
		t.Fatal(err)
	}
	capture()
	if _, ok := cache.entries[other]; ok {
		t.Fatal("removed entry retained")
	}
	// Errors may never serve the previous bytes.
	cfg.Libs = []Root{{Library: true, Files: []string{"missing.intf.abap"}}}
	if _, err := cache.Capture(root, cfg, nil); err == nil {
		t.Fatal("missing library accepted")
	}
}

func TestLintCacheRacyWindow(t *testing.T) {
	file := filepath.Join(t.TempDir(), "z.prog.abap")
	if err := os.WriteFile(file, []byte("REPORT z."), 0600); err != nil {
		t.Fatal(err)
	}
	// Separate an old mtime from a recent ctime, so either timestamp must
	// independently disqualify reuse.
	ancient := time.Now().Add(-time.Hour)
	if err := os.Chtimes(file, ancient, ancient); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	id, ok := lintIdentity(info)
	if !ok {
		t.Skip("platform always reads")
	}
	for _, scenario := range []string{"old", "recent-mtime", "recent-ctime", "future", "disabled", "coarser"} {
		t.Run(scenario, func(t *testing.T) {
			observed := time.Unix(0, max(id.modified, id.changed)).Add(3 * time.Second)
			switch scenario {
			case "recent-mtime":
				observed = time.Unix(0, id.modified).Add(time.Second)
			case "recent-ctime":
				observed = time.Unix(0, id.changed).Add(time.Second)
			case "future":
				observed = time.Unix(0, min(id.modified, id.changed)).Add(-time.Second)
			}
			cache := &LintCache{entries: map[string]lintContent{file: {raw: "cached marker", identity: id, observed: observed}}}
			if scenario == "disabled" {
				cache.Granularity = -1
			}
			if scenario == "coarser" {
				cache.Granularity = 4 * time.Second
			}
			reader := cache.begin()
			// A later snapshot must not age a previously racy observation into safety.
			reader.start = observed.Add(10 * time.Second)
			got, err := reader.read(file, nil)
			if err != nil {
				t.Fatal(err)
			}
			reused := got.raw == "cached marker"
			if reused != (scenario == "old") {
				t.Fatal("wrong reuse decision", scenario, reused)
			}
		})
	}
}

func TestLintCacheSymlinkRetarget(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a", "b"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(root, "link.prog.abap")
	if err := os.Symlink("a", link); err != nil {
		t.Skip(err)
	}
	cfg := &Config{Libs: []Root{{Library: true, Files: []string{"link.prog.abap"}}}}
	cache := &LintCache{}
	before, err := cache.Capture(root, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("b", link); err != nil {
		t.Fatal(err)
	}
	after, err := cache.Capture(root, cfg, nil)
	if err != nil || before.Digest == after.Digest {
		t.Fatal("retarget missed", err)
	}
}

func TestLintCacheReadRace(t *testing.T) {
	file := filepath.Join(t.TempDir(), "z.prog.abap")
	if err := os.WriteFile(file, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := lintIdentity(before); !ok {
		t.Skip("platform always reads")
	}
	// Supply the walk's old stat after an edit, deterministically exercising
	// the same mismatch as a write between pre-read and post-read stat.
	if err := os.WriteFile(file, []byte("changed size"), 0600); err != nil {
		t.Fatal(err)
	}
	cache := &LintCache{}
	reader := cache.begin()
	if _, err := reader.read(file, before); err == nil {
		t.Fatal("racing read accepted")
	}
	if len(reader.next) != 0 {
		t.Fatal("racing content cached")
	}
}

func TestLintCacheFutureMtime(t *testing.T) {
	file := filepath.Join(t.TempDir(), "z.prog.abap")
	if err := os.WriteFile(file, []byte("REPORT z."), 0600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(file, future, future); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	id, ok := lintIdentity(info)
	if !ok {
		t.Skip("platform always reads")
	}
	// ctime is safely old relative to the observation; only future mtime
	// prevents reuse. Test independently from the recent-ctime case above.
	observed := time.Unix(0, id.changed).Add(3 * time.Second)
	cache := &LintCache{entries: map[string]lintContent{file: {raw: "cached marker", identity: id, observed: observed}}}
	got, err := cache.begin().read(file, nil)
	if err != nil || got.raw != "REPORT z." {
		t.Fatal("future mtime reused", got, err)
	}
}
