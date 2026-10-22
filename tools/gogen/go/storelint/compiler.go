// Package storelint adapts a persistent, host-owned lint engine to CHECKRUN.
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

// ParseObjects counts dirty candidates before find_issues_object, not rule runs.
// Counters are cumulative within one prime and read under the compiler mutex.
type Stats struct {
	Updates, Noops, IndexedObjects, ReaderVisits, DirtiedObjects, ParseRuns, ParseObjects int32
}

// Calls run synchronously on one host-owned registry. The ABAP bridge owns
// private Session/Statics. No dialog step or work-process lock may be acquired
// inside these callbacks.
type Engine struct {
	// Name defaults to abap for the existing TS-HA bridge.
	Name, Entry string
	Prime       func([]objstore.LintFile, string)
	Check       func(string) []Issue
	Update      func(string, *string)
	Stats       func() Stats
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
	config   string
}

var _ storecheck.Compiler = (*Compiler)(nil)

func (c *Compiler) name() string {
	if c.Engine.Name != "" {
		return c.Engine.Name
	}
	return "abap"
}

func (c *Compiler) label() string {
	if c.name() == "go" {
		return "Go"
	}
	return "ABAP"
}

func (c *Compiler) log(format string, args ...any) {
	if c.Logf != nil {
		c.Logf(format, args...)
	}
}

func (c *Compiler) stats() Stats {
	if c.Engine.Stats != nil {
		return c.Engine.Stats()
	}
	return Stats{}
}

func (c *Compiler) logWork(phase string, before Stats, started time.Time) {
	if c.Engine.Stats == nil {
		return
	}
	after := c.stats()
	c.log("lint-engine=%s check=%d phase=%s updates=%d noops=%d indexed=%d reader-visits=%d dirtied=%d parse-runs=%d parse-objects=%d elapsed=%s",
		c.name(), c.calls, phase, after.Updates-before.Updates, after.Noops-before.Noops,
		after.IndexedObjects-before.IndexedObjects, after.ReaderVisits-before.ReaderVisits,
		after.DirtiedObjects-before.DirtiedObjects, after.ParseRuns-before.ParseRuns,
		after.ParseObjects-before.ParseObjects, time.Since(started))
}

func (c *Compiler) trapped(err *error) {
	if value := recover(); value != nil {
		*err = fmt.Errorf("%s lint engine failed: %v", c.label(), value)
		c.failure = *err
	}
}

// Prime initializes the private registry before accepting HTTP requests.
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
		return fmt.Errorf("%s lint: prime already attempted; restart required", c.label())
	}
	if c.Engine.Prime == nil || c.Engine.Check == nil {
		return fmt.Errorf("%s lint engine not compiled; rebuild osgo with --lint-lib PATH", c.label())
	}
	if c.Capture == nil {
		return fmt.Errorf("%s lint: no input capture configured", c.label())
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
	if c.baseline.Config != "" {
		config = c.baseline.Config
	}
	started := time.Now()
	c.Engine.Prime(c.baseline.Files, config)
	c.primed = true
	c.config = config
	if err = c.unchanged(); err != nil {
		return err
	}
	c.log("lint-engine=%s prime=1 files=%d elapsed=%s", c.name(), len(c.baseline.Files), time.Since(started))
	// Retain the saved bytes to diff edits and restore overlays exactly.
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
	if now.Root != c.baseline.Root || now.Digest != c.baseline.Digest || now.Structure != c.baseline.Structure {
		return fmt.Errorf("%s lint inputs changed during check; retry", c.label())
	}
	return nil
}

func (c *Compiler) SupportsSource() bool { return true }

func (c *Compiler) syncSaved() (string, error) {
	if c.Guard != nil {
		if err := c.Guard(); err != nil {
			return "", err
		}
	}
	now, err := c.Capture()
	if err != nil {
		return "", err
	}
	if now.Root != c.baseline.Root {
		return "", fmt.Errorf("%s lint: request root differs from primed root", c.label())
	}
	status := ""
	if now.Structure != c.baseline.Structure {
		config := now.Config
		if config == "" {
			config = c.config
		}
		c.Engine.Prime(now.Files, config)
		c.config = config
		status = c.label() + " lint: full re-prime after structural layer/config change"
		c.log("lint-engine=%s re-prime files=%d reason=structural", c.name(), len(now.Files))
	} else if now.Digest != c.baseline.Digest {
		if c.Engine.Update == nil {
			return "", fmt.Errorf("%s lint: update bridge unavailable; rebuild", c.label())
		}
		old, current := map[string]string{}, map[string]string{}
		for _, f := range c.baseline.Files {
			old[f.Filename] = f.Raw
		}
		for _, f := range now.Files {
			current[f.Filename] = f.Raw
		}
		// Remove in old registry order, then update/add in current registry order.
		for _, f := range c.baseline.Files {
			if _, exists := current[f.Filename]; !exists {
				c.Engine.Update(f.Filename, nil)
			}
		}
		for _, f := range now.Files {
			before, exists := old[f.Filename]
			if !exists || before != f.Raw {
				raw := f.Raw
				c.Engine.Update(f.Filename, &raw)
			}
		}
	}
	c.baseline = now
	return status, nil
}

func (c *Compiler) Check(ctx context.Context, in storecheck.Input) ([]storecheck.Issue, error) {
	if !in.CheckRun {
		if c.Other == nil {
			return nil, storecheck.ErrCompilerAbsent
		}
		return c.Other.Check(ctx, in)
	}
	rows, _, err := c.CheckRun(ctx, in)
	return rows, err
}

// A thrown check is recoverable after restoration. A failed update/restore or
// prime poisons the registry, since its saved state can no longer be proven.
func (c *Compiler) engineCheck(fn func() []Issue) (issues []Issue, err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("%s lint engine check failed: %v", c.label(), value)
		}
	}()
	return fn(), nil
}

func (c *Compiler) CheckRun(ctx context.Context, in storecheck.Input) (rows []storecheck.Issue, status string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer c.trapped(&err)
	if c.failure != nil {
		return nil, "", c.failure
	}
	if !c.primed {
		return nil, "", fmt.Errorf("%s lint engine not primed", c.label())
	}
	if err = ctx.Err(); err != nil {
		return nil, "", err
	}
	if in.Type != "CLAS" && in.Type != "INTF" && in.Type != "PROG" && in.Type != "INCL" {
		return nil, "", fmt.Errorf("%s lint: CHECKRUN for %s is outside the ABAP slice", c.label(), in.Type)
	}
	if in.Root != c.baseline.Root {
		return nil, "", fmt.Errorf("%s lint: request root differs from primed root", c.label())
	}
	status, err = c.syncSaved()
	if err != nil {
		return nil, "", err
	}
	if err = ctx.Err(); err != nil {
		return nil, status, err
	}
	target, err := c.currentTarget(in)
	if err != nil {
		return nil, "", err
	}

	c.calls++
	started := time.Now()
	entry := c.Engine.Entry
	if entry == "" {
		entry = "ZCL_OSD_LINT_ENGINE=>CHECK"
	}
	c.log("lint-engine=%s check=%d target=%s entered=%s", c.name(), c.calls, target, entry)
	issues, err := c.checkWithSource(target, in.Source)
	if err != nil {
		return nil, status, err
	}
	if err = ctx.Err(); err != nil {
		return nil, status, err
	}
	if err = c.unchanged(); err != nil {
		return nil, status, err
	}
	rows = MapIssues(in, issues)
	c.log("lint-engine=%s check=%d issues=%d elapsed=%s", c.name(), c.calls, len(rows), time.Since(started))
	return rows, status, nil
}

// Restoration finishes before input verification and the completion log.
func (c *Compiler) checkWithSource(target string, source *string) (issues []Issue, err error) {
	update := func(raw *string, phase string) {
		before, started := c.stats(), time.Now()
		c.Engine.Update(target, raw)
		c.logWork(phase, before, started)
	}
	if source != nil {
		if c.Engine.Update == nil {
			return nil, fmt.Errorf("%s lint: update bridge unavailable; rebuild", c.label())
		}
		var original *string
		for _, f := range c.baseline.Files {
			if f.Filename == target {
				raw := f.Raw
				original = &raw
				break
			}
		}
		defer func() {
			defer c.trapped(&err)
			update(original, "restore")
		}()
		update(source, "install")
	}
	before, started := c.stats(), time.Now()
	defer func() { c.logWork("check", before, started) }()
	return c.engineCheck(func() []Issue { return c.Engine.Check(target) })
}

func (c *Compiler) Outline(ctx context.Context, in storecheck.Input) (json.RawMessage, error) {
	if c.Other == nil {
		return nil, storecheck.ErrCompilerAbsent
	}
	return c.Other.Outline(ctx, in)
}

// A structural re-prime can move an object's winning file to another layer.
// Preserve the store-resolved logical target when present, otherwise select
// that same abapGit filename from the current resolved registry.
func (c *Compiler) currentTarget(in storecheck.Input) (string, error) {
	target, err := targetFile(in)
	if err != nil {
		return "", err
	}
	for _, file := range c.baseline.Files {
		if file.Filename == target {
			return target, nil
		}
	}
	for _, file := range c.baseline.Files {
		if path.Base(file.Filename) == path.Base(target) {
			return file.Filename, nil
		}
	}
	return target, nil
}

func targetFile(in storecheck.Input) (string, error) {
	suffix := map[string]string{"": ".clas.abap", "main": ".clas.abap", "definitions": ".clas.locals_def.abap", "implementations": ".clas.locals_imp.abap", "macros": ".clas.macros.abap", "testclasses": ".clas.testclasses.abap"}[in.Include]
	if in.Type == "CLAS" && suffix == "" {
		return "", fmt.Errorf("lint: unknown class include %s", in.Include)
	}
	if in.Type != "CLAS" {
		suffix = map[string]string{"INTF": ".intf.abap", "PROG": ".prog.abap", "INCL": ".prog.abap"}[in.Type]
	}
	for _, file := range in.Logical {
		if strings.HasSuffix(file, suffix) {
			return "/" + strings.TrimPrefix(file, "/"), nil
		}
	}
	if in.Source != nil && in.Target != "" {
		target := in.Target
		if in.Type == "CLAS" {
			target = strings.TrimSuffix(target, ".clas.abap") + suffix
		}
		return "/" + strings.TrimPrefix(target, "/"), nil
	}
	return "", fmt.Errorf("lint: no saved target file for %s %s include %s", in.Type, in.Name, in.Include)
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
