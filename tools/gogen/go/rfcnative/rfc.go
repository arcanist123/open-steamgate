// SPDX-License-Identifier: MIT

// Package rfcnative mounts the Apache-2.0 open-rfc-go bridge on OSG listeners.
package rfcnative

import (
	"context"
	"fmt"
	"net/http"
	"osg/gogen/instance"
	"osg/gogen/osdbind"
	"strconv"
	"time"

	"github.com/oisee/open-rfc-go/pkg/adtbridge"
)

// Config is startup configuration; credentials never appear in command arguments.
type Config struct {
	Enabled bool
	Port    int
	Options adtbridge.Options
}

// FromEnv validates the same independent RFC and backend identities as JS.
func FromEnv(enabled bool, sid string, env func(string) string) (Config, error) {
	c := Config{Enabled: enabled || env("OSD_OSGO_RFC") == "1"}
	if !c.Enabled {
		return c, nil
	}
	port := env("STG_RFC_PORT")
	if port == "" {
		derived, err := instance.Port(33, env("INSTANCE"))
		if err != nil {
			return c, err
		}
		port = strconv.Itoa(derived)
	}
	var err error
	c.Port, err = strconv.Atoi(port)
	if err != nil || c.Port < 0 || c.Port > 65535 {
		return c, fmt.Errorf("invalid STG_RFC_PORT")
	}
	c.Options = adtbridge.Options{
		Backend:  adtbridge.Backend{URL: "http://127.0.0.1", SystemID: sid, HostName: env("STG_HOST_NAME"), User: env("STG_ADT_USER"), Password: env("STG_ADT_PASSWORD"), Client: env("STG_ADT_CLIENT"), Language: env("STG_ADT_LANGUAGE")},
		AuthMode: env("STG_RFC_AUTH_MODE"), RFCUser: env("STG_RFC_USER"), RFCPassword: env("STG_RFC_PASSWORD"), RFCClient: env("STG_RFC_CLIENT"),
		Timeout: 30 * time.Second,
	}
	if err := adtbridge.Check(c.Options); err != nil {
		return c, err
	}
	return c, nil
}

// Start serves the native handler over private loopback: Backend has no custom
// RoundTripper hook. The dependency owns per-conversation cookies and CSRF.
// Cancel ctx to close listeners. Call once during host startup.
func Start(ctx context.Context, c Config, binds []string, handler http.Handler, logf func(string, ...any)) error {
	if !c.Enabled {
		return nil
	}
	if err := adtbridge.Check(c.Options); err != nil {
		return err
	}
	backend, err := osdbind.ListenAll([]string{osdbind.LoopbackV4}, 0)
	if err != nil {
		return err
	}
	options := c.Options
	options.Backend.URL = "http://" + backend[0].Addr().String()
	options.Log = logf
	if err := adtbridge.Check(options); err != nil {
		backend[0].Close()
		return err
	}
	listeners, err := osdbind.ListenAll(binds, c.Port)
	if err != nil {
		backend[0].Close()
		return err
	}
	server := &http.Server{Handler: stateful(handler), ReadHeaderTimeout: 30 * time.Second}
	go func() { <-ctx.Done(); server.Close() }()
	go func() {
		if err := server.Serve(backend[0]); err != nil && err != http.ErrServerClosed {
			logf("RFC backend: %v", err)
		}
	}()
	for _, ln := range listeners {
		go func() {
			if err := adtbridge.Serve(ctx, ln, options); err != nil {
				logf("RFC listener: %v", err)
			}
		}()
	}
	logf("native RFC listening on %s", osdbind.Describe(listeners))
	return nil
}

// Eclipse conversations retain their HTTP context even when the tunneled
// request omits the session header, as in the JS bridge. CSRF probes use it too.
func stateful(handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-SAP-ADT-SessionType") == "" {
			r.Header.Set("X-SAP-ADT-SessionType", "stateful")
		}
		handler.ServeHTTP(w, r)
	})
}
