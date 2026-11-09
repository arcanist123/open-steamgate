package main

import (
	"osg/gogen/abap"
	"sync"
	"testing"
)

func TestEventRegistrationsFollowStatics(t *testing.T) {
	for _, all := range []bool{false, true} {
		t.Run(map[bool]string{false: "class", true: "all instances"}[all], func(t *testing.T) {
			register := ZCL_PROBE_REGISTER
			fire := ZCL_PROBE_FIRE
			if all {
				register = ZCL_PROBE_REGISTER_ALL
				fire = func(s *abap.Session) int32 { return New_ZCL_PROBE(s).FIRE_INSTANCE(s) }
			}
			a, b, c := &abap.Session{}, &abap.Session{}, &abap.Session{}
			register(a)
			register(b)
			if n := fire(a); n != 1 {
				t.Errorf("a: got %d, want 1", n)
			}
			if n := fire(c); n != 0 {
				t.Errorf("c: got %d, want 0", n)
			}
			if n := fire(b); n != 1 {
				t.Errorf("b: got %d, want 1", n)
			}

			// Shared host requests retain registrations along with class statics.
			abap.WorkProcess.Lock()
			defer abap.WorkProcess.Unlock()
			instance := abap.NewInstance(nil)
			first := instance.NewSession()
			second := instance.NewSession()
			ZCL_PROBE_RESET(first)
			register(first)
			if all {
				defer ZCL_PROBE_UNREGISTER_ALL(second)
			} else {
				defer ZCL_PROBE_UNREGISTER(second)
			}
			if n := fire(second); n != 1 {
				t.Errorf("shared: got %d, want 1", n)
			}
		})
	}
}

func TestPrivateEventRegistrationsParallel(t *testing.T) {
	const workers = 8
	var done sync.WaitGroup
	done.Add(workers)
	for range workers {
		go func() {
			defer done.Done()
			s := &abap.Session{}
			ZCL_PROBE_REGISTER(s)
			ZCL_PROBE_REGISTER_ALL(s)
			sender := New_ZCL_PROBE(s)
			for i := int32(1); i <= 100; i++ {
				if n := ZCL_PROBE_FIRE(s); n != 2*i-1 {
					t.Errorf("class: got %d, want %d", n, 2*i-1)
					return
				}
				if n := sender.FIRE_INSTANCE(s); n != 2*i {
					t.Errorf("all: got %d, want %d", n, 2*i)
					return
				}
			}
		}()
	}
	done.Wait()
}

func TestInstanceRegistrationBelongsToSender(t *testing.T) {
	s := &abap.Session{}
	sender, other := New_ZCL_PROBE(s), New_ZCL_PROBE(s)
	sender.REGISTER_INSTANCE(s)
	if n := other.FIRE_INSTANCE(s); n != 0 {
		t.Fatalf("other sender: %d", n)
	}
	if n := sender.FIRE_INSTANCE(s); n != 1 {
		t.Fatalf("registered sender: %d", n)
	}
	// Even when an object is explicitly passed to another session, its own
	// registrations stay on that object; its callback uses the raising session.
	if n := sender.FIRE_INSTANCE(&abap.Session{}); n != 1 {
		t.Fatalf("same sender: %d", n)
	}
}
