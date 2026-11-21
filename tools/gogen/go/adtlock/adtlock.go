// Package adtlock installs the process lock server behind generated
// ENQUEUE and DEQUEUE calls for the OSGo host.
package adtlock

import (
	"container/list"
	"errors"
	"sync"
	"time"

	"osg/gogen/adtenq"
	"osg/gogen/enq"
	"osg/gogen/hostclass"
	"osg/gogen/yieldsleep"
)

// ErrSessionEnded is Node's EnqSessionEnded at the KERNEL_LOCK boundary.
var ErrSessionEnded = errors.New("the session has ended")

const endedKeep = 10000

type step struct {
	sid       int64
	boundID   string
	holderSID int64
}

// Host maps calling dialog steps to lock-server sessions and installs the
// hostclass seams over one server/kernel pair.
type Host struct {
	server enq.Locks
	kernel *adtenq.Kernel

	// User names the lock owner of a holder session (the host's sy-uname).
	User func() string

	mu    sync.Mutex
	steps map[any]*step
	ended map[string]*list.Element
	order *list.List
}

func New(server enq.Locks, kernel *adtenq.Kernel) *Host {
	return &Host{server: server, kernel: kernel, steps: make(map[any]*step),
		ended: make(map[string]*list.Element), order: list.New()}
}

// Install fills the process-wide hostclass hooks.
func (h *Host) Install() {
	kernel := &hostclass.ZCL_OSD_ENQ_KERNEL
	kernel.Bind = h.bind
	kernel.End = func(_ any, id string) error { h.end(id); return nil }
	kernel.Revive = func(_ any, id string) error { h.revive(id); return nil }
	kernel.ContextAlive = func(_ any, id string) (bool, error) { return h.kernel.ContextAlive(id), nil }
	kernel.Owns = func(_ any, id string) (bool, error) { return h.kernel.Owns(id), nil }
	kernel.SessionID = func(_ any, id string) (string, error) { return h.kernel.SessionID(id), nil }

	locks := &hostclass.KERNEL_LOCK
	locks.Enqueue = h.Enqueue
	locks.Dequeue = h.Dequeue
	locks.DequeueAll = h.DequeueAll

	hostclass.LUW.Commit = h.Commit
	hostclass.LUW.Rollback = h.Rollback
}

// Begin registers a dialog step; it reports whether this call created it.
func (h *Host) Begin(s any) (started bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	started = h.steps[s] == nil
	if started {
		h.steps[s] = &step{}
	}
	return started
}

// Finish applies Node's onEnd rules and removes the step.
func (h *Host) Finish(s any, dumped bool) {
	h.mu.Lock()
	current := h.steps[s]
	delete(h.steps, s)
	h.mu.Unlock()
	if current == nil {
		return
	}
	if current.boundID != "" {
		if dumped && current.sid != 0 {
			h.server.Rollback(current.sid)
			h.kernel.DropContext(current.boundID, current.sid)
		}
		h.kernel.Unpin(current.sid)
		if current.holderSID != 0 {
			h.server.End(current.holderSID)
		}
		return
	}
	if current.sid != 0 {
		if dumped {
			h.server.Rollback(current.sid)
		}
		h.server.End(current.sid)
	}
}

func (h *Host) bind(caller any, id, user string) (bool, error) {
	id = adtenq.Text(id)
	s := caller
	if s == nil {
		return h.kernel.Bind(id, user)
	}
	h.mu.Lock()
	current := h.steps[s]
	h.mu.Unlock()
	if current == nil {
		return h.kernel.Bind(id, user)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ended := h.ended[id]
	if ended {
		return false, nil
	}
	if current.boundID == id && current.sid != 0 {
		return true, nil
	}
	sid, ok, err := h.kernel.Pin(id, user)
	if ok && err == nil {
		// the previous binding is released only once the new one holds, so a
		// refused rebind leaves exactly one pin for Finish to release
		if current.boundID != "" && current.sid != 0 {
			h.kernel.Unpin(current.sid)
		}
		if current.boundID == "" && current.sid != 0 {
			current.holderSID = current.sid
		}
		current.boundID = id
		current.sid = sid
	}
	return ok, err
}

func (h *Host) end(id string) {
	id = adtenq.Text(id)
	h.mu.Lock()
	if old := h.ended[id]; old != nil {
		h.order.Remove(old)
	}
	h.ended[id] = h.order.PushBack(id)
	if h.order.Len() > endedKeep {
		oldest := h.order.Front()
		delete(h.ended, oldest.Value.(string))
		h.order.Remove(oldest)
	}
	h.mu.Unlock()
	h.kernel.End(id)
}

func (h *Host) revive(id string) {
	id = adtenq.Text(id)
	h.mu.Lock()
	if old := h.ended[id]; old != nil {
		h.order.Remove(old)
		delete(h.ended, id)
	}
	h.mu.Unlock()
	h.kernel.Revive(id)
}

func (h *Host) current(caller any, open bool) (*step, int64, string, error) {
	s := caller
	h.mu.Lock()
	current := h.steps[s]
	h.mu.Unlock()
	if current == nil {
		if !open {
			return nil, 0, "", nil
		}
		current = &step{}
		h.mu.Lock()
		h.steps[s] = current
		h.mu.Unlock()
	}
	if current.boundID != "" {
		h.mu.Lock()
		_, ended := h.ended[current.boundID]
		h.mu.Unlock()
		if ended {
			return current, 0, current.boundID, ErrSessionEnded
		}
		if current.sid == 0 {
			sid, exists := h.kernel.Handle(current.boundID)
			if !exists {
				return current, 0, current.boundID, ErrSessionEnded
			}
			current.sid = sid
		}
		return current, current.sid, current.boundID, nil
	}
	if current.sid == 0 {
		if !open {
			return current, 0, "", nil
		}
		current.sid = h.server.Open(h.user())
	}
	return current, current.sid, "", nil
}

// Enqueue is the KERNEL_LOCK hook; a non-nil sleep means _WAIT.
func (h *Host) Enqueue(caller any, request enq.Request, sleep func(time.Duration)) (enq.Result, error) {
	return h.EnqueueWithSleep(caller, request, sleep != nil, sleep)
}

// EnqueueWithSleep exposes the retry schedule for an injected sleep.
func (h *Host) EnqueueWithSleep(caller any, request enq.Request, wait bool, sleep func(time.Duration)) (enq.Result, error) {
	if sleep == nil {
		if wait {
			sleep = func(duration time.Duration) { yieldsleep.Sleep(caller, duration) }
		} else {
			sleep = func(time.Duration) {}
		}
	}
	_, sid, bound, err := h.current(caller, true)
	if err != nil {
		return enq.Result{}, err
	}
	if sid == 0 {
		return enq.Result{Subrc: 2}, nil
	}
	result, callErr := func() (result enq.Result, err error) {
		defer func() {
			recovered := recover()
			if e, isError := recovered.(error); isError && errors.Is(e, ErrSessionEnded) {
				err = ErrSessionEnded
			} else if recovered != nil {
				panic(recovered)
			}
		}()
		result = h.server.EnqueueWith(sid, request, wait, func(duration time.Duration) {
			sleep(duration)
			h.mu.Lock()
			_, ended := h.ended[bound]
			h.mu.Unlock()
			if bound != "" && ended {
				panic(ErrSessionEnded)
			}
		})
		return result, nil
	}()
	if callErr != nil {
		return enq.Result{}, callErr
	}
	return result, nil
}

func (h *Host) Dequeue(caller any, request enq.Request) error {
	_, sid, _, err := h.current(caller, false)
	if err != nil || sid == 0 {
		return nil
	}
	h.server.Dequeue(sid, request)
	return nil
}

func (h *Host) DequeueAll(caller any) error {
	_, sid, _, err := h.current(caller, false)
	if err != nil || sid == 0 {
		return nil
	}
	h.server.DequeueAll(sid)
	return nil
}

// Commit follows Node's COMMIT WORK wrapper, after the database commit (abap.GeneratedCommitWork; the
// gateway's lock release relies on it). The update ran inline: its owner is done before this returns.
func (h *Host) Commit(caller any, updated bool) error {
	_, sid, _, err := h.current(caller, false)
	if err != nil || sid == 0 {
		return nil
	}
	ended := h.server.Commit(sid, updated)
	h.server.UpdateDone(sid, ended)
	return nil
}

// Rollback releases the calling step's update locks, without opening a session.
func (h *Host) Rollback(caller any) error {
	_, sid, _, err := h.current(caller, false)
	if err != nil || sid == 0 {
		return nil
	}
	h.server.Rollback(sid)
	return nil
}

func (h *Host) user() string {
	if h.User == nil {
		return ""
	}
	return h.User()
}
