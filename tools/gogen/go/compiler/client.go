package compiler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type Options struct {
	Root, Version    string
	CheckTimeout     time.Duration
	RestartBackoff   time.Duration
	KillGrace        time.Duration
	ExpectTranspiler string
	MaxResponseBytes int64
}
type Client struct {
	mu        sync.Mutex
	admission chan struct{}
	options   Options
	status    Status
	proc      *proc
	nextID    uint64
	starts    int
	retryAt   time.Time
	closed    bool
	now       func() time.Time
	after     func(time.Duration) <-chan time.Time
}

func New(options Options) *Client {
	if options.CheckTimeout <= 0 {
		options.CheckTimeout = 30 * time.Second
	}
	if options.RestartBackoff <= 0 {
		options.RestartBackoff = 100 * time.Millisecond
	}
	if options.KillGrace <= 0 {
		options.KillGrace = 2 * time.Second
	}
	if options.MaxResponseBytes <= 0 {
		options.MaxResponseBytes = 64 * 1024 * 1024
	}
	if options.Version == "" {
		options.Version = "development"
	}
	return &Client{
		options: options, status: Status{Capabilities: []string{}},
		admission: make(chan struct{}, 1),
		now:       time.Now, after: time.After,
	}
}

func discover(override, executable string) (string, error) {
	paths := []string{}
	if override != "" {
		paths = append(paths, override)
	}
	paths = append(paths, filepath.Join(filepath.Dir(executable), sidecarName()))
	for _, path := range paths {
		// Resolve before exec.Command so even an override without a slash cannot search PATH.
		absolute, err := filepath.Abs(path)
		if err != nil {
			continue
		}
		info, err := os.Stat(absolute)
		if err == nil && !info.IsDir() && executableFile(info) {
			return absolute, nil
		}
	}
	return "", &AbsentError{Paths: paths}
}

// Locate is the discovery a first request makes (OSGO_SIDECAR, then osd
// beside this executable) without starting anything, so a host can say at
// start whether ADT checks will have a compiler. A copied binary without osd
// beside it otherwise fails only later, request by request.
func Locate() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return discover(os.Getenv("OSGO_SIDECAR"), executable)
}

// Describe is the start-up line for Locate's answer.
func Describe(path string, err error) string {
	if err == nil {
		return "compiler     sidecar " + path
	}
	return "compiler     " + err.Error() + ": ADT activation, checkrun, CHECK and outline " +
		"cannot compile; put osd beside this binary or set OSGO_SIDECAR"
}

func (c *Client) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	status := c.status
	status.Capabilities = slices.Clone(status.Capabilities)
	return status
}

// Hello starts lazily and is also used by the status command.
func (c *Client) Hello(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.options.CheckTimeout)
	defer cancel()
	select {
	case c.admission <- struct{}{}:
		defer func() { <-c.admission }()
	case <-ctx.Done():
		return &Refusal{Code: "TIMEOUT", Text: ctx.Err().Error()}
	}
	if err := c.lock(ctx); err != nil {
		return err
	}
	defer c.mu.Unlock()
	return c.ensure(ctx)
}

func (c *Client) Check(ctx context.Context, snapshot Snapshot) (CheckResult, error) {
	var result CheckResult
	err := c.operation(ctx, "check", snapshot, nil, &result)
	return result, err
}

// Outline returns the Node PARSE OUTLINE JSON verbatim after validating the envelope.
func (c *Client) Outline(ctx context.Context, snapshot Snapshot, object Object) (json.RawMessage, error) {
	var result outlineResult
	err := c.operation(ctx, "outline", snapshot, map[string]string{"type": object.Type, "name": object.Name, "version": object.Version}, &result)
	return result.Outline, err
}

func (c *Client) operation(ctx context.Context, op string, snapshot Snapshot, object any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, c.options.CheckTimeout)
	defer cancel()
	select {
	case c.admission <- struct{}{}:
		defer func() { <-c.admission }()
	case <-ctx.Done():
		return &Refusal{Code: "TIMEOUT", Text: ctx.Err().Error()}
	}
	if err := c.lock(ctx); err != nil {
		return err
	}
	defer c.mu.Unlock()
	if err := c.ensure(ctx); err != nil {
		return err
	}
	if !slices.Contains(c.status.Capabilities, op) {
		return c.record(&Refusal{Code: "UNSUPPORTED_OP", Text: op + " not advertised"})
	}
	c.nextID++
	request := map[string]any{"id": c.nextID, "op": op, "snapshot": snapshot}
	if object != nil {
		request["object"] = object
	}
	return c.exchange(ctx, c.nextID, request, result)
}

// A concurrent Close may own mu during bounded cleanup. Admission still honors ctx.
func (c *Client) lock(ctx context.Context) error {
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for !c.mu.TryLock() {
		select {
		case <-ctx.Done():
			return &Refusal{Code: "TIMEOUT", Text: ctx.Err().Error()}
		case <-ticker.C:
		}
	}
	return nil
}

func (c *Client) record(err error) error { c.status.LastError = err.Error(); return err }
func (c *Client) ensure(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return c.record(&Refusal{Code: "TIMEOUT", Text: err.Error()})
	}
	if c.closed {
		return c.record(&Refusal{Code: "INTERNAL", Text: "client closed"})
	}
	if c.proc != nil {
		select {
		case <-c.proc.done:
		case <-c.proc.exited:
		default:
			return nil
		}
		c.stop()
		c.record(&Refusal{Code: "INTERNAL", Text: "idle sidecar exited"})
	}
	if delay := c.retryAt.Sub(c.now()); delay > 0 {
		select {
		case <-c.after(delay):
		case <-ctx.Done():
			return c.record(&Refusal{Code: "TIMEOUT", Text: ctx.Err().Error()})
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return c.record(err)
	}
	path, err := discover(os.Getenv("OSGO_SIDECAR"), executable)
	c.status.Found = err == nil
	c.status.Path = path
	if err != nil {
		return c.record(err)
	}
	cmd := exec.Command(path, "compiler", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return c.record(err)
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		stdin.Close()
		return c.record(err)
	}
	// Tool logs must never be confused with NDJSON responses.
	cmd.Stderr = nil
	cmd.Stdout = stdoutWrite
	lifecycle, err := startProcess(cmd)
	if err != nil {
		stdin.Close()
		stdoutRead.Close()
		stdoutWrite.Close()
		return c.record(&Refusal{Code: "INTERNAL", Text: err.Error()})
	}
	stdoutWrite.Close()
	c.proc = newProc(cmd, lifecycle, stdin, stdoutRead)
	if c.starts > 0 {
		c.status.Restarts++
	}
	c.starts++
	var hello helloReply
	err = c.exchange(ctx, 0, map[string]any{"id": 0, "op": "hello", "contract": Contract, "osgo": c.options.Version, "root": c.options.Root}, &hello)
	if err != nil {
		c.stop()
		return err
	}
	c.status.Contract, c.status.OSD, c.status.Transpiler = hello.Contract, hello.OSD, hello.Transpiler
	c.status.Capabilities, c.status.Limits = hello.Capabilities, hello.Limits
	c.proc.maxLine.Store(c.options.MaxResponseBytes)
	if hello.Contract != Contract {
		c.stop()
		return c.record(&Refusal{Code: "CONTRACT_MISMATCH", Text: fmt.Sprintf("expected %d, got %d", Contract, hello.Contract)})
	}
	if c.options.ExpectTranspiler != "" && hello.Transpiler != c.options.ExpectTranspiler {
		c.stop()
		return c.record(&Refusal{Code: "VERSION_MISMATCH", Text: fmt.Sprintf("expected transpiler %s, got %s", c.options.ExpectTranspiler, hello.Transpiler)})
	}
	return nil
}

type helloReply struct {
	Contract     int      `json:"contract"`
	OSD          string   `json:"osd"`
	Transpiler   string   `json:"transpiler"`
	Capabilities []string `json:"capabilities"`
	Limits       Limits   `json:"limits"`
}

func (hello *helloReply) UnmarshalJSON(raw []byte) error {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	type wireHello helloReply
	var value wireHello
	if err := json.Unmarshal(raw, &value); err != nil {
		return &Refusal{Code: CodeHandshake, Text: err.Error()}
	}
	*hello = helloReply(value)
	missing := func(field string) bool {
		value, ok := fields[field]
		return !ok || string(value) == "null"
	}
	for _, field := range []string{"contract", "osd", "transpiler", "capabilities", "limits"} {
		if missing(field) || (field == "contract" && hello.Contract == 0) || (field == "limits" && (hello.Limits.MaxSnapshotBytes <= 0 || hello.Limits.MaxConcurrentRequests <= 0)) {
			return &Refusal{Code: CodeHandshake, Text: "hello is missing " + field}
		}
	}
	if hello.OSD == "" || hello.Transpiler == "" || hello.Capabilities == nil {
		return &Refusal{Code: CodeHandshake, Text: "hello has an empty required field"}
	}
	return nil
}

func (c *Client) exchange(ctx context.Context, id uint64, request any, target any) error {
	p := c.proc
	fail := func(code, text string) error {
		c.stop()
		return c.record(&Refusal{Code: code, Text: text})
	}
	written := make(chan error, 1)
	go func() { written <- json.NewEncoder(p.stdin).Encode(request) }()
	select {
	case <-ctx.Done():
		return fail("TIMEOUT", ctx.Err().Error())
	case err := <-written:
		if err != nil {
			return fail("INTERNAL", err.Error())
		}
	}
	raw, err := p.answer(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return fail("TIMEOUT", ctx.Err().Error())
		}
		return fail("INTERNAL", err.Error())
	}
	var envelope struct {
		ID    *uint64  `json:"id"`
		Error *Refusal `json:"error"`
	}
	err = json.Unmarshal(raw, &envelope)
	if err != nil || envelope.ID == nil || *envelope.ID != id {
		c.stop()
		return c.record(&Refusal{Code: "INTERNAL", Text: "invalid response id or envelope"})
	}
	if envelope.Error != nil {
		return c.record(envelope.Error)
	}
	if err = json.Unmarshal(raw, target); err != nil {
		var refusal *Refusal
		if errors.As(err, &refusal) {
			c.stop()
			return c.record(refusal)
		}
		c.stop()
		return c.record(&Refusal{Code: "INTERNAL", Text: err.Error()})
	}
	return nil
}

// stop is called with mu held. All waits are bounded; the reader owns no client state.
func (c *Client) stop() {
	p := c.proc
	if p == nil {
		return
	}
	c.proc = nil
	c.retryAt = c.now().Add(c.options.RestartBackoff)
	p.kill()
	go func() {
		defer close(p.dead)
		_ = p.wait()
	}()
	_ = p.stdin.Close()
	_ = p.stdout.Close()
	select {
	case <-p.dead:
	case <-time.After(c.options.KillGrace):
	}
}
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stop()
	c.closed = true
	return nil
}
