package enq_test

import (
	"net"
	"testing"

	"osg/gogen/enq"
	"osg/gogen/enqnet"
)

// The contract with the table in another "process": every call crosses the
// E3 socket (go/enqnet), the _WAIT schedule runs on the client's side.
func TestContractOverSocket(t *testing.T) {
	enq.RunContract(t, func(t *testing.T) enq.Locks {
		srv := enq.New("osdhost_OSD_00")
		near, far := net.Pipe()
		go enqnet.ServeConn(srv, far, enqnet.ServeOptions{})
		c, err := enqnet.NewClient(near, enqnet.Hello{Generation: "go:test"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close(); srv.Close() })
		return c
	})
}
