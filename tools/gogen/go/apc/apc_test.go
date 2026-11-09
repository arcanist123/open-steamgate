package apc

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"osg/gogen/abap"
)

// fakeHost is an APCHost that records its calls: ON_START sends "hello",
// each message is echoed upper case, "dump" sends then panics
type fakeHost struct {
	mu     sync.Mutex
	reject bool
	queue  []string
	calls  []string
	closed chan string
	news   int
	yield  bool
}

func (f *fakeHost) Open(s *abap.Session) bool {
	if f.yield {
		if !s.HoldsWorkProcess {
			panic("APC session does not own work process")
		}
		entered := make(chan struct{})
		go func() { abap.WorkProcess.Lock(); close(entered); abap.WorkProcess.Unlock() }()
		s.YieldSleep(50 * time.Millisecond)
		select {
		case <-entered:
		default:
			panic("APC sleep retained work process")
		}
	}
	f.calls = append(f.calls, "open")
	if f.reject {
		return false
	}
	f.queue = append(f.queue, "hello")
	return true
}
func (f *fakeHost) Message(s *abap.Session, t string) {
	f.calls = append(f.calls, "msg:"+t)
	f.queue = append(f.queue, strings.ToUpper(t))
	if t == "dump" {
		panic(abap.ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
	}
}
func (f *fakeHost) Close(s *abap.Session, reason string, code int32) {
	f.closed <- reason + "/" + strconv.Itoa(int(code))
}
func (f *fakeHost) Drain(s *abap.Session) []string {
	q := f.queue
	f.queue = nil
	return q
}

func serve(t *testing.T, f *fakeHost, steps ...func(*abap.Session, string, func()) error) (*httptest.Server, string) {
	ch := &Channel{Name: "t", New: func(s *abap.Session, r *http.Request) Host { f.news++; return f }, Logf: func(string, ...any) {}}
	if len(steps) > 0 {
		ch.Step = steps[0]
	}
	srv := httptest.NewServer(ch)
	t.Cleanup(srv.Close)
	return srv, "ws" + strings.TrimPrefix(srv.URL, "http")
}

func read(t *testing.T, c *websocket.Conn) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(b)
}

func TestAPCChannel(t *testing.T) {
	f := &fakeHost{closed: make(chan string, 1)}
	_, url := serve(t, f)
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	// what ON_START sent comes after the socket is open
	if got := read(t, c); got != "hello" {
		t.Fatalf("first message %q", got)
	}
	c.Write(ctx, websocket.MessageText, []byte("abc"))
	if got := read(t, c); got != "ABC" {
		t.Fatalf("echo %q", got)
	}
	// a binary frame is ignored and the socket stays up (the Node host)
	c.Write(ctx, websocket.MessageBinary, []byte{1, 2})
	c.Write(ctx, websocket.MessageText, []byte("x"))
	if got := read(t, c); got != "X" {
		t.Fatalf("after a binary frame %q", got)
	}
	// a client close is ON_CLOSE "closed by the client"/1000 whatever its
	// code (the Node host)
	c.Close(websocket.StatusGoingAway, "")
	select {
	case got := <-f.closed:
		if got != "closed by the client/1000" {
			t.Fatalf("ON_CLOSE %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no ON_CLOSE")
	}
}

// a dump in ON_MESSAGE closes the socket 1011 "handler failed", and what
// the step sent goes nowhere (the Node host's queue)
func TestAPCDumpInMessage(t *testing.T) {
	f := &fakeHost{closed: make(chan string, 1)}
	_, url := serve(t, f)
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	read(t, c)
	c.Write(ctx, websocket.MessageText, []byte("dump"))
	_, _, err = c.Read(ctx)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.StatusInternalError || ce.Reason != "handler failed" {
		t.Fatalf("after a dump: %v", err)
	}
	select {
	case got := <-f.closed:
		if got != "closed by the client/1000" {
			t.Fatalf("ON_CLOSE %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no ON_CLOSE")
	}
}

// a dump while the handler starts is a 503 naming the handler
func TestAPCDumpAtStart(t *testing.T) {
	ch := &Channel{Name: "t", Handler: "ZCL_H", New: func(s *abap.Session, r *http.Request) Host {
		panic(abap.ArithmeticError{Class: "CX_SY_ZERODIVIDE", Op: "/"})
	}, Logf: func(string, ...any) {}}
	srv := httptest.NewServer(ch)
	defer srv.Close()
	_, resp, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("a dump at start: %v %v", err, resp)
	}
}

// the query as URLSearchParams reads it (outputs taken from Node 26)
func TestFormFields(t *testing.T) {
	for q, want := range map[string]string{
		"a=1&b=2":                `[[a 1] [b 2]]`,
		"a=%zz&b=%4":             `[[a %zz] [b %4]]`,
		"x;y=1&z=a+b":            `[[x;y 1] [z a b]]`,
		"=v&n=&&k":               `[[ v] [n ] [k ]]`,
		"%E2%82&%FF%FF=%C3%A9":   "[[\uFFFD ] [\uFFFD\uFFFD \u00e9]]",
		"a=b=c":                  `[[a b=c]]`,
		"%F0%9F%98%80=%ED%A0%80": "[[\U0001F600 \uFFFD\uFFFD\uFFFD]]",
	} {
		if got := fmt.Sprint(FormFields(q)); got != want {
			t.Errorf("%q: %s, want %s", q, got, want)
		}
	}
}

func TestRequestPath(t *testing.T) {
	for target, want := range map[string]string{"/sap/bc/apc/sap/zork/?a=1": "/sap/bc/apc/sap/zork", "/sap/bc/apc/sap/%7Aork": "/sap/bc/apc/sap/%7Aork"} {
		r := httptest.NewRequest("GET", target, nil)
		if got := RequestPath(r); got != want {
			t.Errorf("%s: %s", target, got)
		}
	}
}

func TestAPCReject(t *testing.T) {
	f := &fakeHost{reject: true, closed: make(chan string, 1)}
	_, url := serve(t, f)
	if _, resp, err := websocket.Dial(context.Background(), url, nil); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a rejected connection: %v %v", err, resp)
	}
}

// a request that is not a WebSocket handshake runs no ABAP: New is not
// called, and it is answered before anything else
func TestAPCNotAHandshake(t *testing.T) {
	f := &fakeHost{closed: make(chan string, 1)}
	srv, _ := serve(t, f)
	for _, c := range []struct {
		method string
		hdr    map[string]string
		want   int
	}{
		{"GET", nil, http.StatusUpgradeRequired},
		{"HEAD", nil, http.StatusUpgradeRequired},
		{"GET", map[string]string{"Connection": "Upgrade", "Upgrade": "websocket"}, http.StatusBadRequest},
		{"GET", map[string]string{"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13"}, http.StatusBadRequest},
		{"POST", map[string]string{"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}, http.StatusMethodNotAllowed},
	} {
		req, _ := http.NewRequest(c.method, srv.URL, nil)
		for k, v := range c.hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != c.want {
			t.Fatalf("%s %v: %d, want %d", c.method, c.hdr, resp.StatusCode, c.want)
		}
	}
	if f.news != 0 || len(f.calls) != 0 {
		t.Fatalf("ABAP ran for a request that is not a handshake: new %d, calls %v", f.news, f.calls)
	}
}

// a page of another origin is refused before any ABAP runs; a pattern lets it in
func TestAPCOrigin(t *testing.T) {
	f := &fakeHost{closed: make(chan string, 1)}
	_, url := serve(t, f)
	opts := &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"http://evil.example"}}}
	if _, resp, err := websocket.Dial(context.Background(), url, opts); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a cross-origin connection: %v %v", err, resp)
	}
	if f.news != 0 {
		t.Fatalf("ABAP ran for a refused origin")
	}

	g := &fakeHost{closed: make(chan string, 1)}
	ch := &Channel{Name: "t", OriginPatterns: []string{"*.example"}, New: func(s *abap.Session, r *http.Request) Host { return g }, Logf: func(string, ...any) {}}
	srv := httptest.NewServer(ch)
	defer srv.Close()
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), opts)
	if err != nil {
		t.Fatalf("an allowed origin: %v", err)
	}
	if got := read(t, c); got != "hello" {
		t.Fatalf("first message %q", got)
	}
	c.Close(websocket.StatusNormalClosure, "")
	<-g.closed

	// AnyOrigin: every origin, as the Node host (osgo sets it)
	h := &fakeHost{closed: make(chan string, 1)}
	any := &Channel{Name: "t", AnyOrigin: true, New: func(s *abap.Session, r *http.Request) Host { return h }, Logf: func(string, ...any) {}}
	srv2 := httptest.NewServer(any)
	defer srv2.Close()
	for _, o := range []string{"http://evil.example", "null"} {
		c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv2.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {o}}})
		if err != nil {
			t.Fatalf("AnyOrigin %s: %v", o, err)
		}
		read(t, c)
		c.Close(websocket.StatusNormalClosure, "")
		<-h.closed
	}
}

func TestAPCYieldSleep(t *testing.T) {
	for _, custom := range []bool{false, true} {
		t.Run(fmt.Sprint("custom=", custom), func(t *testing.T) {
			f := &fakeHost{yield: true, closed: make(chan string, 1)}
			var step func(*abap.Session, string, func()) error
			if custom {
				step = func(s *abap.Session, name string, work func()) error { return abap.APCStep(s, name, work) }
			}
			_, url := serve(t, f, step)
			c, _, err := websocket.Dial(context.Background(), url, nil)
			if err != nil {
				t.Fatal(err)
			}
			if got := read(t, c); got != "hello" {
				t.Fatal(got)
			}
			c.Close(websocket.StatusNormalClosure, "bye")
			<-f.closed
		})
	}
}
