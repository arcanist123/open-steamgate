// Package osgw is the gateway, the stable process in front of an osgo generation
// (ADR 0010, slice 3): it owns the public HTTP port, the lock table and the
// generation table, and runs the ABAP in a sidecar -- the osgo binary
// started with -sidecar <dir> -- that it proxies every request to.
//
//   - Sockets: the gateway listens; the sidecar answers on a Unix socket in
//     the gateway's directory (SidecarSocket). A request crosses unchanged
//     (forward.go; a WebSocket upgrade through httputil.ReverseProxy): no
//     X-Forwarded-For, the Host kept, no transparent gzip, so an answer
//     through the gateway is the sidecar's.
//   - The lock table: one enq.Server, served on dir/enq.sock (the E3 socket,
//     go/enqnet); every sidecar's ENQUEUE_* is a client of it, an owner
//     is (generation, session, LUW). A sidecar that dies loses its sessions'
//     dialog locks and its open LUWs' locks, and those of its inline update
//     task (enqnet.ServeOptions.InlineUpdates), which committed the database
//     before it handed them over. A lock connection that breaks while the
//     sidecar runs: the sidecar is killed first, its locks go after its exit.
//   - Readiness: a sidecar serves once its own GET /osd/serving says ready;
//     the gateway's /osd/serving says what serves (pid = the sidecar,
//     launcherPid = the gateway) plus the generation table.
//   - Session pinning: a response that sets a stateful session cookie
//     (SAP_SESSIONID_*, sap-contextid) pins that session to the sidecar that
//     set it; the generation swap (swap.go) routes by it.
//   - The swap (slice 4, swap.go): a build after a publishing activation,
//     the result started read-only as a candidate, smoked, promoted, the old
//     generation drained and retired.
//   - Spawn, drain, kill: a crashed sidecar's requests in flight answer 503,
//     the gateway starts a replacement of the same binary; a replacement that
//     dies within RestartWindow is not replaced again. Stop sends the
//     sidecar SIGTERM (its own drain, go/serving), waits, kills at the end.
//
// No import of osg/gogen/abap, of generated code or of tools/osd-*.
package osgw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"osg/gogen/enq"
	"osg/gogen/enqnet"
	"osg/gogen/genbuild"
	"osg/gogen/serving"
)

// SidecarSocket is where a sidecar of pid answers HTTP inside dir; osgo's
// -sidecar mode listens there and the gateway dials it.
func SidecarSocket(dir string, pid int) string {
	return filepath.Join(dir, fmt.Sprintf("http-%d.sock", pid))
}

// privateDir refuses a socket directory others can enter: the HTTP and lock
// sockets bind no interface, so the directory's mode is their only fence
// (MkdirTemp makes 0700). Windows has no such mode bits to read.
func privateDir(dir string) error {
	st, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("gateway: socket directory %s is %v; it must be 0700", dir, st.Mode().Perm())
	}
	return nil
}

// LockSocket is the gateway's lock server inside dir.
func LockSocket(dir string) string { return filepath.Join(dir, "enq.sock") }

// Options say what to run and how long to wait for it.
type Options struct {
	Binary string   // the sidecar executable (an osgo binary)
	Args   []string // its arguments; "-sidecar <dir>" is appended
	Env    []string // added to the gateway's environment for every sidecar
	Dir    string   // where the sockets live; "" = a fresh directory, removed at Stop

	Grace         time.Duration // the drain (serving.DefaultGrace)
	StartTimeout  time.Duration // a sidecar's start to ready (3 min: the boot seeds a database)
	AdmitWait     time.Duration // how long a request waits while a sidecar starts (30 s)
	RestartWindow time.Duration // a replacement that dies sooner is not replaced (1 min)
	// UpdatesOutside: the sidecar's update task runs outside it, so locks a
	// COMMIT handed to it outlive a crash (false for osgo: inline updates)
	UpdatesOutside bool

	LauncherIdentity string
	Stdout, Stderr   io.Writer
	Logf             func(string, ...any)

	// The generation swap (slice 4, swap.go). Builder nil: no builds, an
	// activation's answer is the sidecar's. With a builder the sidecars get
	// -gateway-builds, and an activation that published asks for a build.
	Builder  genbuild.Builder
	Root     string        // the tree the builder builds (genbuild.Request.Root)
	GenDir   string        // where each generation's executable is stashed; "" = run Binary itself
	Smoke    []string      // GET paths a candidate must answer 2xx before promotion (default /health)
	Debounce time.Duration // the build queue's quiet period (500 ms)
}

// Sidecar is one row of the generation table.
type Sidecar struct {
	ID         int       `json:"id"`
	PID        int       `json:"pid"`
	Generation string    `json:"generation"`
	State      string    `json:"state"` // starting, serving, draining, retired
	Started    time.Time `json:"started"`
	Ended      time.Time `json:"ended,omitzero"`
	Why        string    `json:"why,omitempty"`
	Steps      int64     `json:"steps"` // requests in flight
	Pinned     int       `json:"pinned"`
}

type sidecar struct {
	Sidecar
	replacement bool
	cmd         *exec.Cmd
	transport   *http.Transport
	proxy       *httputil.ReverseProxy // upgrades (and the readiness poll's transport)
	pool        *pool                  // every other request (forward.go)
	exited      chan struct{}
	steps       atomic.Int64
	info        info
	binary      string // the executable this sidecar runs (and a replacement restarts)
	candidate   bool   // started read-only for a swap, not yet promoted
}

// info is what the sidecar's own /osd/serving says about it
type info struct {
	Ready      bool   `json:"ready"`
	Generation string `json:"generation"`
	Root       string `json:"root"`
	Database   string `json:"database"`
	// the sidecar's work processes in and out of service (go/workpool);
	// relayed live on the gateway's own answer
	WorkProcesses json.RawMessage `json:"workProcesses,omitempty"`
}

// Gateway runs one sidecar behind one port.
type Gateway struct {
	o       Options
	dir     string
	ownDir  bool
	started time.Time
	locks   *enq.Server
	lockLn  net.Listener
	host    *serving.Host

	mu       sync.Mutex
	current  *sidecar
	ready    chan struct{} // closed while current serves
	table    []*sidecar
	seq      int
	restarts int
	failed   string
	failedCh chan struct{} // closed when failed is set
	stopping bool
	pins     map[string]*sidecar

	binary string // the executable a sidecar of the serving generation runs
	queue  *genbuild.Queue
	swapMu sync.Mutex // one swap at a time
	build  BuildState
}

// Errors of Start.
var ErrNotReady = errors.New("gateway: the sidecar did not become ready")

// Start opens the lock server, starts the first sidecar and waits until it
// serves. The gateway's own listener is the caller's (Handler).
func Start(ctx context.Context, o Options) (*Gateway, error) {
	if o.Grace <= 0 {
		o.Grace = serving.DefaultGrace
	}
	if o.StartTimeout <= 0 {
		o.StartTimeout = 3 * time.Minute
	}
	if o.AdmitWait <= 0 {
		o.AdmitWait = 30 * time.Second
	}
	if o.RestartWindow <= 0 {
		o.RestartWindow = time.Minute
	}
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	g := &Gateway{o: o, dir: o.Dir, started: time.Now(), ready: make(chan struct{}), pins: map[string]*sidecar{},
		failedCh: make(chan struct{})}
	if g.dir == "" {
		// short: a Unix socket path has a limit near 104 bytes
		d, err := os.MkdirTemp("", "osgw-")
		if err != nil {
			return nil, err
		}
		g.dir, g.ownDir = d, true
	} else if err := privateDir(g.dir); err != nil {
		return nil, err
	}
	g.locks = enq.New("osgw")
	_ = os.Remove(LockSocket(g.dir))
	ln, err := net.Listen("unix", LockSocket(g.dir))
	if err != nil {
		g.cleanup()
		return nil, err
	}
	g.lockLn = ln
	go enqnet.Serve(g.locks, ln, enqnet.ServeOptions{InlineUpdates: !o.UpdatesOutside, Logf: o.Logf,
		BeforeRelease: g.endProcess})
	g.binary = o.Binary
	if o.GenDir != "" {
		// the first generation is stashed too: a later build overwriting the
		// builder's output must not change what a replacement starts
		if g.binary, _, err = genbuild.Stash(o.Binary, o.GenDir); err != nil {
			g.cleanup()
			return nil, err
		}
	}
	if o.Builder != nil {
		g.o.Args = append(append([]string{}, o.Args...), "-gateway-builds")
		g.queue = genbuild.NewQueue(gatedBuilder{g: g, Builder: o.Builder}, o.Debounce, g.built)
	}
	sc, err := g.spawn(g.binary, false, false)
	if err == nil {
		err = g.waitReady(ctx, sc)
	}
	if err == nil && !g.serve(sc) {
		err = fmt.Errorf("%w: pid %d exited before it served (%s)", ErrNotReady, sc.PID, sc.Why)
	}
	if err != nil {
		g.Stop(context.Background())
		return nil, err
	}
	g.host = serving.New(serving.Options{Generation: sc.info.Generation, Root: sc.info.Root, Database: sc.info.Database,
		LauncherIdentity: o.LauncherIdentity, Started: g.started, Grace: o.Grace, Logf: o.Logf})
	return g, nil
}

// Host is the gateway's supervised-host contract (admission, the drain).
func (g *Gateway) Host() *serving.Host { return g.host }

// Locks is the gateway's lock table (tests read it).
func (g *Gateway) Locks() *enq.Server { return g.locks }

// Dir is where the sockets live.
func (g *Gateway) Dir() string { return g.dir }

func (g *Gateway) spawn(binary string, replacement, candidate bool) (*sidecar, error) {
	args := append(append([]string{}, g.o.Args...), "-sidecar", g.dir)
	if candidate {
		args = append(args, "-candidate")
	}
	cmd := exec.Command(binary, args...)
	if len(g.o.Env) > 0 {
		cmd.Env = append(os.Environ(), g.o.Env...)
	}
	cmd.Stdout, cmd.Stderr = g.o.Stdout, g.o.Stderr
	ownGroup(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("gateway: start %s: %w", binary, err)
	}
	g.mu.Lock()
	g.seq++
	sc := &sidecar{Sidecar: Sidecar{ID: g.seq, PID: cmd.Process.Pid, State: "starting", Started: time.Now()},
		replacement: replacement, cmd: cmd, exited: make(chan struct{}), binary: binary, candidate: candidate}
	g.table = append(g.table, sc)
	g.mu.Unlock()
	sock := SidecarSocket(g.dir, sc.PID)
	sc.pool = &pool{sock: sock}
	sc.transport = &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
		MaxIdleConns: 256, MaxIdleConnsPerHost: 256, IdleConnTimeout: 90 * time.Second,
		// the client's Accept-Encoding goes through as it came; the
		// transport must not add gzip and unpack it behind the client's back
		DisableCompression: true,
	}
	sc.proxy = &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			r.URL.Scheme, r.URL.Host = "http", "sidecar"
			// the sidecar sees the request as the client sent it: the Host
			// stays (r.Host), and no X-Forwarded-For is added
			r.Header["X-Forwarded-For"] = nil
		},
		Transport:      sc.transport,
		ModifyResponse: func(resp *http.Response) error { g.pinFrom(sc, resp); g.buildFrom(resp); return nil },
		ErrorHandler:   func(w http.ResponseWriter, r *http.Request, err error) { g.lostRequest(sc, w, r, err) },
	}
	g.o.Logf("gateway: sidecar %d started, pid %d", sc.ID, sc.PID)
	go g.watch(sc)
	return sc, nil
}

// waitReady polls the sidecar's /osd/serving until it says ready; serve
// then makes it the one new requests go to (a candidate waits for its
// promotion instead, swap.go).
func (g *Gateway) waitReady(ctx context.Context, sc *sidecar) error {
	ctx, cancel := context.WithTimeout(ctx, g.o.StartTimeout)
	defer cancel()
	client := &http.Client{Transport: sc.transport, Timeout: 5 * time.Second}
	for {
		if in, ok := ask(ctx, client); ok {
			g.mu.Lock()
			sc.info = in
			sc.Generation = in.Generation
			if sc.State == "starting" && sc.candidate {
				sc.State = "candidate"
			}
			g.mu.Unlock()
			return nil
		}
		select {
		case <-sc.exited:
			return fmt.Errorf("%w: pid %d exited during its start (%s)", ErrNotReady, sc.PID, sc.Why)
		case <-ctx.Done():
			g.terminate(sc, 0)
			return fmt.Errorf("%w within %s", ErrNotReady, g.o.StartTimeout)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// flipLocked makes a live sidecar the serving one; false when it died
// first (its watch retired it between its readiness and here). g.mu held.
func (g *Gateway) flipLocked(sc *sidecar) bool {
	if sc.State != "starting" && sc.State != "candidate" {
		return false
	}
	sc.State = "serving"
	sc.candidate = false
	g.current = sc
	select {
	case <-g.ready:
	default:
		close(g.ready)
	}
	return true
}

// served is what follows a flip: the host's generation and the log line
func (g *Gateway) served(sc *sidecar) {
	if g.host != nil {
		g.host.SetGeneration(sc.Generation)
	}
	g.o.Logf("gateway: sidecar %d (pid %d) serves %s", sc.ID, sc.PID, sc.Generation)
}

// serve makes a ready sidecar the serving one; false when it died first:
// nothing serves then, and the caller (Start, a replacement) fails loudly
// rather than leaving a gateway that answers 503 for ever with no failure
// signal
func (g *Gateway) serve(sc *sidecar) bool {
	g.mu.Lock()
	ok := g.flipLocked(sc)
	g.mu.Unlock()
	if ok {
		g.served(sc)
	}
	return ok
}

func ask(ctx context.Context, client *http.Client) (info, bool) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://sidecar/osd/serving", nil)
	resp, err := client.Do(req)
	if err != nil {
		return info{}, false
	}
	defer resp.Body.Close()
	var in info
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&in) != nil || !in.Ready {
		return info{}, false
	}
	return in, true
}

// watch waits for the sidecar's exit and replaces a sidecar that served,
// unless the gateway is stopping or the replacement policy says no.
func (g *Gateway) watch(sc *sidecar) {
	err := sc.cmd.Wait()
	why := "exit 0"
	if err != nil {
		why = err.Error()
	}
	g.mu.Lock()
	served := sc.State == "serving" || sc.State == "draining"
	planned := sc.State == "draining" || g.current != sc
	sc.State, sc.Ended, sc.Why = "retired", time.Now(), why
	if g.current == sc {
		g.current = nil
		g.ready = make(chan struct{})
	}
	for k, p := range g.pins {
		if p == sc {
			delete(g.pins, k)
		}
	}
	stopping := g.stopping
	lived := sc.Ended.Sub(sc.Started)
	g.mu.Unlock()
	close(sc.exited)
	sc.transport.CloseIdleConnections()
	sc.pool.close()
	_ = os.Remove(SidecarSocket(g.dir, sc.PID))
	if stopping || planned || !served {
		return
	}
	g.o.Logf("gateway: sidecar %d (pid %d) ended unplanned after %s: %s", sc.ID, sc.PID, lived.Round(time.Millisecond), why)
	if sc.replacement && lived < g.o.RestartWindow {
		g.fail(fmt.Sprintf("the replacement sidecar %d ended %s after its start (%s); not restarting again", sc.ID, lived.Round(time.Second), why))
		return
	}
	g.mu.Lock()
	g.restarts++
	g.mu.Unlock()
	next, err := g.spawn(sc.binary, true, false)
	if err == nil {
		err = g.waitReady(context.Background(), next)
	}
	if err == nil && !g.serve(next) {
		err = fmt.Errorf("%w: pid %d exited before it served (%s)", ErrNotReady, next.PID, next.Why)
	}
	if err != nil {
		g.fail("the replacement did not start: " + err.Error())
	}
}

// fail records why the gateway gave up restarting and closes Failed
func (g *Gateway) fail(why string) {
	g.mu.Lock()
	if g.stopping { // a replacement ended by Stop is not a failure
		g.mu.Unlock()
		return
	}
	if g.failed == "" {
		g.failed = why
		close(g.failedCh)
	}
	g.mu.Unlock()
	g.o.Logf("gateway: %s", why)
}

// Failed is closed once the gateway has given up restarting (its
// /osd/serving answers 503 phase failed from then on); FailedWhy says why.
// cmd/osgw exits non-zero there, so a supervisor sees it rather than a
// port that answers 503 forever.
func (g *Gateway) Failed() <-chan struct{} { return g.failedCh }

// FailedWhy is why the gateway gave up, "" while it has not.
func (g *Gateway) FailedWhy() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.failed
}

// endProcess runs when a lock connection with sessions is gone and before
// its locks are released (enqnet.ServeOptions.BeforeRelease). The usual case
// is a sidecar that died: its exit closed the connection. But a connection
// can also break while its process lives on, and that process may still
// commit a LUW whose locks the table would otherwise give to somebody else.
// So the process the hello named is killed first and its exit waited for;
// only then do its locks go. A pid this gateway did not start (none, or a
// test's) is not ours to kill: its locks go as before.
func (g *Gateway) endProcess(h enqnet.Hello) {
	if h.PID == 0 {
		return
	}
	g.mu.Lock()
	var sc *sidecar
	for _, s := range g.table {
		if s.PID == h.PID {
			sc = s
		}
	}
	g.mu.Unlock()
	if sc == nil {
		g.o.Logf("gateway: lock connection of pid %d gone; not a sidecar of this gateway", h.PID)
		return
	}
	select {
	case <-sc.exited:
		return
	default:
	}
	g.o.Logf("gateway: sidecar %d (pid %d) lost its lock connection while running: killed before its locks go", sc.ID, sc.PID)
	_ = sc.cmd.Process.Kill()
	<-sc.exited
}

// route is the sidecar a request goes to: the one its session is pinned to
// while that one lives, else the serving one, waited for while it starts.
// The step is counted here, under the same mutex that reads g.current and
// the pins, so a request that has selected a sidecar is a step before it is
// forwarded: the drain of a swap cannot observe zero and retire the sidecar
// under a request that sits between its routing and its forward (the
// counting used to happen later, in ServeHTTP, a few instructions wide and
// wide enough). The caller removes the step when its answer is done.
func (g *Gateway) route(r *http.Request) *sidecar {
	g.mu.Lock()
	for _, k := range sessionKeys(r) {
		if sc := g.pins[k]; sc != nil && sc.State != "retired" {
			sc.steps.Add(1)
			g.mu.Unlock()
			return sc
		}
	}
	sc, ready, failed := g.current, g.ready, g.failed
	if sc != nil {
		sc.steps.Add(1)
		g.mu.Unlock()
		return sc
	}
	g.mu.Unlock()
	if failed != "" {
		return nil
	}
	t := time.NewTimer(g.o.AdmitWait)
	defer t.Stop()
	select {
	case <-ready:
	case <-t.C:
	case <-r.Context().Done():
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if sc = g.current; sc != nil {
		sc.steps.Add(1)
	}
	return sc
}

// the cookies a stateful session carries (ADT: SAP_SESSIONID_<sid>_<client>
// and sap-contextid); the key is name=value
func isSessionCookie(name string) bool {
	return strings.HasPrefix(name, "SAP_SESSIONID_") || strings.EqualFold(name, "sap-contextid")
}

func sessionKeys(r *http.Request) []string {
	var keys []string
	if len(r.Header["Cookie"]) == 0 {
		return nil
	}
	for _, c := range r.Cookies() {
		if isSessionCookie(c.Name) && c.Value != "" {
			keys = append(keys, c.Name+"="+c.Value)
		}
	}
	return keys
}

// isUpgrade: a WebSocket handshake (RFC 6455 4.2.1)
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

// pinFrom records the session a response opens (or forgets one it ends)
func (g *Gateway) pinFrom(sc *sidecar, resp *http.Response) {
	if len(resp.Header["Set-Cookie"]) == 0 {
		return
	}
	for _, c := range resp.Cookies() {
		if !isSessionCookie(c.Name) {
			continue
		}
		g.mu.Lock()
		if c.Value == "" || c.MaxAge < 0 || (!c.Expires.IsZero() && c.Expires.Before(time.Now())) {
			for k := range g.pins {
				if strings.HasPrefix(k, c.Name+"=") && g.pins[k] == sc {
					delete(g.pins, k)
				}
			}
		} else {
			g.pins[c.Name+"="+c.Value] = sc
		}
		g.mu.Unlock()
	}
}

// logoffPath is the ICF logoff: a session that called it successfully has
// ended, whether or not the answer clears its cookie (osgo's does not; the
// ADT client drops the cookie itself), so its pin goes and a drain need not
// wait out the grace for it.
const logoffPath = "/sap/public/bc/icf/logoff"

func (g *Gateway) logoff(r *http.Request, resp *http.Response) {
	if resp.StatusCode < 200 || resp.StatusCode > 299 || !strings.EqualFold(strings.TrimSuffix(r.URL.Path, "/"), logoffPath) {
		return
	}
	keys := sessionKeys(r)
	g.mu.Lock()
	for _, k := range keys {
		delete(g.pins, k)
	}
	g.mu.Unlock()
}

// ServeHTTP answers /osd/serving itself and proxies everything else; wrap
// it in Host().Wrap for the generation header and the drain (Handler).
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/osd/serving" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		g.serving(w, r)
		return
	}
	if r.URL.Path == promotePath {
		// the gateway's own door into a candidate, never a client's
		http.NotFound(w, r)
		return
	}
	sc := g.route(r)
	if sc == nil {
		g.notServing(w)
		return
	}
	defer sc.steps.Add(-1) // counted inside route, under its mutex
	// the sidecar's own header is the one that counts: it says which code ran
	w.Header().Del("X-OSD-Generation")
	if isUpgrade(r) {
		sc.proxy.ServeHTTP(w, r)
		return
	}
	if err := sc.pool.forward(w, r, func(resp *http.Response) { g.pinFrom(sc, resp); g.logoff(r, resp); g.buildFrom(resp) }); err != nil {
		g.lostRequest(sc, w, r, err)
	}
}

// Handler is the gateway's front door: the generation on every answer,
// newcomers refused while it drains, everything else proxied.
func (g *Gateway) Handler() http.Handler { return g.host.Wrap(g) }

// lostRequest: the sidecar went during the request (a crash or a kill);
// the step's LUW rolled back with its connection, the client may retry
func (g *Gateway) lostRequest(sc *sidecar, w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		return // the client left first
	}
	g.o.Logf("gateway: %s %s: sidecar %d (pid %d): %v", r.Method, r.URL.RequestURI(), sc.ID, sc.PID, err)
	w.Header().Set("X-OSD-Generation", g.host.Generation())
	writeJSON(w, 503, map[string]any{
		"error": map[string]any{"code": "STG/NOT_SERVING",
			"message": map[string]string{"lang": "en", "value": "the work process ended during the request; its LUW was rolled back, retry"}},
		"ready": false, "phase": "restarting", "generation": sc.Generation,
	})
}

func (g *Gateway) notServing(w http.ResponseWriter) {
	g.mu.Lock()
	phase, why := "starting", "a sidecar is starting"
	if g.failed != "" {
		phase, why = "failed", g.failed
	}
	g.mu.Unlock()
	writeJSON(w, 503, map[string]any{
		"error": map[string]any{"code": "STG/NOT_SERVING", "message": map[string]string{"lang": "en", "value": why}},
		"ready": false, "phase": phase, "generation": g.host.Generation(), "pid": os.Getpid(),
	})
}

// Table is the generation table: every sidecar this gateway started.
func (g *Gateway) Table() []Sidecar {
	g.mu.Lock()
	defer g.mu.Unlock()
	pinned := map[*sidecar]int{}
	for _, sc := range g.pins {
		pinned[sc]++
	}
	rows := make([]Sidecar, 0, len(g.table))
	for _, sc := range g.table {
		row := sc.Sidecar
		row.Steps = sc.steps.Load()
		row.Pinned = pinned[sc]
		rows = append(rows, row)
	}
	return rows
}

// serving is the gateway's GET /osd/serving: the supervised-host contract
// (go/serving), pid the sidecar that serves, launcherPid this process, and
// the generation table under "gateway".
func (g *Gateway) serving(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	sc := g.current
	restarts, failed, build := g.restarts, g.failed, g.build
	g.mu.Unlock()
	if sc == nil {
		g.notServing(w)
		return
	}
	gw := map[string]any{"pid": os.Getpid(), "sidecars": g.Table(), "restarts": restarts,
		"locks": len(g.locks.Read(enq.Filter{})), "dir": g.dir}
	if g.queue != nil {
		gw["build"] = build
	}
	if h := build.Header(); h != "" {
		w.Header().Set("X-OSD-Build", h)
	}
	if failed != "" {
		gw["failed"] = failed
	}
	body := map[string]any{
		"ready": true, "pid": sc.PID, "since": g.started.UnixMilli(), "generation": sc.Generation,
		"hot":  map[string]any{"swaps": build.Swaps, "unverified": false},
		"root": sc.info.Root, "database": sc.info.Database, "launcherPid": os.Getpid(),
		"gateway": gw,
	}
	if g.o.LauncherIdentity != "" {
		body["launcherIdentity"] = g.o.LauncherIdentity
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(200)
		return
	}
	// what the serving sidecar says of its work processes now: one stopped
	// for want of a connection must show here, not only in its ZOSD_WP rows
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	if in, ok := ask(ctx, &http.Client{Transport: sc.transport}); ok && len(in.WorkProcesses) > 0 {
		body["workProcesses"] = in.WorkProcesses
	}
	cancel()
	writeJSON(w, 200, body)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(raw)))
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// terminate asks a sidecar to drain (SIGTERM; a kill where there are no
// signals) and kills it when grace runs out; zero grace kills at once.
func (g *Gateway) terminate(sc *sidecar, grace time.Duration) {
	g.mu.Lock()
	if sc.State != "retired" {
		sc.State = "draining"
	}
	g.mu.Unlock()
	if grace <= 0 || signalTerm(sc.cmd.Process) != nil {
		_ = sc.cmd.Process.Kill()
	}
	select {
	case <-sc.exited:
	case <-time.After(grace):
		g.o.Logf("gateway: sidecar %d (pid %d) still running %s after SIGTERM: killed", sc.ID, sc.PID, grace)
		_ = sc.cmd.Process.Kill()
		<-sc.exited
	}
}

// Stop drains the sidecars (SIGTERM, then a kill when ctx ends or the grace
// is up), then closes the lock server and removes the directory it made.
// The lock server stays up until the sidecars are gone: a sidecar whose
// lock connection drops leaves at once, which is not a drain.
func (g *Gateway) Stop(ctx context.Context) {
	if g.queue != nil {
		g.queue.Close()
	}
	g.mu.Lock()
	g.stopping = true
	var live []*sidecar
	for _, sc := range g.table {
		if sc.State != "retired" {
			live = append(live, sc)
		}
	}
	g.mu.Unlock()
	grace := g.o.Grace
	if d, ok := ctx.Deadline(); ok && time.Until(d) < grace {
		grace = time.Until(d)
	}
	var wg sync.WaitGroup
	for _, sc := range live {
		wg.Add(1)
		go func(sc *sidecar) { defer wg.Done(); g.terminate(sc, grace) }(sc)
	}
	wg.Wait()
	g.cleanup()
}

// Kill ends every sidecar at once (the last thing before the process exits).
func (g *Gateway) Kill() {
	g.mu.Lock()
	g.stopping = true
	var live []*sidecar
	for _, sc := range g.table {
		if sc.State != "retired" {
			live = append(live, sc)
		}
	}
	g.mu.Unlock()
	for _, sc := range live {
		_ = sc.cmd.Process.Kill()
	}
}

func (g *Gateway) cleanup() {
	if g.lockLn != nil {
		g.lockLn.Close()
	}
	if g.locks != nil {
		g.locks.Close()
	}
	if g.ownDir {
		_ = os.RemoveAll(g.dir)
	}
}
