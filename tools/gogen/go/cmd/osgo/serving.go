package main

import (
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"osg/gogen/profiling"
	"osg/gogen/serving"
)

// The supervised-host contract (go/serving, ADR 0010 slice 1): GET
// /osd/serving, X-OSD-Generation on every answer, the drain on a signal.
// The generation is the one the status tables already name, buildGeneration
// (zz_status.go): the program itself, by content.
func newServingHost(root, dbFile string, started time.Time) *serving.Host {
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	return serving.New(serving.Options{Generation: buildGeneration, Root: root, Database: dbFile,
		LauncherIdentity: os.Getenv("OSD_LAUNCHER_IDENTITY"), Started: started, Logf: log.Printf,
		Extra: wpServing})
}

func servingRoute(host *serving.Host) route {
	door := host.Serving(http.HandlerFunc(notFound))
	return route{"/osd/serving", true, func(w http.ResponseWriter, r *http.Request) {
		profiling.Matched(r, "/osd/serving")
		door(w, r)
	}}
}

// serveUntilSignal answers on the listener until SIGTERM, SIGINT or SIGHUP;
// the stop is then the host's: refuse newcomers, finish the steps in flight,
// close the listeners, close the database under the work process, exit 0 --
// within serving.DefaultGrace (55 s). Serve returns ErrServerClosed when the
// listeners go; the process ends in the stop, not here.
func serveUntilSignal(host *serving.Host, server *http.Server, ln net.Listener) {
	go host.OnSignal(nil, serving.Stop{Shutdown: server.Shutdown, Lock: stepLock(), Final: closeDatabase, Exit: os.Exit})
	if err := server.Serve(ln); err != http.ErrServerClosed {
		log.Fatal(err)
	}
	select {}
}

// closeDatabase commits nothing: every dialog step committed or rolled back
// when it ended (abap.DialogStep). The pool's connections go first (a step
// that still runs would fail on its own connection error, which the drain
// has waited out); closing a WAL file checkpoints it.
func closeDatabase() {
	if wp != nil {
		if err := wp.Close(); err != nil {
			log.Printf("work processes close: %v", err)
		}
	}
	if adtState.pool != nil {
		adtState.pool.Close()
	}
	if instance == nil || instance.DB == nil {
		return
	}
	if err := instance.DB.Close(); err != nil {
		log.Printf("database close: %v", err)
	}
}
