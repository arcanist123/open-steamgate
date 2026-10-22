package objstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type testCompiler struct {
	checks      int
	request     CompilerInput
	diagnostics []Issue
	err         error
}

func (c *testCompiler) Available(context.Context) error { return c.err }
func (c *testCompiler) Check(ctx context.Context, in CompilerInput) ([]Issue, error) {
	c.checks++
	c.request = in
	return c.diagnostics, c.err
}
func (c *testCompiler) Outline(ctx context.Context, in CompilerInput) (json.RawMessage, error) {
	c.request = in
	return json.RawMessage(`{"found":true}`), c.err
}

func TestCompilerStore(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "src"), 0700)
	os.WriteFile(filepath.Join(root, "abap_transpile.json"), []byte(`{}`), 0600)
	os.WriteFile(filepath.Join(root, "src/ztest.prog.abap"), []byte("REPORT ztest."), 0600)
	if err := SetStore(root, []byte(`{"roots":[{"path":"src","writable":true}]}`), ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	os.MkdirAll(filepath.Join(root, "build"), 0700)
	if err := os.Symlink("by-input/live-generation", filepath.Join(root, "build/live")); err != nil {
		t.Fatal(err)
	}
	c := &testCompiler{diagnostics: []Issue{{OBJ_TYPE: "PROG", OBJ_NAME: "ZTEST", FILE: "/src/ztest.prog.abap", LINE: 2, COL: 4, RULE: "syntax", MESSAGE: "bad"}}}
	SetCompiler(c, "live-generation")
	defer SetCompiler(nil, "")
	str := func(s string) *string { return &s }
	call := map[string]*string{"IV_COMMAND": str("CHECK"), "IV_TYPE": str("PROG"), "IV_NAME": str("ZTEST")}
	a := Call(call)
	if a.Scalars["EV_ERROR"] != "" || a.Scalars["EV_COUNT"] != "1" || len(a.Issues) != 1 || a.Issues[0].COL != 4 || a.Issues[0].FILE != "/src/ztest.prog.abap" {
		t.Fatalf("check: %+v", a)
	}
	if c.request.Generation != "live-generation" || c.request.Version != "inactive" || len(c.request.Files) != 1 {
		t.Fatalf("snapshot input: %+v", c.request)
	}
	if !strings.Contains(a.Scalars["EV_JSON"], `"issues":[{"OBJ_TYPE":"PROG"`) {
		t.Fatal(a.Scalars)
	}
	call = map[string]*string{"IV_COMMAND": str("PARSE"), "IV_JSON": str(`{"kind":"OUTLINE","type":"PROG","name":"ZTEST","version":"active"}`)}
	a = Call(call)
	if a.Scalars["EV_ERROR"] != "" || len(c.request.Files) != 0 {
		t.Fatal("unproven active outline must pass an empty source list")
	}
	call["IV_JSON"] = str(`{"kind":"OUTLINE","type":"PROG","name":"ZTEST"}`)
	a = Call(call)
	if a.Scalars["EV_JSON"] != `{"found":true}` {
		t.Fatal(a.Scalars)
	}
	missing := Call(map[string]*string{"IV_COMMAND": str("PARSE"), "IV_JSON": str(`{"kind":"OUTLINE","type":"PROG","name":"ZMISSING"}`)})
	if missing.Scalars["EV_JSON"] != `{"found":false}` || missing.Scalars["EV_ERROR"] != "" {
		t.Fatalf("missing outline with live generation: %+v", missing)
	}
	for _, reason := range []string{"SNAPSHOT_MISMATCH", "TIMEOUT", "UNSUPPORTED_OP"} {
		c.err = errors.New(reason + ": refused")
		a = Call(call)
		if !strings.Contains(a.Scalars["EV_ERROR"], reason) || !strings.Contains(a.Scalars["EV_JSON"], "NOT_SUPPORTED") {
			t.Fatal(a.Scalars)
		}
	}
	c.err = nil
	c.request = CompilerInput{}
	os.WriteFile(filepath.Join(root, "src/ztable.tabl.xml"), []byte("<abapGit/>"), 0600)
	checkrun := func(extra map[string]*string) map[string]*string {
		call := map[string]*string{"IV_COMMAND": str("CHECKRUN"), "IV_TYPE": str("PROG"), "IV_NAME": str("ZTEST")}
		for key, value := range extra {
			call[key] = value
		}
		return call
	}
	SetCompiler(nil, "")
	a = Call(checkrun(nil))
	if a.Scalars["EV_ERROR"] != "" || a.Scalars["EV_JSON"] != `{"status":"notProcessed","issues":[],"statusText":"CHECKRUN needs the compiler sidecar; none is available"}` {
		t.Fatalf("checkrun without compiler: %+v", a.Scalars)
	}
	SetCompiler(c, "live-generation")
	for _, source := range []struct {
		name  string
		extra map[string]*string
	}{
		{"omitted", map[string]*string{}},
		{"nil", map[string]*string{"IV_SOURCE": nil}},
		{"empty", map[string]*string{"IV_SOURCE": str("")}},
		{"supplied", map[string]*string{"IV_SOURCE": str("REPORT ztest.")}},
	} {
		source.extra["IV_FILTER"] = str("SOURCE")
		before := c.checks
		a = Call(checkrun(source.extra))
		if a.Scalars["EV_ERROR"] != "" || a.Scalars["EV_JSON"] != `{"status":"notProcessed","issues":[],"statusText":"CHECKRUN with IV_FILTER=SOURCE requires a saved draft; write the draft first"}` || c.checks != before {
			t.Fatalf("checkrun %s source: %+v checks %d -> %d", source.name, a.Scalars, before, c.checks)
		}
	}
	a = Call(checkrun(map[string]*string{"IV_TYPE": str("TABL"), "IV_NAME": str("ZTABLE")}))
	if a.Scalars["EV_ERROR"] != "" || a.Scalars["EV_JSON"] != `{"status":"processed","issues":[],"statusText":"no dictionary check here; the object is present and readable"}` {
		t.Fatalf("checkrun non-source: %+v", a.Scalars)
	}
	a = Call(checkrun(map[string]*string{"IV_NAME": str("ZMISSING")}))
	if a.Scalars["EV_ERROR"] != "" || a.Scalars["EV_JSON"] != `{"status":"notProcessed","issues":[],"statusText":"PROG ZMISSING does not exist"}` {
		t.Fatalf("checkrun missing: %+v", a.Scalars)
	}
}

type blockedCompiler struct {
	entered           chan CompilerInput
	release           chan struct{}
	blockAvailability bool
}

func (c *blockedCompiler) SupportsSource() bool { return true }

func (c *blockedCompiler) Available(ctx context.Context) error {
	if c.blockAvailability {
		c.entered <- CompilerInput{}
		select {
		case <-c.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func (c *blockedCompiler) Check(ctx context.Context, in CompilerInput) ([]Issue, error) {
	if !c.blockAvailability {
		c.entered <- in
		select {
		case <-c.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return []Issue{{MESSAGE: "old verdict"}}, nil
}
func (c *blockedCompiler) Outline(ctx context.Context, in CompilerInput) (json.RawMessage, error) {
	_, err := c.Check(ctx, in)
	return json.RawMessage(`{"found":true}`), err
}

func TestCompilerDoesNotLockStoreAndRejectsStaleResults(t *testing.T) {
	for _, command := range []string{"CHECK", "CHECKRUN", "PARSE"} {
		for _, mutation := range []string{"none", "write", "provider", "store", "external", "generation", "generation-removed", "generation-replaced"} {
			for _, availability := range []bool{false, true} {
				t.Run(command+"/"+mutation+"/"+strconv.FormatBool(availability), func(t *testing.T) {
					root := t.TempDir()
					os.MkdirAll(filepath.Join(root, "src"), 0700)
					os.WriteFile(filepath.Join(root, "abap_transpile.json"), []byte(`{}`), 0600)
					os.MkdirAll(filepath.Join(root, "build"), 0700)
					live := filepath.Join(root, "build/live")
					if err := os.Symlink("by-input/before", live); err != nil {
						t.Fatal(err)
					}
					file := filepath.Join(root, "src/ztest.prog.abap")
					os.WriteFile(file, []byte("REPORT ztest."), 0600)
					config := []byte(`{"roots":[{"path":"src","writable":true}]}`)
					if err := SetStore(root, config, ""); err != nil {
						t.Fatal(err)
					}
					defer SetStore("", nil, "")
					c := &blockedCompiler{entered: make(chan CompilerInput, 1), release: make(chan struct{}), blockAvailability: availability}
					SetCompiler(c, "before")
					defer SetCompiler(nil, "")
					// Ensure even a failing lock regression can release the blocked compiler.
					defer func() {
						select {
						case <-c.release:
						default:
							close(c.release)
						}
					}()
					ptr := func(s string) *string { return &s }
					done := make(chan Answer, 1)
					go func() {
						done <- Call(map[string]*string{"IV_COMMAND": ptr(command), "IV_TYPE": ptr("PROG"), "IV_NAME": ptr("ZTEST"), "IV_JSON": ptr(`{"kind":"OUTLINE","type":"PROG","name":"ZTEST"}`), "IV_SOURCE": nil})
					}()
					select {
					case input := <-c.entered:
						if !availability && input.Generation != "before" {
							t.Fatalf("captured generation: %+v", input)
						}
					case <-time.After(2 * time.Second):
						t.Fatal("compiler was not entered")
					}
					progressed := make(chan Answer, 1)
					go func() {
						read := Call(map[string]*string{"IV_COMMAND": ptr("READ"), "IV_TYPE": ptr("PROG"), "IV_NAME": ptr("ZTEST")})
						switch mutation {
						case "write":
							read = Call(map[string]*string{"IV_COMMAND": ptr("WRITE"), "IV_TYPE": ptr("PROG"), "IV_NAME": ptr("ZTEST"), "IV_SOURCE": ptr("REPORT ztest. WRITE 'new'.")})
						case "provider":
							SetCompiler(&testCompiler{}, "after")
						case "store":
							SetStore(root, config, "")
						case "generation", "generation-removed", "generation-replaced":
							if mutation == "generation-removed" {
								os.Remove(live)
							} else {
								target := "by-input/after"
								if mutation == "generation-replaced" {
									target = "by-input/before"
								}
								if err := os.Symlink(target, live+".next"); err != nil {
									read.Scalars["EV_ERROR"] = err.Error()
								} else if err := os.Rename(live+".next", live); err != nil {
									read.Scalars["EV_ERROR"] = err.Error()
								}
							}
						case "external":
							os.WriteFile(file, []byte("REPORT ztest. WRITE 'external'."), 0600)
						}
						progressed <- read
					}()
					select {
					case read := <-progressed:
						if read.Scalars["EV_ERROR"] != "" {
							t.Fatal(read.Scalars)
						}
					case <-time.After(2 * time.Second):
						t.Fatal("other store command blocked by compiler")
					}
					close(c.release)
					select {
					case result := <-done:
						if mutation == "none" {
							if strings.Contains(result.Scalars["EV_JSON"], "STALE_RESULT") || result.Scalars["EV_ERROR"] != "" {
								t.Fatal(result.Scalars)
							}
						} else {
							if !strings.Contains(result.Scalars["EV_JSON"], "STALE_RESULT") || strings.Contains(result.Scalars["EV_JSON"], "old verdict") || len(result.Issues) != 0 {
								t.Fatal(result)
							}
							if command == "CHECKRUN" && (!strings.Contains(result.Scalars["EV_JSON"], `"status":"notProcessed"`) || result.Scalars["EV_ERROR"] != "") {
								t.Fatal(result.Scalars)
							}
						}
					case <-time.After(2 * time.Second):
						t.Fatal("compiler did not complete")
					}
				})
			}
		}
	}
}

type sourceTestCompiler struct{ testCompiler }

func (*sourceTestCompiler) SupportsSource() bool { return true }

func TestABAPSourceCaptureNewObjectAndMissingInclude(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	for file, source := range map[string]string{"abap_transpile.json": "{}", "src/ztest.clas.abap": "CLASS ztest DEFINITION PUBLIC. ENDCLASS. CLASS ztest IMPLEMENTATION. ENDCLASS."} {
		if err := os.WriteFile(filepath.Join(root, file), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := SetStore(root, []byte(`{"roots":[{"path":"src","writable":true}]}`), ""); err != nil {
		t.Fatal(err)
	}
	defer SetStore("", nil, "")
	c := &sourceTestCompiler{}
	SetCompiler(c, "old-generation")
	defer SetCompiler(nil, "")
	if err := os.MkdirAll(filepath.Join(root, "build"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("by-input/new-generation", filepath.Join(root, "build/live")); err != nil {
		t.Fatal(err)
	}
	ptr := func(s string) *string { return &s }
	for _, tc := range []struct{ name, include, target string }{{"ZNEW", "main", "src/osd/znew.clas.abap"}, {"ZTEST", "macros", "src/ztest.clas.abap"}} {
		a := Call(map[string]*string{"IV_COMMAND": ptr("CHECKRUN"), "IV_TYPE": ptr("CLAS"), "IV_NAME": ptr(tc.name), "IV_INCLUDE": ptr(tc.include), "IV_FILTER": ptr("SOURCE"), "IV_SOURCE": ptr("")})
		if !strings.Contains(a.Scalars["EV_JSON"], `"status":"processed"`) || c.request.Source == nil || *c.request.Source != "" || c.request.Target != tc.target || c.request.Include != tc.include {
			t.Fatal(a, c.request)
		}
	}
}
