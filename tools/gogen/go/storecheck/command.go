// Package storecheck runs compiler commands over immutable, host-resolved facts.
package storecheck

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Issue retains the RFC table shape; report-only fields never enter that table.
type Issue struct {
	OBJ_TYPE, OBJ_NAME string
	FILE               string
	LINE, COL          int32
	RULE, MESSAGE      string
	Severity           string `json:"-"`
	URI                string `json:"-"`
}
type Compiler interface {
	Available(context.Context) error
	Check(context.Context, Input) ([]Issue, error)
	Outline(context.Context, Input) (json.RawMessage, error)
}
type Input struct {
	Root, Generation, Type, Name, Version string
	Files                                 []string
	Expected                              map[string]string
	Logical                               []string
	Source                                *string
	CheckRun                              bool
	Include, Target                       string
}

// CheckMode selects ordinary saved syntax checking or the ADT report contract.
func (in Input) CheckMode() string {
	if in.CheckRun {
		return "checkrun"
	}
	return "saved"
}

var ErrCompilerAbsent = errors.New("compiler absent")

// Request owns all its values. Resolution and file reads happen before Run.
type Request struct {
	Command, Type, Name, Filter, ParseKind string
	Known, SourceType, Exists              bool
	Input                                  Input
	InputError, ReadError                  error
	Fallback                               Result
	FallbackError                          error
}
type Result struct {
	Scalars map[string]string
	Issues  []Issue
}

func encode(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(out.String(), "\n")
}
func refusal(r *Result, err error) error {
	r.Scalars["EV_JSON"] = encode(map[string]any{"error": map[string]string{"code": "NOT_SUPPORTED", "message": err.Error()}})
	return err
}

type ReportIssue struct {
	Severity string `json:"severity"`
	Line     int32  `json:"line"`
	Column   int32  `json:"column"`
	Message  string `json:"message"`
	URI      string `json:"uri,omitempty"`
}
type Report struct {
	Status     string        `json:"status"`
	Issues     []ReportIssue `json:"issues"`
	StatusText string        `json:"statusText,omitempty"`
}

func NotProcessed(reason string) Result {
	return Result{Scalars: map[string]string{"EV_JSON": encode(Report{"notProcessed", []ReportIssue{}, reason})}}
}
func Processed(issues []Issue) Result { return processed(issues, "") }
func processed(issues []Issue, statusText string) Result {
	rows := make([]ReportIssue, 0, len(issues))
	for _, issue := range issues {
		rows = append(rows, ReportIssue{issue.Severity, issue.LINE, issue.COL, issue.MESSAGE, issue.URI})
	}
	return Result{Scalars: map[string]string{"EV_JSON": encode(Report{"processed", rows, statusText})}}
}

// SourceCompiler is implemented only by the opt-in ABAP engine. The ordinary
// Node snapshot adapter retains its saved-draft contract.
type SourceCompiler interface{ SupportsSource() bool }
type ReportCompiler interface {
	CheckRun(context.Context, Input) ([]Issue, string, error)
}

// Run never consults store state and never owns the provider's lifecycle.
func Run(provider Compiler, req Request) (Result, error) {
	sourceCompiler, ok := provider.(SourceCompiler)
	overlay := req.Command == "CHECKRUN" && req.Filter == "SOURCE" && req.SourceType && ok && sourceCompiler.SupportsSource()
	r := Result{Scalars: map[string]string{}, Issues: []Issue{}}
	if req.Command == "CHECKRUN" {
		if !req.Known {
			return NotProcessed("object type " + req.Type + " is not supported"), nil
		}
		if !req.Exists && !overlay {
			return NotProcessed(req.Type + " " + req.Name + " does not exist"), nil
		}
		if !req.SourceType {
			if req.ReadError != nil {
				return NotProcessed(req.ReadError.Error()), nil
			}
			r.Scalars["EV_JSON"] = encode(Report{"processed", []ReportIssue{}, "no dictionary check here; the object is present and readable"})
			return r, nil
		}
	}
	if req.Command == "CHECKRUN" && req.Filter == "SOURCE" && !overlay {
		return NotProcessed("CHECKRUN with IV_FILTER=SOURCE requires a saved draft; write the draft first"), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var err error
	if provider == nil {
		err = ErrCompilerAbsent
	} else {
		err = provider.Available(ctx)
	}
	if err != nil {
		if req.Command == "CHECKRUN" {
			if errors.Is(err, ErrCompilerAbsent) {
				err = errors.New("CHECKRUN needs the compiler sidecar; none is available")
			}
			return NotProcessed(err.Error()), nil
		}
		if errors.Is(err, ErrCompilerAbsent) {
			if req.Command == "CHECK" {
				return req.Fallback, req.FallbackError
			}
			err = fmt.Errorf("unknown store command PARSE")
		}
		return r, refusal(&r, err)
	}
	if req.InputError != nil {
		if req.Command == "CHECKRUN" {
			return NotProcessed(req.InputError.Error()), nil
		}
		return r, req.InputError
	}
	if req.Command == "PARSE" {
		if req.ParseKind != "OUTLINE" {
			return r, refusal(&r, fmt.Errorf("parse kind %s is not supported", req.ParseKind))
		}
		if req.Input.Version != "active" && req.Input.Version != "inactive" {
			return r, refusal(&r, fmt.Errorf("outline version %s is not supported", req.Input.Version))
		}
		if !req.Exists {
			r.Scalars["EV_JSON"] = `{"found":false}`
			return r, nil
		}
		value, err := provider.Outline(ctx, req.Input)
		if errors.Is(err, ErrCompilerAbsent) {
			err = fmt.Errorf("unknown store command PARSE")
		}
		if err != nil {
			return r, refusal(&r, err)
		}
		r.Scalars["EV_JSON"] = string(value)
		return r, nil
	}
	input := req.Input
	input.CheckRun = req.Command == "CHECKRUN"
	// Saved CHECKRUN ignores a buffer unless the selected engine accepts SOURCE.
	if overlay && input.Source == nil {
		empty := ""
		input.Source = &empty
	}
	if input.CheckRun && !overlay {
		input.Source = nil
	}
	var issues []Issue
	var statusText string
	if reporter, ok := provider.(ReportCompiler); ok && input.CheckRun {
		issues, statusText, err = reporter.CheckRun(ctx, input)
	} else {
		issues, err = provider.Check(ctx, input)
	}
	if req.Command == "CHECKRUN" {
		if err != nil {
			if statusText != "" {
				err = fmt.Errorf("%s; %w", statusText, err)
			}
			if errors.Is(err, ErrCompilerAbsent) {
				err = errors.New("CHECKRUN needs the compiler sidecar; none is available")
			}
			return NotProcessed(err.Error()), nil
		}
		return processed(issues, statusText), nil
	}
	if errors.Is(err, ErrCompilerAbsent) {
		return req.Fallback, req.FallbackError
	}
	if err != nil {
		return r, refusal(&r, err)
	}
	r.Issues = append(r.Issues, issues...)
	r.Scalars["EV_COUNT"] = strconv.Itoa(len(r.Issues))
	if len(r.Issues) == 0 {
		r.Scalars["EV_ACTIVE"] = "X"
	}
	r.Scalars["EV_JSON"] = encode(struct {
		Active bool    `json:"active"`
		Live   bool    `json:"live"`
		Note   string  `json:"note"`
		Issues []Issue `json:"issues"`
	}{len(r.Issues) == 0, false, "", r.Issues})
	return r, nil
}
