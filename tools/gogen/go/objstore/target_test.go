package objstore

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTargetIndexMatchesFull(t *testing.T) {
	root := t.TempDir()
	write := func(file string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, file)), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, file), []byte("saved"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"abap_transpile.json", "base/a/ZTEST.clas.abap", "base/z/ztest.clas.abap", "overlay/ztest.clas.abap", "overlay/ztest.clas.macros.abap", "overlay/zzzexcluded/ztest.clas.abap", "lib/ztest.clas.abap", "lib/zdep.intf.abap", "base/zprog.prog.abap", "base/#ns#ztest.clas.abap"} {
		write(file)
	}
	cfg := []byte(`{"roots":[{"path":"base","writable":true},{"path":"overlay","writable":true}],"libs":[{"path":"lib","library":true,"files":["lib/ztest.clas.abap","lib/zdep.intf.abap"]}],"excluded":["excluded"]}`)
	if err := SetStore(root, cfg, ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	compare := func() {
		t.Helper()
		for _, tc := range []struct{ typ, name string }{{"CLAS", "ZTEST"}, {"CLAS", "/NS/ZTEST"}, {"INTF", "ZDEP"}, {"INCL", "ZPROG"}, {"PROG", "MISSING"}} {
			ext, _ := storeTypeExt(tc.typ)
			full := storeBuild().find(tc.typ, tc.name)
			fast := storeBuildFor(storeFileOf(tc.name)+ext).find(tc.typ, tc.name)
			if !reflect.DeepEqual(full, fast) {
				t.Fatalf("%s %s: full=%+v targeted=%+v", tc.typ, tc.name, full, fast)
			}
			if full != nil {
				a, err := compilerInput(storeBuild(), tc.typ, tc.name, "inactive")
				if err != nil {
					t.Fatal(err)
				}
				b, err := compilerInput(storeBuildFor(storeFileOf(tc.name)+ext), tc.typ, tc.name, "inactive")
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(a, b) {
					t.Fatalf("include/hash mapping: %+v != %+v", a, b)
				}
			}
		}
	}
	compare()
	for _, file := range []string{"overlay/zzzexcluded/ztest.clas.abap", "overlay/ztest.clas.abap", "base/z/ztest.clas.abap"} {
		if err := os.Remove(filepath.Join(root, file)); err != nil {
			t.Fatal(err)
		}
		compare()
	}
	write("base/zz/ZTEST.clas.abap")
	compare()
	if err := os.Symlink("zz", filepath.Join(root, "base/zzz")); err != nil {
		t.Fatal(err)
	}
	compare()
	if err := os.MkdirAll(filepath.Join(root, "base/zzzz"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("absent", filepath.Join(root, "base/zzzz/ztest.clas.abap")); err != nil {
		t.Fatal(err)
	}
	compare()
}

func BenchmarkTargetIndex3000(b *testing.B) {
	root := b.TempDir()
	if err := os.WriteFile(filepath.Join(root, "abap_transpile.json"), []byte("{}"), 0600); err != nil {
		b.Fatal(err)
	}
	for n := 0; n < 3000; n++ {
		file := filepath.Join(root, fmt.Sprintf("src/d%02d/z%04d.prog.abap", n/100, n))
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			b.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("REPORT synthetic."), 0600); err != nil {
			b.Fatal(err)
		}
	}
	if err := SetStore(root, []byte(`{"roots":[{"path":"src"}]}`), ""); err != nil {
		b.Fatal(err)
	}
	defer SetStore("", nil, "")
	for _, target := range []string{"", "z0000.prog.abap"} {
		name := "full"
		if target != "" {
			name = "targeted"
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if storeBuildFor(target).find("PROG", "Z0000") == nil {
					b.Fatal("missing")
				}
			}
		})
	}
}

func TestTargetIndexAdmission(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "abap_transpile.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"z.prog.abap", "other.prog.abap", "ztable.tabl.xml"} {
		if err := os.WriteFile(filepath.Join(root, "src", file), []byte("saved"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := SetStore(root, []byte(`{"roots":[{"path":"src"}]}`), ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	SetCompiler(&sourceTestCompiler{}, "")
	defer SetCompiler(nil, "")
	if ix := checkRunIndex("CHECKRUN", "PROG", "Z", nil, ""); ix.find("PROG", "Z") == nil || ix.find("PROG", "OTHER") != nil {
		t.Fatal("saved ABAP did not use targeted lookup")
	}
	source := "buffer"
	for _, tc := range []struct {
		command, typ, filter string
		source               *string
	}{
		{"CHECK", "PROG", "", nil}, {"CHECKRUN", "TABL", "", nil}, {"CHECKRUN", "PROG", "SOURCE", nil}, {"CHECKRUN", "PROG", "", &source},
	} {
		if checkRunIndex(tc.command, tc.typ, "Z", tc.source, tc.filter).find("PROG", "OTHER") == nil {
			t.Fatalf("lost fallback %+v", tc)
		}
	}
	SetCompiler(&testCompiler{}, "")
	if checkRunIndex("CHECKRUN", "PROG", "Z", nil, "").find("PROG", "OTHER") == nil {
		t.Fatal("sidecar lost fallback")
	}
}
