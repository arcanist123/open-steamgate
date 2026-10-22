// Test-only launcher for replaying the existing JS wire assertions.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"osg/gogen/diagnative"
	"osg/gogen/rfcnative"
)

func main() {
	var c struct {
		Kind    string
		Env     map[string]string
		Backend string
	}
	if err := json.NewDecoder(os.Stdin).Decode(&c); err != nil {
		panic(err)
	}
	env := func(k string) string { return c.Env[k] }
	logf := func(f string, args ...any) { fmt.Printf(f+"\n", args...) }
	ctx := context.Background()
	if c.Kind == "diag" {
		port, err := diagnative.Port(true, env)
		if err != nil {
			panic(err)
		}
		if err := diagnative.Start(ctx, port, []string{"127.0.0.1"}, logf); err != nil {
			panic(err)
		}
	} else {
		config, err := rfcnative.FromEnv(true, "OSD", env)
		if err != nil {
			panic(err)
		}
		target, err := url.Parse(c.Backend)
		if err != nil {
			panic(err)
		}
		var handler http.Handler = httputil.NewSingleHostReverseProxy(target)
		if err := rfcnative.Start(ctx, config, []string{"127.0.0.1"}, handler, logf); err != nil {
			panic(err)
		}
	}
	select {}
}
