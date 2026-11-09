package abap

import (
	"reflect"
	"sync"
)

// Class events: EVENTS / CLASS-EVENTS, SET HANDLER and RAISE EVENT, as A4H
// answered them (ZCL_GOGEN_T_EVENTS, ZCL_GOGEN_T_EVENTS2 and the A4H-only
// ZCL_GOGEN_T_EVGC, $ZOSG_TMP_0440, 2026-09-24):
//
//   - the handlers of one sender are a table with holes: a deactivation frees
//     its place, a new registration takes the lowest free place, else it is
//     appended; registering an active handler again changes nothing;
//   - RAISE EVENT calls the handlers registered FOR the sender first, then
//     the ones FOR ALL INSTANCES, each in its table's order;
//   - a dispatch calls the registrations that were active when it started
//     and are still active when it reaches them: one deactivated on the way
//     is skipped, one added (or re-added) on the way is not called;
//   - the actual of an event parameter is read when each handler is called;
//   - an exception out of a handler ends the dispatch and goes on to the
//     RAISE EVENT's caller;
//   - a registration FOR an object lives in the sender, so it keeps the
//     handler object alive exactly as long as the sender lives, and does not
//     keep the sender alive; FOR ALL INSTANCES and a static event's
//     registrations keep the handler alive; a deactivated one is released;
//   - SET HANDLER with an initial handler or an initial FOR object is a
//     runtime abortion no CATCH takes.

// HandlerFunc calls one handler method: the sender (nil for a static
// event) and the event's parameters (the generated EV_ struct).
type HandlerFunc func(s *Session, sender any, args any)

type handlerEntry struct {
	obj    any    // the handler object, nil for a static handler
	method string // the handler method, CLASS=>M for a static one
	filter func(any) bool
	fn     HandlerFunc
	dead   bool
}

type handlerTable struct {
	slots []*handlerEntry
}

func (t *handlerTable) set(obj any, method string, filter func(any) bool, fn HandlerFunc, on bool) {
	free := -1
	for i, e := range t.slots {
		if e == nil {
			if free < 0 {
				free = i
			}
			continue
		}
		if e.obj == obj && e.method == method {
			if !on {
				e.dead = true
				t.slots[i] = nil
			}
			return
		}
	}
	if !on {
		return
	}
	e := &handlerEntry{obj: obj, method: method, filter: filter, fn: fn}
	if free >= 0 {
		t.slots[free] = e
	} else {
		t.slots = append(t.slots, e)
	}
}

// Events is the part of an object that can raise instance events: the
// handlers registered FOR it, per event. A class with instance events embeds
// it (emit-go), so a sender carries its own registrations.
type Events struct {
	tables map[string]*handlerTable
}

// EventsOf gives the object's registrations (promoted through the embedding).
func (e *Events) EventsOf() *Events { return e }

// EventSender is an object whose class has instance events.
type EventSender interface {
	EventsOf() *Events
}

// The same store as CLASS-DATA owns session-wide event registrations.
// Sessions minted from one Instance share this slot; private stores never share its tables.
type eventRegistrations struct {
	allHandlers    map[string]*handlerTable
	staticHandlers map[string]*handlerTable
}

var eventSlot = RegisterStatics(func() any {
	return &eventRegistrations{
		allHandlers:    map[string]*handlerTable{},
		staticHandlers: map[string]*handlerTable{},
	}
})

func eventsOf(s *Session) *eventRegistrations {
	return s.Static(eventSlot).(*eventRegistrations)
}

// Protect object-held tables too; an object's registrations remain on the sender.
var eventMu sync.Mutex

// IsInitialRef: an initial object reference, typed pointer or interface.
func IsInitialRef(v any) bool {
	if v == nil {
		return true
	}
	r := reflect.ValueOf(v)
	return r.Kind() == reflect.Pointer && r.IsNil()
}

// Activation is the value of ACTIVATION: 'X' registers, blank deregisters.
// Any other value is not measured and is refused where it is used.
func Activation(v string) bool {
	switch v {
	case "X":
		return true
	case "", " ":
		return false
	}
	panic(NotCompiled("SET HANDLER", "ACTIVATION with a value that is neither 'X' nor blank is not measured"))
}

func notBound(what string) {
	panic(ArithmeticError{Class: "OBJECTS_OBJREF_NOT_ASSIGNED", Op: what})
}

// SetHandler is one handler of a SET HANDLER statement. forObj is the FOR
// object (nil with all or for a static event), all is FOR ALL INSTANCES,
// static a static event; obj is the handler object (nil for a static
// handler) and method its name.
func SetHandler(s *Session, event string, forObj any, all, static bool, obj any, method string, filter func(any) bool, fn HandlerFunc, on bool) {
	var t *handlerTable
	switch {
	case static || all:
		eventMu.Lock()
		registrations := eventsOf(s)
		m := registrations.allHandlers
		if static {
			m = registrations.staticHandlers
		}
		t = m[event]
		if t == nil {
			t = &handlerTable{}
			m[event] = t
		}
		eventMu.Unlock()
	default:
		if IsInitialRef(forObj) {
			notBound("SET HANDLER ... FOR an initial reference")
		}
		es, ok := forObj.(EventSender)
		if !ok {
			panic(NotCompiled("SET HANDLER", "the FOR object's class has no instance events in this program"))
		}
		ev := es.EventsOf()
		if ev.tables == nil {
			ev.tables = map[string]*handlerTable{}
		}
		t = ev.tables[event]
		if t == nil {
			t = &handlerTable{}
			ev.tables[event] = t
		}
	}
	eventMu.Lock()
	t.set(obj, method, filter, fn, on)
	eventMu.Unlock()
}

func snapshot(t *handlerTable) []*handlerEntry {
	if t == nil {
		return nil
	}
	eventMu.Lock()
	defer eventMu.Unlock()
	out := make([]*handlerEntry, 0, len(t.slots))
	for _, e := range t.slots {
		if e != nil {
			out = append(out, e)
		}
	}
	return out
}

// RaiseEvent is RAISE EVENT: sender is me for an instance event and nil for
// a static one; args makes the parameters, once per handler called.
func RaiseEvent(s *Session, event string, sender any, static bool, args func() any) {
	var lists [][]*handlerEntry
	if static {
		eventMu.Lock()
		t := eventsOf(s).staticHandlers[event]
		eventMu.Unlock()
		lists = append(lists, snapshot(t))
	} else {
		if es, ok := sender.(EventSender); ok && !IsInitialRef(sender) {
			lists = append(lists, snapshot(es.EventsOf().tables[event]))
		}
		eventMu.Lock()
		t := eventsOf(s).allHandlers[event]
		eventMu.Unlock()
		lists = append(lists, snapshot(t))
	}
	for _, l := range lists {
		for _, e := range l {
			if e.dead {
				continue
			}
			if e.filter != nil && !e.filter(sender) {
				continue
			}
			e.fn(s, sender, args())
		}
	}
}

// BoundHandler is the handler object of SET HANDLER h->m: an initial one is
// a runtime abortion.
func BoundHandler[T any](v T) T {
	if IsInitialRef(any(v)) {
		notBound("SET HANDLER with an initial handler reference")
	}
	return v
}

// SenderAs is the SENDER parameter of a handler, typed as the handler
// declares it; nil (a static event) is initial.
func SenderAs[T any](v any) T {
	var z T
	if v == nil {
		return z
	}
	return v.(T)
}
