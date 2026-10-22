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

// Even byte-identical complete objects must use the isolated parser: the saved
// registry can expand macros from external INCLUDEs for every ABAP object type.
func TestNativeOutlineNeverBorrowsExternalMacros(t *testing.T) {
	for _, typ := range []string{"PROG", "INCL", "CLAS", "INTF"} {
		for _, version := range []string{"active", "inactive"} {
			t.Run(typ+"/"+version, func(t *testing.T) {
				c, in, _ := nativeFixture(t)
				in.Type, in.Version = typ, version
				logical := "ztest." + strings.ToLower(registryType(typ)) + ".abap"
				in.Logical = []string{logical}
				source := "REPORT ztest.\nINCLUDE zmac.\ndecl."
				if typ == "CLAS" {
					source = "INCLUDE zmac. CLASS ztest DEFINITION PUBLIC. PUBLIC SECTION. decl. ENDCLASS. CLASS ztest IMPLEMENTATION. ENDCLASS."
				} else if typ == "INTF" {
					source = "INTERFACE ztest PUBLIC. INCLUDE zmac. decl. ENDINTERFACE."
				}
				if err := os.WriteFile(filepath.Join(in.Root, in.Files[0]), []byte(source), 0600); err != nil {
					t.Fatal(err)
				}
				in.Expected[in.Files[0]] = fmt.Sprintf("%x", sha256.Sum256([]byte(source)))
				capture := c.Capture
				c.Capture = func() (objstore.LintSnapshot, error) {
					s, err := capture()
					s.Files[0].Filename = "/" + logical
					s.Files = append(s.Files, objstore.LintFile{Filename: "/zmac.prog.abap", Raw: "DEFINE decl. FORM do_it. ENDFORM. END-OF-DEFINITION."})
					s.Digest += "external-macro"
					return s, err
				}
				saved, isolated := 0, 0
				c.Engine.Tree = func(string, string) ([]adtoutline.FileTree, bool) {
					saved++
					panic("saved tree can contain externally expanded declarations")
				}
				c.Engine.SnapshotTree = func(files []objstore.LintFile, _ string, gotType, name string) ([]adtoutline.FileTree, bool) {
					isolated++
					if gotType != registryType(typ) || name != in.Name || len(files) != 1 || files[0].Filename != "/"+logical || files[0].Raw != source {
						t.Fatalf("wrong isolated input: %s %s %+v", gotType, name, files)
					}
					return nil, true
				}
				if _, err := c.Outline(context.Background(), in); err != nil {
					t.Fatal(err)
				}
				if saved != 0 || isolated != 1 {
					t.Fatalf("saved=%d isolated=%d", saved, isolated)
				}
			})
		}
	}
}

func TestNativeOutlineFreshness(t *testing.T) {
	c, in, _ := nativeFixture(t)
	c.Engine.SnapshotTree = func([]objstore.LintFile, string, string, string) ([]adtoutline.FileTree, bool) {
		os.WriteFile(filepath.Join(in.Root, in.Files[0]), []byte("changed"), 0600)
		return nil, true
	}
	if _, err := c.Outline(context.Background(), in); err == nil || !strings.Contains(err.Error(), "inputs changed") {
		t.Fatal(err)
	}
}
