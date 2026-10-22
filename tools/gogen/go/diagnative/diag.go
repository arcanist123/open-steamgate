// SPDX-License-Identifier: MIT

// Package diagnative mounts the existing open-diag-go tape service.
package diagnative

import (
	"context"
	"fmt"
	"net"
	"osg/gogen/instance"
	"osg/gogen/osdbind"
	"strconv"
	"sync"

	"github.com/oisee/open-diag-go/pkg/lsd"
)

// Port selects the optional DIAG listener; a negative port means disabled.
func Port(enabled bool, env func(string) string) (int, error) {
	if !enabled && env("OSD_OSGO_DIAG") != "1" {
		return -1, nil
	}
	text := env("STG_DIAG_PORT")
	if text == "" {
		text = env("DIAG_PORT")
	}
	if text == "" {
		derived, err := instance.Port(32, env("INSTANCE"))
		if err != nil {
			return 0, err
		}
		text = strconv.Itoa(derived)
	}
	port, err := strconv.Atoi(text)
	if err != nil || port < 0 || port > 65535 {
		return 0, fmt.Errorf("invalid DIAG port")
	}
	return port, nil
}

// Start calls lsd.Serve exactly once: that API sets package-global render state.
// A fan-in listener lets that one service accept both loopback address families.
// Call once during host startup, before clients connect.
func Start(ctx context.Context, port int, binds []string, logf func(string, ...any)) error {
	if port < 0 {
		return nil
	}
	listeners, err := osdbind.ListenAll(binds, port)
	if err != nil {
		return err
	}
	ln := &joined{listeners: listeners, incoming: make(chan accepted), done: make(chan struct{})}
	for _, listener := range listeners {
		go func() {
			for {
				c, err := listener.Accept()
				select {
				case ln.incoming <- accepted{c, err}:
				case <-ln.done:
					if c != nil {
						c.Close()
					}
					return
				}
				if err != nil {
					return
				}
			}
		}()
	}
	go func() {
		defer ln.Close()
		if err := lsd.Serve(ctx, ln, lsd.Options{Stub: "tape", Log: logf}); err != nil {
			logf("DIAG listener: %v", err)
		}
	}()
	logf("native DIAG tape listening on %s", osdbind.Describe(listeners))
	return nil
}

type accepted struct {
	conn net.Conn
	err  error
}
type joined struct {
	listeners []net.Listener
	incoming  chan accepted
	done      chan struct{}
	once      sync.Once
}

func (j *joined) Accept() (net.Conn, error) {
	select {
	case a := <-j.incoming:
		return a.conn, a.err
	case <-j.done:
		return nil, net.ErrClosed
	}
}
func (j *joined) Close() error {
	j.once.Do(func() {
		close(j.done)
		for _, ln := range j.listeners {
			ln.Close()
		}
	})
	return nil
}
func (j *joined) Addr() net.Addr { return j.listeners[0].Addr() }
