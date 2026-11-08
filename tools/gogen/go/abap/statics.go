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
