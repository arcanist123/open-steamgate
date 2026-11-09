// The ZO4D demo channel served by the compiled ABAP (tools/gogen), and every
// other request proxied to an OSG server, so the page, the audio and the
// images are that server's and only the frames come from here.
//
//	go run ./cmd/o4dserve -listen :3092 (OSD_BIND, default loopback) -upstream http://127.0.0.1:3091
//
// The APC framework is the library's (apc.Channel, go/apc/apc.go)
// around open-abap-apc's ZCL_APC_HOST, compiled with the demo: a host per
// socket, ON_ACCEPT and ON_START before the upgrade, each message to the
// handler's own ON_MESSAGE, ON_CLOSE, what SEND queued written after each
// step. This file is only the adapter from the program's types to the
// library's and the proxy.
package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"osg/gogen/abap"
	"osg/gogen/apc"
	"osg/gogen/osdbind"
)

// apcHost is ZCL_APC_HOST as the library's apc.Host
type apcHost struct{ h *ZCL_APC_HOST }

func (a apcHost) Open(s *abap.Session) bool         { return a.h.OPEN(s) == "X" }
func (a apcHost) Message(s *abap.Session, t string) { a.h.MESSAGE(s, t) }
func (a apcHost) Close(s *abap.Session, reason string, code int32) {
	a.h.CLOSE(s, reason, code)
}
func (a apcHost) Drain(s *abap.Session) []string { return a.h.DRAIN(s) }

// instance: no database, one statics store shared by every socket's
// session, which is what the process had before sessions owned their state
var instance = abap.NewInstance(nil)

// Channel is an APC application of this program by its handler class.
func Channel(app, handler string) *apc.Channel {
	return &apc.Channel{Name: app, NewSession: instance.NewSession, New: func(s *abap.Session, r *http.Request) apc.Host {
		// the query of the upgrade request, as ZCL_APC_INITIAL_REQUEST's
		// form fields
		fields := []IHTTPNVP{}
		for k, vs := range r.URL.Query() {
			for _, v := range vs {
				fields = append(fields, IHTTPNVP{name: k, value: v})
			}
		}
		return apcHost{New_ZCL_APC_HOST(s, handler, &fields)}
	}}
}

func main() {
	listen := flag.String("listen", ":3092", "address to serve; a bare port takes OSD_BIND (default loopback)")
	upstream := flag.String("upstream", "http://127.0.0.1:3091", "OSG server for everything but the demo channel")
	origins := flag.String("origins", "", "comma-separated origin host patterns allowed besides the page's own (path.Match, e.g. 'localhost:*'); empty is same origin only")
	flag.Parse()
	u, err := url.Parse(*upstream)
	if err != nil {
		log.Fatal(err)
	}
	ch := Channel("zo4d_demo", "ZCL_O4D_APC_HANDLER")
	// the page comes through the proxy below, so it is same origin; a page
	// served from elsewhere has to be named
	for _, o := range strings.Split(*origins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			ch.OriginPatterns = append(ch.OriginPatterns, o)
		}
	}
	ch.Step = func(s *abap.Session, name string, work func()) error {
		t0 := time.Now()
		err := abap.APCStep(s, name, work)
		if d := time.Since(t0); d > 200*time.Millisecond {
			log.Printf("slow step %s %v", name, d)
		}
		return err
	}
	http.Handle("/sap/bc/apc/sap/zo4d_demo", ch)
	http.Handle("/sap/bc/apc/sap/zo4d_demo/", ch)
	http.Handle("/", httputil.NewSingleHostReverseProxy(u))
	// the catch-all proxy above reaches the loopback backend, ADT included:
	// a bare port listens where OSD_BIND says, loopback unless told
	lns, err := osdbind.ListenFlag(*listen, os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("ZO4D frames from Go on %s, the rest from %s", osdbind.Describe(lns), *upstream)
	for _, ln := range lns[1:] {
		go func(ln net.Listener) { log.Printf("listener %s: %v", ln.Addr(), http.Serve(ln, nil)) }(ln)
	}
	log.Fatal(http.Serve(lns[0], nil))
}
