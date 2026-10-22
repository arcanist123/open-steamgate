package lintinput

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"osg/gogen/lintresolve"
	"osg/gogen/objstore"
	"osg/gogen/storecheck"
	"osg/gogen/storelint"
	"reflect"
)

func criticWrite(t *testing.T, root, file, raw string) {
	t.Helper()
	at := filepath.Join(root, file)
	if err := os.MkdirAll(filepath.Dir(at), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(at, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
}

func criticFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for file, raw := range map[string]string{
		"abap_transpile.json":  `{"input_folder":["base","gen"],"libs":[]}`,
		"abaplint.jsonc":       `{"syntax":{"version":"v702"}}`,
		"libs.lock.json":       `{"libraries":[]}`,
		"base/ztest.prog.abap": "REPORT ztest.",
	} {
		criticWrite(t, root, file, raw)
	}
	return root
}

// Test both a mutation before startup and after a healthy prime/CHECKRUN.
func criticLifecycle(t *testing.T, root string, spec Spec, mutate func(), restore func()) {
	t.Helper()
	Resolve = nil
	calls := 0
	engine := storelint.Engine{Prime: func([]objstore.LintFile, string) {}, Update: func(string, *string) {}, Check: func(string) []storelint.Issue { calls++; return nil }}
	req := storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true, Input: storecheck.Input{Root: root, CheckRun: true, Type: "PROG", Name: "ZTEST", Logical: []string{"base/ztest.prog.abap"}}}
	for _, startup := range []bool{false, true} {
		c := New(root, nil, engine, spec)
		if startup {
			mutate()
		}
		if err := c.Prime(spec.Config); err != nil && (!startup || !strings.Contains(err.Error(), "rebuild")) {
			t.Fatal(err)
		}
		if !startup {
			r, err := storecheck.Run(c, req)
			if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"processed"`) {
				t.Fatal(r, err)
			}
			mutate()
		}
		before := calls
		r, err := storecheck.Run(c, req)
		if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"notProcessed"`) || !strings.Contains(r.Scalars["EV_JSON"], "rebuild") || calls != before {
			t.Fatalf("startup=%v calls=%d before=%d result=%+v err=%v", startup, calls, before, r, err)
		}
		restore()
	}
}

func TestCriticUnnamedPackageLifecycle(t *testing.T) {
	root := criticFixture(t)
	criticWrite(t, root, "base/.abapgit.xml", "<abapGit><STARTING_FOLDER>/</STARTING_FOLDER></abapGit>")
	criticWrite(t, root, "base/package.devc.xml", "<DEVC><CTEXT>Root package</CTEXT></DEVC>")
	criticWrite(t, root, "base/zcl_one_first.clas.abap", "CLASS zcl_one_first DEFINITION PUBLIC. ENDCLASS.")
	spec := buildSpec(t, root)
	criticLifecycle(t, root, spec, func() {
		criticWrite(t, root, "base/zcl_other_first.clas.abap", "CLASS zcl_other_first DEFINITION PUBLIC. ENDCLASS.")
	}, func() {
		if err := os.Remove(filepath.Join(root, "base/zcl_other_first.clas.abap")); err != nil {
			t.Fatal(err)
		}
	})
}

func TestCriticBSPFolderLifecycle(t *testing.T) {
	for _, replacement := range []bool{false, true} {
		t.Run(fmt.Sprint(replacement), func(t *testing.T) {
			root := criticFixture(t)
			criticWrite(t, root, "packs/p/osd-pack.json", `{"name":"p","abap":"src","bsp":{"APP":"webapp"}}`)
			criticWrite(t, root, "packs/p/src/zpack.prog.abap", "REPORT zpack.")
			restore := func() {
				os.RemoveAll(filepath.Join(root, "packs/p/webapp"))
				criticWrite(t, root, "packs/p/webapp/index.html", "ok")
			}
			restore()
			spec := buildSpec(t, root)
			criticLifecycle(t, root, spec, func() {
				if err := os.RemoveAll(filepath.Join(root, "packs/p/webapp")); err != nil {
					t.Fatal(err)
				}
				if replacement {
					criticWrite(t, root, "packs/p/webapp", "file")
				}
			}, restore)
		})
	}
}

func TestCriticRootPackLifecycle(t *testing.T) {
	root := criticFixture(t)
	criticWrite(t, root, "osd-pack.json", `{"name":"rootpack"}`)
	criticWrite(t, root, "ztop.prog.abap", "REPORT ztop.")
	t.Setenv("OSD_PACKS", ".")
	spec := buildSpec(t, root)
	Resolve = nil
	calls := 0
	c := New(root, nil, storelint.Engine{Prime: func([]objstore.LintFile, string) {}, Update: func(string, *string) {}, Check: func(string) []storelint.Issue { calls++; return nil }}, spec)
	if err := c.Prime(spec.Config); err != nil {
		t.Fatal(err)
	}
	for _, src := range []bool{false, true, false} {
		if src {
			criticWrite(t, root, "src/zroot.prog.abap", "REPORT zroot.")
		} else if err := os.RemoveAll(filepath.Join(root, "src")); err != nil {
			t.Fatal(err)
		}
		fresh := buildSpec(t, root)
		Resolve = nil
		got, err := lintresolve.Resolve(root, spec.Rules)
		if err != nil || !reflect.DeepEqual(got.PackSources, fresh.PackSources) {
			t.Fatalf("packSources got=%v want=%v err=%v", got.PackSources, fresh.PackSources, err)
		}
		r, err := storecheck.Run(c, storecheck.Request{Command: "CHECKRUN", Known: true, SourceType: true, Exists: true, Input: storecheck.Input{Root: root, CheckRun: true, Type: "PROG", Name: "ZTEST", Logical: []string{"base/ztest.prog.abap"}}})
		if err != nil || !strings.Contains(r.Scalars["EV_JSON"], `"status":"processed"`) {
			t.Fatal(r, err)
		}
	}
	if calls != 3 {
		t.Fatal(calls)
	}
}

func TestSweepZIPOverlayLifecycle(t *testing.T) {
	for _, link := range []bool{false, true} {
		t.Run(fmt.Sprint(link), func(t *testing.T) {
			root := criticFixture(t)
			var raw bytes.Buffer
			archive := zip.NewWriter(&raw)
			for name, content := range map[string]string{
				".abapgit.xml":          "<abapGit><STARTING_FOLDER>/src/</STARTING_FOLDER></abapGit>",
				"src/package.devc.xml":  "<DEVCLASS>ZZIP</DEVCLASS>",
				"src/zcl_zip.clas.abap": "CLASS zcl_zip DEFINITION PUBLIC. ENDCLASS.",
			} {
				w, err := archive.Create(name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := w.Write([]byte(content)); err != nil {
					t.Fatal(err)
				}
			}
			if err := archive.Close(); err != nil {
				t.Fatal(err)
			}
			criticWrite(t, root, "layer.zip", raw.String())
			t.Setenv("OSD_LAYERS", "layer.zip")
			spec := buildSpec(t, root)
			overlay := ""
			for _, r := range spec.Store.Roots {
				if r.OverlayOf != "" {
					overlay = filepath.Join(root, r.Path)
				}
			}
			if overlay == "" {
				t.Fatal("no overlay")
			}
			target := filepath.Join(overlay, "zcl_zip.clas.abap")
			content, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			criticLifecycle(t, root, spec, func() {
				if link {
					if err := os.Rename(overlay, overlay+"-saved"); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(overlay+"-saved", overlay); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Remove(target); err != nil {
					t.Fatal(err)
				}
			}, func() {
				if link {
					if err := os.Remove(overlay); err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(overlay+"-saved", overlay); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(target, content, 0600); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestCriticFormerPackRootShadowLifecycle(t *testing.T) {
	root := criticFixture(t)
	t.Setenv("OSD_PACKS", "local")
	criticWrite(t, root, "local/osd-pack.json", `{"name":"p","abap":"extra"}`)
	target := filepath.Join(root, "local/extra")
	restore := func() {
		if err := os.RemoveAll(target); err != nil {
			t.Fatal(err)
		}
		criticWrite(t, root, "local/extra/zextra.prog.abap", "REPORT zextra.")
	}
	restore()
	spec := buildSpec(t, root)
	selected := false
	for _, r := range spec.Store.Roots {
		selected = selected || r.Path == "local/extra"
	}
	if !selected {
		t.Fatal("fixture did not select local/extra")
	}
	criticLifecycle(t, root, spec, func() {
		if err := os.RemoveAll(target); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(root, "absent"), target); err != nil {
			t.Fatal(err)
		}
	}, restore)
}
