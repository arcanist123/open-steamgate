package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"osg/gogen/abap"
)

// openDatabase opens what the instance runs on: the in-memory database, a
// -db file (seeded once, stamped with its schema fingerprint, go/dbschema),
// or, for a swap candidate, that file read-only until its promotion
// (candidate.go). A candidate without a file refuses: an in-memory
// database dies with its generation, so a swap would lose every row.
func openDatabase(dbFile, sidecarDir string) {
	switch {
	case dbFile == "" && candidate.Load():
		refuseCandidate(sidecarDir, "a swap needs a database file (-home or -db): an in-memory database dies with its generation; restart instead", false)
	case dbFile == "":
		d, err := abap.OpenDB(dbScript)
		if err != nil {
			log.Fatalf("database: %v", err)
		}
		instance = abap.NewInstance(d)
		log.Printf("database: in memory (use -home or -db to keep data)")
		abap.HostFacts = append(abap.HostFacts, "database\tSQLite (modernc.org/sqlite, pure Go), in memory, seeded at start")
	case candidate.Load():
		instance = abap.NewInstance(openCandidateDB(sidecarDir, dbFile))
		log.Printf("database: %s (WAL), read-only until promoted", dbFile)
		abap.HostFacts = append(abap.HostFacts, "database\tSQLite (modernc.org/sqlite, pure Go), file "+filepath.Base(dbFile)+", WAL")
	default:
		d, seeded, err := abap.OpenDBFile(dbFile, dbScript)
		if err != nil {
			log.Fatalf("database: %v", err)
		}
		instance = abap.NewInstance(d)
		log.Printf("database: %s (WAL)%s", dbFile, map[bool]string{true: ", new: seeded", false: ", as it was"}[seeded])
		abap.HostFacts = append(abap.HostFacts, "database\tSQLite (modernc.org/sqlite, pure Go), file "+filepath.Base(dbFile)+", WAL")
	}
}

// runDemoData writes the synthetic demo rows (ZCL_OSD_DEMO_DATA=>BOOT, as
// the Node hosts run it through tools/osd-demo-data.mjs): the same class and
// the same knob, OSD_DEMO_ROWS; one dialog step of its own, and a dump there
// is reported and the server starts without the rows
func runDemoData() {
	if !hasDemoData {
		return
	}
	started := time.Now()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("demo data: ZCL_OSD_DEMO_DATA=>BOOT failed, serving without it: %s  at %s", dumpText(r), strings.Join(abapStack(r), " <- "))
		}
	}()
	var report string
	if err := runSystemStep(abap.WriteStep, "demo data", func(s *abap.Session) {
		report = demoData(s, os.Getenv("OSD_DEMO_ROWS"))
	}); err != nil {
		log.Printf("demo data: %v", err)
	}
	log.Printf("demo data: %s (%d ms)", report, time.Since(started).Milliseconds())
}
