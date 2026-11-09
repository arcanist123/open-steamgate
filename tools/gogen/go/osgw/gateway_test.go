package osgw

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"osg/gogen/enq"
	"osg/gogen/enqnet"
)

// The test binary is its own sidecar: run with GATEWAY_FAKE_SIDECAR=1 it
// does what osgo -sidecar does at the seam -- answers HTTP on
// SidecarSocket, takes its locks from LockSocket -- with a few doors a test
// needs (/lock takes a dialog lock, /crash dies mid-request, /echo shows the
// request as it arrived, /login sets a session cookie, /slow takes its time).
func TestMain(m *testing.M) {
	if os.Getenv("GATEWAY_FAKE_SIDECAR") == "1" {
		fakeSidecar()
		return
	}
	os.Exit(m.Run())
}

const fakeGeneration = "go:fake0000000000"

func fakeSidecar() {
	fs := flag.NewFlagSet("fake", flag.ExitOnError)
	dir := fs.String("sidecar", "", "")
	fs.String("port", "", "")
	candidate := fs.Bool("candidate", false, "")
	builds := fs.Bool("gateway-builds", false, "")
	fs.Parse(os.Args[1:])
	if *candidate && os.Getenv("FAKE_REFUSE_SCHEMA") == "1" {
		raw, _ := json.Marshal(Refusal{Why: "-db x was seeded by another build: the tables differ", Schema: true})
		os.WriteFile(RefusedFile(*dir, os.Getpid()), raw, 0o600)
		os.Exit(4)
	}
	var promoted atomic.Bool
	promoted.Store(!*candidate)
	gen := fakeGeneration
	if v := os.Getenv("FAKE_GENERATION"); v != "" {
		gen = v
	}
	locks, err := enqnet.Dial("unix", LockSocket(*dir), enqnet.Hello{Generation: gen, PID: os.Getpid(), Name: "fake"})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(4)
	}
	var cut atomic.Bool // /cutlocks: the connection breaks, the process stays
	go func() {
		<-locks.Done()
		if !cut.Load() {
			os.Exit(3)
		}
	}()
	sid := locks.Open("FAKE")
	mux := http.NewServeMux()
	mux.HandleFunc("/osd/serving", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(404)
			return
		}
		writeJSON(w, 200, map[string]any{"ready": true, "generation": gen, "root": "/tree", "database": ":memory:", "pid": os.Getpid()})
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("FAKE_SMOKE_FAIL") == "1" {
			w.WriteHeader(500)
			return
		}
		io.WriteString(w, `{"status":"ready"}`)
	})
	mux.HandleFunc("/osd/promote", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !*candidate {
			w.WriteHeader(404)
			return
		}
		if os.Getenv("FAKE_PROMOTE_FAIL") == "1" {
			http.Error(w, "boot writes failed", 500)
			return
		}
		promoted.Store(true)
		io.WriteString(w, "promoted")
	})
	// the build-time gate's door (cmd/osgo /osd/inactive): how many objects
	// are inactive, read from FAKE_INACTIVE_FILE per request so a test can
	// change it while the sidecar runs
	mux.HandleFunc("/osd/inactive", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(404)
			return
		}
		n := 0
		if f := os.Getenv("FAKE_INACTIVE_FILE"); f != "" {
			if b, err := os.ReadFile(f); err == nil {
				n, _ = strconv.Atoi(strings.TrimSpace(string(b)))
			}
		}
		writeJSON(w, 200, map[string]any{"inactive": n})
	})
	mux.HandleFunc("/promoted", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, promoted.Load()) })
	// an activation that published: with a builder, the sidecar asks for a build
	mux.HandleFunc("/activate", func(w http.ResponseWriter, r *http.Request) {
		if *builds {
			w.Header().Set("X-OSD-Build", "published; building")
		} else {
			w.Header().Set("X-OSD-Build", "published; rebuild osgo to run it")
		}
		io.WriteString(w, "activated")
	})
	mux.HandleFunc("/unlock", func(w http.ResponseWriter, r *http.Request) {
		locks.Dequeue(sid, enq.Request{Client: "001", Table: "ZT", Mode: "E", Scope: 1,
			Fields: []enq.Field{{Value: r.URL.Query().Get("k"), Length: 10}}})
		io.WriteString(w, "unlocked")
	})
	mux.HandleFunc("/lock", func(w http.ResponseWriter, r *http.Request) {
		res := locks.EnqueueWith(sid, enq.Request{Client: "001", Table: "ZT", Mode: "E", Scope: 1,
			Fields: []enq.Field{{Value: r.URL.Query().Get("k"), Length: 10}}}, false, nil)
		fmt.Fprintf(w, "%d %s", res.Subrc, res.Holder)
	})
	mux.HandleFunc("/cutlocks", func(w http.ResponseWriter, r *http.Request) {
		cut.Store(true)
		// after the answer: the gateway kills this process as soon as it
		// sees the connection go
		go func() { time.Sleep(50 * time.Millisecond); locks.Close() }()
		io.WriteString(w, "cut")
	})
	mux.HandleFunc("/crash", func(w http.ResponseWriter, r *http.Request) { os.Exit(2) })
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		io.WriteString(w, "slow done")
	})
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "SAP_SESSIONID_OSD_001", Value: fmt.Sprint(os.Getpid()), Path: "/"})
		io.WriteString(w, "in")
	})
	mux.HandleFunc("/logoff", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "SAP_SESSIONID_OSD_001", Value: "", Path: "/", MaxAge: -1})
		io.WriteString(w, "out")
	})
	mux.HandleFunc("/sap/public/bc/icf/logoff", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "bye") })
	mux.HandleFunc("/body", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		fmt.Fprintf(w, "%s %d %q %q", r.Method, r.ContentLength, r.Header.Get("Expect"), b)
	})
	mux.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 3; i++ {
			fmt.Fprintf(w, "part%d;", i)
			w.(http.Flusher).Flush()
		}
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		rw.Flush()
		line, _ := rw.ReadString('\n')
		rw.WriteString("echo " + line)
		rw.Flush()
	})
	mux.HandleFunc("/echo", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"host": r.Host, "xff": r.Header.Values("X-Forwarded-For"),
			"ae": r.Header.Get("Accept-Encoding"), "pid": os.Getpid(), "uri": r.RequestURI})
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-OSD-Generation", gen)
		mux.ServeHTTP(w, r)
	})
	ln, err := net.Listen("unix", SidecarSocket(*dir, os.Getpid()))
	if err != nil {
		os.Exit(5)
	}
	srv := &http.Server{Handler: handler}
	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, syscall.SIGTERM)
		<-c
		srv.Shutdown(context.Background())
		os.Exit(0)
	}()
	srv.Serve(ln)
	select {}
}

func start(t *testing.T, o Options) (*Gateway, *httptest.Server) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GATEWAY_FAKE_SIDECAR", "1")
	o.Binary = exe
	if testing.Verbose() {
		o.Logf = t.Logf
	}
	g, err := Start(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(g.Handler())
	t.Cleanup(func() {
		front.Close()
		g.Stop(context.Background())
	})
	return g, front
}

func get(t *testing.T, url string, header ...string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DisableCompression = true // what the client sends is what the sidecar must see
	resp, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, string(raw)
}

func TestPassThrough(t *testing.T) {
	_, front := start(t, Options{})
	resp, body := get(t, front.URL+"/echo?a=1%2F2")
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if v := resp.Header.Values("X-OSD-Generation"); len(v) != 1 || v[0] != fakeGeneration {
		t.Fatalf("X-OSD-Generation %v", v)
	}
	var echo struct {
		Host, Ae, URI string
		Xff           []string
	}
	json.Unmarshal([]byte(body), &echo)
	if echo.Host != strings.TrimPrefix(front.URL, "http://") || len(echo.Xff) != 0 || echo.Ae != "" || echo.URI != "/echo?a=1%2F2" {
		t.Fatalf("the sidecar saw %+v", echo)
	}
	if resp, _ := get(t, front.URL+"/nope"); resp.StatusCode != 404 || resp.Header.Get("X-OSD-Generation") != fakeGeneration {
		t.Fatalf("404 %d %v", resp.StatusCode, resp.Header)
	}
}

func TestServing(t *testing.T) {
	g, front := start(t, Options{LauncherIdentity: "test-launcher"})
	resp, body := get(t, front.URL+"/osd/serving")
	var s struct {
		Ready            bool
		PID              int
		LauncherPid      int
		LauncherIdentity string
		Generation       string
		Root, Database   string
		Since            int64
		Hot              struct{ Swaps int }
		Gateway          struct {
			PID      int
			Sidecars []Sidecar
			Locks    int
		}
	}
	if err := json.Unmarshal([]byte(body), &s); err != nil || resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	table := g.Table()
	if !s.Ready || s.PID != table[0].PID || s.LauncherPid != os.Getpid() || s.Gateway.PID != os.Getpid() ||
		s.Generation != fakeGeneration || s.Root != "/tree" || s.Database != ":memory:" || s.Since <= 0 ||
		s.LauncherIdentity != "test-launcher" || len(s.Gateway.Sidecars) != 1 || s.Gateway.Sidecars[0].State != "serving" {
		t.Fatalf("%s", body)
	}
	if resp.Header.Get("X-OSD-Generation") != fakeGeneration {
		t.Fatal(resp.Header)
	}
	// another method is the sidecar's door, as on a lone osgo
	req, _ := http.NewRequest("POST", front.URL+"/osd/serving", nil)
	r2, err := http.DefaultClient.Do(req)
	if err != nil || r2.StatusCode != 404 {
		t.Fatalf("POST /osd/serving %v %v", r2, err)
	}
	r2.Body.Close()
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// critic #895 SHOULD 2: a request that has selected a sidecar counts for
// the drain before it is a step. route() counts it under the same mutex
// that reads g.current, so the drain of a swap cannot observe zero steps
// and retire the sidecar under a request that sits between route() and the
// forward (the Add used to happen later, in ServeHTTP).
func TestRoutedRequestCountsForTheDrain(t *testing.T) {
	g, front := start(t, Options{Grace: 30 * time.Second})
	old := g.Table()[0]
	r, _ := http.NewRequest("GET", front.URL+"/slow", nil)
	sc := g.route(r) // the request has selected the old generation
	if sc == nil || sc.PID != old.PID {
		t.Fatalf("routed to %+v", sc)
	}
	if n := sc.steps.Load(); n != 1 {
		t.Fatalf("a routed request is not a step before it is forwarded: %d", n)
	}
	// the swap's drain waits for it: the old generation is not retired
	// while the routed step is outstanding
	go func() { g.Swap(context.Background(), generation(t, "go:fakeB")) }()
	waitFor(t, "the flip", func() bool {
		rows := g.Table()
		return len(rows) > 1 && rows[1].State == "serving"
	})
	time.Sleep(250 * time.Millisecond) // the drain polls every 50 ms
	if row := g.Table()[0]; row.State != "draining" {
		t.Fatalf("the old generation was retired or kept serving under a routed step: %+v", row)
	}
	sc.steps.Add(-1) // the answer is done
	waitFor(t, "the old generation to retire after the step", func() bool { return g.Table()[0].State == "retired" })
}

// a crash: the request in flight answers 503, the sidecar's locks go with
// it (ADR 0010 failure modes), a replacement serves, and a second crash of
// a replacement within the window is not replaced again
func TestCrashRestartAndLocks(t *testing.T) {
	g, front := start(t, Options{RestartWindow: time.Hour})
	if _, body := get(t, front.URL+"/lock?k=A"); body != "0 " {
		t.Fatalf("lock: %q", body)
	}
	rows := g.Locks().Read(enq.Filter{})
	if len(rows) != 1 || rows[0].Generation != fakeGeneration || rows[0].User != "FAKE" {
		t.Fatalf("rows %+v", rows)
	}
	first := g.Table()[0].PID
	resp, body := get(t, front.URL+"/crash")
	if resp.StatusCode != 503 || !strings.Contains(body, "STG/NOT_SERVING") || resp.Header.Get("X-OSD-Generation") == "" {
		t.Fatalf("crash: %d %s", resp.StatusCode, body)
	}
	waitFor(t, "the dead sidecar's locks to go", func() bool { return len(g.Locks().Read(enq.Filter{})) == 0 })
	// a request after the crash waits for the replacement and is served there
	resp, body = get(t, front.URL+"/lock?k=A")
	if resp.StatusCode != 200 || body != "0 " {
		t.Fatalf("after the crash: %d %q", resp.StatusCode, body)
	}
	table := g.Table()
	if len(table) != 2 || table[0].State != "retired" || table[1].State != "serving" || table[1].PID == first {
		t.Fatalf("table %+v", table)
	}
	// the replacement dies too, within the window: no third sidecar
	get(t, front.URL+"/crash")
	waitFor(t, "the replacement to be retired", func() bool { return g.Table()[1].State == "retired" })
	time.Sleep(100 * time.Millisecond)
	if n := len(g.Table()); n != 2 {
		t.Fatalf("restarted again: %d sidecars", n)
	}
	resp, body = get(t, front.URL+"/osd/serving")
	if resp.StatusCode != 503 || !strings.Contains(body, `"phase":"failed"`) {
		t.Fatalf("after giving up: %d %s", resp.StatusCode, body)
	}
	select {
	case <-g.Failed():
	default:
		t.Fatal("Failed not closed after giving up")
	}
}

// a lock connection that breaks while its sidecar lives on: that process
// could still commit, so the gateway kills it and waits for its exit before
// its locks go (enqnet.ServeOptions.BeforeRelease)
func TestBrokenLockConnectionKillsFirst(t *testing.T) {
	g, front := start(t, Options{RestartWindow: time.Hour})
	if _, body := get(t, front.URL+"/lock?k=A"); body != "0 " {
		t.Fatalf("lock: %q", body)
	}
	first := g.Table()[0]
	if _, body := get(t, front.URL+"/cutlocks"); body != "cut" {
		t.Fatalf("cutlocks: %q", body)
	}
	waitFor(t, "the locks to go", func() bool { return len(g.Locks().Read(enq.Filter{})) == 0 })
	// the release waited for the exit: by the time the rows are gone the
	// sidecar is retired, and it was killed (it would have stayed alive)
	row := g.Table()[0]
	if row.PID != first.PID || row.State != "retired" || !strings.Contains(row.Why, "killed") {
		t.Fatalf("the locks went before the sidecar did: %+v", row)
	}
	// the replacement serves and takes the lock
	if resp, body := get(t, front.URL+"/lock?k=A"); resp.StatusCode != 200 || body != "0 " {
		t.Fatalf("after: %d %q", resp.StatusCode, body)
	}
}

func TestSessionPinning(t *testing.T) {
	g, front := start(t, Options{})
	resp, _ := get(t, front.URL+"/login")
	cookie := resp.Header.Get("Set-Cookie")
	if !strings.HasPrefix(cookie, "SAP_SESSIONID_OSD_001=") {
		t.Fatalf("cookie %q", cookie)
	}
	if p := g.Table()[0].Pinned; p != 1 {
		t.Fatalf("pinned %d", p)
	}
	_, body := get(t, front.URL+"/echo", "Cookie", strings.SplitN(cookie, ";", 2)[0])
	if !strings.Contains(body, fmt.Sprintf(`"pid":%d`, g.Table()[0].PID)) {
		t.Fatalf("routed to %s", body)
	}
	get(t, front.URL+"/logoff", "Cookie", strings.SplitN(cookie, ";", 2)[0])
	if p := g.Table()[0].Pinned; p != 0 {
		t.Fatalf("pinned after logoff %d", p)
	}
	// the ICF logoff ends the session even when its answer clears no cookie
	resp, _ = get(t, front.URL+"/login")
	cookie = strings.SplitN(resp.Header.Get("Set-Cookie"), ";", 2)[0]
	if p := g.Table()[0].Pinned; p != 1 {
		t.Fatalf("pinned %d", p)
	}
	get(t, front.URL+"/sap/public/bc/icf/logoff", "Cookie", cookie)
	if p := g.Table()[0].Pinned; p != 0 {
		t.Fatalf("pinned after the ICF logoff %d", p)
	}
}

// the drain: Stop waits for the request in flight, SIGTERMs the sidecar,
// and closes the lock server only after it is gone
func TestStopDrains(t *testing.T) {
	exe, _ := os.Executable()
	t.Setenv("GATEWAY_FAKE_SIDECAR", "1")
	g, err := Start(context.Background(), Options{Binary: exe, Grace: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(g.Handler())
	defer front.Close()
	done := make(chan string)
	go func() { _, body := get(t, front.URL+"/slow"); done <- body }()
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	g.Host().Drain(ctx)
	if body := <-done; body != "slow done" {
		t.Fatalf("in flight: %q", body)
	}
	g.Stop(ctx)
	row := g.Table()[0]
	if row.State != "retired" || row.Why != "exit 0" {
		t.Fatalf("after Stop: %+v", row)
	}
	if _, err := os.Stat(g.Dir()); !os.IsNotExist(err) {
		t.Fatalf("socket directory left: %v", err)
	}
}

func TestStartFailure(t *testing.T) {
	exe, _ := os.Executable()
	t.Setenv("GATEWAY_FAKE_SIDECAR", "1")
	// no -sidecar flag the fake understands: it exits during its start
	_, err := Start(context.Background(), Options{Binary: exe, Args: []string{"-unknown"}, StartTimeout: 10 * time.Second})
	if err == nil || !strings.Contains(err.Error(), "exited during its start") {
		t.Fatalf("err %v", err)
	}
}

// bodies, HEAD, Expect, a streamed answer and a WebSocket upgrade cross the
// hop as they came (forward.go; the upgrade through ReverseProxy)
func TestForwardShapes(t *testing.T) {
	_, front := start(t, Options{})
	post, _ := http.NewRequest("POST", front.URL+"/body", strings.NewReader("abc"))
	post.Header.Set("Expect", "100-continue")
	resp, err := http.DefaultClient.Do(post)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != `POST 3 "" "abc"` {
		t.Fatalf("POST: %s", b)
	}
	chunked, _ := http.NewRequest("PUT", front.URL+"/body", io.MultiReader(strings.NewReader("x"), strings.NewReader("yz")))
	resp, err = http.DefaultClient.Do(chunked)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != `PUT -1 "" "xyz"` {
		t.Fatalf("chunked PUT: %s", b)
	}
	head, _ := http.NewRequest("HEAD", front.URL+"/body", nil)
	resp, err = http.DefaultClient.Do(head)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("HEAD: %v %v", resp, err)
	}
	resp.Body.Close()
	if _, body := get(t, front.URL+"/stream"); body != "part0;part1;part2;" {
		t.Fatalf("stream: %q", body)
	}
	// many requests over few connections: the pool reuses its connections
	for i := 0; i < 50; i++ {
		if resp, _ := get(t, front.URL+"/echo"); resp.StatusCode != 200 {
			t.Fatal(resp.Status)
		}
	}
	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	br := bufio.NewReader(conn)
	status, _ := br.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade: %q", status)
	}
	for line, _ := br.ReadString('\n'); line != "\r\n" && line != ""; line, _ = br.ReadString('\n') {
	}
	fmt.Fprintf(conn, "ping\n")
	if line, _ := br.ReadString('\n'); line != "echo ping\n" {
		t.Fatalf("over the upgraded connection: %q", line)
	}
}

// the sockets bind no interface: their directory's mode is the fence
func TestSocketDirMustBePrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no mode bits")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Start(context.Background(), Options{Binary: "/nonexistent", Dir: dir}); err == nil || !strings.Contains(err.Error(), "0700") {
		t.Fatalf("an open socket directory was taken: %v", err)
	}
}
