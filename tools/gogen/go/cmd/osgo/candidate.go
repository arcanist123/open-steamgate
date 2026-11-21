package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync/atomic"

	"osg/gogen/abap"
	"osg/gogen/adtactivate"
	"osg/gogen/objstore"
	"osg/gogen/osgw"
	"osg/gogen/profiling"
)

// A swap candidate (-sidecar <dir> -candidate; ADR 0010 slice 4, step 3).
// The gateway starts the next generation beside the one that serves, on the
// same database file, and it must not write that file until it is promoted:
// the file is opened query_only (abap.OpenDBCandidate), and every write a
// start does -- the seed and the normalising UPDATEs of OpenDBFile, the
// demo rows, the status rows -- waits for POST /osd/promote. The boot step
// (the SEGW and search-help registries) writes no row and runs at start; a
// boot that tried would dump on the read-only connection and the candidate
// would not start. The smoke the gateway runs reaches it through ordinary
// requests, each a dialog step on a read transaction. At promotion the file
// is opened again for writing, the deferred writes run, and the read-only
// database is closed. A candidate whose tables are not the file's refuses
// at once: it says why in osgw.RefusedFile and exits 4, and the gateway
// refuses the swap (X-OSD-Build: built; schema differs, restart needed).
//
// The ADR sketched the boot writes into an attached in-memory schema read
// through union views and flushed at promotion. Deferring them is the same
// outcome on the shared file with no view layer: nothing of the candidate's
// reaches the file before promotion, and a promotion that fails leaves it
// as the serving generation left it (the normalising UPDATEs of the
// promotion's open are one transaction, dbstore.go).
var candidate atomic.Bool

// refuseCandidate tells the gateway why this candidate will not serve, and
// exits 4
func refuseCandidate(dir, why string, schema bool) {
	raw, _ := json.Marshal(osgw.Refusal{Why: why, Schema: schema})
	if err := os.WriteFile(osgw.RefusedFile(dir, os.Getpid()), raw, 0o600); err != nil {
		log.Printf("candidate: %v", err)
	}
	log.Printf("candidate: refused: %s", why)
	os.Exit(4)
}

func openCandidateDB(dir, file string) *abap.Database {
	d, err := abap.OpenDBCandidate(file, dbScript)
	if err != nil {
		var se *abap.SchemaError
		refuseCandidate(dir, err.Error(), errors.As(err, &se))
	}
	return d
}

// promoteRoute is POST /osd/promote, the gateway's door (it refuses a
// client's request to this path before it reaches a sidecar): the database
// opened for writing in place of the read-only one, then the boot's
// deferred writes. 200 when this process may serve; anything else and the
// gateway ends it, the generation that served before serving on.
func promoteRoute(dbFile string, status statusHost) route {
	return route{"/osd/promote", true, func(w http.ResponseWriter, r *http.Request) {
		profiling.Matched(r, "/osd/promote")
		if r.Method != http.MethodPost {
			notFound(w, r)
			return
		}
		if err := promote(dbFile); err != nil {
			log.Printf("candidate: promotion failed: %v", err)
			http.Error(w, err.Error(), 500)
			return
		}
		rows, err := refreshStatus(status)
		if err != nil {
			log.Printf("status refresh: %v", err)
		}
		log.Printf("candidate: promoted; the database is open for writing, %d status rows", rows)
		fmt.Fprint(w, "promoted")
	}}
}

func promote(dbFile string) error {
	stepLock().Lock()
	defer stepLock().Unlock()
	if !candidate.Load() {
		return nil // promoted already
	}
	d, _, err := abap.OpenDBFile(dbFile, dbScript)
	if err != nil {
		return err
	}
	readOnly := instance.DB
	instance.DB = d
	if readOnly != nil {
		_ = readOnly.Close()
	}
	// the pool's connections were the read-only database's: new ones, on the
	// file as it is open now, for the writes a serving generation runs
	if wp != nil {
		wp.Close()
	}
	candidate.Store(false)
	openWorkProcesses(dbFile, workProcessCount)
	mintADTState()
	runDemoData() // a dump there is logged, and the generation serves without the rows
	return nil
}

// useGatewayBuilds: the gateway builds a new generation after an activation
// (go/osgw). The activation's answer asks it to, unless an object of the
// tree is inactive: the build reads the tree, and an inactive object's
// working source would go live without being activated. Then the answer
// says so and nothing is built; the next activation that leaves nothing
// inactive asks. The answer's gate is a sample from the moment it is
// composed; the gateway asks again at build start (inactiveRoute below).
func useGatewayBuilds() {
	adtactivate.Builds = func() (string, string) {
		if n := len(objstore.Inactive()); n > 0 {
			return fmt.Sprintf("published; not building: %d inactive object(s) would enter the build", n),
				fmt.Sprintf("is active in the object store; the gateway builds a new generation once no object is inactive (%d now)", n)
		}
		return "published; building",
			"is active in the object store; the gateway is building a new generation from this tree, and this code runs once it serves"
	}
}

// inactiveRoute is GET /osd/inactive, the gateway's build-time gate
// (gatedBuilder, go/osgw swap.go): how many objects of the tree are
// inactive in this generation's store. The gateway asks every generation
// that still takes requests right before a build reads the tree, because a
// save that is not activated can land between the activation answer and
// the build.
func inactiveRoute() route {
	return route{"/osd/inactive", true, func(w http.ResponseWriter, r *http.Request) {
		profiling.Matched(r, "/osd/inactive")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			notFound(w, r)
			return
		}
		n := len(objstore.Inactive())
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(200)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		fmt.Fprintf(w, "{\"inactive\":%d}\n", n)
	}}
}

// restorePublished brings back what activation published before this
// process started (objstore's index, ADR 0010 slice 4)
func restorePublished() {
	n, err := objstore.RestorePublished()
	if err != nil {
		log.Printf("store: the published index: %v", err)
	} else if n > 0 {
		log.Printf("store: %d published file(s) restored from build/osgo-published", n)
	}
}
