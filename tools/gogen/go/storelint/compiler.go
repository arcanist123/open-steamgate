// Package storelint adapts a persistent, host-owned ABAP lint facade to CHECKRUN.
// It has no dependency on generated types or the ABAP runtime.
package storelint

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"osg/gogen/objstore"
	"osg/gogen/storecheck"
)

type Issue struct {
	Filename, Key, Message string
	Row, Column            int32
}

// Calls run synchronously on one private Session/Statics owned by the host.
// No dialog step or work-process lock may be acquired inside these callbacks.
type Engine struct {
	Prime func([]objstore.LintFile, string)
	Check func(string) []Issue
}

type Compiler struct {
	mu       sync.Mutex
	Engine   Engine
	Other    storecheck.Compiler
	Capture  func() (objstore.LintSnapshot, error)
	Guard    func() error
	Logf     func(string, ...any)
	baseline objstore.LintSnapshot
	failure  error
	primed   bool
	calls    uint64
}

var _ storecheck.Compiler = (*Compiler)(nil)

func (c *Compiler) log(format string, args ...any) {
	if c.Logf != nil {
		c.Logf(format, args...)
	}
}

func (c *Compiler) trapped(err *error) {
	if value := recover(); value != nil {
		*err = fmt.Errorf("ABAP lint engine failed: %v", value)
		c.failure = *err
	}
}

// Prime is called exactly once at startup, before accepting HTTP requests.
// Failure is retained so CHECKRUN can return notProcessed with its cause.
func (c *Compiler) Prime(config string) (err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer func() {
		if err != nil {
			c.failure = err
		}
	}()
	defer c.trapped(&err)
	if c.primed || c.failure != nil {
		return fmt.Errorf("ABAP lint: prime already attempted; restart required")
	}
	if c.Engine.Prime == nil || c.Engine.Check == nil {
		return fmt.Errorf("ABAP lint engine not compiled; rebuild osgo with --lint-lib PATH")
	}
	if c.Capture == nil {
		return fmt.Errorf("ABAP lint: no input capture configured")
	}
	if c.Guard != nil {
		if err = c.Guard(); err != nil {
			return err
		}
	}
	c.baseline, err = c.Capture()
	if err != nil {
		return err
	}
	started := time.Now()
	c.Engine.Prime(c.baseline.Files, config)
	c.primed = true
	if err = c.unchanged(); err != nil {
		return err
	}
	c.log("lint-engine=abap prime=1 files=%d elapsed=%s", len(c.baseline.Files), time.Since(started))
	// Raw source bytes are owned by the registry now; keep only identity.
	c.baseline.Files = nil
	return nil
}

// Available must not probe the sidecar: an opted-in CHECKRUN may never fall back.
// CHECK/OUTLINE delegate to Other, which checks its own availability.
func (c *Compiler) Available(context.Context) error { return nil }

func (c *Compiler) unchanged() error {
	if c.Guard != nil {
		if err := c.Guard(); err != nil {
			return err
		}
	}
	now, err := c.Capture()
	if err != nil {
		return err
	}
	if now.Root != c.baseline.Root || now.Digest != c.baseline.Digest {
		return fmt.Errorf("ABAP lint baseline changed (store/config/library inputs); restart and re-prime; rebuild if layers changed")
	}
	return nil
}

func (c *Compiler) Check(ctx context.Context, in storecheck.Input) (rows []storecheck.Issue, err error) {
	if !in.CheckRun {
		if c.Other == nil {
			return nil, storecheck.ErrCompilerAbsent
		}
		return c.Other.Check(ctx, in)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	defer c.trapped(&err)
	if c.failure != nil {
		return nil, c.failure
	}
	if !c.primed {
		return nil, fmt.Errorf("ABAP lint engine not primed")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if in.Source != nil {
		return nil, fmt.Errorf("ABAP lint: inline SOURCE requires the overlay slice")
	}
	if in.Type != "CLAS" && in.Type != "INTF" && in.Type != "PROG" && in.Type != "INCL" {
		return nil, fmt.Errorf("ABAP lint: CHECKRUN for %s is outside the saved ABAP slice", in.Type)
	}
	if in.Root != c.baseline.Root {
		return nil, fmt.Errorf("ABAP lint: request root differs from primed root")
	}
	if err = c.unchanged(); err != nil {
		return nil, err
	}
	target, err := targetFile(in)
	if err != nil {
		return nil, err
	}
	c.calls++
	started := time.Now()
	c.log("lint-engine=abap check=%d target=%s entered=ZCL_OSD_LINT_ENGINE=>CHECK", c.calls, target)
	issues := c.Engine.Check(target)
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = c.unchanged(); err != nil {
		return nil, err
	}
	rows = MapIssues(in, issues)
	c.log("lint-engine=abap check=%d issues=%d elapsed=%s", c.calls, len(rows), time.Since(started))
	return rows, nil
}

func (c *Compiler) Outline(ctx context.Context, in storecheck.Input) (json.RawMessage, error) {
	if c.Other == nil {
		return nil, storecheck.ErrCompilerAbsent
	}
	return c.Other.Outline(ctx, in)
}

func targetFile(in storecheck.Input) (string, error) {
	suffix := map[string]string{"": ".clas.abap", "main": ".clas.abap", "definitions": ".clas.locals_def.abap", "implementations": ".clas.locals_imp.abap", "macros": ".clas.macros.abap", "testclasses": ".clas.testclasses.abap"}[in.Include]
	if in.Type == "CLAS" && suffix == "" {
		return "", fmt.Errorf("ABAP lint: unknown class include %s", in.Include)
	}
	if in.Type != "CLAS" {
		suffix = map[string]string{"INTF": ".intf.abap", "PROG": ".prog.abap", "INCL": ".prog.abap"}[in.Type]
	}
	for _, file := range in.Logical {
		if strings.HasSuffix(file, suffix) {
			return "/" + strings.TrimPrefix(file, "/"), nil
		}
	}
	return "", fmt.Errorf("ABAP lint: no saved target file for %s %s include %s", in.Type, in.Name, in.Include)
}

func MapIssues(in storecheck.Input, issues []Issue) []storecheck.Issue {
	rows := make([]storecheck.Issue, 0, len(issues))
	for _, issue := range issues {
		rows = append(rows, storecheck.Issue{OBJ_TYPE: in.Type, OBJ_NAME: in.Name, FILE: issue.Filename,
			LINE: issue.Row, COL: issue.Column, RULE: issue.Key, MESSAGE: issue.Message,
			Severity: "E", URI: diagnosticURI(in, issue.Filename)})
	}
	return rows
}

// encodeURIComponent's safe bytes, deliberately not Go's PathEscape/QueryEscape.
func encodeName(name string) string {
	var out strings.Builder
	for _, b := range []byte(strings.ToLower(name)) {
		if b >= 'a' && b <= 'z' || b >= '0' && b <= '9' || strings.ContainsRune("-_.!~*'()", rune(b)) {
			out.WriteByte(b)
		} else {
			fmt.Fprintf(&out, "%%%02X", b)
		}
	}
	return out.String()
}

func objectURI(typ, name string) string {
	collection := map[string]string{"CLAS": "oo/classes", "INTF": "oo/interfaces", "PROG": "programs/programs", "INCL": "programs/includes"}[typ]
	return "/sap/bc/adt/" + collection + "/" + encodeName(name)
}

var classFile = regexp.MustCompile(`(?i)^(.+)\.clas(?:\.([a-z_]+))?\.abap$`)
var progFile = regexp.MustCompile(`^(.+)\.prog\.abap$`)

// Mirrors diagnosticUri + frameUri: includes take priority over file frames;
// only CLAS/PROG filenames can frame a diagnostic. Everything else uses target.
func diagnosticURI(in storecheck.Input, file string) string {
	if in.Type == "INCL" {
		return objectURI("INCL", in.Name)
	}
	if match := classFile.FindStringSubmatch(path.Base(file)); match != nil {
		include, known := map[string]string{"": "main", "locals_def": "definitions", "locals_imp": "implementations", "macros": "macros", "testclasses": "testclasses"}[strings.ToLower(match[2])]
		if known {
			root := objectURI("CLAS", strings.ReplaceAll(match[1], "#", "/"))
			if include != "main" {
				return root + "/includes/" + include
			}
			return root + "/source/main"
		}
	}
	if match := progFile.FindStringSubmatch(path.Base(file)); match != nil {
		return objectURI("PROG", match[1]) + "/source/main"
	}
	root := objectURI(in.Type, in.Name)
	if in.Type == "CLAS" && in.Include != "" && in.Include != "main" {
		return root + "/includes/" + in.Include
	}
	return root + "/source/main"
}
