package abap

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
