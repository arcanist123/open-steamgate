package osgw

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
)

// a pooled connection the sidecar closes after reading the request: a GET
// is sent again on a fresh connection, a POST or DELETE is not -- it may
// have run (an ADT _action=LOCK, an OData function import) -- and answers
// with errNoAnswer, the caller's 503
func TestReplayOnlySafeMethods(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var mu sync.Mutex
	seen := map[string]int{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				for n := 0; ; n++ {
					req, err := http.ReadRequest(br)
					if err != nil {
						return
					}
					io.Copy(io.Discard, req.Body)
					mu.Lock()
					seen[req.Method+" "+req.URL.Path]++
					mu.Unlock()
					if n > 0 {
						return // the second request on a connection: read, and gone
					}
					io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
				}
			}(c)
		}
	}()
	p := &pool{sock: sock}
	defer p.close()
	do := func(method, path string) (int, error) {
		w := httptest.NewRecorder()
		err := p.forward(w, httptest.NewRequest(method, path, nil), nil)
		return w.Code, err
	}
	for _, m := range []string{"POST", "DELETE", "GET", "HEAD", "OPTIONS"} {
		if code, err := do("GET", "/warm"); err != nil || code != 200 {
			t.Fatalf("warm: %d %v", code, err)
		}
		code, err := do(m, "/x")
		mu.Lock()
		n := seen[m+" /x"]
		mu.Unlock()
		if safeMethod(m) {
			if err != nil || code != 200 || n != 2 {
				t.Fatalf("%s: %d %v, sent %d times; want replayed once", m, code, err, n)
			}
		} else if !errors.Is(err, errNoAnswer) || n != 1 {
			t.Fatalf("%s: %v, sent %d times; want no replay", m, err, n)
		}
	}
}
