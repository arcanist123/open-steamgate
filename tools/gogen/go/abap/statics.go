package abap

// Statics holds stable per-class pointers, including class-constructor state.
// Slots never replace an initialized value, so a method may cache its pointer.
// Only one goroutine may use a store at a time, even across different Sessions.
type Statics struct {
	slots []any
}

// Factories are registered only during package initialization, before sessions run.
var staticsFactories []func() any

// RegisterStatics reserves a class slot. Generated packages call it during init.
func RegisterStatics(newFn func() any) int {
	slot := len(staticsFactories)
	staticsFactories = append(staticsFactories, newFn)
	return slot
}

// Static returns stable class storage, lazily creating a private store if needed.
// The cold path is separate; a hot lookup only reads existing slots and allocates nothing.
func (s *Session) Static(slot int) any {
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
	st := s.Statics
	if slot >= len(st.slots) {
		st.slots = append(st.slots, make([]any, len(staticsFactories)-len(st.slots))...)
	}
	value := staticsFactories[slot]()
	st.slots[slot] = value
	return value
}

// Instance is what one serving process hands to every session it runs: the
// database it opened and, until class statics are kept per logical internal
// session (ADR 0010, slice 5), one Statics store its sessions share, which
// is what the Node host has per process too. A host makes one after it
// opened the database and mints a Session per dialog step from it; a
// Session made by hand (&Session{}) has a private store and no database,
// which is what a Unit test class and a harness want.
//
// Sharing the store is only safe with one step at a time: the hosts of a
// process hold WorkProcess around every step (apc.go).
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
// its shared statics, everything else zero.
func (i *Instance) NewSession() *Session {
	return &Session{DB: i.DB, Statics: i.Statics}
}
