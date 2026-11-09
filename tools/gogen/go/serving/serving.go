// Package serving is the supervised-host contract of a one-process ABAP
// host, the Go half of what tools/osd-serve.mjs and the facade in front of
// it (tools/osd-runtime.mjs, tools/osd-proxy.mjs, tools/osd-serving-front.mjs)
// answer on Node:
//
//   - GET /osd/serving: which generation this process serves, how a
//     supervisor (the VS Code launcher's waitForServing, vsp, a CI script)
//     knows it is alive and ready; 200 {ready:true, generation, pid, ...}.
//   - X-OSD-Generation on every answer: the generation hash the code was
//     built from, so a client can wait for "the next answer carries the new
//     generation" (test/adt-conformance X1 on Node).
//   - The drain: on SIGTERM, SIGINT or SIGHUP the host stops admitting (a
//     new request is answered 503 STG/NOT_SERVING, the facade's answer when
//     nothing serves), lets the dialog steps in flight finish, closes the
//     listeners, takes the work process once to close the database, and
//     exits 0 -- within the grace (55 s, the Node supervisor's quiesce
//     budget, under the launcher's 60 s SIGKILL). A step that does not
//     finish within the grace is left behind: its LUW rolls back with the
//     connection, and the exit code is still 0, as the Node child's is.
//
// No import of osg/gogen/abap: the work process arrives as a sync.Locker,
// the database as a func, the listeners as http.Server.Shutdown.
package serving

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// DefaultGrace is the Node supervisor's quiesce budget (tools/osd-runtime.mjs),
// chosen under the VS Code launcher's 60 s SIGTERM-to-SIGKILL grace.
const DefaultGrace = 55 * time.Second

// Options describe the process to its supervisor.
type Options struct {
	Generation       string // the build's generation, "go:" + 16 hex (zz_status.go buildGeneration)
	Root             string // the tree served (-root)
	Database         string // the database file, or ":memory:"
	LauncherIdentity string // OSD_LAUNCHER_IDENTITY when a launcher set it, else ""
	Started          time.Time
	Grace            time.Duration // zero: DefaultGrace
	Logf             func(string, ...any)
}

// Host carries the contract for one process.
type Host struct {
	o        Options
	pid      int
	mu       sync.Mutex
	cond     *sync.Cond
	draining bool
	since    time.Time // when the drain began
	inflight int
	stopping sync.Once
	signals  int
}

// New makes the host; Generation is the one thing it cannot do without.
func New(o Options) *Host {
	if o.Grace <= 0 {
		o.Grace = DefaultGrace
	}
	if o.Started.IsZero() {
		o.Started = time.Now()
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	if o.Database == "" {
		o.Database = ":memory:"
	}
	h := &Host{o: o, pid: os.Getpid()}
	h.cond = sync.NewCond(&h.mu)
	return h
}

// Generation is what X-OSD-Generation carries.
func (h *Host) Generation() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.o.Generation
}

// SetGeneration changes what the host says it serves: a gateway in front of
// a sidecar (go/osgw) says the generation of the sidecar that serves.
func (h *Host) SetGeneration(g string) {
	h.mu.Lock()
	h.o.Generation = g
	h.mu.Unlock()
}

// InFlight is the number of admitted requests not yet answered.
func (h *Host) InFlight() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.inflight
}

// Draining says whether the host has stopped admitting.
func (h *Host) Draining() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.draining
}

// admit counts a request in, or refuses it once the drain has begun.
// An upgrade (a push channel's socket) is admitted but not counted: it lives
// as long as the page keeps it, and the drain must not wait for that; its
// steps take the work process, which Quiesce waits for instead.
func (h *Host) admit(counted bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.draining {
		return false
	}
	if counted {
		h.inflight++
	}
	return true
}

func (h *Host) done() {
	h.mu.Lock()
	h.inflight--
	h.mu.Unlock()
	h.cond.Broadcast()
}

func isUpgrade(r *http.Request) bool {
	for _, v := range r.Header.Values("Upgrade") {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), "websocket") {
				return true
			}
		}
	}
	return false
}

// Wrap puts the generation on every answer and gates admission: a request
// that arrives after the drain began is answered Refusal, the one in flight
// is counted until its handler returns.
func (h *Host) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-OSD-Generation", h.Generation())
		counted := !isUpgrade(r)
		if !h.admit(counted) {
			h.refuse(w)
			return
		}
		if counted {
			defer h.done()
		}
		next.ServeHTTP(w, r)
	})
}

// Serving is the GET /osd/serving handler: the Node child's answer
// (tools/osd-serve.mjs hostNodes.serving) with the facade's launcher fields
// (tools/osd-serving-front.mjs), because this process is both. `hot` is
// there for shape: a Go process takes no warm swap, so swaps is 0 and the
// generation never carries the "warm-unverified" suffix. Another method is
// not this door's: notFound answers it, as express does.
func (h *Host) Serving(notFound http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			notFound.ServeHTTP(w, r)
			return
		}
		body := map[string]any{
			"ready":       true,
			"pid":         h.pid,
			"since":       h.o.Started.UnixMilli(), // the Node child's Date.now() at start
			"generation":  h.Generation(),
			"hot":         map[string]any{"swaps": 0, "unverified": false},
			"root":        h.o.Root,
			"database":    h.o.Database,
			"launcherPid": h.pid,
		}
		if h.o.LauncherIdentity != "" {
			body["launcherIdentity"] = h.o.LauncherIdentity
		}
		writeJSON(w, 200, body, r.Method == http.MethodHead)
	}
}

// refuse is the facade's answer when nothing serves (tools/osd-proxy.mjs
// STG/NOT_SERVING), with what a poller wants to know: ready is false and
// the phase is "draining", never "starting", so a launcher does not wait
// for a process that is leaving.
func (h *Host) refuse(w http.ResponseWriter) {
	h.mu.Lock()
	seconds := int(time.Since(h.since).Round(time.Second) / time.Second)
	generation := h.o.Generation
	h.mu.Unlock()
	writeJSON(w, 503, map[string]any{
		"error": map[string]any{"code": "STG/NOT_SERVING",
			"message": map[string]string{"lang": "en", "value": fmt.Sprintf("the system is draining (%d s): stopping", seconds)}},
		"ready": false, "draining": true, "phase": "draining", "seconds": seconds,
		"generation": generation, "pid": h.pid,
	}, false)
}

func writeJSON(w http.ResponseWriter, status int, body any, headOnly bool) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
	text := strings.TrimSuffix(b.String(), "\n")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(text)))
	w.WriteHeader(status)
	if !headOnly {
		_, _ = w.Write([]byte(text))
	}
}

// Drain stops admitting and waits for the requests in flight to be
// answered, or for ctx to end; true when every one finished in time.
func (h *Host) Drain(ctx context.Context) bool {
	h.mu.Lock()
	if !h.draining {
		h.draining = true
		h.since = time.Now()
	}
	h.mu.Unlock()
	// the wake-up takes the mutex first: a waiter is then either before its
	// check of ctx.Err (and sees the end) or inside Wait (and is woken); a
	// broadcast between the two would be lost, and a hung step sends no
	// other (critic of #874)
	stop := context.AfterFunc(ctx, func() {
		h.mu.Lock()
		h.mu.Unlock()
		h.cond.Broadcast()
	})
	defer stop()
	h.mu.Lock()
	defer h.mu.Unlock()
	for h.inflight > 0 && ctx.Err() == nil {
		if beforeWait != nil {
			beforeWait()
		}
		h.cond.Wait()
	}
	return h.inflight == 0
}

// beforeWait is a test's hook into the instant between the waiter's check
// and its Wait -- the window a wake-up could be lost in; nil in production.
var beforeWait func()

// Quiesce takes the work process and runs final with it held -- the moment
// no dialog step is half-way, where the database may be closed -- or gives
// up when ctx ends first: a step that hangs (final not run), or a final that
// does not return (a close stuck on a checkpoint; left running, the process
// is about to end). False in both cases; the grace bounds the whole stop.
func Quiesce(ctx context.Context, lock sync.Locker, final func()) bool {
	got := make(chan struct{})
	go func() {
		lock.Lock()
		select {
		case <-ctx.Done():
			// too late: the host is leaving without us
			lock.Unlock()
		default:
			close(got)
		}
	}()
	select {
	case <-got:
	case <-ctx.Done():
		// the lock may have been taken in the same instant: then it is ours
		select {
		case <-got:
		default:
			return false
		}
	}
	if final == nil {
		lock.Unlock()
		return true
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer lock.Unlock()
		final()
	}()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}

// Stop is how the process ends once a signal arrived.
type Stop struct {
	Shutdown func(context.Context) error // closes the listeners (http.Server.Shutdown)
	Lock     sync.Locker                 // the work process
	Final    func()                      // runs with Lock held: close the database
	Exit     func(int)                   // os.Exit
}

// Signals is what Notify listens for when OnSignal is given no channel:
// the three the Node supervisor handles (tools/osd-runtime.mjs).
var Signals = []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}

// OnSignal blocks until a signal arrives on c (nil: Signals, subscribed
// here) and runs the stop: drain, shut the listeners, quiesce, exit 0 -- all
// within the grace. A second signal while that runs ends the process at
// once with exit 1: the step in flight is lost and its LUW rolls back with
// the connection, which is what a kill would have done anyway.
func (h *Host) OnSignal(c <-chan os.Signal, stop Stop) {
	if c == nil {
		ch := make(chan os.Signal, 2)
		signal.Notify(ch, Signals...)
		c = ch
	}
	for sig := range c {
		h.mu.Lock()
		h.signals++
		n := h.signals
		h.mu.Unlock()
		if n > 1 {
			h.o.Logf("%s again: leaving now, without the drain", sig)
			stop.Exit(1)
			return
		}
		go h.stop(sig, stop)
	}
}

func (h *Host) stop(sig os.Signal, stop Stop) {
	h.stopping.Do(func() {
		t0 := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), h.o.Grace)
		defer cancel()
		h.o.Logf("%s: draining, %d in flight; new requests are answered 503 for up to %s", sig, h.InFlight(), h.o.Grace)
		clean := h.Drain(ctx)
		if !clean {
			h.o.Logf("a step did not finish within %s: leaving without it (its LUW rolls back with the connection)", h.o.Grace)
		}
		if stop.Shutdown != nil {
			if err := stop.Shutdown(ctx); err != nil && ctx.Err() == nil {
				h.o.Logf("listeners: %v", err)
			}
		}
		// the database close is bounded like the rest: a close that does not
		// return within the grace is left behind too (the WAL file recovers
		// on the next open), and the exit code is still 0 -- the stop ran to
		// its end, the grace decided what it left
		quiet := Quiesce(ctx, lockOrNone(stop.Lock), stop.Final)
		if !quiet {
			h.o.Logf("the database was not closed within the grace: left to the next open")
		}
		h.o.Logf("stopped in %d ms (drained %v, database closed %v)", time.Since(t0).Milliseconds(), clean, quiet)
		stop.Exit(0)
	})
}

// noLock stands in for a missing work process: a host without one quiesces
// with no step to wait for.
type noLock struct{}

func (noLock) Lock()   {}
func (noLock) Unlock() {}

func lockOrNone(l sync.Locker) sync.Locker {
	if l == nil {
		return noLock{}
	}
	return l
}
