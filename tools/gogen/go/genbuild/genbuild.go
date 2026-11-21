// Package genbuild is the builder seam of the generation swap (ADR 0010
// slice 4): what turns the tree into a new osgo executable, behind a typed
// interface, so the gateway does not care whether that is `node
// tools/gogen/osgo.mjs` today or gogen-in-Go later. It holds three things:
//
//   - Builder: Build(ctx, Request) -> Result{Binary}. Command is the one
//     implementation: a command run in the tree, and the path it writes.
//   - Queue: one build at a time, requests debounced (500 ms) and coalesced:
//     a request while a build waits joins it; a request while one runs
//     queues the next, and further requests join that one.
//   - Stash: the executable copied to <dir>/<sha16>/<name>, written beside
//     and renamed into place, so a half-written file is never started and the
//     next build overwriting the builder's own output cannot change the code
//     a running generation restarts with.
//
// No import of osg/gogen/abap, of generated code or of tools/osd-*.
package genbuild

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Request says what to build from: the tree, and the published snapshots
// (objstore's build/osgo-published under it) that activation wrote.
// Command builds the tree as it is on disk: a sidecar asks for a build only
// when no object of the tree is inactive (cmd/osgo -gateway-builds), so the
// working file of every published object holds the published bytes, and the
// tree read whole is the snapshot laid over the tree.
type Request struct {
	Root      string
	Published string
	Objects   []string // what the activations asked for, for the log
}

// Result is what a build made. Binary may be overwritten by the next build:
// Stash it before starting it.
type Result struct {
	Binary   string
	Duration time.Duration
	Output   string // the tail of what the builder printed
}

// Builder makes an executable from a Request.
type Builder interface {
	Build(ctx context.Context, r Request) (Result, error)
}

// Command runs Argv in the request's Root and answers Output (relative to
// Root unless absolute) when it exits 0. Env is added to the process's own.
type Command struct {
	Argv   []string
	Output string
	Env    []string
	Log    io.Writer // the builder's output as it comes (nil: kept only as the tail)
}

const tailBytes = 4 << 10

func (c Command) Build(ctx context.Context, r Request) (Result, error) {
	if len(c.Argv) == 0 {
		return Result{}, errors.New("genbuild: no builder command")
	}
	started := time.Now()
	cmd := exec.CommandContext(ctx, c.Argv[0], c.Argv[1:]...)
	cmd.Dir = r.Root
	cmd.Env = append(os.Environ(), c.Env...)
	tail := &tailWriter{max: tailBytes}
	var out io.Writer = tail
	if c.Log != nil {
		out = io.MultiWriter(tail, c.Log)
	}
	cmd.Stdout, cmd.Stderr = out, out
	ownGroup(cmd)
	err := cmd.Run()
	res := Result{Duration: time.Since(started), Output: tail.String()}
	if err != nil {
		return res, fmt.Errorf("genbuild: %s: %w", strings.Join(c.Argv, " "), err)
	}
	res.Binary = c.Output
	if !filepath.IsAbs(res.Binary) {
		res.Binary = filepath.Join(r.Root, res.Binary)
	}
	if st, err := os.Stat(res.Binary); err != nil || st.IsDir() {
		return res, fmt.Errorf("genbuild: the builder exited 0 but wrote no executable at %s", res.Binary)
	}
	return res, nil
}

type tailWriter struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = append([]byte(nil), t.b[len(t.b)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailWriter) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}

// Digest is the first 16 hex of the file's SHA-256: a generation's
// executable by content.
func Digest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

// Stash copies binary to dir/<digest>/<its name> and answers that path and
// the digest. The copy is written beside and renamed into place; a copy that
// is already there with the same content is kept (same inputs, same name, no
// second copy).
func Stash(binary, dir string) (path, digest string, err error) {
	digest, err = Digest(binary)
	if err != nil {
		return "", "", err
	}
	path = filepath.Join(dir, digest, filepath.Base(binary))
	if have, err := Digest(path); err == nil && have == digest {
		return path, digest, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", "", err
	}
	src, err := os.Open(binary)
	if err != nil {
		return "", "", err
	}
	defer src.Close()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".stash-*")
	if err != nil {
		return "", "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), src); err != nil {
		tmp.Close()
		return "", "", err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return "", "", err
	}
	if err := tmp.Close(); err != nil {
		return "", "", err
	}
	// the builder may have rewritten the file while it was copied
	if got := hex.EncodeToString(h.Sum(nil))[:16]; got != digest {
		return "", "", fmt.Errorf("genbuild: %s changed while it was stashed", binary)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", "", err
	}
	return path, digest, nil
}

// Queue runs one build at a time. Done is called once per build, in the
// queue's goroutine, after the build ended; the next build starts when Done
// has returned, so a swap that Done runs is finished before another build
// begins.
type Queue struct {
	b        Builder
	debounce time.Duration
	done     func(id string, req Request, res Result, err error)

	mu      sync.Mutex
	seq     int
	pending *job // waiting for the quiet period or for the running one
	running *job
	closed  bool
	ctx     context.Context
	cancel  context.CancelFunc
	idle    chan struct{} // closed while nothing is pending or running
}

type job struct {
	id    string
	req   Request
	timer *time.Timer
}

// NewQueue makes a queue; debounce <= 0 is 500 ms.
func NewQueue(b Builder, debounce time.Duration, done func(id string, req Request, res Result, err error)) *Queue {
	if debounce <= 0 {
		debounce = 500 * time.Millisecond
	}
	ctx, cancel := context.WithCancel(context.Background())
	idle := make(chan struct{})
	close(idle)
	return &Queue{b: b, debounce: debounce, done: done, ctx: ctx, cancel: cancel, idle: idle}
}

// Request asks for a build of req and answers the id of the build that will
// cover it ("" once the queue is closed).
func (q *Queue) Request(req Request) string {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ""
	}
	if q.pending == nil {
		q.seq++
		q.pending = &job{id: fmt.Sprintf("b%d", q.seq), req: req}
		if q.running == nil {
			q.idle = make(chan struct{})
		}
	} else {
		q.pending.req = merge(q.pending.req, req)
	}
	if q.running == nil {
		q.arm()
	}
	return q.pending.id
}

// arm (re)starts the quiet period of the pending job; q.mu held
func (q *Queue) arm() {
	p := q.pending
	if p.timer != nil {
		p.timer.Stop()
	}
	p.timer = time.AfterFunc(q.debounce, func() { q.fire(p) })
}

func (q *Queue) fire(p *job) {
	q.mu.Lock()
	if q.pending != p || q.running != nil || q.closed {
		q.mu.Unlock()
		return
	}
	q.pending, q.running = nil, p
	q.mu.Unlock()
	res, err := q.b.Build(q.ctx, p.req)
	if q.done != nil {
		q.done(p.id, p.req, res, err)
	}
	q.mu.Lock()
	q.running = nil
	if q.pending != nil && !q.closed {
		q.arm()
	} else {
		close(q.idle)
	}
	q.mu.Unlock()
}

// Busy says whether a build is waiting or running, and which.
func (q *Queue) Busy() (pending, running string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.pending != nil {
		pending = q.pending.id
	}
	if q.running != nil {
		running = q.running.id
	}
	return
}

// Wait returns when nothing is pending or running (or ctx ends).
func (q *Queue) Wait(ctx context.Context) error {
	q.mu.Lock()
	idle := q.idle
	q.mu.Unlock()
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close drops a pending build and cancels a running one (its Done still runs).
func (q *Queue) Close() {
	q.mu.Lock()
	q.closed = true
	if q.pending != nil {
		if q.pending.timer != nil {
			q.pending.timer.Stop()
		}
		q.pending = nil
		if q.running == nil {
			select {
			case <-q.idle:
			default:
				close(q.idle)
			}
		}
	}
	q.mu.Unlock()
	q.cancel()
}

func merge(a, b Request) Request {
	seen := map[string]bool{}
	var objs []string
	for _, o := range append(append([]string{}, a.Objects...), b.Objects...) {
		if !seen[o] {
			seen[o] = true
			objs = append(objs, o)
		}
	}
	sort.Strings(objs)
	out := b
	out.Objects = objs
	return out
}
