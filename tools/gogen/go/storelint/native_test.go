package storelint

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"osg/gogen/adtoutline"
	"osg/gogen/objstore"
	"osg/gogen/storecheck"
)

func nativeFixture(t *testing.T) (*Compiler, storecheck.Input, *string) {
	t.Helper()
	root := t.TempDir()
	file := "ztest.prog.abap"
	saved := "REPORT ztest."
	if err := os.WriteFile(filepath.Join(root, file), []byte(saved), 0600); err != nil {
		t.Fatal(err)
	}
	raw := saved
	c := &Compiler{Other: &otherCompiler{}, Capture: func() (objstore.LintSnapshot, error) {
		b, err := os.ReadFile(filepath.Join(root, file))
		if err != nil {
			return objstore.LintSnapshot{}, err
		}
		return objstore.LintSnapshot{Root: root, Digest: fmt.Sprintf("%x", sha256.Sum256(b)), Files: []objstore.LintFile{{Filename: "/" + file, Raw: string(b)}}}, nil
	}}
	c.Engine = Engine{Name: "go", Prime: func(files []objstore.LintFile, _ string) { raw = files[0].Raw }, Check: func(string) []Issue { return nil }, Update: func(_ string, s *string) {
		if s == nil {
			raw = ""
		} else {
			raw = *s
		}
	}, CheckObject: func(typ, name string) ([]Issue, bool) {
		if typ != "PROG" || name != "ZTEST" {
			panic("incorrect registry identity")
		}
		if raw == "panic" {
			panic("check failed")
		}
		return []Issue{{Filename: "/" + file, Message: raw, Severity: "warning", Row: 3, Column: 4}}, true
	}, SnapshotTree: func(files []objstore.LintFile, _, typ, name string) ([]adtoutline.FileTree, bool) {
		if typ != "PROG" || name != "ZTEST" {
			panic("incorrect outline identity")
		}
		return nil, true
	}}
	if err := c.Prime("{}"); err != nil {
		t.Fatal(err)
	}
	return c, storecheck.Input{Root: root, Type: "INCL", Name: "ZTEST", Version: "inactive", Files: []string{file}, Logical: []string{file}, Expected: map[string]string{file: fmt.Sprintf("%x", sha256.Sum256([]byte(saved)))}}, &raw
}
func TestNativeSavedAndOverlay(t *testing.T) {
	c, in, raw := nativeFixture(t)
	check := func(want string) {
		t.Helper()
		rows, err := c.Check(context.Background(), in)
		if err != nil || len(rows) != 1 || rows[0].MESSAGE != want || rows[0].Severity != "E" || rows[0].URI != "" || rows[0].OBJ_TYPE != "INCL" {
			t.Fatal(rows, err)
		}
	}
	check("REPORT ztest.")
	for _, s := range []string{"edited", "", "panic"} {
		in.Source = &s
		if s == "panic" {
			if _, err := c.Check(context.Background(), in); err == nil {
				t.Fatal("missing check refusal")
			}
		} else {
			check(s)
		}
		if *raw != "REPORT ztest." {
			t.Fatal("overlay leaked", *raw)
		}
		in.Source = nil
		check("REPORT ztest.")
	}
	if other := c.Other.(*otherCompiler); other.checks != 0 || other.outlines != 0 {
		t.Fatal("sidecar called", other)
	}
}
func TestNativeOutlineUsesResolvedVersion(t *testing.T) {
	c, in, _ := nativeFixture(t)
	active := "REPORT active."
	os.WriteFile(filepath.Join(in.Root, "active-copy"), []byte(active), 0600)
	in.Version = "active"
	in.Files = []string{"active-copy"}
	in.Expected = map[string]string{"active-copy": fmt.Sprintf("%x", sha256.Sum256([]byte(active)))}
	c.Engine.SnapshotTree = func(files []objstore.LintFile, config, typ, name string) ([]adtoutline.FileTree, bool) {
		if len(files) != 1 || files[0].Raw != active || files[0].Filename != "/ztest.prog.abap" || config != "{}" {
			t.Fatal(files, config)
		}
		return nil, true
	}
	doc, err := c.Outline(context.Background(), in)
	if err != nil || !strings.Contains(string(doc), `"version":"active"`) {
		t.Fatal(string(doc), err)
	}
	if other := c.Other.(*otherCompiler); other.outlines != 0 {
		t.Fatal("sidecar called")
	}
}
func TestNativeFreshnessAndRestorePoison(t *testing.T) {
	t.Run("expected hash", func(t *testing.T) {
		c, in, _ := nativeFixture(t)
		in.Expected[in.Files[0]] = "wrong"
		if _, err := c.Check(context.Background(), in); err == nil || !strings.Contains(err.Error(), "SNAPSHOT_MISMATCH") {
			t.Fatal(err)
		}
	})
	t.Run("change during check", func(t *testing.T) {
		c, in, _ := nativeFixture(t)
		check := c.Engine.CheckObject
		c.Engine.CheckObject = func(typ, name string) ([]Issue, bool) {
			os.WriteFile(filepath.Join(in.Root, in.Files[0]), []byte("changed"), 0600)
			return check(typ, name)
		}
		if _, err := c.Check(context.Background(), in); err == nil || !strings.Contains(err.Error(), "inputs changed") {
			t.Fatal(err)
		}
	})
	t.Run("snapshot containment", func(t *testing.T) {
		c, in, _ := nativeFixture(t)
		in.Files = []string{"../outside"}
		if _, err := c.Outline(context.Background(), in); err == nil {
			t.Fatal("accepted escaping snapshot")
		}
	})
	t.Run("restore poisons", func(t *testing.T) {
		c, in, _ := nativeFixture(t)
		update := c.Engine.Update
		calls := 0
		c.Engine.Update = func(file string, raw *string) {
			calls++
			if calls == 2 {
				panic("restore failed")
			}
			update(file, raw)
		}
		s := "inline"
		in.Source = &s
		if _, err := c.Check(context.Background(), in); err == nil {
			t.Fatal("missing restore refusal")
		}
		in.Source = nil
		if _, err := c.Check(context.Background(), in); err == nil || !strings.Contains(err.Error(), "restore failed") {
			t.Fatal(err)
		}
	})
}
func TestNativeCallsSerialize(t *testing.T) {
	c, in, _ := nativeFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Go(func() {
			source := "overlay"
			req := in
			req.Source = &source
			if _, err := c.Check(context.Background(), req); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	rows, err := c.Check(context.Background(), in)
	if err != nil || rows[0].MESSAGE != "REPORT ztest." {
		t.Fatal(rows, err)
	}
}

func TestNativeOutlineTrapIsIsolated(t *testing.T) {
	c, in, _ := nativeFixture(t)
	c.Engine.SnapshotTree = func([]objstore.LintFile, string, string, string) ([]adtoutline.FileTree, bool) {
		panic("snapshot parse refused")
	}
	if _, err := c.Outline(context.Background(), in); err == nil || !strings.Contains(err.Error(), "snapshot parse refused") {
		t.Fatal(err)
	}
	if _, err := c.Check(context.Background(), in); err != nil {
		t.Fatal("isolated outline poisoned saved checker", err)
	}
}

func TestSavedOutlineIdentity(t *testing.T) {
	for _, version := range []string{"active", "inactive"} {
		t.Run(version, func(t *testing.T) {
			c, in, _ := nativeFixture(t)
			in.Version = version
			saved, isolated := 0, 0
			c.Engine.Tree = func(typ, name string) ([]adtoutline.FileTree, bool) { saved++; return nil, true }
			c.Engine.SnapshotTree = func([]objstore.LintFile, string, string, string) ([]adtoutline.FileTree, bool) {
				isolated++
				return nil, true
			}
			run := func() {
				t.Helper()
				if _, err := c.Outline(context.Background(), in); err != nil {
					t.Fatal(err)
				}
			}
			run()
			if saved != 1 || isolated != 0 {
				t.Fatal(saved, isolated)
			}
			// An extra saved include must never leak into a version that omits it.
			capture := c.Capture
			c.Capture = func() (objstore.LintSnapshot, error) {
				s, e := capture()
				s.Files = append(s.Files, objstore.LintFile{Filename: "/other/ztest.prog.abap", Raw: "REPORT other."})
				s.Digest += "extra"
				return s, e
			}
			run()
			if saved != 1 || isolated != 1 {
				t.Fatal("borrowed a competing file", saved, isolated)
			}
			c.Capture = capture
			// A different active byte snapshot uses an isolated checker even when the
			// logical filename matches the saved registry exactly.
			os.WriteFile(filepath.Join(in.Root, "active-copy"), []byte("REPORT active."), 0600)
			in.Files = []string{"active-copy"}
			in.Expected = nil
			run()
			if saved != 1 || isolated != 2 {
				t.Fatal(saved, isolated)
			}
		})
	}
}

func TestSavedOutlineRestore(t *testing.T) {
	c, in, raw := nativeFixture(t)
	c.Engine.Tree = func(string, string) ([]adtoutline.FileTree, bool) { *raw = "corrupted"; panic("tree failed") }
	if _, err := c.Outline(context.Background(), in); err == nil {
		t.Fatal("missing refusal")
	}
	if *raw != "REPORT ztest." {
		t.Fatal("saved state not restored", *raw)
	}
	if _, err := c.Check(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	c.Engine.Prime = func([]objstore.LintFile, string) { panic("restore failed") }
	if _, err := c.Outline(context.Background(), in); err == nil {
		t.Fatal("missing restoration refusal")
	}
	if _, err := c.Check(context.Background(), in); err == nil || !strings.Contains(err.Error(), "restore failed") {
		t.Fatal(err)
	}
}

func TestSavedOutlineFreshness(t *testing.T) {
	c, in, _ := nativeFixture(t)
	c.Engine.Tree = func(string, string) ([]adtoutline.FileTree, bool) {
		os.WriteFile(filepath.Join(in.Root, in.Files[0]), []byte("changed"), 0600)
		return nil, true
	}
	if _, err := c.Outline(context.Background(), in); err == nil || !strings.Contains(err.Error(), "inputs changed") {
		t.Fatal(err)
	}
}
