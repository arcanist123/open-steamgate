package storelint

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"

	"osg/gogen/adtoutline"
	"osg/gogen/compiler"
	"osg/gogen/nodeutf8"
	"osg/gogen/objstore"
	"osg/gogen/storecheck"
)

func (c *Compiler) SupportsCheckSource() bool { return c.Engine.CheckObject != nil }
func (c *Compiler) NativeCheckOutline() bool {
	return c.Engine.CheckObject != nil && c.Engine.SnapshotTree != nil
}

func registryType(typ string) string {
	if typ == "STRU" {
		return "TABL"
	}
	if typ == "INCL" {
		return "PROG"
	}
	return typ
}
func (c *Compiler) ready(ctx context.Context, in storecheck.Input) error {
	if c.failure != nil {
		return c.failure
	}
	if !c.primed {
		return fmt.Errorf("%s lint engine not primed", c.label())
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if in.Root != c.baseline.Root {
		return fmt.Errorf("%s lint: request root differs from primed root", c.label())
	}
	return nil
}

// Read exactly the host-resolved version, using the same containment/size boundary
// as the sidecar. Capture's saved registry alone cannot prove active snapshot bytes.
func snapshot(ctx context.Context, in storecheck.Input) ([]objstore.LintFile, error) {
	s, err := compiler.BuildSnapshot(ctx, in.Root, in.Generation, []compiler.ObjectFiles{{Type: in.Type, Name: in.Name, Version: in.Version, Files: in.Files, Logical: in.Logical}}, 16*1024*1024)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(in.Root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	files := make([]objstore.LintFile, 0, len(in.Files))
	for _, f := range s.Objects[0].Files {
		if expected, ok := in.Expected[f.Path]; ok && expected != f.SHA256 {
			return nil, fmt.Errorf("SNAPSHOT_MISMATCH: source changed: %s", f.Path)
		}
		logical := f.LogicalPath
		if logical == "" {
			logical = f.Path
		}
		if strings.HasPrefix(logical, "/") || strings.Contains(logical, "\\") || hasParent(logical) || (ObjectIdentity(logical) != strings.ToUpper(in.Name)+"."+registryType(in.Type) && !(in.Type == "DEVC" && strings.EqualFold(path.Base(logical), "package.devc.xml"))) {
			return nil, fmt.Errorf("invalid logical snapshot path: %s", logical)
		}
		raw, err := root.ReadFile(f.Path)
		if err != nil {
			return nil, err
		}
		if fmt.Sprintf("%x", sha256.Sum256(raw)) != f.SHA256 {
			return nil, fmt.Errorf("SNAPSHOT_MISMATCH: source changed: %s", f.Path)
		}
		files = append(files, objstore.LintFile{Filename: "/" + logical, Raw: nodeutf8.Decode(string(raw))})
	}
	return files, nil
}
func hasParent(s string) bool {
	for _, p := range strings.Split(s, "/") {
		if p == ".." {
			return true
		}
	}
	return false
}
func (c *Compiler) checkObject(ctx context.Context, in storecheck.Input) (rows []storecheck.Issue, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer c.trapped(&err)
	if err = c.ready(ctx, in); err != nil {
		return nil, err
	}
	if _, err = c.syncSaved(); err != nil {
		return nil, err
	}
	if _, err = snapshot(ctx, in); err != nil {
		return nil, err
	}
	target := ""
	if in.Source != nil {
		target, err = c.currentTarget(in)
		if err != nil {
			return nil, err
		}
	}
	issues, err := c.withSource(target, in.Source, func() []Issue {
		issues, found := c.Engine.CheckObject(registryType(in.Type), in.Name)
		if !found {
			return []Issue{{Message: in.Type + " " + in.Name + " is not in the registry", Row: 1, Column: 1}}
		}
		if in.Type == "DDLS" {
			if c.Engine.DDLS == nil {
				panic("native CDS extraction adapter is not linked; rebuild lint library")
			}
			issues = append(c.Engine.DDLS(in.Name), issues...)
		}
		return issues
	})
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = c.unchanged(); err != nil {
		return nil, err
	}
	if _, err = snapshot(ctx, in); err != nil {
		return nil, err
	}
	rows = MapIssues(in, issues)
	// Saved registryIssues maps every abaplint severity to E, and has no URI.
	// CDS generator additions retain their explicit E/W severities.
	for i := range rows {
		rows[i].URI = ""
		if issues[i].Severity == "W" && issues[i].Key == "cds" {
			rows[i].Severity = "W"
		}
	}
	seen := map[string]bool{}
	unique := rows[:0]
	for _, r := range rows {
		key := string(mustJSON(r)) + r.Severity
		if !seen[key] {
			unique = append(unique, r)
			seen[key] = true
		}
	}
	return unique, nil
}
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
func (c *Compiler) outline(ctx context.Context, in storecheck.Input) (doc json.RawMessage, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer c.trapped(&err)
	if err = c.ready(ctx, in); err != nil {
		return nil, err
	}
	if in.Version != "active" && in.Version != "inactive" {
		return nil, fmt.Errorf("outline version %s is not supported", in.Version)
	}
	if _, err = c.syncSaved(); err != nil {
		return nil, err
	}
	files, err := snapshot(ctx, in)
	if err != nil {
		return nil, err
	}
	// All ABAP object types share ExpandMacros, which can follow INCLUDE into
	// other objects (also in class-pool macros and interfaces). Matching own
	// bytes cannot prove the saved registry equivalent to this isolated snapshot.
	trees, treeErr := c.snapshotTree(files, in)
	if treeErr != nil {
		return nil, treeErr
	}
	doc = adtoutline.Document(in.Type, in.Name, in.Version, trees)
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = c.unchanged(); err != nil {
		return nil, err
	}
	if _, err = snapshot(ctx, in); err != nil {
		return nil, err
	}
	return doc, nil
}

// A snapshot checker is disposable: a parse trap must not poison saved state.
func (c *Compiler) snapshotTree(files []objstore.LintFile, in storecheck.Input) (trees []adtoutline.FileTree, err error) {
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("%s lint engine outline failed: %v", c.label(), value)
		}
	}()
	trees, _ = c.Engine.SnapshotTree(files, c.config, registryType(in.Type), in.Name)
	return trees, nil
}
