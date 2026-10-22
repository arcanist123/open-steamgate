package lintinput

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"osg/gogen/objstore"
)

func TestMembershipDeltaGuards(t *testing.T) {
	root := t.TempDir()
	hidden := "base/#ns#z.clas.abap"
	if err := os.MkdirAll(filepath.Join(root, "base"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, hidden), []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                  string
		before, after, hidden []string
		want                  bool
	}{
		{"unchanged", []string{"/src/z.clas.abap"}, []string{"/src/z.clas.abap"}, nil, false},
		{"include", []string{"/src/z.clas.abap"}, []string{"/src/z.clas.abap", "/src/z.clas.macros.abap"}, nil, false},
		{"encoded competitor", []string{"/src/#ns#z.clas.abap"}, []string{"/src/#ns#z.clas.abap", "/new/%23ns%23z.clas.abap"}, nil, true},
		{"new competitors", nil, []string{"/a/z.clas.abap", "/b/z.clas.abap"}, nil, true},
		{"remove duplicate", []string{"/a/z.clas.abap", "/b/z.clas.abap"}, []string{"/a/z.clas.abap"}, nil, true},
		{"rename winner", []string{"/a/#ns#z.clas.abap"}, []string{"/a/y.clas.abap"}, []string{hidden}, true},
		{"hidden addition", nil, []string{"/a/%23ns%23z.clas.abap"}, []string{hidden}, true},
		{"known duplicates", []string{"/a/z.clas.abap", "/b/z.clas.abap"}, []string{"/a/z.clas.abap", "/b/z.clas.abap"}, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := Spec{Files: tc.before, Hidden: tc.hidden}
			m := newMembership(spec)
			snap := objstore.LintSnapshot{}
			for _, f := range tc.after {
				snap.Files = append(snap.Files, objstore.LintFile{Filename: f})
			}
			if got := m.needs(root, spec, snap); got != tc.want {
				t.Fatalf("needs=%v want=%v", got, tc.want)
			}
		})
	}
	m := newMembership(Spec{Files: []string{"/package.devc.xml", "/unknown"}})
	m.advance(objstore.LintSnapshot{}) // unclassified removals must not panic
	spec := Spec{Hidden: []string{hidden}}
	m = newMembership(spec)
	if err := os.Remove(filepath.Join(root, hidden)); err != nil {
		t.Fatal(err)
	}
	if !m.needs(root, spec, objstore.LintSnapshot{}) {
		t.Fatal("hidden deletion missed")
	}
}

func BenchmarkMembershipDelta3000(b *testing.B) {
	spec := Spec{}
	snapshot := objstore.LintSnapshot{}
	for n := 0; n < 3000; n++ {
		file := fmt.Sprintf("/src/d%02d/z%04d.clas.abap", n/100, n)
		spec.Files = append(spec.Files, file)
		snapshot.Files = append(snapshot.Files, objstore.LintFile{Filename: file})
	}
	root := b.TempDir()
	for _, retained := range []bool{false, true} {
		b.Run(fmt.Sprint("retained=", retained), func(b *testing.B) {
			m := newMembership(spec)
			b.ReportAllocs()
			for b.Loop() {
				if !retained {
					m = newMembership(spec)
				}
				if m.needs(root, spec, snapshot) {
					b.Fatal("unchanged")
				}
				if retained {
					m.advance(snapshot)
				}
			}
		})
	}
}
