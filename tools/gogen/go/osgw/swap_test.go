package osgw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"osg/gogen/enq"
	"osg/gogen/genbuild"
)

// generation writes an executable that is the fake sidecar as another
// generation (other content, so another stash; FAKE_GENERATION = gen) with
// the given environment
func generation(t *testing.T, gen string, env ...string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("a shell wrapper")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "#!/bin/sh\nexport FAKE_GENERATION=%s\n", gen)
	for _, e := range env {
		fmt.Fprintf(&b, "export %s\n", e)
	}
	fmt.Fprintf(&b, "exec %q \"$@\"\n", exe)
	p := filepath.Join(t.TempDir(), "osgo")
	if err := os.WriteFile(p, []byte(b.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func pidOf(t *testing.T, url string, header ...string) int {
	t.Helper()
	_, body := get(t, url+"/echo", header...)
	var e struct{ PID int }
	if err := json.Unmarshal([]byte(body), &e); err != nil {
		t.Fatalf("echo %s", body)
	}
	return e.PID
}

func login(t *testing.T, url string) string {
	t.Helper()
	resp, _ := get(t, url+"/login")
	return strings.SplitN(resp.Header.Get("Set-Cookie"), ";", 2)[0]
}

// X1's shape on fakes: the swap promotes the candidate, the next answer
// carries the new generation, the old one drains and retires, the status
// says live; a crash of the new one restarts the new one, not the old
func TestSwapPromotesAndRetires(t *testing.T) {
	g, front := start(t, Options{GenDir: t.TempDir(), RestartWindow: time.Hour})
	old := g.Table()[0]
	gen, err := g.Swap(context.Background(), generation(t, "go:fakeB"))
	if err != nil || gen != "go:fakeB" {
		t.Fatalf("swap: %s %v", gen, err)
	}
	resp, _ := get(t, front.URL+"/echo")
	if resp.Header.Get("X-OSD-Generation") != "go:fakeB" {
		t.Fatalf("the next answer: %v", resp.Header)
	}
	if _, body := get(t, front.URL+"/promoted"); body != "true" {
		t.Fatalf("the new generation was not promoted: %s", body)
	}
	waitFor(t, "the old generation to retire", func() bool { return g.Table()[0].State == "retired" })
	table := g.Table()
	if len(table) != 2 || table[0].PID != old.PID || table[1].State != "serving" || table[1].Generation != "go:fakeB" {
		t.Fatalf("table %+v", table)
	}
	if !strings.Contains(table[0].Why, "exit") {
		t.Fatalf("the old generation was not stopped by its drain: %+v", table[0])
	}
	resp, body := get(t, front.URL+"/osd/serving")
	if resp.Header.Get("X-OSD-Build") != "live go:fakeB" || !strings.Contains(body, `"swaps":1`) || resp.Header.Get("X-OSD-Generation") != "go:fakeB" {
		t.Fatalf("serving: %v %s", resp.Header, body)
	}
	// a crash after the swap is replaced by the generation that serves
	get(t, front.URL+"/crash")
	waitFor(t, "a replacement", func() bool { n := g.Table(); return len(n) == 3 && n[2].State == "serving" })
	if r := g.Table()[2]; r.Generation != "go:fakeB" {
		t.Fatalf("the replacement runs %s", r.Generation)
	}
}

// a lock held by a session pinned to the old generation refuses the same
// key to the new generation until that session releases it; the session
// keeps going to the old generation, which retires when it logs off
func TestSwapPinnedSessionKeepsItsLock(t *testing.T) {
	g, front := start(t, Options{Grace: 20 * time.Second})
	a := g.Table()[0]
	cookie := login(t, front.URL)
	if _, body := get(t, front.URL+"/lock?k=K", "Cookie", cookie); body != "0 " {
		t.Fatalf("lock in the old generation: %q", body)
	}
	if _, err := g.Swap(context.Background(), generation(t, "go:fakeB")); err != nil {
		t.Fatal(err)
	}
	if p := pidOf(t, front.URL, "Cookie", cookie); p != a.PID {
		t.Fatalf("the pinned session went to %d, not %d", p, a.PID)
	}
	if p := pidOf(t, front.URL); p == a.PID {
		t.Fatal("a stateless request went to the draining generation")
	}
	resp, body := get(t, front.URL+"/lock?k=K")
	if resp.Header.Get("X-OSD-Generation") != "go:fakeB" || strings.HasPrefix(body, "0 ") {
		t.Fatalf("the new generation took a lock the pinned session holds: %q", body)
	}
	rows := g.Locks().Read(enq.Filter{})
	if len(rows) != 1 || rows[0].Generation != fakeGeneration {
		t.Fatalf("rows %+v", rows)
	}
	if st := g.Table()[0].State; st != "draining" {
		t.Fatalf("old generation %s while a session is pinned", st)
	}
	get(t, front.URL+"/unlock?k=K", "Cookie", cookie)
	if _, body := get(t, front.URL+"/lock?k=K"); body != "0 " {
		t.Fatalf("after the release, the new generation: %q", body)
	}
	if rows := g.Locks().Read(enq.Filter{}); len(rows) != 1 || rows[0].Generation != "go:fakeB" {
		t.Fatalf("rows after %+v", rows)
	}
	get(t, front.URL+"/logoff", "Cookie", cookie)
	waitFor(t, "the old generation to retire after the logoff", func() bool { return g.Table()[0].State == "retired" })
}

// the old generation killed during its drain: nothing is restarted, its
// pinned session's locks go, the new generation serves on
func TestSwapOldKilledDuringDrain(t *testing.T) {
	g, front := start(t, Options{Grace: 30 * time.Second, RestartWindow: time.Hour})
	a := g.Table()[0]
	cookie := login(t, front.URL)
	if _, body := get(t, front.URL+"/lock?k=K", "Cookie", cookie); body != "0 " {
		t.Fatalf("lock: %q", body)
	}
	if _, err := g.Swap(context.Background(), generation(t, "go:fakeB")); err != nil {
		t.Fatal(err)
	}
	proc, _ := os.FindProcess(a.PID)
	if err := proc.Kill(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the killed generation to retire", func() bool { return g.Table()[0].State == "retired" })
	waitFor(t, "its locks to go", func() bool { return len(g.Locks().Read(enq.Filter{})) == 0 })
	time.Sleep(100 * time.Millisecond)
	table := g.Table()
	if len(table) != 2 || table[1].State != "serving" {
		t.Fatalf("a replacement was started for a draining generation: %+v", table)
	}
	// the cookie of the dead session falls to the generation that serves
	if resp, body := get(t, front.URL+"/lock?k=K", "Cookie", cookie); resp.Header.Get("X-OSD-Generation") != "go:fakeB" || body != "0 " {
		t.Fatalf("after: %v %q", resp.Header, body)
	}
	select {
	case <-g.Failed():
		t.Fatal("the gateway gave up")
	default:
	}
}

// a candidate whose tables differ from the file's refuses at its start:
// the swap is refused, loudly, and the old generation serves on
func TestSwapRefusedSchema(t *testing.T) {
	g, front := start(t, Options{})
	_, err := g.Swap(context.Background(), generation(t, "go:fakeB", "FAKE_REFUSE_SCHEMA=1"))
	if !errors.Is(err, ErrSchemaDiffers) {
		t.Fatalf("err %v", err)
	}
	resp, _ := get(t, front.URL+"/osd/serving")
	if resp.Header.Get("X-OSD-Build") != "built; schema differs, restart needed" || resp.Header.Get("X-OSD-Generation") != fakeGeneration {
		t.Fatalf("serving: %v", resp.Header)
	}
	if b := g.BuildStatus(); b.State != "refused" || !strings.Contains(b.Why, "tables differ") {
		t.Fatalf("build %+v", b)
	}
	table := g.Table()
	if len(table) != 2 || table[0].State != "serving" || table[1].State != "retired" {
		t.Fatalf("table %+v", table)
	}
	if left, _ := filepath.Glob(filepath.Join(g.Dir(), "refused-*")); len(left) != 0 {
		t.Fatalf("refusal left: %v", left)
	}
}

// a candidate that fails its smoke or its promotion is ended; the old
// generation serves on
func TestSwapFailedCandidate(t *testing.T) {
	g, front := start(t, Options{})
	for _, env := range []string{"FAKE_SMOKE_FAIL=1", "FAKE_PROMOTE_FAIL=1"} {
		_, err := g.Swap(context.Background(), generation(t, "go:fakeB", env))
		if err == nil || errors.Is(err, ErrSchemaDiffers) {
			t.Fatalf("%s: %v", env, err)
		}
		if b := g.BuildStatus(); b.State != "failed" {
			t.Fatalf("%s: %+v", env, b)
		}
		if resp, _ := get(t, front.URL+"/echo"); resp.Header.Get("X-OSD-Generation") != fakeGeneration {
			t.Fatalf("%s: served by %v", env, resp.Header)
		}
	}
	waitFor(t, "the candidates to end", func() bool {
		n := g.Table()
		return len(n) == 3 && n[1].State == "retired" && n[2].State == "retired"
	})
	if g.Table()[0].State != "serving" {
		t.Fatal("the old generation stopped serving")
	}
}

func TestSwapSameExecutable(t *testing.T) {
	g, _ := start(t, Options{GenDir: t.TempDir()})
	exe, _ := os.Executable()
	if _, err := g.Swap(context.Background(), exe); !errors.Is(err, ErrSameGeneration) {
		t.Fatalf("err %v", err)
	}
	if n := len(g.Table()); n != 1 {
		t.Fatalf("a candidate was started: %d", n)
	}
}

// the candidate's promotion door is the gateway's, never a client's
func TestPromoteIsNotAClientDoor(t *testing.T) {
	_, front := start(t, Options{})
	resp, err := http.Post(front.URL+"/osd/promote", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("POST /osd/promote: %d", resp.StatusCode)
	}
}

// critic #895 SHOULD 5: a candidate that dies between its promotion and
// the routing flip (kill, OOM -- a window nanoseconds wide) must fail the
// swap loudly and leave the old generation serving. As it was, the flip
// silently did nothing (serve() only flips a starting/candidate sidecar),
// the old one drained and retired, no replacement came (watch saw a
// planned exit), and the gateway answered 503 phase starting for ever with
// Failed never closed.
func TestSwapCandidateDiedBeforeTheFlip(t *testing.T) {
	g, front := start(t, Options{GenDir: t.TempDir()})
	g.mu.Lock()
	old := g.current
	g.mu.Unlock()
	bin := generation(t, "go:fakeB")
	cand, err := g.spawn(bin, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := g.waitReady(context.Background(), cand); err != nil {
		t.Fatal(err)
	}
	if err := g.smoke(context.Background(), cand); err != nil {
		t.Fatal(err)
	}
	if err := g.promote(context.Background(), cand); err != nil {
		t.Fatal(err)
	}
	// the candidate dies here, in the gap between promote() and the flip
	proc, err := os.FindProcess(cand.PID)
	if err != nil {
		t.Fatal(err)
	}
	if err := proc.Kill(); err != nil {
		t.Fatal(err)
	}
	<-cand.exited // its watch has retired it
	if _, err := g.flip(old, cand, bin, ""); err == nil {
		t.Fatal("the flip took a dead candidate")
	}
	if row := g.Table()[0]; row.PID != old.PID || row.State != "serving" {
		t.Fatalf("the old generation does not serve on: %+v", row)
	}
	if resp, _ := get(t, front.URL+"/echo"); resp.StatusCode != 200 || resp.Header.Get("X-OSD-Generation") != fakeGeneration {
		t.Fatalf("served by %v %d", resp.Header, resp.StatusCode)
	}
	if b := g.BuildStatus(); b.State != "failed" {
		t.Fatalf("build %+v", b)
	}
	select {
	case <-g.Failed():
		t.Fatal("the gateway gave up")
	default:
	}
}

// the same refusal at Start and at a replacement: serve() says so when the
// sidecar died first, so neither leaves a gateway answering 503 for ever
// with no failure signal
func TestServeRefusesASidecarThatDiedFirst(t *testing.T) {
	g, _ := start(t, Options{})
	g.mu.Lock()
	sc := g.current
	sc.State, sc.Why = "retired", "signal: killed" // its watch has been here
	g.current, g.ready = nil, make(chan struct{})
	g.mu.Unlock()
	if g.serve(sc) {
		t.Fatal("serve took a sidecar that had died first")
	}
	if g.current != nil {
		t.Fatal("serve left a serving generation")
	}
}

type fakeBuilder struct {
	binary string
	err    error
}

func (f fakeBuilder) Build(ctx context.Context, r genbuild.Request) (genbuild.Result, error) {
	if f.err != nil {
		return genbuild.Result{Output: "broken"}, f.err
	}
	return genbuild.Result{Binary: f.binary}, nil
}

// an activation that published asks for a build: the answer names it, the
// build is swapped in, and /osd/serving says live; a failed build says so
// on /osd/serving and in the next activation's answer
func TestActivationBuildsAndSwaps(t *testing.T) {
	b := generation(t, "go:fakeB")
	g, front := start(t, Options{Builder: fakeBuilder{binary: b}, Root: t.TempDir(), Debounce: 10 * time.Millisecond})
	resp, _ := get(t, front.URL+"/activate")
	if h := resp.Header.Get("X-OSD-Build"); h != "published; building b1" {
		t.Fatalf("activation: %q", h)
	}
	waitFor(t, "the swap", func() bool { return g.BuildStatus().State == "live" })
	if resp, _ := get(t, front.URL+"/echo"); resp.Header.Get("X-OSD-Generation") != "go:fakeB" {
		t.Fatalf("after the build: %v", resp.Header)
	}
	if resp, _ := get(t, front.URL+"/osd/serving"); resp.Header.Get("X-OSD-Build") != "live go:fakeB" {
		t.Fatalf("serving: %v", resp.Header)
	}

	g2, front2 := start(t, Options{Builder: fakeBuilder{err: errors.New("exit status 1")}, Root: t.TempDir(), Debounce: 10 * time.Millisecond})
	get(t, front2.URL+"/activate")
	waitFor(t, "the failure", func() bool { return g2.BuildStatus().State == "failed" })
	if resp, _ := get(t, front2.URL+"/osd/serving"); resp.Header.Get("X-OSD-Build") != "build failed b1: exit status 1" {
		t.Fatalf("serving after a failure: %v", resp.Header)
	}
	if resp, _ := get(t, front2.URL+"/activate"); resp.Header.Get("X-OSD-Build") != "published; building b2; last build failed b1: exit status 1" {
		t.Fatalf("the next activation: %v", resp.Header)
	}
	// without a builder the sidecar's answer goes through as it is
	_, front3 := start(t, Options{})
	if resp, _ := get(t, front3.URL+"/activate"); resp.Header.Get("X-OSD-Build") != "published; rebuild osgo to run it" {
		t.Fatalf("no builder: %v", resp.Header)
	}
}

// critic #895 SHOULD 4: the inactive-objects gate is checked when the build
// reads the tree, not only when the activation answer is composed. A save
// that is not activated can land in the debounce window between the answer
// and the build; the gateway asks every generation that still takes
// requests right before the builder runs, and the build is refused while
// any of them has an inactive object, or the draft would go live
// unactivated -- and be believed live, its digest the working file's.
func TestBuildRefusedWhileAnObjectIsInactive(t *testing.T) {
	flagFile := filepath.Join(t.TempDir(), "inactive")
	if err := os.WriteFile(flagFile, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	g, front := start(t, Options{Builder: fakeBuilder{binary: generation(t, "go:fakeB")},
		Root: t.TempDir(), Debounce: 10 * time.Millisecond, Env: []string{"FAKE_INACTIVE_FILE=" + flagFile}})
	resp, _ := get(t, front.URL+"/activate") // the answer's own gate saw nothing inactive
	if h := resp.Header.Get("X-OSD-Build"); h != "published; building b1" {
		t.Fatalf("activation: %q", h)
	}
	waitFor(t, "the build to be refused at its start", func() bool {
		b := g.BuildStatus()
		return b.State == "failed" && strings.Contains(b.Why, "1 inactive object")
	})
	if resp, _ := get(t, front.URL+"/echo"); resp.Header.Get("X-OSD-Generation") != fakeGeneration {
		t.Fatalf("served by %v after a refused build", resp.Header)
	}
	// nothing inactive any more: the next activation builds and swaps
	if err := os.WriteFile(flagFile, []byte("0"), 0o644); err != nil {
		t.Fatal(err)
	}
	get(t, front.URL+"/activate")
	waitFor(t, "the swap", func() bool { return g.BuildStatus().State == "live" })
	if resp, _ := get(t, front.URL+"/echo"); resp.Header.Get("X-OSD-Generation") != "go:fakeB" {
		t.Fatalf("after the build: %v", resp.Header)
	}
}
