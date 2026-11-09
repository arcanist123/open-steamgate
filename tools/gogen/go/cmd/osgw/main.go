// osgw: the stable gateway in front of an osgo generation (go/osgw,
// ADR 0010 slice 3). It listens on the port osgo would, owns the lock
// table, starts the osgo binary as its sidecar and proxies every request.
//
//	osgw [-binary <osgo>] [-port N] [-addr A] [-- <osgo flags: -adt -root ... -home ...>]
//
// Same port and address rules as osgo (-port, OSD_PORT, STG_PORT, INSTANCE,
// 3095; -addr, OSD_BIND, loopback). The sidecar gets -port N too, so what it
// reports names the public port. SIGTERM, SIGINT or SIGHUP: refuse
// newcomers, finish what is in flight, drain the sidecar, exit 0 within the
// grace (55 s). HTTPS, native RFC and DIAG are not the gateway's yet: osgo
// flags for them go to the sidecar, which opens those listeners itself.
package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"osg/gogen/hostports"
	"osg/gogen/osdbind"
	"osg/gogen/osgw"
	"osg/gogen/serving"
)

func main() {
	binary := flag.String("binary", "", "the osgo executable to run as the sidecar (default: osgo beside osgw, else on PATH)")
	portFlag := flag.String("port", "", "HTTP port (OSD_PORT, STG_PORT, else 80nn with INSTANCE or 3095)")
	addr := flag.String("addr", "", "address to listen on (default OSD_BIND, else loopback)")
	startTimeout := flag.Duration("start-timeout", 3*time.Minute, "how long a sidecar may take to become ready")
	flag.Parse()
	explicit := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { explicit[f.Name] = true })
	port, _, err := hostports.SelectedHTTP(*portFlag, explicit["port"], os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	bin, err := sidecarBinary(*binary)
	if err != nil {
		log.Fatal(err)
	}
	args := append([]string{"-port", strconv.Itoa(port)}, flag.Args()...)
	g, err := osgw.Start(context.Background(), osgw.Options{Binary: bin, Args: args, StartTimeout: *startTimeout,
		LauncherIdentity: os.Getenv("OSD_LAUNCHER_IDENTITY"), Stdout: os.Stdout, Stderr: os.Stderr, Logf: log.Printf})
	if err != nil {
		log.Fatal(err)
	}
	binds := osdbind.Selected(*addr, explicit["addr"], os.Getenv)
	lns, err := osdbind.ListenAll(binds, port)
	if err != nil {
		g.Stop(context.Background())
		log.Fatal(err)
	}
	server := &http.Server{Handler: g.Handler(), ReadHeaderTimeout: 30 * time.Second}
	for _, extra := range lns[1:] {
		go func(ln net.Listener) { log.Printf("listener %s: %v", ln.Addr(), server.Serve(ln)) }(extra)
	}
	log.Printf("osgw: http://localhost:%d (%s) -> sidecar %s, locks on %s", port, osdbind.Describe(lns), bin, osgw.LockSocket(g.Dir()))
	go g.Host().OnSignal(nil, serving.Stop{
		Shutdown: server.Shutdown,
		Final:    func() { g.Stop(context.Background()) },
		Exit:     func(code int) { g.Kill(); os.Exit(code) },
	})
	go func() {
		// the restart limit: exit non-zero so a supervisor sees it, rather
		// than answer 503 phase failed forever
		<-g.Failed()
		log.Printf("osgw: %s; exiting", g.FailedWhy())
		g.Kill()
		os.Exit(1)
	}()
	if err := server.Serve(lns[0]); err != http.ErrServerClosed {
		g.Kill()
		log.Fatal(err)
	}
	select {}
}

func sidecarBinary(flagValue string) (string, error) {
	if flagValue != "" {
		return filepath.Abs(flagValue)
	}
	if exe, err := os.Executable(); err == nil {
		name := "osgo"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		beside := filepath.Join(filepath.Dir(exe), name)
		if _, err := os.Stat(beside); err == nil {
			return beside, nil
		}
	}
	return exec.LookPath("osgo")
}
