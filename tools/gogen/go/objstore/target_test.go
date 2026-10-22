package objstore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"osg/gogen/storecheck"
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
	for _, file := range []string{"abap_transpile.json", "base/a/ZTEST.clas.abap", "base/z/ztest.clas.abap", "overlay/ztest.clas.abap", "overlay/ztest.clas.macros.abap", "overlay/zzzexcluded/ztest.clas.abap", "lib/ztest.clas.abap", "lib/zdep.intf.abap", "base/zprog.prog.abap", "base/#ns#ztest.clas.abap",
		// Exact extensions remain required, including for library candidates.
		"overlay/zı.prog.abap", "overlay/zß.prog.abap", "overlay/zK.prog.abap", "overlay/zẞ.prog.abap", "overlay/zi.prog.ABAP", "lib/lı.intf.abap", "lib/lß.intf.abap", "lib/lK.intf.abap", "lib/lẞ.intf.abap", "lib/li.intf.ABAP"} {
		write(file)
	}
	cfg := []byte(`{"roots":[{"path":"base","writable":true},{"path":"overlay","writable":true}],"libs":[{"path":"lib","library":true,"files":["lib/ztest.clas.abap","lib/zdep.intf.abap","lib/lı.intf.abap","lib/lß.intf.abap","lib/lK.intf.abap","lib/lẞ.intf.abap","lib/li.intf.ABAP"]}],"excluded":["excluded"]}`)
	if err := SetStore(root, cfg, ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	SetCompiler(&sourceTestCompiler{}, "")
	defer SetCompiler(nil, "")
	compare := func() {
		t.Helper()
		for _, tc := range []struct{ typ, name string }{{"CLAS", "ZTEST"}, {"CLAS", "/NS/ZTEST"}, {"INTF", "ZDEP"}, {"INCL", "ZPROG"}, {"PROG", "MISSING"}, {"PROG", "ZI"}, {"PROG", "Zß"}, {"PROG", "ZK"}, {"PROG", "Zẞ"}, {"INTF", "LI"}, {"INTF", "Lß"}, {"INTF", "LK"}, {"INTF", "Lẞ"}} {
			ext, _ := storeTypeExt(tc.typ)
			full := storeBuild().find(tc.typ, tc.name)
			if full == nil && tc.name != "MISSING" {
				t.Fatalf("invalid fixture: %s %s missing from full index", tc.typ, tc.name)
			}
			fast := checkRunIndex("CHECKRUN", tc.typ, tc.name, nil, "").find(tc.typ, tc.name)
			if !reflect.DeepEqual(full, fast) {
				t.Fatalf("%s %s: full=%+v targeted=%+v", tc.typ, tc.name, full, fast)
			}
			if full != nil {
				a, err := compilerInput(storeBuild(), tc.typ, tc.name, "inactive")
				if err != nil {
					t.Fatal(err)
				}
				b, err := compilerInput(storeBuildFor(strings.ReplaceAll(tc.name, "/", "#")+ext), tc.typ, tc.name, "inactive")
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
	for _, tc := range []struct {
		command, typ, filter string
		source               *string
	}{
		{"CHECK", "PROG", "", nil}, {"CHECKRUN", "TABL", "", nil}, {"CHECKRUN", "PROG", "SOURCE", nil},
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

func TestTargetIndexCanonicalWinner(t *testing.T) {
	for _, library := range []bool{false, true} {
		t.Run(map[bool]string{false: "project", true: "library"}[library], func(t *testing.T) {
			for _, competing := range []bool{false, true} {
				t.Run(map[bool]string{false: "missing", true: "wrong-winner"}[competing], func(t *testing.T) {
					root := t.TempDir()
					for _, dir := range []string{"base", "overlay"} {
						if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
							t.Fatal(err)
						}
					}
					files := map[string]string{"abap_transpile.json": "{}", "overlay/zı.prog.abap": "REPORT zi. WRITE 'overlay'."}
					if competing {
						files["base/zi.prog.abap"] = "REPORT zi. WRITE 'base'."
					}
					for f, s := range files {
						if err := os.WriteFile(filepath.Join(root, f), []byte(s), 0600); err != nil {
							t.Fatal(err)
						}
					}
					cfg := Config{Roots: []Root{{Path: "base"}, {Path: "overlay"}}}
					if library {
						cfg.Roots = nil
						cfg.Libs = []Root{{Path: "overlay", Library: true, Files: []string{"overlay/zı.prog.abap"}}}
						if competing {
							cfg.Libs = append(cfg.Libs, Root{Path: "base", Library: true, Files: []string{"base/zi.prog.abap"}})
						}
					}
					config, err := json.Marshal(cfg)
					if err != nil {
						t.Fatal(err)
					}
					if err := SetStore(root, config, ""); err != nil {
						t.Fatal(err)
					}
					defer SetStore("", nil, "")
					full := storeBuild().find("PROG", "ZI")
					fast := storeBuildFor(storeFileOf("ZI")+".prog.abap").find("PROG", "ZI")
					t.Logf("full=%+v targeted=%+v", full, fast)
					if full == nil || full.File != "overlay/zı.prog.abap" {
						t.Fatal("invalid fixture")
					}
					if !reflect.DeepEqual(full, fast) {
						t.Fatalf("target index disagrees with full for valid canonical identity ZI")
					}
				})
			}
		})
	}
}

func TestTargetIndexSavedCheckCanonicalName(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	for f, s := range map[string]string{"abap_transpile.json": "{}", "src/zı.prog.abap": "REPORT zi."} {
		if err := os.WriteFile(filepath.Join(root, f), []byte(s), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := SetStore(root, []byte(`{"roots":[{"path":"src"}]}`), ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	provider := &sourceTestCompiler{}
	SetCompiler(provider, "")
	defer SetCompiler(nil, "")
	storeState.mu.Lock()
	req := captureCompiler(storeBuild(), "CHECKRUN", "PROG", "ZI", "main", nil, "", "")
	storeState.mu.Unlock()
	full, err := storecheck.Run(provider, req)
	if err != nil || !strings.Contains(full.Scalars["EV_JSON"], `"status":"processed"`) {
		t.Fatalf("invalid full fixture: %+v %v", full, err)
	}
	ptr := func(s string) *string { return &s }
	fast := Call(map[string]*string{"IV_COMMAND": ptr("CHECKRUN"), "IV_TYPE": ptr("PROG"), "IV_NAME": ptr("ZI")})
	t.Logf("full=%s; targeted=%s", full.Scalars["EV_JSON"], fast.Scalars["EV_JSON"])
	if full.Scalars["EV_JSON"] != fast.Scalars["EV_JSON"] {
		t.Fatal("saved CHECKRUN changes its public result")
	}
}

// The generated STORE adapter supplies IV_SOURCE even for saved HTTP requests.
// Observe the actual builder reached by Call, rather than only equal output.
func TestTargetIndexAdapterSource(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	for f, s := range map[string]string{"abap_transpile.json": "{}", "src/ztest.prog.abap": "REPORT ztest.", "src/other.prog.abap": "REPORT other."} {
		if err := os.WriteFile(filepath.Join(root, f), []byte(s), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := SetStore(root, []byte(`{"roots":[{"path":"src","writable":true}]}`), ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	provider := &sourceTestCompiler{}
	SetCompiler(provider, "")
	defer SetCompiler(nil, "")
	ptr := func(s string) *string { return &s }
	for _, tc := range []struct {
		name, filter string
		source       *string
	}{
		{"saved-absent", "", nil},
		{"saved-adapter-empty", "", ptr("")},
		{"saved-ignores-buffer", "", ptr("unsaved")},
		{"overlay-empty", "SOURCE", ptr("")},
		{"overlay-text", "SOURCE", ptr("unsaved")},
		{"overlay-absent", "SOURCE", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			storeState.mu.Lock()
			req := captureCompiler(storeBuild(), "CHECKRUN", "PROG", "ZTEST", "", tc.source, tc.filter, "")
			storeState.mu.Unlock()
			full, err := storecheck.Run(provider, req)
			if err != nil || !strings.Contains(full.Scalars["EV_JSON"], `"status":"processed"`) {
				t.Fatalf("invalid full fixture: %+v %v", full, err)
			}
			var builds []string
			storeState.mu.Lock()
			storeIndexBuilt = func(target string) { builds = append(builds, target) }
			storeState.mu.Unlock()
			defer func() {
				storeState.mu.Lock()
				storeIndexBuilt = nil
				storeState.mu.Unlock()
			}()
			answer := Call(map[string]*string{"IV_COMMAND": ptr("CHECKRUN"), "IV_TYPE": ptr("PROG"), "IV_NAME": ptr("ZTEST"), "IV_SOURCE": tc.source, "IV_FILTER": ptr(tc.filter)})
			wantTarget := "ZTEST.prog.abap"
			if tc.filter == "SOURCE" {
				wantTarget = ""
			}
			if !reflect.DeepEqual(builds, []string{wantTarget}) {
				t.Fatalf("index builds = %q, want %q", builds, []string{wantTarget})
			}
			if answer.Scalars["EV_ERROR"] != "" || answer.Scalars["EV_JSON"] != full.Scalars["EV_JSON"] {
				t.Fatalf("full=%+v Call=%+v", full, answer)
			}
			if tc.filter != "SOURCE" && provider.request.Source != nil {
				t.Fatal("saved check used inline source")
			}
			if tc.filter == "SOURCE" && (provider.request.Source == nil || (tc.source != nil && *provider.request.Source != *tc.source)) {
				t.Fatal("overlay source lost, including empty buffer")
			}
		})
	}
}
