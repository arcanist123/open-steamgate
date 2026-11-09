package osgw

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// forward is the hop for every request but a WebSocket upgrade: the
// request written to a pooled connection to the sidecar and its answer
// copied back, in the request's own goroutine. httputil.ReverseProxy with
// an http.Transport does the same through a read and a write goroutine per
// connection and channels between them; on the OData bench that hand-off
// was a fifth of the gateway's CPU (futex, the scheduler), measured before
// this was written (ADR 0010 slice 3, the hop). Upgrades still go through
// ReverseProxy, which knows how to hand a connection over.
type upstream struct {
	conn net.Conn
	br   *bufio.Reader
	bw   *bufio.Writer
}

type pool struct {
	sock   string
	mu     sync.Mutex
	idle   []*upstream
	closed bool
}

const maxIdle = 256

func (p *pool) get(ctx context.Context) (u *upstream, reused bool, err error) {
	p.mu.Lock()
	if n := len(p.idle); n > 0 {
		u = p.idle[n-1]
		p.idle = p.idle[:n-1]
		p.mu.Unlock()
		return u, true, nil
	}
	p.mu.Unlock()
	var d net.Dialer
	c, err := d.DialContext(ctx, "unix", p.sock)
	if err != nil {
		return nil, false, err
	}
	return &upstream{conn: c, br: bufio.NewReaderSize(c, 16<<10), bw: bufio.NewWriterSize(c, 16<<10)}, false, nil
}

func (p *pool) put(u *upstream) {
	p.mu.Lock()
	if p.closed || len(p.idle) >= maxIdle {
		p.mu.Unlock()
		u.conn.Close()
		return
	}
	p.idle = append(p.idle, u)
	p.mu.Unlock()
}

func (p *pool) close() {
	p.mu.Lock()
	p.closed = true
	idle := p.idle
	p.idle = nil
	p.mu.Unlock()
	for _, u := range idle {
		u.conn.Close()
	}
}

// hop-by-hop headers (RFC 9110 7.6.1), never forwarded; Expect too: the
// gateway has already accepted the body it streams
var hopHeaders = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade", "Expect"}

func dropHop(h http.Header) {
	for _, f := range h.Values("Connection") {
		for _, name := range strings.Split(f, ",") {
			if name = strings.TrimSpace(name); name != "" {
				h.Del(name)
			}
		}
	}
	for _, name := range hopHeaders {
		h.Del(name)
	}
}

var copyBufs = sync.Pool{New: func() any { b := make([]byte, 32<<10); return &b }}

// errNoAnswer: nothing reached the client, so the caller may still answer 503
var errNoAnswer = errors.New("the sidecar gave no answer")

// forward sends r to the sidecar and copies its answer to w. An error
// wrapping errNoAnswer means nothing was written to w.
func (p *pool) forward(w http.ResponseWriter, r *http.Request, onResponse func(*http.Response)) error {
	out := r.Clone(r.Context())
	out.RequestURI, out.Close = "", false
	dropHop(out.Header)
	if _, ok := out.Header["User-Agent"]; !ok {
		out.Header["User-Agent"] = []string{""} // Request.Write adds none then, as ReverseProxy does
	}
	// A request without a body may be sent again on a fresh connection when
	// a pooled one turns out to be closed by the sidecar meanwhile -- but
	// only when sending it twice cannot do anything twice: the method is
	// idempotent and safe (GET, HEAD, OPTIONS, TRACE), or the request never
	// reached the sidecar (its write failed). A POST or DELETE that was
	// written and got no answer may have run (an ADT _action=LOCK, an OData
	// function import): it answers 503 and the client decides. The same
	// rule as net/http's Transport.
	bodyless := r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0
	for attempt := 0; ; attempt++ {
		u, reused, err := p.get(r.Context())
		if err != nil {
			return errors.Join(errNoAnswer, err)
		}
		resp, written, err := u.roundTrip(out)
		if err != nil {
			u.conn.Close()
			if reused && bodyless && (!written || safeMethod(r.Method)) && attempt == 0 && r.Context().Err() == nil {
				continue
			}
			return errors.Join(errNoAnswer, err)
		}
		if onResponse != nil {
			onResponse(resp)
		}
		dropHop(resp.Header)
		h := w.Header()
		for k, v := range resp.Header {
			h[k] = v
		}
		w.WriteHeader(resp.StatusCode)
		bp := copyBufs.Get().(*[]byte)
		var dst io.Writer = w
		if resp.ContentLength < 0 {
			if f, ok := w.(http.Flusher); ok {
				dst = flushWriter{w, f} // a streamed answer reaches the client as it comes
			}
		}
		_, err = io.CopyBuffer(dst, resp.Body, *bp)
		copyBufs.Put(bp)
		resp.Body.Close()
		if err != nil || resp.Close {
			u.conn.Close()
		} else {
			p.put(u)
		}
		return nil
	}
}

// safeMethod: sending it twice does nothing twice (RFC 9110 9.2.1)
func safeMethod(m string) bool {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return true
	}
	return false
}

// roundTrip writes the request and reads its answer; written says whether
// the request was handed to the connection in full (a failed write never
// reached the sidecar whole, so it cannot have run)
func (u *upstream) roundTrip(out *http.Request) (resp *http.Response, written bool, err error) {
	if err := out.Write(u.bw); err != nil {
		return nil, false, err
	}
	if err := u.bw.Flush(); err != nil {
		return nil, false, err
	}
	for {
		resp, err := http.ReadResponse(u.br, out)
		if err != nil {
			return nil, true, err
		}
		// an interim answer (100, 102, 103) is not the answer
		if resp.StatusCode >= 100 && resp.StatusCode < 200 && resp.StatusCode != http.StatusSwitchingProtocols {
			continue
		}
		return resp, true, nil
	}
}

type flushWriter struct {
	w io.Writer
	f http.Flusher
}

func (fw flushWriter) Write(b []byte) (int, error) {
	n, err := fw.w.Write(b)
	fw.f.Flush()
	return n, err
}
