package main

import (
	"net"
	"testing"

	"osg/gogen/abap"
	"osg/gogen/enq"
	"osg/gogen/enqnet"
)

// -sidecar puts the ADT kernel, the step glue and the generated seam on the
// gateway's table: a lock a step takes is a row there, owned by this
// generation, and the end of the step releases it there (sidecar.go).
func TestSidecarLocksAreTheGatewayTable(t *testing.T) {
	table := enq.New("osgw")
	defer table.Close()
	near, far := net.Pipe()
	go enqnet.ServeConn(table, far, enqnet.ServeOptions{InlineUpdates: true})
	client, err := enqnet.NewClient(near, enqnet.Hello{Generation: buildGeneration})
	if err != nil {
		t.Fatal(err)
	}
	own := adtLocks
	useLocks(client)
	defer func() { useLocks(own); client.Close() }()

	step := &abap.Session{}
	adtHost.Begin(step)
	if res, err := adtHost.Enqueue(step, lockRequest("SIDECAR"), nil); err != nil || res.Subrc != 0 {
		t.Fatalf("enqueue: %+v %v", res, err)
	}
	rows := table.Read(enq.Filter{Table: "ZOSD_CMD"})
	if len(rows) != 1 || rows[0].Generation != buildGeneration {
		t.Fatalf("the gateway's table: %+v", rows)
	}
	if own.Read(enq.Filter{Table: "ZOSD_CMD"}) != nil {
		t.Fatal("the lock went to the process's own table")
	}
	adtHost.Finish(step, false)
	if rows := table.Read(enq.Filter{Table: "ZOSD_CMD"}); len(rows) != 0 {
		t.Fatalf("after the step: %+v", rows)
	}
}
