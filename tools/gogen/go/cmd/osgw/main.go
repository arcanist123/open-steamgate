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
//
// The generation swap (ADR 0010 slice 4): -build "<command>" makes the
// gateway build a new generation after an activation that published (the
// command runs in the tree, -build-output is the executable it writes), and
// swap it in: started read-only beside the serving one, smoked (-smoke),
// promoted, the old one drained. Each generation's executable is kept under
// -gen-dir (default <root>/build/osgo-gen). The swap needs a database file
// (-home or -db among the sidecar's flags): a candidate of an in-memory
// database refuses.
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
	"strings"
	"time"

	"osg/gogen/genbuild"
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
	build := flag.String("build", "", `the command that builds a new generation after an activation, run in the tree (e.g. "node tools/gogen/osgo.mjs --fast"); none: no swap`)
	buildOutput := flag.String("build-output", "tools/gogen/.out/osgo", "the executable the build command writes, relative to the tree")
	genDir := flag.String("gen-dir", "", "where each generation's executable is kept (default <root>/build/osgo-gen with -build)")
	smoke := flag.String("smoke", "/health,/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata", "GET paths a candidate must answer 2xx before it is promoted, comma-separated")
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
	o := osgw.Options{Binary: bin, Args: args, StartTimeout: *startTimeout,
		LauncherIdentity: os.Getenv("OSD_LAUNCHER_IDENTITY"), Stdout: os.Stdout, Stderr: os.Stderr, Logf: log.Printf}
	if *build != "" {
		root := sidecarRoot(flag.Args())
		o.Root = root
		o.Builder = genbuild.Command{Argv: strings.Fields(*build), Output: *buildOutput, Log: os.Stderr}
		o.GenDir = *genDir
		if o.GenDir == "" {
			o.GenDir = filepath.Join(root, "build", "osgo-gen")
		}
		for _, p := range strings.Split(*smoke, ",") {
			if p = strings.TrimSpace(p); p != "" {
				o.Smoke = append(o.Smoke, p)
			}
		}
		log.Printf("osgw: builds after an activation: %q in %s, generations in %s", *build, root, o.GenDir)
		// a stashed generation runs from GenDir: what osgo finds beside its
		// own executable (the compiler sidecar osd, the media) it is told
		// where the first one had it
		o.Env, o.Args = besideBinary(bin, o.Args, os.Getenv)
	}
	g, err := osgw.Start(context.Background(), o)
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

// besideBinary: the compiler sidecar (osd) and the SMW0 media osgo looks
// for beside its executable, named explicitly (OSGO_SIDECAR, -media) for a
// copy that runs from elsewhere, unless they are named already
func besideBinary(bin string, args []string, getenv func(string) string) (env, out []string) {
	dir := filepath.Dir(bin)
	osd := filepath.Join(dir, "osd")
	if runtime.GOOS == "windows" {
		osd += ".exe"
	}
	if getenv("OSGO_SIDECAR") == "" {
		if st, err := os.Stat(osd); err == nil && !st.IsDir() {
			env = append(env, "OSGO_SIDECAR="+osd)
		}
	}
	out = args
	named := false
	for _, a := range args {
		if a == "-media" || a == "--media" || strings.HasPrefix(a, "-media=") || strings.HasPrefix(a, "--media=") {
			named = true
		}
	}
	if media := filepath.Join(dir, "media"); !named {
		if _, err := os.Stat(filepath.Join(media, "w3mi.json")); err == nil {
			out = append(append([]string{}, args...), "-media", media)
		}
	}
	return env, out
}

// sidecarRoot is the tree the sidecar is given (-root), else the current
// directory, absolute
func sidecarRoot(args []string) string {
	root := "."
	for i, a := range args {
		switch {
		case (a == "-root" || a == "--root") && i+1 < len(args):
			root = args[i+1]
		case strings.HasPrefix(a, "-root=") || strings.HasPrefix(a, "--root="):
			root = a[strings.Index(a, "=")+1:]
		}
	}
	if abs, err := filepath.Abs(root); err == nil {
		return abs
	}
	return root
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
