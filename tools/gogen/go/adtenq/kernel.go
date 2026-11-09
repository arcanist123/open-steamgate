package adtenq

import (
	"container/list"
	"errors"
	"strings"
	"sync"

	"osg/gogen/enq"
)

const endedKeep = 10000

// Kernel maps ADT keys to lock-server handles. Use one per host/server;
// callers keep request-local handles rather than a global current session.
type Kernel struct {
	mu       sync.Mutex
	server   enq.Locks
	owner    Owner
	sessions map[string]int64
	pins     map[int64]int
	retired  map[int64]string
	ended    map[string]*list.Element
	order    *list.List
}

// New uses the process's shared owner, like Node's adtEnqOwner singleton.
func New(server enq.Locks) *Kernel {
	return &Kernel{server: server, owner: processOwner, sessions: make(map[string]int64),
		pins: make(map[int64]int), retired: make(map[int64]string),
		ended: make(map[string]*list.Element), order: list.New()}
}

// Owner is the identity to use when translating lock holders to ADT ids.
func (k *Kernel) Owner() Owner { return k.owner }

// text mirrors osd-enq-session's String(...).trimEnd(), including ECMAScript
// whitespace (U+FEFF is whitespace, U+0085 is not). Leading spaces survive.
// Text is the key normalization the kernel applies to every id (trimEnd), so
// a host keeping its own ledger keys it the same way.
func Text(s string) string { return text(s) }

func text(s string) string {
	return strings.TrimRightFunc(s, func(r rune) bool {
		return r >= '\t' && r <= '\r' || r == ' ' || r == '\u00a0' || r == '\u1680' ||
			r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' ||
			r == '\u202f' || r == '\u205f' || r == '\u3000' || r == '\ufeff'
	})
}

// Bind opens or reuses id's context. Only a host-ended key answers false,
// nil (Node's EnqSessionEnded); other failures remain errors for the seam
// adapter to translate into a generated ZCX_OSD_ADT exception.
func (k *Kernel) Bind(id, user string) (bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	key := k.owner.Key(text(id))
	if k.ended[key] != nil {
		return false, nil
	}
	if k.sessions[key] != 0 {
		return true, nil
	}
	if k.server == nil {
		return false, errors.New("ADT ENQ: no lock server")
	}
	sid := k.server.Open(text(user))
	if sid == 0 {
		return false, errors.New("ADT ENQ: lock server is closed")
	}
	k.sessions[key] = sid
	return true, nil
}

// End releases the context and remembers the key even if it never bound.
// Repeated ends refresh its position in Node's bounded ended-key ledger.
func (k *Kernel) End(id string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	key := k.owner.Key(text(id))
	if old := k.ended[key]; old != nil {
		k.order.Remove(old)
	}
	k.ended[key] = k.order.PushBack(key)
	if k.order.Len() > endedKeep {
		oldest := k.order.Front()
		delete(k.ended, oldest.Value.(string))
		k.order.Remove(oldest)
	}
	k.drop(key)
	for sid, retired := range k.retired {
		if retired == key {
			k.retireNow(sid, key)
		}
	}
}

// Revive permits the next bind; it opens no context and restores no locks.
func (k *Kernel) Revive(id string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	key := k.owner.Key(text(id))
	if old := k.ended[key]; old != nil {
		k.order.Remove(old)
		delete(k.ended, key)
	}
}

// ContextAlive mirrors Node's !isEnded(key) && sessions.has(key). A context
// with no locks is alive; Revive alone does not make it alive.
func (k *Kernel) ContextAlive(id string) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	key := k.owner.Key(text(id))
	return k.ended[key] == nil && k.sessions[key] != 0
}

func (k *Kernel) Owns(id string) bool        { return k.owner.Owns(text(id)) }
func (k *Kernel) SessionID(id string) string { return k.owner.IDOf(text(id)) }

// Handle returns an existing context for request-local ENQUEUE/COMMIT/etc.
// It opens nothing; after End an old handle is rejected by the ENQ server.
func (k *Kernel) Handle(id string) (int64, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	sid := k.sessions[k.owner.Key(text(id))]
	return sid, sid != 0
}

// Pin atomically binds and pins id's context, returning the handle that Unpin
// must release. A pinned context survives DropContext until its last pin exits.
func (k *Kernel) Pin(id, user string) (int64, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	key := k.owner.Key(text(id))
	if k.ended[key] != nil {
		return 0, false, nil
	}
	sid := k.sessions[key]
	if sid == 0 {
		if k.server == nil {
			return 0, false, errors.New("ADT ENQ: no lock server")
		}
		sid = k.server.Open(text(user))
		if sid == 0 {
			return 0, false, errors.New("ADT ENQ: lock server is closed")
		}
		k.sessions[key] = sid
	}
	k.pins[sid]++
	return sid, true, nil
}

// Unpin releases one pin acquired for the returned handle. The last pin of a
// dumped context ends that old context, never its replacement.
func (k *Kernel) Unpin(sid int64) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.pins[sid] <= 1 {
		delete(k.pins, sid)
		if key, dumped := k.retired[sid]; dumped {
			k.retireNow(sid, key)
		}
		return
	}
	k.pins[sid]--
}

// DropContext is the host's dump cleanup for the step that dumped, unlike
// logoff: sid is that step's own handle (from Pin), never looked up by key, so
// a dump of an old step cannot retire the key's replacement (Node's retire,
// tools/osd-enq-host.mjs). The key loses its mapping only while it still
// points at sid; a pinned sid is retired and ends with its last Unpin.
func (k *Kernel) DropContext(id string, sid int64) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if sid == 0 {
		return
	}
	key := k.owner.Key(text(id))
	_, doomed := k.retired[sid]
	if k.sessions[key] != sid && !doomed {
		return
	}
	if k.sessions[key] == sid {
		delete(k.sessions, key)
	}
	if k.pins[sid] > 0 {
		k.retired[sid] = key
		return
	}
	k.retireNow(sid, key)
}

func (k *Kernel) drop(key string) {
	if sid := k.sessions[key]; sid != 0 {
		delete(k.sessions, key)
		k.server.End(sid)
	}
}

func (k *Kernel) retireNow(sid int64, key string) {
	delete(k.retired, sid)
	k.server.End(sid)
}

// KeyForHandle identifies live or retired ADT contexts; holder sessions
// outside this kernel stay foreign and must not be ended by ADT.
func (k *Kernel) KeyForHandle(sid int64) (string, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	for key, handle := range k.sessions {
		if handle == sid {
			return key, true
		}
	}
	key, ok := k.retired[sid]
	return key, ok
}
