package lintinput

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
)

// Ordered engine double models Registry's first-main-file selection and its
// append-on-add/remove semantics. Exercise real capture and saved-file sync,
// rather than only testing the resolver predicate.
func TestCompetingMutationsSelectFreshWinner(t *testing.T) {
	for _, scenario := range []string{"move", "delete-restore-project", "delete-restore-library", "add-override", "edit"} {
		t.Run(scenario, func(t *testing.T) {
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
			project, library := "src/a/ztest.intf.abap", "lib/ztest.intf.abap"
			write(library, "library method")
			if scenario != "add-override" {
				write(project, "project method")
			}
			facts := &objstore.Config{Roots: []objstore.Root{{Path: "src"}}, Libs: []objstore.Root{{Path: "lib", Library: true, Files: []string{library}}}}
			resolve := func(string) (Spec, error) {
				snapshot, err := objstore.CaptureLintView(root, facts, nil)
				spec := Spec{Config: "{}", Store: facts}
				for _, f := range snapshot.Files {
					spec.Files = append(spec.Files, f.Filename)
				}
				return spec, err
			}
			saved := Resolve
			defer func() { Resolve = saved }()
			resolves := 0
			Resolve = func(root string) (Spec, error) { resolves++; return resolve(root) }
			spec, err := resolve(root)
			if err != nil {
				t.Fatal(err)
			}
			var registry []objstore.LintFile
			primes, updates := 0, 0
			engine := storelint.Engine{
				Prime: func(files []objstore.LintFile, _ string) {
					primes++
					registry = append([]objstore.LintFile{}, files...)
				},
				Update: func(name string, raw *string) {
					updates++
					for i, f := range registry {
						if f.Filename == name {
							if raw == nil {
								registry = append(registry[:i], registry[i+1:]...)
							} else {
								registry[i].Raw = *raw
							}
							return
						}
					}
					if raw != nil {
						registry = append(registry, objstore.LintFile{Filename: name, Raw: *raw})
					}
				},
				Check: func(string) []storelint.Issue {
					for _, f := range registry {
						if strings.HasSuffix(f.Filename, "/ztest.intf.abap") {
							return []storelint.Issue{{Filename: f.Filename, Message: f.Raw}}
						}
					}
					t.Fatal("no selected source")
					return nil
				},
			}
			c := New(root, nil, engine, spec)
			if err := c.Prime("{}"); err != nil {
				t.Fatal(err)
			}
			check := func(want string) {
				t.Helper()
				rows, err := c.Check(context.Background(), storecheck.Input{CheckRun: true, Root: root, Type: "INTF", Name: "ZTEST", Logical: []string{project}})
				fresh, capErr := objstore.CaptureLintView(root, facts, nil)
				if err != nil || capErr != nil || len(rows) != 1 || rows[0].MESSAGE != want || rows[0].FILE != fresh.Files[0].Filename {
					t.Fatalf("rows=%+v err=%v capture=%v want=%s", rows, err, capErr, want)
				}
			}
			check(map[bool]string{true: "library method", false: "project method"}[scenario == "add-override"])
			switch scenario {
			case "move":
				moved := "src/b/ztest.intf.abap"
				write(moved, "project method")
				if err := os.Remove(filepath.Join(root, project)); err != nil {
					t.Fatal(err)
				}
				project = moved
				check("project method")
			case "delete-restore-project":
				if err := os.Remove(filepath.Join(root, project)); err != nil {
					t.Fatal(err)
				}
				check("library method")
				write(project, "restored method")
				check("restored method")
			case "delete-restore-library":
				// The library membership case is covered by the library discovery suite.
				// Here remove/restore it in resolved facts to exercise the ordered bridge.
				facts.Libs = nil
				check("project method")
				facts.Libs = []objstore.Root{{Path: "lib", Library: true, Files: []string{library}}}
				check("project method")
			case "add-override":
				write(project, "override method")
				check("override method")
			case "edit":
				write(project, "edited method")
				check("edited method")
				if primes != 1 || updates != 1 || resolves != 0 {
					t.Fatalf("byte edit: primes=%d updates=%d resolves=%d", primes, updates, resolves)
				}
			}
			if scenario != "edit" && primes < 2 {
				t.Fatal("membership did not re-prime", primes)
			}
		})
	}
}
