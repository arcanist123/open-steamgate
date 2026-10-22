package lintinput

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

func TestLibraryMembershipThroughCanonicalResolver(t *testing.T) {
	for _, duringCheck := range []bool{false, true} {
		t.Run(fmt.Sprint(duringCheck), func(t *testing.T) {
			root := t.TempDir()
			write := func(file, raw string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, file), []byte(raw), 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Build the policy once; runtime refreshes it natively.
			repo, err := filepath.Abs("../../../..")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(repo, "tools"), filepath.Join(root, "tools")); err != nil {
				t.Fatal(err)
			}
			write("abap_transpile.json", `{"input_folder":["src"],"libs":[{"folder":"/lib","files":["/src/*.abap"],"exclude_filter":["excluded"]},{"folder":"/empty","files":"/src/**"}]}`)
			write("abaplint.jsonc", `{"syntax":{"version":"v702"}}`)
			write("libs.lock.json", `{"libraries":[]}`)
			write("src/ztest.prog.abap", "REPORT ztest.")
			write("lib/src/zdep.clas.abap", "CLASS zdep DEFINITION PUBLIC. ENDCLASS. CLASS zdep IMPLEMENTATION. ENDCLASS.")
			spec := buildSpec(t, root)
			if err != nil {
				t.Fatal(err)
			}
			include := "lib/src/zdep.clas.locals_def.abap"
			add := func() { write(include, "CLASS lcl_added DEFINITION. ENDCLASS.") }
			var registry []objstore.LintFile
			mutate := false
			primes := 0
			engine := storelint.Engine{Prime: func(files []objstore.LintFile, _ string) {
				primes++
				registry = append([]objstore.LintFile{}, files...)
			}, Check: func(target string) []storelint.Issue {
				if mutate {
					mutate = false
					add()
				}
				for _, file := range registry {
					if file.Filename == "/"+include {
						return []storelint.Issue{{Filename: target, Message: file.Raw}}
					}
				}
				return nil
			}, Update: func(string, *string) { t.Fatal("library namespace change should re-prime") }}
			c := New(root, nil, engine, spec)
			if err := c.Prime(spec.Config); err != nil {
				t.Fatal(err)
			}
			in := storecheck.Input{Root: root, CheckRun: true, Type: "PROG", Name: "ZTEST", Logical: []string{"src/ztest.prog.abap"}}
			check := func(want string) {
				t.Helper()
				rows, err := c.Check(context.Background(), in)
				if err != nil {
					t.Fatal(err)
				}
				if want == "" && len(rows) != 0 || want != "" && (len(rows) != 1 || rows[0].MESSAGE != want) {
					t.Fatalf("rows=%+v want=%s", rows, want)
				}
			}
			check("")
			if duringCheck {
				mutate = true
				if _, err := c.Check(context.Background(), in); err == nil || !strings.Contains(err.Error(), "changed during check") {
					t.Fatalf("library addition accepted during check: %v", err)
				}
			} else {
				add()
			}
			check("CLASS lcl_added DEFINITION. ENDCLASS.")
			if primes < 2 {
				t.Fatal("library include did not re-prime")
			}
			if err := os.Remove(filepath.Join(root, include)); err != nil {
				t.Fatal(err)
			}
			check("")
			write("lib/src/excluded.clas.abap", "excluded")
			write("lib/other/zoutside.clas.abap", "outside glob")
			write("lib/src/zdep.clas.testclasses.abap", "testclasses")
			write("empty/src/znew.intf.abap", "INTERFACE znew PUBLIC. ENDINTERFACE.")
			check("")
			found := false
			for _, file := range registry {
				if strings.Contains(file.Filename, "excluded") || strings.Contains(file.Filename, "outside") || strings.Contains(file.Filename, "testclasses") {
					t.Fatal("original library filter lost", file)
				}
				found = found || file.Filename == "/empty/src/znew.intf.abap"
			}
			if !found {
				t.Fatal("previously missing library root not watched")
			}
		})
	}
}

func BenchmarkLibrarySnapshot3000(b *testing.B) {
	root := b.TempDir()
	cfg := &objstore.Config{Roots: []objstore.Root{{Path: "src"}}, Libs: []objstore.Root{{Path: "lib", Library: true}}}
	if err := os.MkdirAll(filepath.Join(root, "src"), 0700); err != nil {
		b.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src/ztest.prog.abap"), []byte("REPORT ztest."), 0600); err != nil {
		b.Fatal(err)
	}
	for i := 0; i < 3000; i++ {
		file := fmt.Sprintf("lib/src/d%02d/z%04d.clas.abap", i/100, i)
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0700); err != nil {
			b.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file), []byte(strings.Repeat("CLASS ztest.\n", 100)), 0600); err != nil {
			b.Fatal(err)
		}
		cfg.Libs[0].Files = append(cfg.Libs[0].Files, file)
	}
	places := []string{"lib"}
	for _, mode := range []string{"membership-only", "snapshot-baseline", "snapshot-with-detection"} {
		b.Run(mode, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if mode != "snapshot-baseline" {
					if _, err := libraryMembership(root, places); err != nil {
						b.Fatal(err)
					}
				}
				if mode != "membership-only" {
					if _, err := objstore.CaptureLintView(root, cfg, nil); err != nil {
						b.Fatal(err)
					}
				}
			}
		})
	}
}
