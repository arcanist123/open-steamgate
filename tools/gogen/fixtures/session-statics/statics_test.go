package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"osg/gogen/abap"
	"osg/gogen/apc"
)

func TestSessionStatics(t *testing.T) {
	const workers = 8
	var ready, done sync.WaitGroup
	ready.Add(workers)
	done.Add(workers)
	start := make(chan struct{})
	values, counts := make([]int32, workers), make([]int32, workers)
	for w := range workers {
		go func() {
			defer done.Done()
			s := &abap.Session{}
			ready.Done()
			<-start
			values[w] = ZCL_RACE_INIT_READ(s)
			for range 10000 {
				counts[w] = ZCL_RACE_COUNTER_INCREMENT(s)
			}
		}()
	}
	ready.Wait()
	close(start)
	done.Wait()
	for w := range workers {
		if values[w] != 42 {
			t.Errorf("session %d init: got %d, want 42", w, values[w])
		}
		if counts[w] != 10000 {
			t.Errorf("session %d counter: got %d, want 10000", w, counts[w])
		}
	}
	// A new zero session resets both attributes and constructor state.
	s := &abap.Session{}
	if got := ZCL_RACE_INIT_READ(s); got != 42 {
		t.Errorf("fresh init: %d", got)
	}
	if got := ZCL_RACE_COUNTER_INCREMENT(s); got != 1 {
		t.Errorf("fresh counter: %d", got)
	}
}

var benchmarkCount int32

func BenchmarkSessionStaticIncrement(b *testing.B) {
	s := &abap.Session{}
	ZCL_RACE_COUNTER_INCREMENT(s) // initialize outside the measured loop
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		benchmarkCount = ZCL_RACE_COUNTER_INCREMENT(s)
	}
}

func TestInheritedAndReferencedStatics(t *testing.T) {
	a, b := &abap.Session{}, &abap.Session{}
	if got := ZCL_RACE_READER_READ(a); got != 8 {
		t.Fatalf("cross-class init: %d", got)
	}
	if got := ZCL_RACE_CHILD_REFERENCES(a); got != 19 {
		t.Fatalf("static references: %d", got)
	}
	if got := ZCL_RACE_READER_READ(a); got != 19 {
		t.Fatalf("inherited storage: %d", got)
	}
	if got := ZCL_RACE_READER_READ(b); got != 8 {
		t.Fatalf("fresh inherited storage: %d", got)
	}
	if got := ZCL_RACE_READER_INITIAL(a); got != 1 {
		t.Fatalf("ABAP initial values: %d", got)
	}
	for _, s := range []*abap.Session{a, b, a} {
		if got := ZCL_RACE_READER_OWNED(s); got != 2 {
			t.Fatalf("owned buffer/CLEAR: %d", got)
		}
	}
}

// Exercise the actual APC HTTP host: it creates a new Session per connection.
type counterHost struct {
	count  int32
	closed chan struct{}
}

func (h *counterHost) Open(s *abap.Session) bool                        { return true }
func (h *counterHost) Message(s *abap.Session, text string)             {}
func (h *counterHost) Close(s *abap.Session, reason string, code int32) { close(h.closed) }
func (h *counterHost) Drain(s *abap.Session) []string {
	if h.count == 0 {
		return nil
	}
	text := fmt.Sprint(h.count)
	h.count = 0
	return []string{text}
}
func TestHostStaticsAcrossRequests(t *testing.T) {
	instance := abap.NewInstance(nil)
	abap.WorkProcess.Lock()
	ZCL_RACE_COUNTER_RESET(instance.NewSession())
	abap.WorkProcess.Unlock()
	closed := make(chan chan struct{}, 2)
	channel := &apc.Channel{Name: "counter", NewSession: instance.NewSession, New: func(s *abap.Session, r *http.Request) apc.Host {
		h := &counterHost{count: ZCL_RACE_COUNTER_INCREMENT(s), closed: make(chan struct{})}
		closed <- h.closed
		return h
	}, Logf: func(string, ...any) {}}
	server := httptest.NewServer(channel)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for want := 1; want <= 2; want++ {
		connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		_, message, err := connection.Read(ctx)
		connection.Close(websocket.StatusNormalClosure, "")
		select {
		case <-<-closed:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		if err != nil {
			t.Fatal(err)
		}
		if string(message) != fmt.Sprint(want) {
			t.Fatalf("request %d: got %s", want, message)
		}
	}
}
