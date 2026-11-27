package main

import (
	"fmt"
	"log"
	"net"
	"os"

	"osg/gogen/enqnet"
	"osg/gogen/osdbind"
	"osg/gogen/osgw"
)

// -sidecar <dir>: this process is the work sidecar of a gateway (cmd/osgw,
// go/osgw; ADR 0010 slice 3). The gateway owns the public port and the
// lock table; the sidecar answers HTTP on a Unix socket in dir that the
// gateway proxies to (osgw.SidecarSocket: one per pid, so two sidecars of
// a later swap never share one) and takes its locks from the gateway's
// table over osgw.LockSocket, as an owner of its own generation. When
// that connection goes the gateway is gone: nobody can reach this process
// any more and its locks are released, so it leaves rather than hold the
// database as an orphan.
func startSidecarLocks(dir string) {
	if dir == "" {
		return
	}
	locks, err := enqnet.Dial("unix", osgw.LockSocket(dir),
		enqnet.Hello{Generation: buildGeneration, PID: os.Getpid(), Name: fmt.Sprintf("osgo sidecar pid %d", os.Getpid())})
	if err != nil {
		log.Fatalf("sidecar: the gateway's lock server: %v", err)
	}
	useLocks(locks)
	go func() {
		<-locks.Done()
		log.Printf("sidecar: the gateway's lock server is gone (%v): leaving", locks.Err())
		os.Exit(3)
	}()
}

// listeners are the public ones (osdbind), or for a sidecar the one Unix
// socket the gateway proxies to: the gateway owns the public port
func listeners(dir string, binds []string, port int) []net.Listener {
	if dir == "" {
		lns, err := osdbind.ListenAll(binds, port)
		if err != nil {
			log.Fatal(err)
		}
		return lns
	}
	return []net.Listener{listenSidecar(dir)}
}

func listenSidecar(dir string) net.Listener {
	sock := osgw.SidecarSocket(dir, os.Getpid())
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		log.Fatalf("sidecar: %v", err)
	}
	log.Printf("sidecar: HTTP on %s, locks from the gateway (generation %s)", sock, buildGeneration)
	return ln
}
