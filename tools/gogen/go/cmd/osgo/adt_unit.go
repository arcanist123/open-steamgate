package main

import (
	"reflect"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"

	"osg/gogen/abap"
	"osg/gogen/adtunit"
	"osg/gogen/castdiag"
	"osg/gogen/objstore"
	"osg/gogen/session"
)

// The test classes compiled into this binary, by owner; zz_unit.go fills it
// for the owners tools/gogen/osgo.mjs was given (docs/osgo-adt-activation.md).
var unitOwners map[string][]adtunit.Class

// adtUnitHost is ABAP Unit for the ADT routes, in process: one fresh session
// on a copy of the seed database per test class.
func adtUnitHost() adtunit.Host {
	return adtunit.Host{Owners: unitOwners, Exec: unitExec, Live: objstore.Live, HasTests: hasTests,
		Build: "rebuild osgo with them: OSGO_UNIT_OWNERS=<class,...> node tools/gogen/osgo.mjs"}
}

var unitExec = &unitExecutor{Script: dbScript}

func hasTests(name string) bool {
	command, typ, include := "READ", "CLAS", "testclasses"
	a := objstore.Call(map[string]*string{"IV_COMMAND": &command, "IV_TYPE": &typ, "IV_NAME": &name, "IV_INCLUDE": &include})
	return a.Scalars["EV_ERROR"] == "" && !strings.Contains(a.Scalars["EV_JSON"], `"empty":true`)
}

// unitExecutor is adtunit.Executor in a serving process: one fresh session on
// a copy of the seed database (Session.OpenUnitDB) per test class. Script is
// the binary's seed script; its image is built once, on the first run.
type unitExecutor struct {
	Script []byte
	once   sync.Once
	image  []byte
	err    error
}

// Begin opens one test class's session on its own copy; end closes it.
func (u *unitExecutor) Begin() (any, func(), error) {
	u.once.Do(func() { u.image, u.err = abap.ScriptImage(u.Script) })
	if u.err != nil {
		return nil, nil, u.err
	}
	// the test class's session owns its copy; the serving step's session
	// and its transaction are not touched (ADR 0010 slice 2)
	s := &abap.Session{}
	if err := s.OpenUnitDB(u.image); err != nil {
		return nil, nil, err
	}
	session.BeginTestClass()
	return s, func() { abap.EndTestClass(s) /* closes the copy too */ }, nil
}

var (
	abapFrame    = regexp.MustCompile(`([A-Za-z0-9_#]+\.(?:clas|prog|intf)(?:\.[a-z_]+)?\.abap):(\d+)`)
	assertMethod = regexp.MustCompile(`\bCL_ABAP_UNIT_ASSERT_(ASSERT_[A-Z0-9_]+|FAIL|ABORT|SKIP)\(`)
	// messages cl_abap_unit_assert raises with when the test gave none
	defaultMessages = map[string]bool{"Expected different values": true, "Unit test assertion failed": true,
		"Expected abap_true": true, "Expected abap_false": true, "Hashed table contents differs": true, "Types are not comparable": true}
)

// Catch turns what a test raised into the alert the Node runner makes of it
// (alertOf in tools/osd-unit.mjs).
func (u *unitExecutor) Catch(f func()) (alert *adtunit.Alert) {
	defer func() {
		x := recover()
		if x == nil {
			return
		}
		stack := string(debug.Stack())
		if w, ok := x.(*abap.Rethrown); ok && w.Stack != "" {
			stack = w.Stack
		}
		alert = &adtunit.Alert{Stack: frames(stack)}
		r, raised := abap.AsRaised(x)
		switch {
		case raised && r.Class == "KERNEL_CX_ASSERT":
			alert.Kind, alert.Severity = "failedAssertion", "critical"
			alert.Title = field(r.Obj, "msg")
			if alert.Title == "" {
				alert.Title = r.Error()
			}
			if !defaultMessages[alert.Title] {
				alert.Message = alert.Title
			}
			alert.Expected, alert.Actual = field(r.Obj, "expected"), field(r.Obj, "actual")
			if m := assertMethod.FindStringSubmatch(stack); m != nil {
				alert.AssertMethod = strings.ToLower(m[1])
			}
		case raised:
			alert.Kind, alert.Severity = "exception", "critical"
			alert.Title = "Exception " + r.Class + " was not caught"
			if text := r.Error(); text != "UNCAUGHT_EXCEPTION "+r.Class && text != "" {
				alert.Details = []string{text}
			}
		default:
			alert.Kind, alert.Severity = "shortDump", "fatal"
			alert.Title = castdiag.DumpText(x)
		}
	}()
	f()
	return nil
}

// field reads a string attribute of a generated exception object.
func field(obj any, name string) string {
	v := reflect.ValueOf(obj)
	for v.IsValid() && (v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface) {
		if v.IsNil() {
			return ""
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return ""
	}
	f := v.FieldByNameFunc(func(n string) bool { return strings.EqualFold(n, name) }) // msg, or Msg in a layered build
	if !f.IsValid() || f.Kind() != reflect.String {
		return ""
	}
	return f.String()
}

// frames are the ABAP source positions of a Go stack, innermost first,
// without repeats.
func frames(stack string) []adtunit.Frame {
	var out []adtunit.Frame
	for _, m := range abapFrame.FindAllStringSubmatch(stack, -1) {
		line, _ := strconv.Atoi(m[2])
		f := adtunit.Frame{File: m[1], Line: line}
		if len(out) == 0 || out[len(out)-1] != f {
			out = append(out, f)
		}
	}
	return out
}
