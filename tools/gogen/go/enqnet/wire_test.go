package enqnet

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"osg/gogen/enq"
)

func key(v string) Request {
	return Request{Client: "001", Table: "ZOSD_PRB", Object: "EZOSD_PRB", Mode: "E", Fields: []enq.Field{{Value: v, Length: 10}}}
}

func scoped(r Request, scope int) Request { r.Scope = scope; return r }

// a sidecar that dies: the ADR 0010 rule, over a real Unix socket. The
// crashed process's session held a dialog lock (_SCOPE 1), a lock of its
// open LUW (_SCOPE 2) and a lock of a LUW it had committed into an update
// task that has not run yet. The first two go with the connection; the third
// belongs to the update and stays until UpdateDone -- unless the update ran
// inline in the dead process (osgo's case), and then it goes with it (sound: the
// database committed before the locks were handed over, enqnet/README.md).
func TestLostConnectionReleasesByOwner(t *testing.T) {
	for _, inline := range []bool{false, true} {
		t.Run(map[bool]string{false: "update task outside", true: "inline update"}[inline], func(t *testing.T) {
			srv := enq.New("gw")
			defer srv.Close()
			sock := filepath.Join(t.TempDir(), "enq.sock")
			ln, err := net.Listen("unix", sock)
			if err != nil {
				t.Fatal(err)
			}
			defer ln.Close()
			var mu sync.Mutex
			var lost []int64
			lostAll := make(chan struct{})
			go Serve(srv, ln, ServeOptions{InlineUpdates: inline, Lost: func(h Hello, sid int64) {
				if h.Generation != "go:old" {
					return // the surviving client, closed when the test ends
				}
				mu.Lock()
				lost = append(lost, sid)
				mu.Unlock()
				close(lostAll)
			}})

			crashed, err := Dial("unix", sock, Hello{Generation: "go:old", Name: "sidecar 1"})
			if err != nil {
				t.Fatal(err)
			}
			other, err := Dial("unix", sock, Hello{Generation: "go:new"})
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			a := crashed.Open("A")
			if r := crashed.EnqueueWith(a, scoped(key("UPD"), 2), false, nil); r.Subrc != 0 {
				t.Fatal(r)
			}
			ended := crashed.Commit(a, true) // handed to the update task; no UpdateDone yet
			if ended == "" {
				t.Fatal("commit with an update ended no owner")
			}
			for _, r := range []Request{scoped(key("DIALOG"), 1), scoped(key("LUW"), 2)} {
				if res := crashed.EnqueueWith(a, r, false, nil); res.Subrc != 0 {
					t.Fatal(res)
				}
			}
			rows := other.Read(Filter{Client: "001"})
			if len(rows) != 3 {
				t.Fatalf("rows %v", rows)
			}
			for _, w := range rows {
				if w.Generation != "go:old" || w.Session != a {
					t.Fatalf("owner of %q is (%q, %d), want (go:old, %d)", w.Arg, w.Generation, w.Session, a)
				}
			}
			b := other.Open("B")
			if r := other.EnqueueWith(b, key("DIALOG"), false, nil); r.Subrc != 1 || r.Msgno != "601" || r.Holder != "A" {
				t.Fatalf("before the crash: %+v", r)
			}

			crashed.conn.(*net.UnixConn).Close() // the process is gone
			select {
			case <-lostAll:
			case <-time.After(5 * time.Second):
				t.Fatal("the server never noticed the connection go")
			}
			<-crashed.Done()
			if crashed.Open("again") != 0 {
				t.Fatal("a closed client opened a session")
			}
			if r := crashed.EnqueueWith(a, key("X"), false, nil); r.Subrc != 2 {
				t.Fatalf("a closed client's ENQUEUE: %+v, want SYSTEM_FAILURE", r)
			}
			if len(lost) != 1 || lost[0] != a {
				t.Fatalf("lost %v", lost)
			}
			for _, k := range []string{"DIALOG", "LUW"} {
				if r := other.EnqueueWith(b, key(k), false, nil); r.Subrc != 0 {
					t.Fatalf("%s after the crash: %+v", k, r)
				}
			}
			upd := other.EnqueueWith(b, key("UPD"), false, nil)
			if inline {
				if upd.Subrc != 0 {
					t.Fatalf("the inline update died with the process; its lock stayed: %+v", upd)
				}
				return
			}
			if upd.Subrc != 1 || upd.Msgno != "601" {
				t.Fatalf("the update's lock went with the dialog: %+v", upd)
			}
			other.UpdateDone(a, ended) // the update task completes, from anywhere
			if r := other.EnqueueWith(b, key("UPD"), false, nil); r.Subrc != 0 {
				t.Fatalf("after UpdateDone: %+v", r)
			}
		})
	}
}

// _WAIT over the socket waits on the client side, and a release by another
// client during the wait grants the lock
func TestWaitOverSocket(t *testing.T) {
	srv := enq.New("gw")
	defer srv.Close()
	pipe := func() *Client {
		near, far := net.Pipe()
		go ServeConn(srv, far, ServeOptions{})
		c, err := NewClient(near, Hello{Generation: "g"})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	x, y := pipe(), pipe()
	defer x.Close()
	defer y.Close()
	a, b := x.Open("A"), y.Open("B")
	if r := x.EnqueueWith(a, key("K"), false, nil); r.Subrc != 0 {
		t.Fatal(r)
	}
	slept := 0
	r := y.EnqueueWith(b, key("K"), true, func(time.Duration) {
		slept++
		if slept == 2 {
			x.End(a)
		}
	})
	if r.Subrc != 0 || slept != 2 {
		t.Fatalf("granted %+v after %d sleeps", r, slept)
	}
}

func TestClientAfterServerClose(t *testing.T) {
	srv := enq.New("gw")
	near, far := net.Pipe()
	go ServeConn(srv, far, ServeOptions{})
	c, err := NewClient(near, Hello{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	sid := c.Open("A")
	srv.Close()
	if sid == 0 {
		t.Fatal("no session")
	}
	if r := c.EnqueueWith(sid, key("K"), false, nil); r.Subrc != 2 {
		t.Fatalf("%+v, want SYSTEM_FAILURE from a closed server", r)
	}
	if c.Open("B") != 0 {
		t.Fatal("a closed server opened a session")
	}
}

// the hello carries ProtocolVersion: a server refuses another one and a
// client refuses a server that answers with none (an older build), both at
// Dial, with ErrProtocol
func TestProtocolVersionAtDial(t *testing.T) {
	srv := enq.New("gw")
	defer srv.Close()

	// a client of another version, written by hand on the wire
	near, far := net.Pipe()
	go ServeConn(srv, far, ServeOptions{})
	go fmt.Fprintf(near, `{"id":1,"op":"hello","hello":{"version":%d,"generation":"g"}}`+"\n", ProtocolVersion+1)
	var a wireRes
	if err := json.NewDecoder(near).Decode(&a); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(a.Err, "protocol version") {
		t.Fatalf("the server took another version's hello: %+v", a)
	}
	near.Close()

	// a server that answers the hello without a version
	near, far = net.Pipe()
	go func() {
		var q wireReq
		dec := json.NewDecoder(far)
		if dec.Decode(&q) == nil {
			fmt.Fprintf(far, `{"id":%d}`+"\n", q.ID)
		}
		io.Copy(io.Discard, far)
	}()
	c, err := NewClient(near, Hello{Generation: "g"})
	if !errors.Is(err, ErrProtocol) || c != nil {
		t.Fatalf("a server without a version: client %v, err %v", c, err)
	}

	// over a real socket: the same build agrees
	sock := filepath.Join(t.TempDir(), "enq.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go Serve(srv, ln, ServeOptions{})
	ok, err := Dial("unix", sock, Hello{Generation: "g", PID: 1})
	if err != nil {
		t.Fatal(err)
	}
	ok.Close()
}

// a request the server refuses (an op it does not know, a session of
// another connection) answers as a closed server -- ENQUEUE SYSTEM_FAILURE
// -- and does not panic in the work process
func TestRefusalIsSystemFailure(t *testing.T) {
	srv := enq.New("gw")
	defer srv.Close()
	pipe := func() *Client {
		near, far := net.Pipe()
		go ServeConn(srv, far, ServeOptions{})
		c, err := NewClient(near, Hello{Generation: "g"})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	x, y := pipe(), pipe()
	defer x.Close()
	defer y.Close()
	if _, ok := x.call(wireReq{Op: "bogus"}); ok {
		t.Fatal("an unknown op was answered")
	}
	if n, why := x.Refused(); n != 1 || !strings.Contains(why, "unknown op bogus") {
		t.Fatalf("refused %d %q", n, why)
	}
	a := x.Open("A")
	if r := x.EnqueueWith(a, key("K"), false, nil); r.Subrc != 0 {
		t.Fatal(r)
	}
	// y may not release, commit or enqueue in x's session
	y.DequeueAll(a)
	y.End(a)
	if r := y.EnqueueWith(a, key("L"), false, nil); r.Subrc != 2 {
		t.Fatalf("an ENQUEUE in another connection's session: %+v, want SYSTEM_FAILURE", r)
	}
	if n, why := y.Refused(); n != 3 || !strings.Contains(why, "not this connection's") {
		t.Fatalf("refused %d %q", n, why)
	}
	if rows := y.Read(Filter{}); len(rows) != 1 {
		t.Fatalf("x's lock went through y: %v", rows)
	}
	// the connection is still good after a refusal
	if r := x.EnqueueWith(a, key("M"), false, nil); r.Subrc != 0 {
		t.Fatal(r)
	}
}

// BeforeRelease runs once a connection with sessions is gone and before any
// of its locks goes: the gateway ends the process there
func TestBeforeReleaseRunsFirst(t *testing.T) {
	srv := enq.New("gw")
	defer srv.Close()
	near, far := net.Pipe()
	held := make(chan int, 1)
	done := make(chan struct{})
	go func() {
		ServeConn(srv, far, ServeOptions{BeforeRelease: func(h Hello) {
			held <- len(srv.Read(Filter{}))
			if h.PID != 4242 {
				t.Errorf("hello pid %d", h.PID)
			}
		}})
		close(done)
	}()
	c, err := NewClient(near, Hello{Generation: "g", PID: 4242})
	if err != nil {
		t.Fatal(err)
	}
	a := c.Open("A")
	if r := c.EnqueueWith(a, key("K"), false, nil); r.Subrc != 0 {
		t.Fatal(r)
	}
	c.Close()
	<-done
	if n := <-held; n != 1 {
		t.Fatalf("locks at BeforeRelease: %d, want 1 (still held)", n)
	}
	if n := len(srv.Read(Filter{})); n != 0 {
		t.Fatalf("locks after the release: %d", n)
	}
}
