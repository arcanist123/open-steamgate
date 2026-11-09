//go:build gitprobe

// ZCL_OSD_GIT as the OSGo binary compiled it, driven from outside: the refs
// of a remote and a clone of one branch, printed as JSON for
// tools/gogen/httpc-git.mjs to compare with the same ABAP on Node. Built only
// with -tags gitprobe, against the zz_generated.go of a full osgo.mjs build
// (the --echo build has no ZCL_OSD_GIT). The classes live in the layered
// packages (osgo-layers.mjs: core, app; main only while edited), reached
// the way zz_*.go reaches them, with their fields exported (emit-go.mjs
// goIdent); an --unlayered build does not compile this probe.
//
//	OSGO_GIT_URL=http://127.0.0.1:4100/repo.git go test -tags gitprobe ./cmd/osgo -run TestGitProbe -v
package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"osg/gogen/abap"
	. "osg/gogen/generated/osgo/app"
	. "osg/gogen/generated/osgo/core"
)

var _ = GogenCoreLayer{}
var _ = GogenAppLayer{}

type probeFile struct {
	Path, Filename, SHA1 string
	Size                 int
}

type probeOut struct {
	Refs   [][2]string `json:",omitempty"`
	Commit string      `json:",omitempty"`
	Branch string      `json:",omitempty"`
	Files  []probeFile `json:",omitempty"`
	Dump   string      `json:",omitempty"`
}

// dumpOf: what ended the step, as httpc.mjs names it
func dumpOf(r any) string {
	switch e := r.(type) {
	case abap.ArithmeticError:
		return "DUMP " + e.Class + "|" + e.Op
	case abap.HostError:
		return "DUMP host|" + e.Error()
	}
	if x, ok := abap.AsRaised(r); ok {
		return "DUMP " + x.Class
	}
	return fmt.Sprintf("DUMP ?|%v", r)
}

func TestGitProbe(t *testing.T) {
	url := os.Getenv("OSGO_GIT_URL")
	if url == "" {
		t.Skip("OSGO_GIT_URL is not set")
	}
	d, err := abap.OpenDB(dbScript)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	s := &abap.Session{DB: d}
	var refs, clone probeOut
	func() {
		defer func() {
			if r := recover(); r != nil {
				refs.Dump = dumpOf(r)
			}
		}()
		for _, r := range ZCL_OSD_GIT_REFS(s, url) {
			refs.Refs = append(refs.Refs, [2]string{r.Sha1, r.Name})
		}
	}()
	func() {
		defer func() {
			if r := recover(); r != nil {
				clone.Dump = dumpOf(r)
			}
		}()
		c := ZCL_OSD_GIT_CLONE(s, url, "")
		clone.Commit, clone.Branch = c.Commit, c.Branch
		for _, f := range c.Files {
			sum := sha1.Sum([]byte(f.Data))
			clone.Files = append(clone.Files, probeFile{f.Path, f.Filename, hex.EncodeToString(sum[:]), len(f.Data)})
		}
	}()
	out, _ := json.Marshal(map[string]probeOut{"refs": refs, "clone": clone})
	fmt.Printf("GITPROBE %s\n", out)
}
