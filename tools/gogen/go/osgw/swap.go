package osgw

// The generation swap (ADR 0010 slice 4, "The hot swap of a generation",
// steps 2 to 7). A build is asked for by the answer of an activation that
// published (its X-OSD-Build starts "published; building", which a sidecar
// says only when the gateway builds and no object is inactive); the queue
// (go/genbuild) debounces and runs one build at a time; its executable is
// stashed and started as a candidate, smoked, promoted, and the generation
// that served before drains and retires. Locks need no step: the table is
// the gateway's, an owner is (generation, session, LUW), so a lock held by a
// session pinned to the old generation refuses a conflicting request of the
// new one until it is released.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"osg/gogen/genbuild"
)

// promotePath is the candidate's door the gateway knocks on to promote it
// (cmd/osgo -candidate); a client's request to it is refused at the gateway.
const promotePath = "/osd/promote"

// inactivePath is the door the gateway asks a generation how many objects
// are inactive in its store (cmd/osgo -gateway-builds), for the build-time
// gate below.
const inactivePath = "/osd/inactive"

// gatedBuilder is the builder the queue runs (critic #895 SHOULD 4): a
// build is refused while any generation that still takes requests has an
// inactive object. The activation answer's own gate (cmd/osgo
// -gateway-builds) is a sample from before the debounce, and a save that is
// not activated can land between it and the build; the gateway asks here,
// right before the builder reads the tree, so the tree that is built is the
// tree that was gated. A refused build fails loudly (its why names the
// count, /osd/serving and the next activation say so), and the next
// activation that leaves nothing inactive builds.
type gatedBuilder struct {
	g *Gateway
	genbuild.Builder
}

func (b gatedBuilder) Build(ctx context.Context, r genbuild.Request) (genbuild.Result, error) {
	if n, err := b.g.inactiveObjects(ctx); err != nil {
		return genbuild.Result{}, err
	} else if n > 0 {
		return genbuild.Result{}, fmt.Errorf("%d inactive object(s) would enter the build", n)
	}
	return b.Builder.Build(ctx, r)
}

// inactiveObjects asks every live generation -- the serving one, and any
// still draining, which a pinned session can still write in -- how many
// objects are inactive in its store, and answers the sum. A generation
// that cannot be asked fails the ask: a build must not run on an
// unverified gate.
func (g *Gateway) inactiveObjects(ctx context.Context) (int, error) {
	g.mu.Lock()
	var live []*sidecar
	for _, sc := range g.table {
		if sc.State == "serving" || sc.State == "draining" {
			live = append(live, sc)
		}
	}
	g.mu.Unlock()
	total := 0
	for _, sc := range live {
		client := &http.Client{Transport: sc.transport, Timeout: 5 * time.Second}
		req, err := http.NewRequestWithContext(ctx, "GET", "http://sidecar"+inactivePath, nil)
		if err != nil {
			return 0, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return 0, fmt.Errorf("generation %s: %w", sc.Generation, err)
		}
		var body struct {
			Inactive int `json:"inactive"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil {
			return 0, fmt.Errorf("generation %s: %w", sc.Generation, err)
		}
		total += body.Inactive
	}
	return total, nil
}

// RefusedFile is where a candidate that refuses to serve says why before it
// exits (cmd/osgo -candidate: a schema that differs from the file's).
func RefusedFile(dir string, pid int) string {
	return filepath.Join(dir, fmt.Sprintf("refused-%d.json", pid))
}

// Refusal is the content of RefusedFile.
type Refusal struct {
	Why    string `json:"why"`
	Schema bool   `json:"schema"` // the DDL differs: a swap cannot help, a restart can
}

// BuildState is the build and swap status /osd/serving reports under
// gateway.build, and the X-OSD-Build header it answers with.
type BuildState struct {
	State      string    `json:"state"` // "" (none yet), building, swapping, live, failed, refused
	ID         string    `json:"id,omitempty"`
	Generation string    `json:"generation,omitempty"`
	Why        string    `json:"why,omitempty"`
	At         time.Time `json:"at,omitzero"`
	Swaps      int       `json:"swaps"`
	Seconds    float64   `json:"seconds,omitempty"` // the last build's duration
}

// Header is the X-OSD-Build value of the state ("" when there is none).
func (b BuildState) Header() string {
	switch b.State {
	case "building", "swapping":
		return "building " + b.ID
	case "live":
		return "live " + b.Generation
	case "failed":
		return "build failed " + b.ID + ": " + firstLine(b.Why)
	case "refused":
		return "built; schema differs, restart needed"
	}
	return ""
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// Errors of Swap.
var (
	ErrSchemaDiffers  = errors.New("gateway: built; schema differs, restart needed")
	ErrSameGeneration = errors.New("gateway: the build is the executable that serves")
	ErrNotServing     = errors.New("gateway: no generation serves to swap from")
)

// BuildStatus is the current build and swap status.
func (g *Gateway) BuildStatus() BuildState {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.build
}

func (g *Gateway) setBuild(f func(*BuildState)) {
	g.mu.Lock()
	f(&g.build)
	g.build.At = time.Now()
	g.mu.Unlock()
}

// buildFrom asks for a build when an answer says that an activation
// published and a build should follow, and puts the build's id into it.
func (g *Gateway) buildFrom(resp *http.Response) {
	if g.queue == nil {
		return
	}
	h := resp.Header.Get("X-OSD-Build")
	if !strings.HasPrefix(h, "published; building") {
		return
	}
	last := g.BuildStatus()
	id := g.queue.Request(genbuild.Request{Root: g.o.Root, Published: filepath.Join(g.o.Root, "build", "osgo-published")})
	if id == "" {
		resp.Header.Set("X-OSD-Build", "published; not building: the gateway is stopping")
		return
	}
	value := "published; building " + id
	if last.State == "failed" || last.State == "refused" {
		value += "; last " + last.Header()
	}
	resp.Header.Set("X-OSD-Build", value)
	g.setBuild(func(b *BuildState) {
		if b.State != "swapping" {
			b.State, b.ID, b.Why = "building", id, ""
		}
	})
}

// built is the queue's done: the build's executable is swapped in.
func (g *Gateway) built(id string, req genbuild.Request, res genbuild.Result, err error) {
	if err != nil {
		g.o.Logf("gateway: build %s failed after %s: %v\n%s", id, res.Duration.Round(time.Millisecond), err, res.Output)
		g.setBuild(func(b *BuildState) {
			b.State, b.ID, b.Why, b.Seconds = "failed", id, err.Error(), res.Duration.Seconds()
		})
		return
	}
	g.o.Logf("gateway: build %s made %s in %s", id, res.Binary, res.Duration.Round(time.Millisecond))
	g.setBuild(func(b *BuildState) { b.Seconds = res.Duration.Seconds() })
	g.swap(context.Background(), id, res.Binary)
}

// Swap starts binary as the next generation and, once it passed its smoke
// and its promotion, routes every new session and stateless request to it;
// sessions pinned to the generation that served stay there until they end or
// the grace is up, then it retires. It answers the generation that serves
// afterwards. The old generation keeps serving on any error: a build that
// is the serving executable (ErrSameGeneration), a candidate whose tables
// differ from the file's (ErrSchemaDiffers), one that does not start, fails
// its smoke or its promotion.
func (g *Gateway) Swap(ctx context.Context, binary string) (string, error) {
	return g.swap(ctx, "", binary)
}

func (g *Gateway) swap(ctx context.Context, id, binary string) (string, error) {
	g.swapMu.Lock()
	defer g.swapMu.Unlock()
	fail := func(state string, err error) (string, error) {
		g.o.Logf("gateway: swap %s: %v", id, err)
		g.setBuild(func(b *BuildState) { b.State, b.ID, b.Why = state, id, err.Error() })
		return g.host.Generation(), err
	}
	g.setBuild(func(b *BuildState) { b.State, b.ID, b.Why = "swapping", id, "" })
	path := binary
	if g.o.GenDir != "" {
		var err error
		if path, _, err = genbuild.Stash(binary, g.o.GenDir); err != nil {
			return fail("failed", fmt.Errorf("stash: %w", err))
		}
	}
	g.mu.Lock()
	old, current := g.current, g.binary
	g.mu.Unlock()
	if old == nil {
		return fail("failed", ErrNotServing)
	}
	if same, _ := sameFile(path, current); same {
		g.setBuild(func(b *BuildState) { b.State, b.ID, b.Generation, b.Why = "live", id, old.Generation, "" })
		g.o.Logf("gateway: build %s is the executable that serves (%s): no swap", id, old.Generation)
		return old.Generation, ErrSameGeneration
	}
	// step 3: the candidate, read-only, with its boot writes deferred
	cand, err := g.spawn(path, false, true)
	if err != nil {
		return fail("failed", err)
	}
	if err := g.waitReady(ctx, cand); err != nil {
		if r, ok := readRefusal(g.dir, cand.PID); ok {
			if r.Schema {
				return fail("refused", fmt.Errorf("%w: %s", ErrSchemaDiffers, r.Why))
			}
			return fail("failed", fmt.Errorf("the candidate refused to serve: %s", r.Why))
		}
		return fail("failed", fmt.Errorf("the candidate did not start: %w", err))
	}
	// the smoke: on read transactions only, the candidate's database is
	// query_only until its promotion
	if err := g.smoke(ctx, cand); err != nil {
		g.terminate(cand, 0)
		return fail("failed", fmt.Errorf("the candidate %s failed its smoke: %w", cand.Generation, err))
	}
	// step 4 happened at the candidate's start (it refuses a file whose DDL
	// differs); step 5, promotion: its boot writes, then the routing flip
	if err := g.promote(ctx, cand); err != nil {
		g.terminate(cand, 0)
		return fail("failed", fmt.Errorf("the candidate %s failed its promotion: %w", cand.Generation, err))
	}
	return g.flip(old, cand, path, id)
}

// flip is a swap's routing flip (ADR 0010 slice 4, step 5's end): the old
// generation starts draining, the candidate becomes the serving one, and
// the drain of the old one begins (steps 6 and 7). One mutex hold refuses
// a candidate that died between its promotion and here (kill, OOM): the
// flip would otherwise leave the gateway with no serving generation -- the
// old one draining, the candidate retired, no replacement (watch saw a
// planned exit) -- answering 503 phase starting for ever with Failed never
// closed. Refused, the old generation serves on, as on any failed swap.
func (g *Gateway) flip(old, cand *sidecar, path, id string) (string, error) {
	fail := func(err error) (string, error) {
		g.o.Logf("gateway: swap %s: %v", id, err)
		g.setBuild(func(b *BuildState) { b.State, b.ID, b.Why = "failed", id, err.Error() })
		return g.host.Generation(), err
	}
	g.mu.Lock()
	if g.current != old || g.stopping {
		// the old one crashed meanwhile (a replacement serves) or a stop began
		g.mu.Unlock()
		g.terminate(cand, 0)
		return fail(errors.New("the generation that served changed during the swap"))
	}
	if !g.flipLocked(cand) {
		why := cand.Why
		g.mu.Unlock()
		g.terminate(cand, 0)
		return fail(fmt.Errorf("the candidate %s ended between its promotion and the flip: %s", cand.Generation, why))
	}
	old.State = "draining"
	g.binary = path
	g.mu.Unlock()
	g.served(cand)
	g.setBuild(func(b *BuildState) {
		b.State, b.ID, b.Generation, b.Why = "live", id, cand.Generation, ""
		b.Swaps++
	})
	g.o.Logf("gateway: swap %s: %s serves (sidecar %d, pid %d); %s drains", id, cand.Generation, cand.ID, cand.PID, old.Generation)
	// steps 6 and 7: the old one drains, then retires
	go g.drain(old)
	return cand.Generation, nil
}

func sameFile(a, b string) (bool, error) {
	if a == b {
		return true, nil
	}
	da, err := genbuild.Digest(a)
	if err != nil {
		return false, err
	}
	db, err := genbuild.Digest(b)
	return err == nil && da == db, err
}

func readRefusal(dir string, pid int) (Refusal, bool) {
	f := RefusedFile(dir, pid)
	raw, err := os.ReadFile(f)
	if err != nil {
		return Refusal{}, false
	}
	_ = os.Remove(f)
	var r Refusal
	if json.Unmarshal(raw, &r) != nil {
		r.Why = strings.TrimSpace(string(raw))
	}
	return r, true
}

// smoke asks the candidate for each smoke path and wants a 2xx for each
func (g *Gateway) smoke(ctx context.Context, sc *sidecar) error {
	paths := g.o.Smoke
	if len(paths) == 0 {
		paths = []string{"/health"}
	}
	client := &http.Client{Transport: sc.transport, Timeout: g.o.StartTimeout}
	for _, p := range paths {
		req, _ := http.NewRequestWithContext(ctx, "GET", "http://sidecar"+p, nil)
		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("GET %s: %w", p, err)
		}
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return fmt.Errorf("GET %s: %s", p, resp.Status)
		}
	}
	return nil
}

// promote asks the candidate to open the database for writing and do its
// boot writes; it answers 200 when it may serve
func (g *Gateway) promote(ctx context.Context, sc *sidecar) error {
	client := &http.Client{Transport: sc.transport, Timeout: g.o.StartTimeout}
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://sidecar"+promotePath, nil)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		var b strings.Builder
		_, _ = fmt.Fprint(&b, resp.Status)
		buf := make([]byte, 512)
		if n, _ := resp.Body.Read(buf); n > 0 {
			b.WriteString(": " + strings.TrimSpace(string(buf[:n])))
		}
		return errors.New(b.String())
	}
	return nil
}

// drain waits until the old generation has no step in flight and no session
// pinned to it, or until the grace is up; then it is asked to stop (its own
// drain), or killed when the grace ran out. Its lock connection closes with
// it, and the lock server releases its sessions' dialog locks then.
func (g *Gateway) drain(old *sidecar) {
	deadline := time.Now().Add(g.o.Grace)
	for {
		g.mu.Lock()
		pinned := 0
		for _, p := range g.pins {
			if p == old {
				pinned++
			}
		}
		g.mu.Unlock()
		if old.steps.Load() == 0 && pinned == 0 {
			g.o.Logf("gateway: sidecar %d (pid %d, %s) drained", old.ID, old.PID, old.Generation)
			g.terminate(old, g.o.Grace)
			return
		}
		if time.Now().After(deadline) {
			g.o.Logf("gateway: sidecar %d (pid %d, %s) still has %d step(s) and %d pinned session(s) after %s: killed",
				old.ID, old.PID, old.Generation, old.steps.Load(), pinned, g.o.Grace)
			g.terminate(old, 0)
			return
		}
		select {
		case <-old.exited:
			return // killed or crashed during the drain: nothing to replace
		case <-time.After(50 * time.Millisecond):
		}
	}
}
