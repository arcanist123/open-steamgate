package enq

import "time"

// Locks is the lock table as its callers use it: the in-process *Server, or a
// client of a server in another process over the E3 socket (go/enqnet). The
// ADT kernel (adtenq), the step glue (adtlock) and the holder lookup
// (adtsystem) take this, so a sidecar runs the same code against the
// gateway's table that a lone osgo runs against its own.
type Locks interface {
	Open(user string) int64
	EnqueueWith(sid int64, r Request, wait bool, sleep func(time.Duration)) Result
	Dequeue(sid int64, r Request)
	DequeueAll(sid int64)
	Rollback(sid int64)
	Commit(sid int64, updated bool) (ended string)
	UpdateDone(sid int64, owner string)
	End(sid int64)
	UpdateOwner(sid int64) string
	Read(f Filter) []Row
	Holder(r Request) (Row, bool)
}

var _ Locks = (*Server)(nil)
