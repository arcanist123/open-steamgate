package abap

import (
	"fmt"
	"osg/gogen/dyncall"
	"reflect"
	"runtime"
	"strings"
)

// A class CREATE OBJECT ... TYPE (name) can make: a typed nil to check the
// fit with, and a constructor without arguments.
type classEntry struct {
	zero any
	make func(*Session) any
}

// classes is filled by the generated program with every class it compiles.
var classes = map[string]classEntry{}

func RegisterClass(name string, zero any, make func(*Session) any) {
	classes[name] = classEntry{zero, make}
}

// CreateAs makes the class a name gives. The name is taken as written, trailing
// blanks aside: a lower-case name is an unknown class (A4H, 2026-09-23). As in the kernel, the fit is checked
// before the constructor runs: an unknown class is CX_SY_CREATE_OBJECT_ERROR,
// one that does not fit the target is CX_SY_MOVE_CAST_ERROR.
func CreateAs[T any](s *Session, name string) T {
	c, ok := classes[strings.TrimRight(name, " ")]
	if !ok {
		panic(ArithmeticError{Class: "CX_SY_CREATE_OBJECT_ERROR", Op: "CREATE OBJECT TYPE (" + name + ")"})
	}
	if _, fits := c.zero.(T); !fits {
		var z T
		_, file, line, _ := runtime.Caller(1)
		panic(ArithmeticError{Class: "CX_SY_MOVE_CAST_ERROR", Op: "CREATE OBJECT TYPE (" + name + ")", Detail: fmt.Sprintf("%T -> %T at %s:%d", c.zero, z, file, line)})
	}
	return c.make(s).(T)
}

// Up widens a class pointer into an interface. A nil pointer inside an
// interface is not a nil interface, and an unbound reference must stay
// initial after the move.
func Up[T any, P any](p *P) T {
	var z T
	if p == nil {
		return z
	}
	return any(p).(T)
}

// DynamicRef reads the reference value, not its concrete storage type. Like
// Up, widening an initial class pointer must leave the formal initial.
func DynamicRef[T any](d Data) T {
	var zero T
	if d.T == nil || d.T.Kind != 'r' {
		DynCallError("CX_SY_DYN_CALL_ILLEGAL_TYPE", "reference argument")
	}
	value := reflect.ValueOf(d.P).Elem().Interface()
	if refNil(value) {
		return zero
	}
	result, ok := value.(T)
	if !ok {
		DynCallError("CX_SY_DYN_CALL_ILLEGAL_TYPE", "reference argument")
	}
	return result
}

// Cast is ?= and CAST: an initial reference casts to initial, anything else
// must fit the target or it is CX_SY_MOVE_CAST_ERROR.
func Cast[T any](v any) T {
	var z T
	if v == nil {
		return z
	}
	t, ok := v.(T)
	if !ok {
		_, file, line, _ := runtime.Caller(1)
		panic(ArithmeticError{Class: "CX_SY_MOVE_CAST_ERROR", Op: "?=", Detail: fmt.Sprintf("%T -> %T at %s:%d", v, z, file, line)})
	}
	return t
}

// ClassicException is RAISE name: it ends the method that raised it, and
// only its caller's EXCEPTIONS list can take it. Method names the raiser, so
// a classic exception that passes a caller without the list is not taken by
// one further up: it goes on and ends the program, as RAISE_EXCEPTION does.
type ClassicException struct {
	Name   string
	Method string
}

func (c ClassicException) Error() string { return "RAISE_EXCEPTION " + c.Name + " in " + c.Method }

// Classic is deferred around a call with EXCEPTIONS: the exception named, or
// OTHERS, sets sy-subrc; -1 means absent, so an assigned zero is handled.
func Classic(s *Session, method string, m map[string]int32, others int32) {
	r := recover()
	if r == nil {
		return
	}
	if c, ok := r.(ClassicException); ok && c.Method == method {
		if v, ok := m[c.Name]; ok {
			s.Sy.Subrc = v
			return
		}
		if others >= 0 {
			s.Sy.Subrc = others
			return
		}
	}
	panic(r)
}

// The dynamic registry owns name/signature resolution; this adapter owns
// ABAP session values and the refusal/exception boundary.
var dynamicRegistry = dyncall.New[*Session, Data]()

func KnownClasses(compiled, known []string) { dynamicRegistry.Known(compiled, known) }
func RegisterStatic(name string, params []string, returning string, call func(*Session, map[string]Data) any) {
	dynamicRegistry.Register(name, params, returning, call)
}
func CallStatic(s *Session, class, method string, args map[string]Data, receiving string, compatible []string) (string, any) {
	return dynamicRegistry.Call(s, class, method, args, receiving, compatible, DynCallError,
		func(op, reason string) { panic(NotCompiled(op, reason)) })
}

// DynCallError refuses when the requested exception is outside the closure.
func DynCallError(class, op string) {
	if !dynamicRegistry.Compiled(class) {
		panic(NotCompiled(op, class+" is not compiled"))
	}
	panic(ArithmeticError{Class: class, Op: op})
}

// Local RFC destination registrations belong to the registering internal session.
// CALL FUNCTION is not compiled yet; preserve that boundary before adding lookup.
func RegisterLocalDestination(s *Session, name string) {
	if s.localDestinations == nil {
		s.localDestinations = map[string]bool{}
	}
	s.localDestinations[strings.TrimRight(name, " ")] = true
}

// MessageCall carries only the immediate caller's EXCEPTIONS assignment.
// Every call, including one without EXCEPTIONS, masks its parent's assignment.
type MessageCall struct {
	method string
	codes  map[string]int32
	others int32
	active bool
}

// MessageCallScope saves the assignment for a deferred Restore call.
// Neither push nor panic-safe pop needs a heap record or a restore closure.
func MessageCallScope(s *Session, method string, codes map[string]int32, others int32) MessageCall {
	previous := s.messageCall
	s.messageCall = MessageCall{method: method, codes: codes, others: others, active: true}
	return previous
}

func (previous MessageCall) Restore(s *Session) { s.messageCall = previous }

// MESSAGE ... RAISING sets the session fields before raising. Classic's
// deferred handler assigns sy-subrc using the caller's EXCEPTIONS mapping.
func MessageRaise(s *Session, id, ty, no, name, method string, values ...string) {
	s.Sy.Msgid = CFit(strings.ToUpper(id), 20)
	s.Sy.Msgty = CFit(strings.ToUpper(ty), 1)
	s.Sy.Msgno = CToN(no, 3)
	dst := []*string{&s.Sy.Msgv1, &s.Sy.Msgv2, &s.Sy.Msgv3, &s.Sy.Msgv4}
	for i, p := range dst {
		*p = ""
		if i < len(values) {
			*p = CFit(values[i], 50)
		}
	}
	if c := s.messageCall; c.active && c.method == method {
		if _, assigned := c.codes[name]; assigned || c.others >= 0 {
			panic(ClassicException{Name: name, Method: method})
		}
	}
	// As for plain MESSAGE, S/I continue. Other types are not implemented by
	// this host's plain MESSAGE path; preserve that explicit refusal.
	if s.Sy.Msgty != "S" && s.Sy.Msgty != "I" {
		panic(NotCompiled("MESSAGE", "plain MESSAGE type "+s.Sy.Msgty))
	}
}
