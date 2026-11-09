package genbuild

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStash(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "osgo")
	os.WriteFile(bin, []byte("generation one"), 0o755)
	gen := filepath.Join(dir, "gen")
	p1, d1, err := Stash(bin, gen)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(p1) != "osgo" || filepath.Base(filepath.Dir(p1)) != d1 || len(d1) != 16 {
		t.Fatalf("path %s digest %s", p1, d1)
	}
	if st, _ := os.Stat(p1); runtime.GOOS != "windows" && st.Mode().Perm()&0o100 == 0 {
		t.Fatalf("not executable: %v", st.Mode())
	}
	// the builder overwrites its output: the stashed copy stays
	os.WriteFile(bin, []byte("generation two"), 0o755)
	p2, d2, err := Stash(bin, gen)
	if err != nil || d2 == d1 || p2 == p1 {
		t.Fatalf("second: %s %s %v", p2, d2, err)
	}
	if b, _ := os.ReadFile(p1); string(b) != "generation one" {
		t.Fatalf("first copy changed: %q", b)
	}
	if p3, d3, err := Stash(bin, gen); err != nil || p3 != p2 || d3 != d2 {
		t.Fatalf("same content: %s %s %v", p3, d3, err)
	}
	left, _ := filepath.Glob(filepath.Join(gen, "*", ".stash-*"))
	if len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
}

func TestCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	root := t.TempDir()
	ok := Command{Argv: []string{"sh", "-c", "echo building; printf x > out.bin"}, Output: "out.bin"}
	res, err := ok.Build(context.Background(), Request{Root: root})
	if err != nil || res.Binary != filepath.Join(root, "out.bin") || res.Output != "building\n" {
		t.Fatalf("%+v %v", res, err)
	}
	if _, err := (Command{Argv: []string{"sh", "-c", "echo broken; exit 3"}, Output: "out.bin"}).Build(context.Background(), Request{Root: root}); err == nil {
		t.Fatal("exit 3 was a build")
	}
	if _, err := (Command{Argv: []string{"true"}, Output: "none.bin"}).Build(context.Background(), Request{Root: root}); err == nil {
		t.Fatal("no output was a build")
	}
}

type fakeBuilder struct {
	mu      sync.Mutex
	runs    []Request
	running atomic.Int32
	max     atomic.Int32
	block   chan struct{}
	fail    bool
}

func (f *fakeBuilder) Build(ctx context.Context, r Request) (Result, error) {
	n := f.running.Add(1)
	defer f.running.Add(-1)
	if n > f.max.Load() {
		f.max.Store(n)
	}
	f.mu.Lock()
	f.runs = append(f.runs, r)
	f.mu.Unlock()
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}
	if f.fail {
		return Result{}, errors.New("broken")
	}
	return Result{Binary: "/x"}, nil
}

func TestQueueDebouncesAndCoalesces(t *testing.T) {
	f := &fakeBuilder{block: make(chan struct{})}
	var mu sync.Mutex
	var done []string
	q := NewQueue(f, 30*time.Millisecond, func(id string, req Request, res Result, err error) {
		mu.Lock()
		done = append(done, id)
		mu.Unlock()
	})
	defer q.Close()
	// two requests inside the quiet period are one build
	a := q.Request(Request{Root: "/t", Objects: []string{"CLAS A"}})
	b := q.Request(Request{Root: "/t", Objects: []string{"CLAS B"}})
	if a != "b1" || b != "b1" {
		t.Fatalf("ids %s %s", a, b)
	}
	for deadline := time.Now().Add(5 * time.Second); f.running.Load() == 0; {
		if time.Now().After(deadline) {
			t.Fatal("the build did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// while it runs: the next build is queued, and requests join it
	c := q.Request(Request{Root: "/t", Objects: []string{"CLAS C"}})
	d := q.Request(Request{Root: "/t", Objects: []string{"CLAS D"}})
	if c != "b2" || d != "b2" {
		t.Fatalf("ids while running %s %s", c, d)
	}
	if p, r := q.Busy(); p != "b2" || r != "b1" {
		t.Fatalf("busy %s %s", p, r)
	}
	close(f.block)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := q.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.runs) != 2 || f.max.Load() != 1 {
		t.Fatalf("runs %d, at once %d", len(f.runs), f.max.Load())
	}
	if got := f.runs[0].Objects; len(got) != 2 || got[0] != "CLAS A" || got[1] != "CLAS B" {
		t.Fatalf("first build objects %v", got)
	}
	if got := f.runs[1].Objects; len(got) != 2 || got[0] != "CLAS C" {
		t.Fatalf("second build objects %v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(done) != 2 || done[0] != "b1" || done[1] != "b2" {
		t.Fatalf("done %v", done)
	}
}

func TestQueueClose(t *testing.T) {
	f := &fakeBuilder{block: make(chan struct{})}
	errs := make(chan error, 2)
	q := NewQueue(f, time.Millisecond, func(id string, req Request, res Result, err error) { errs <- err })
	q.Request(Request{})
	for f.running.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	q.Request(Request{}) // pending, dropped by Close
	q.Close()
	if err := <-errs; !errors.Is(err, context.Canceled) {
		t.Fatalf("running build: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := q.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if id := q.Request(Request{}); id != "" {
		t.Fatalf("closed queue took %s", id)
	}
	if len(errs) != 0 {
		t.Fatal("the dropped build ran")
	}
}
