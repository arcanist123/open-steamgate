package abap

// Statics holds stable per-class pointers, including class-constructor state.
// Slots never replace an initialized value, so a method may cache its pointer.
// Only one goroutine may use a store at a time, even across different Sessions.
type Statics struct {
	slots []any
}

// Factories are registered only during package initialization, before sessions run.
var staticsFactories []func() any

// sharedSlots are the class slots the runtime itself caches in (ADR 0010
// slice 5): one value per process, every session sees the same one, what a
// system keeps in the shared program buffer rather than in the internal
// session. Generated init marks them beside RegisterStatics (emit-go.mjs
// names the classes), and the host gives the sessions it mints a Shared
// store to keep them in. Only a class whose statics are filled once and
// read afterwards may be here: a shared slot's value is written by the
// generated code directly, with no lock the kernel could take.
var sharedSlots = map[int]bool{}

// RegisterSharedStatics marks a class slot instance-wide. Generated
// packages call it during init, right after RegisterStatics.
func RegisterSharedStatics(slot int) { sharedSlots[slot] = true }

// RegisterStatics reserves a class slot. Generated packages call it during init.
func RegisterStatics(newFn func() any) int {
	slot := len(staticsFactories)
	staticsFactories = append(staticsFactories, newFn)
	return slot
}

// Static returns stable class storage, lazily creating a private store if needed.
// The cold path is separate; a hot lookup only reads existing slots and allocates nothing.
func (s *Session) Static(slot int) any {
	if sharedSlots[slot] && s.Shared != nil {
		if slot < len(s.Shared.slots) {
			if value := s.Shared.slots[slot]; value != nil {
				return value
			}
		}
		return s.newStaticIn(s.Shared, slot)
	}
	if s.Statics != nil && slot < len(s.Statics.slots) {
		value := s.Statics.slots[slot]
		if value != nil {
			return value
		}
	}
	return s.newStatic(slot)
}

func (s *Session) newStatic(slot int) any {
	if s.Statics == nil {
		s.Statics = &Statics{}
	}
	return s.newStaticIn(s.Statics, slot)
}

func (s *Session) newStaticIn(st *Statics, slot int) any {
	if slot >= len(st.slots) {
		st.slots = append(st.slots, make([]any, len(staticsFactories)-len(st.slots))...)
	}
	value := staticsFactories[slot]()
	st.slots[slot] = value
	return value
}

// Instance is what one serving process hands to every session it runs: the
// database it opened, and one Statics store its sessions share -- which,
// since ADR 0010 slice 5, is what a host keeps only for the classes whose
// statics are the runtime's own caches (RegisterSharedStatics): a host that
// runs one logical internal session per request mints its Sessions by hand
// (&Session{DB: ..., Shared: instance.Statics}) so every other class's
// CLASS-DATA is the session's own, as a system's is. A Session made by hand
// with neither has a private store and no database, which is what a Unit
// test class and a harness want.
//
// Sharing the store is only safe with one step at a time: the hosts of a
// process hold WorkProcess around every step (apc.go), or lend a work
// process and serialise the sessions (go/workpool).
type Instance struct {
	DB      *Database
	Statics *Statics
}

// NewInstance makes an instance over a database (nil for a host that runs
// no SQL) with a fresh shared store.
func NewInstance(db *Database) *Instance {
	return &Instance{DB: db, Statics: &Statics{}}
}

// NewSession is a Session for one dialog step: the instance's database and
// its shared statics, everything else zero. Shared is the same store, so a
// session minted here behaves as this always did (every class's statics
// shared); a host that keeps one logical internal session per request mints
// its own Sessions with Statics nil and Shared set (statics.go).
func (i *Instance) NewSession() *Session {
	return &Session{DB: i.DB, Statics: i.Statics, Shared: i.Statics}
}
