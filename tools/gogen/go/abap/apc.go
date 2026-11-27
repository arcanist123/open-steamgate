package abap

import (
	"fmt"
	"sync"
)

// The part of an APC host (go/apc) that belongs to the runtime: the one work
// process and the dialog step. The socket part lives in package apc, so a
// program that serves no push channel does not link a WebSocket library.

// WorkProcess is the process's one work process. A Database has one
// connection and the hosts of one process share one Statics store
// (Instance), so every host that runs ABAP holds it for the length of a
// step; the ADR 0010 slice that adds work processes replaces it. The default Step of an
// APC channel takes it; an HTTP host of the same process must take it too
// (or give the channel a Step that holds the host's own lock).
var WorkProcess sync.Mutex

// ErrDump is what a step that dumped returns, wrapping the dump.
type ErrDump struct {
	Step string
	Dump any
}

func (e *ErrDump) Error() string { return fmt.Sprintf("dump in %s: %v", e.Step, e.Dump) }

// APCStep is the default dialog step of a channel: the work process held,
// a database LUW of the channel Session's own, a dump returned rather than
// raised. The Session is the channel's (its database, its statics), and an
// in-step sleep releases the work process through it.
func APCStep(s *Session, name string, work func()) (err error) {
	WorkProcess.Lock()
	defer WorkProcess.Unlock()
	defer func() {
		if r := recover(); r != nil {
			err = &ErrDump{Step: name, Dump: r}
		}
	}()
	DialogStepIn(s, work)
	return nil
}
