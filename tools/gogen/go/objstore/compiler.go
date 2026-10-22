package objstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"osg/gogen/storecheck"
)

// Keep the host API stable; orchestration and neutral contracts live in storecheck.
type Compiler = storecheck.Compiler
type CompilerInput = storecheck.Input

var ErrCompilerAbsent = storecheck.ErrCompilerAbsent
var compilerState struct {
	provider   Compiler
	generation string
}

func SetCompiler(provider Compiler, generation string) {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	storeState.revision++
	compilerState.provider, compilerState.generation = provider, generation
}

func compilerInput(ix *storeIndex, typ, name, version string) (CompilerInput, error) {
	in := CompilerInput{Root: storeState.root, Generation: compilerState.generation, Type: typ, Name: name, Version: version, Files: []string{}, Expected: map[string]string{}, Logical: []string{}}
	e := ix.find(typ, name)
	if e == nil {
		return in, storeNotFound(typ, name)
	}
	in.Name = e.Name
	in.Target = e.File
	for _, file := range storeFilesOf(e) {
		if version == "active" {
			if _, proven := storeActiveBytes(file); proven {
				in.Files = append(in.Files, storeState.cfg.Active[file])
				in.Expected[storeState.cfg.Active[file]] = storeState.cfg.Built[file]
				in.Logical = append(in.Logical, file)
			}
		} else if bytes, err := os.ReadFile(filepath.Join(storeState.root, file)); err == nil {
			in.Files = append(in.Files, file)
			in.Expected[file] = storeDigestBytes(bytes)
			in.Logical = append(in.Logical, file)
		} else if !os.IsNotExist(err) {
			return in, err
		}
	}
	return in, nil
}

// captureCompiler is called only under the store mutex. No callback runs here.
func captureCompiler(ix *storeIndex, command, typ, name, include string, source *string, filter, raw string) storecheck.Request {
	req := storecheck.Request{Command: command, Type: typ, Name: name, Filter: filter}
	version := "inactive"
	if command == "PARSE" {
		var parsed struct{ Kind, Type, Name, Version string }
		req.InputError = json.Unmarshal([]byte(raw), &parsed)
		req.ParseKind = parsed.Kind
		typ, name = strings.ToUpper(parsed.Type), strings.ToUpper(parsed.Name)
		if parsed.Version != "" {
			version = parsed.Version
		}
	}
	req.SourceType, req.Known = storeTypeSource(typ)
	entry := ix.find(typ, name)
	req.Exists = entry != nil
	if entry != nil && !req.SourceType {
		_, req.ReadError = os.ReadFile(filepath.Join(storeState.root, entry.File))
	}
	if req.InputError == nil && (req.Exists || command != "PARSE") {
		req.Input, req.InputError = compilerInput(ix, typ, name, version)
	} else {
		req.Input.Version = version
	}
	capable, nativeSource := compilerState.provider.(interface{ SupportsCheckSource() bool })
	checkSource := command == "CHECK" && source != nil && req.SourceType && nativeSource && capable.SupportsCheckSource()
	if !req.Exists && (checkSource || storecheck.UsesSource(command, filter, req.SourceType, compilerState.provider)) {
		req.Input = CompilerInput{Root: storeState.root, Generation: compilerState.generation, Type: typ, Name: name, Version: version}
		req.InputError = nil
		for _, root := range storeState.cfg.Roots {
			if root.Writable {
				ext := map[string]string{"CLAS": ".clas.abap", "INTF": ".intf.abap", "PROG": ".prog.abap", "INCL": ".prog.abap", "DDLS": ".ddls.asddls", "SRVD": ".srvd.srvdsrv"}[typ]
				req.Input.Target = filepath.ToSlash(filepath.Join(root.Path, "osd", strings.ReplaceAll(strings.ToLower(name), "/", "#")+ext))
				break
			}
		}
	}
	req.Input.Include = include
	if source != nil && command != "PARSE" {
		value := *source
		req.Input.Source = &value
	}
	if command == "CHECK" {
		fallback := storeEmpty()
		req.FallbackError = storeNoCompiler(ix, &fallback, command, typ, name)
		req.Fallback = storecheck.Result{Scalars: fallback.Scalars, Issues: fallback.Issues}
	}
	return req
}

// runCompiler releases the mutex during all compiler calls, then rejects results
// if the store tree, provider/generation or saved files changed concurrently.
func runCompiler(ix *storeIndex, a *Answer, command, typ, name, include string, source *string, filter, raw string) error {
	req := captureCompiler(ix, command, typ, name, include, source, filter, raw)
	provider, generation, revision := compilerState.provider, compilerState.generation, storeState.revision
	// The publisher changes build/live outside our mutex. Retain the link
	// identity too, so switching away and back cannot reuse an old verdict.
	live := filepath.Join(storeState.root, "build", "live")
	liveInfo, liveErr := os.Lstat(live)
	liveTarget, _ := os.Readlink(live)
	storeState.mu.Unlock()
	result, err := storecheck.Run(provider, req)
	storeState.mu.Lock()
	stale := revision != storeState.revision
	currentInfo, currentErr := os.Lstat(live)
	currentTarget, _ := os.Readlink(live)
	if liveErr == nil {
		capable, abapEngine := provider.(storecheck.SourceCompiler)
		selectedABAP := command == "CHECKRUN" && abapEngine && capable.SupportsSource()
		native, nativeCompiler := provider.(interface{ NativeCheckOutline() bool })
		selectedNative := (command == "CHECK" || command == "PARSE") && nativeCompiler && native.NativeCheckOutline()
		stale = stale || currentErr != nil || !os.SameFile(liveInfo, currentInfo) || liveTarget != currentTarget || (req.SourceType && provider != nil && !selectedABAP && !selectedNative && filepath.Base(liveTarget) != generation)
	} else if !os.IsNotExist(liveErr) || !os.IsNotExist(currentErr) {
		stale = true
	}
	for file, hash := range req.Input.Expected {
		bytes, readErr := os.ReadFile(filepath.Join(req.Input.Root, file))
		if readErr != nil || storeDigestBytes(bytes) != hash {
			stale = true
		}
	}
	if stale {
		reason := "STALE_RESULT: store state or active generation changed during compiler request; retry"
		if command == "CHECKRUN" {
			result, err = storecheck.NotProcessed(reason), nil
		} else {
			result = storecheck.Result{Scalars: map[string]string{"EV_JSON": storeJSONRefusal(reason, "STALE_RESULT")}}
			err = storeRefusal(reason)
		}
	}
	for key, value := range result.Scalars {
		a.Scalars[key] = value
	}
	a.Issues = append(a.Issues, result.Issues...)
	return err
}
