package lintinput

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

// The expensive engine is a no-op here: measure the real input/guard/bridge
// path independently of engine work. The store variant includes index build,
// target hashing and the store's post-call stale-result checks.
func BenchmarkFreshness3000(b *testing.B) {
	root := b.TempDir()
	if err := os.WriteFile(filepath.Join(root, "abap_transpile.json"), []byte("{}"), 0600); err != nil {
		b.Fatal(err)
	}
	cfg := &objstore.Config{Roots: []objstore.Root{{Path: "src", Writable: true}}, Libs: []objstore.Root{{Path: "lib", Library: true}}}
	raw := []byte(strings.Repeat("* synthetic ABAP input\n", 200)) // 4,400 bytes; 13.2 MB total
	for i := 0; i < 3000; i++ {
		base := "lib"
		if i < 300 {
			base = "src"
		}
		file := fmt.Sprintf("%s/d%02d/z%04d.prog.abap", base, i/100, i)
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0700); err != nil {
			b.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file), raw, 0600); err != nil {
			b.Fatal(err)
		}
		if base == "lib" {
			cfg.Libs[0].Files = append(cfg.Libs[0].Files, file)
		}
	}
	// Let both mtime and ctime age beyond the production two-second window.
	time.Sleep(2100 * time.Millisecond)
	spec := Spec{Config: "{}", Store: cfg}
	for _, mode := range []string{"full-read", "cached"} {
		for _, path := range []string{"snapshot", "checkrun", "store-checkrun"} {
			b.Run(mode+"/"+path, func(b *testing.B) {
				engine := storelint.Engine{Prime: func([]objstore.LintFile, string) {}, Check: func(string) []storelint.Issue { return nil }, Update: func(string, *string) {}}
				var cache *objstore.LintCache
				if mode == "cached" {
					cache = &objstore.LintCache{}
				}
				c := newWithCache(root, nil, engine, spec, cache)
				c.Logf = nil
				if err := c.Prime("{}"); err != nil {
					b.Fatal(err)
				}
				in := storecheck.Input{Root: root, Type: "PROG", Name: "Z0000", Logical: []string{"src/d00/z0000.prog.abap"}, CheckRun: true}
				config, _ := json.Marshal(cfg)
				if err := objstore.SetStore(root, config, ""); err != nil {
					b.Fatal(err)
				}
				objstore.SetCompiler(c, "")
				defer objstore.SetStore("", nil, "")
				defer objstore.SetCompiler(nil, "")
				command, typ, name := "CHECKRUN", "PROG", "Z0000"
				args := map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name}
				b.ReportAllocs()
				for b.Loop() {
					switch path {
					case "snapshot":
						if _, err := c.Capture(); err != nil {
							b.Fatal(err)
						}
					case "checkrun":
						if _, _, err := c.CheckRun(context.Background(), in); err != nil {
							b.Fatal(err)
						}
					case "store-checkrun":
						answer := objstore.Call(args)
						if answer.Scalars["EV_ERROR"] != "" || !strings.Contains(answer.Scalars["EV_JSON"], `"status":"processed"`) {
							b.Fatal(answer)
						}
					}
				}
			})
		}
	}
}

func TestCachedCheckRunRefusesDependencyEdit(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	target, dep := "src/z.prog.abap", "src/dep.intf.abap"
	for _, file := range []string{target, dep} {
		if err := os.WriteFile(filepath.Join(root, file), []byte("old bytes"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Exercise the default production shortcut after the timestamp window.
	time.Sleep(2100 * time.Millisecond)
	cfg := &objstore.Config{Roots: []objstore.Root{{Path: "src"}}}
	mutate := false
	saved := map[string]string{}
	engine := storelint.Engine{Prime: func(files []objstore.LintFile, _ string) {
		for _, file := range files {
			saved[file.Filename] = file.Raw
		}
	}, Update: func(file string, raw *string) {
		if raw == nil {
			delete(saved, file)
		} else {
			saved[file] = *raw
		}
	}, Check: func(file string) []storelint.Issue {
		if mutate {
			file := filepath.Join(root, dep)
			info, err := os.Stat(file)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte("new bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
				t.Fatal(err)
			}
		}
		return []storelint.Issue{{Filename: file, Key: "dependency", Message: "engine dependency: " + saved["/"+dep]}}
	}}
	c := New(root, nil, engine, Spec{Config: "{}", Store: cfg})
	c.Logf = nil
	if err := c.Prime("{}"); err != nil {
		t.Fatal(err)
	}
	in := storecheck.Input{Root: root, Type: "PROG", Name: "Z", Logical: []string{target}, CheckRun: true}
	if _, _, err := c.CheckRun(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	mutate = true
	rows, _, err := c.CheckRun(context.Background(), in)
	if err == nil || len(rows) != 0 || !strings.Contains(err.Error(), "changed during check") {
		t.Fatal(rows, err)
	}
	mutate = false
	rows, _, err = c.CheckRun(context.Background(), in)
	if err != nil || len(rows) != 1 || rows[0].MESSAGE != "engine dependency: new bytes" || saved["/"+dep] != "new bytes" {
		t.Fatal("next check must sync edited bytes into engine and diagnostics", rows, saved, err)
	}
}
