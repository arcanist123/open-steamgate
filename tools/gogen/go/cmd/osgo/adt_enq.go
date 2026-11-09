package main

// One lock table backs both the ADT context kernel and the generated
// ENQUEUE/DEQUEUE seam: this process's own (enq.New), or, as a gateway's
// sidecar, the gateway's over the E3 socket (sidecar.go, ADR 0010 slice 3).
// adtlock owns the step-to-session glue.
import (
	"osg/gogen/abap"

	"osg/gogen/adtenq"
	"osg/gogen/adtlock"
	"osg/gogen/enq"
)

var (
	adtLocks  enq.Locks = enq.New("osd")
	adtKernel           = adtenq.New(adtLocks)
	adtHost             = adtlock.New(adtLocks, adtKernel)
)

func init() { useLocks(adtLocks) }

// useLocks puts the ADT kernel, the step glue and the generated seam on
// locks. It runs before the first step: a lock taken in the old table would
// not be seen by the new one.
func useLocks(locks enq.Locks) {
	adtLocks = locks
	adtKernel = adtenq.New(locks)
	adtHost = adtlock.New(locks, adtKernel)
	adtHost.User = func() string { return abap.UName }
	adtHost.Install()
}
