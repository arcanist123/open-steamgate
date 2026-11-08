package serving

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"syscall"
	"testing"
	"time"
)

func newHost(t *testing.T, grace time.Duration) *Host {
	t.Helper()
	return New(Options{Generation: "go:0123456789abcdef", Root: "/tree", Database: ":memory:", Grace: grace,
		Started: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC), Logf: t.Logf})
}

// a handler that blocks until released, so a test has a step in flight
type blocking struct {
	release chan struct{}
	entered chan struct{}
}

func (b *blocking) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	select {
	case b.entered <- struct{}{}:
	default:
	}
	<-b.release
	w.WriteHeader(200)
	_, _ = io.WriteString(w, "done")
}

func fetch(t *testing.T, url string) (*http.Response, map[string]any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var body map[string]any
	if len(raw) > 0 && raw[0] == '{' {
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("not JSON: %s", raw)
		}
	}
	return res, body
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 500; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("waited 5 s for %s", what)
}

func TestHeaderOnEveryAnswer(t *testing.T) {
	h := newHost(t, 0)
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	srv := httptest.NewServer(h.Wrap(mux))
	defer srv.Close()
	for _, p := range []string{"/ok", "/nothing-here"} {
		res, _ := fetch(t, srv.URL+p)
		if got := res.Header.Get("X-OSD-Generation"); got != "go:0123456789abcdef" {
			t.Fatalf("%s: X-OSD-Generation %q", p, got)
		}
	}
	if h.InFlight() != 0 {
		t.Fatalf("in flight after the answers: %d", h.InFlight())
	}
}

func TestServingAnswer(t *testing.T) {
	h := newHost(t, 0)
	notFound := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) })
	srv := httptest.NewServer(h.Wrap(h.Serving(notFound)))
	defer srv.Close()
	res, body := fetch(t, srv.URL+"/osd/serving")
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("status %d, type %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	if body["ready"] != true || body["generation"] != "go:0123456789abcdef" || body["root"] != "/tree" || body["database"] != ":memory:" {
		t.Fatalf("body %v", body)
	}
	if int(body["pid"].(float64)) != os.Getpid() || int(body["launcherPid"].(float64)) != os.Getpid() {
		t.Fatalf("pid %v launcherPid %v", body["pid"], body["launcherPid"])
	}
	if body["since"] != float64(time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC).UnixMilli()) {
		t.Fatalf("since %v (the Node child's epoch milliseconds)", body["since"])
	}
	hot := body["hot"].(map[string]any)
	if hot["swaps"] != float64(0) || hot["unverified"] != false {
		t.Fatalf("hot %v", hot)
	}
	if _, has := body["launcherIdentity"]; has {
		t.Fatalf("launcherIdentity without OSD_LAUNCHER_IDENTITY: %v", body)
	}
	if body["generation"] != res.Header.Get("X-OSD-Generation") {
		t.Fatalf("the body and the header disagree: %v / %s", body["generation"], res.Header.Get("X-OSD-Generation"))
	}
	post, err := http.Post(srv.URL+"/osd/serving", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	post.Body.Close()
	if post.StatusCode != 404 {
		t.Fatalf("POST /osd/serving: %d, express answers 404 to a method the door has no route for", post.StatusCode)
	}
	with := New(Options{Generation: "go:1", LauncherIdentity: "launch-1"})
	rec := httptest.NewRecorder()
	with.Serving(notFound).ServeHTTP(rec, httptest.NewRequest("GET", "/osd/serving", nil))
	var b map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &b)
	if b["launcherIdentity"] != "launch-1" {
		t.Fatalf("launcherIdentity not echoed: %v", b)
	}
}

func TestDrainWaitsForTheStepInFlightAndRefusesNewOnes(t *testing.T) {
	h := newHost(t, 5*time.Second)
	step := &blocking{release: make(chan struct{}), entered: make(chan struct{}, 1)}
	notFound := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) })
	mux := http.NewServeMux()
	mux.Handle("/step", step)
	mux.Handle("/osd/serving", h.Serving(notFound))
	srv := httptest.NewServer(h.Wrap(mux))
	defer srv.Close()

	first := make(chan *http.Response, 1)
	go func() {
		res, err := http.Get(srv.URL + "/step")
		if err == nil {
			first <- res
		} else {
			close(first)
		}
	}()
	<-step.entered
	if h.InFlight() != 1 {
		t.Fatalf("in flight: %d", h.InFlight())
	}

	drained := make(chan bool, 1)
	t0 := time.Now()
	go func() { drained <- h.Drain(context.Background()) }()
	waitUntil(t, "the drain to begin", h.Draining)

	// a newcomer is refused the way the Node facade refuses when nothing serves
	res, body := fetch(t, srv.URL+"/step")
	if res.StatusCode != 503 {
		t.Fatalf("a request during the drain: %d", res.StatusCode)
	}
	if res.Header.Get("X-OSD-Generation") != "go:0123456789abcdef" {
		t.Fatalf("no generation on the refusal")
	}
	if body["error"].(map[string]any)["code"] != "STG/NOT_SERVING" || body["ready"] != false || body["draining"] != true || body["phase"] != "draining" {
		t.Fatalf("refusal body %v", body)
	}
	if _, starting := body["starting"]; starting {
		t.Fatalf("a draining host must not say starting: %v", body)
	}
	serving, sbody := fetch(t, srv.URL+"/osd/serving")
	if serving.StatusCode != 503 || sbody["ready"] != false {
		t.Fatalf("/osd/serving during the drain: %d %v", serving.StatusCode, sbody)
	}
	select {
	case <-drained:
		t.Fatal("the drain returned with a step still in flight")
	case <-time.After(150 * time.Millisecond):
	}

	close(step.release)
	select {
	case clean := <-drained:
		if !clean {
			t.Fatal("the drain gave up although the step finished")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the drain did not return after the step finished")
	}
	if took := time.Since(t0); took > 2*time.Second {
		t.Fatalf("the drain took %s for one released step", took)
	}
	got := <-first
	if got == nil || got.StatusCode != 200 {
		t.Fatalf("the step in flight was cut: %v", got)
	}
	got.Body.Close()
	if got.Header.Get("X-OSD-Generation") == "" {
		t.Fatal("the step's answer lost its generation")
	}
}

func TestDrainIsBoundedByTheGrace(t *testing.T) {
	h := newHost(t, 0)
	step := &blocking{release: make(chan struct{}), entered: make(chan struct{}, 1)}
	srv := httptest.NewServer(h.Wrap(step))
	defer srv.Close()
	defer close(step.release)
	go func() {
		res, err := http.Get(srv.URL + "/hang")
		if err == nil {
			res.Body.Close()
		}
	}()
	<-step.entered
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	t0 := time.Now()
	if h.Drain(ctx) {
		t.Fatal("a hung step was reported drained")
	}
	if took := time.Since(t0); took > time.Second {
		t.Fatalf("the drain outlived its context: %s", took)
	}
	if h.InFlight() != 1 {
		t.Fatalf("the hung step is still in flight, count %d", h.InFlight())
	}
}

func TestUpgradesAreNotCounted(t *testing.T) {
	h := newHost(t, 0)
	var seen int
	srv := httptest.NewServer(h.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = h.InFlight()
		w.WriteHeader(200)
	})))
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/channel", nil)
	req.Header.Set("Upgrade", "websocket")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if seen != 0 {
		t.Fatalf("an upgrade counted as a step in flight: %d", seen)
	}
}

func TestQuiesceRunsFinalUnderTheLock(t *testing.T) {
	var lock sync.Mutex
	ran := false
	ok := Quiesce(context.Background(), &lock, func() {
		if lock.TryLock() {
			t.Fatal("final ran without the lock")
		}
		ran = true
	})
	if !ok || !ran {
		t.Fatalf("quiesce %v, final %v", ok, ran)
	}
	if !lock.TryLock() {
		t.Fatal("the lock was not given back")
	}
	lock.Unlock()

	// a step that hangs holds the work process: the quiesce gives up at the deadline
	lock.Lock()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	t0 := time.Now()
	if Quiesce(ctx, &lock, func() { t.Fatal("final ran under a lock somebody else holds") }) {
		t.Fatal("quiesce claimed the lock it never got")
	}
	if time.Since(t0) > time.Second {
		t.Fatal("quiesce outlived its context")
	}
	lock.Unlock()
}

// the whole stop, with the signal and the exit faked: the order is drain,
// listeners, database under the lock, exit 0 -- and a second signal is exit 1
func TestOnSignalStopsInOrder(t *testing.T) {
	h := newHost(t, 5*time.Second)
	step := &blocking{release: make(chan struct{}), entered: make(chan struct{}, 1)}
	srv := httptest.NewServer(h.Wrap(step))
	defer srv.Close()
	go func() {
		res, err := http.Get(srv.URL + "/step")
		if err == nil {
			res.Body.Close()
		}
	}()
	<-step.entered

	var order []string
	var mu sync.Mutex
	note := func(s string) { mu.Lock(); order = append(order, s); mu.Unlock() }
	var lock sync.Mutex
	exit := make(chan int, 1)
	signals := make(chan os.Signal, 1)
	go h.OnSignal(signals, Stop{
		Shutdown: func(ctx context.Context) error { note("shutdown"); return srv.Config.Shutdown(ctx) },
		Lock:     &lock,
		Final:    func() { note("final") },
		Exit:     func(code int) { note("exit"); exit <- code },
	})
	signals <- syscall.SIGTERM
	waitUntil(t, "the drain", h.Draining)
	select {
	case <-exit:
		t.Fatal("exited with the step in flight")
	case <-time.After(100 * time.Millisecond):
	}
	close(step.release)
	select {
	case code := <-exit:
		if code != 0 {
			t.Fatalf("exit %d after a clean drain", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no exit after the step finished")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 3 || order[0] != "shutdown" || order[1] != "final" || order[2] != "exit" {
		t.Fatalf("order %v", order)
	}
}

func TestSecondSignalLeavesAtOnce(t *testing.T) {
	h := newHost(t, 5*time.Second)
	step := &blocking{release: make(chan struct{}), entered: make(chan struct{}, 1)}
	srv := httptest.NewServer(h.Wrap(step))
	defer srv.Close()
	defer close(step.release)
	go func() {
		res, err := http.Get(srv.URL + "/step")
		if err == nil {
			res.Body.Close()
		}
	}()
	<-step.entered
	exit := make(chan int, 2)
	signals := make(chan os.Signal, 2)
	go h.OnSignal(signals, Stop{Exit: func(code int) { exit <- code }})
	signals <- os.Interrupt
	waitUntil(t, "the drain", h.Draining)
	signals <- os.Interrupt
	select {
	case code := <-exit:
		if code != 1 {
			t.Fatalf("a second signal exits 1, got %d", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the second signal did not end the process")
	}
}

// the grace wins over a step that never finishes: exit 0 all the same, as
// the Node child leaves (tools/osd-serve.mjs quiesce: "leaving anyway")
func TestGraceExpiryStillExitsZero(t *testing.T) {
	h := newHost(t, 100*time.Millisecond)
	step := &blocking{release: make(chan struct{}), entered: make(chan struct{}, 1)}
	srv := httptest.NewServer(h.Wrap(step))
	defer srv.Close()
	defer close(step.release)
	go func() {
		res, err := http.Get(srv.URL + "/step")
		if err == nil {
			res.Body.Close()
		}
	}()
	<-step.entered
	exit := make(chan int, 1)
	signals := make(chan os.Signal, 1)
	var lock sync.Mutex
	lock.Lock() // the hung step holds the work process too
	defer lock.Unlock()
	finalRan := false
	go h.OnSignal(signals, Stop{Lock: &lock, Final: func() { finalRan = true }, Exit: func(code int) { exit <- code }})
	t0 := time.Now()
	signals <- syscall.SIGTERM
	select {
	case code := <-exit:
		if code != 0 {
			t.Fatalf("exit %d when the grace won", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the grace did not end the stop")
	}
	if took := time.Since(t0); took > time.Second {
		t.Fatalf("the stop took %s against a grace of 100 ms", took)
	}
	if finalRan {
		t.Fatal("the database was closed under a lock a step still holds")
	}
}

// the cancellation must not be lost between the waiter's check and its
// Wait (critic of #874): the context ends exactly there, and the wake-up
// is given time to fire before the waiter sleeps. Without the mutex around
// the broadcast the waiter never wakes, since a hung step sends no other.
func TestDrainCancellationBetweenCheckAndWaitIsNotLost(t *testing.T) {
	h := newHost(t, 0)
	if !h.admit(true) {
		t.Fatal("admit")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	beforeWait = func() {
		beforeWait = nil
		cancel()
		time.Sleep(50 * time.Millisecond)
	}
	defer func() { beforeWait = nil }()
	finished := make(chan bool, 1)
	go func() { finished <- h.Drain(ctx) }()
	select {
	case clean := <-finished:
		if clean {
			t.Fatal("a hung step was reported drained")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the drain lost the cancellation between its check and its wait")
	}
}

// a database close that never returns does not hold the process past the
// grace: exit 0, "database closed false", the lock still held by the close
func TestStuckFinalIsBoundedByTheGrace(t *testing.T) {
	h := newHost(t, 120*time.Millisecond)
	var lock sync.Mutex
	never := make(chan struct{})
	defer close(never)
	exit := make(chan int, 1)
	signals := make(chan os.Signal, 1)
	go h.OnSignal(signals, Stop{Lock: &lock, Final: func() { <-never }, Exit: func(code int) { exit <- code }})
	t0 := time.Now()
	signals <- syscall.SIGTERM
	select {
	case code := <-exit:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a stuck close held the stop past the grace")
	}
	if took := time.Since(t0); took > time.Second {
		t.Fatalf("the stop took %s against a grace of 120 ms", took)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if Quiesce(ctx, &lock, nil) {
		t.Fatal("the stuck close gave the lock back")
	}
}

func TestQuiesceWithoutALock(t *testing.T) {
	ran := false
	if !Quiesce(context.Background(), lockOrNone(nil), func() { ran = true }) || !ran {
		t.Fatal("a host without a work process still runs final")
	}
}
