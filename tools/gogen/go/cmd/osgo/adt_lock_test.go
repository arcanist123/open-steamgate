package main

import (
	"errors"
	"testing"
	"time"

	"osg/gogen/abap"
	"osg/gogen/adtlock"
	"osg/gogen/enq"
	"osg/gogen/hostclass"
)

func lockRequest(value string) enq.Request {
	return enq.Request{Table: "ZOSD_CMD", Object: "EZOSD_CMD", Fields: []enq.Field{{Value: value}}, Mode: "E"}
}

func TestOsgoFindsStepKeyedEnqSessions(t *testing.T) {
	first, second := &abap.Session{}, &abap.Session{}
	adtHost.Begin(first)
	adtHost.Begin(second)
	if result, err := hostclass.KERNEL_LOCK.Enqueue(first, lockRequest("STEP"), nil); err != nil || result.Subrc != 0 {
		t.Fatalf("first: %+v %v", result, err)
	}
	result, err := hostclass.KERNEL_LOCK.Enqueue(second, lockRequest("STEP"), nil)
	if err != nil || result.Subrc != 1 || result.Msgno != "601" || result.Holder != "DEVELOPER" {
		t.Fatalf("second: %+v %v", result, err)
	}
	adtHost.Finish(first, false)
	adtHost.Finish(second, false)
	if rows := adtLocks.Read(enq.Filter{Table: "ZOSD_CMD"}); len(rows) != 0 {
		t.Fatalf("holder sessions survived their steps: %+v", rows)
	}
}

func TestOsgoReleasesHolderSessionOnDump(t *testing.T) {
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		step := &abap.Session{}
		runDialogStep(step, func() {
			if _, err := hostclass.KERNEL_LOCK.Enqueue(step, lockRequest("DUMP"), nil); err != nil {
				t.Error(err)
			}
			panic("lock step dump")
		}, false)
	}()
	if recovered != "lock step dump" {
		t.Fatalf("dump recovered %v (%T), want the original panic", recovered, recovered)
	}
	if rows := adtLocks.Read(enq.Filter{Table: "ZOSD_CMD"}); len(rows) != 0 {
		t.Fatalf("dumped holder session survived: %+v", rows)
	}
}

func TestOsgoAPCStepsReleaseHolderSessions(t *testing.T) {
	tests := []struct {
		name   string
		dumped bool
	}{
		{name: "end"},
		{name: "dump", dumped: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			step := &abap.Session{}
			err := runAPCStep(step, test.name, func() {
				if _, err := hostclass.KERNEL_LOCK.Enqueue(step, lockRequest("APC-"+test.name), nil); err != nil {
					t.Error(err)
				}
				if test.dumped {
					panic("apc step dump")
				}
			})
			var dump *abap.ErrDump
			if test.dumped && !errors.As(err, &dump) {
				t.Fatalf("APC dump err %v, want *abap.ErrDump", err)
			}
			if !test.dumped && err != nil {
				t.Fatal(err)
			}
			if rows := adtLocks.Read(enq.Filter{Table: "ZOSD_CMD"}); len(rows) != 0 {
				t.Fatalf("APC holder session survived: %+v", rows)
			}
		})
	}
}

func TestOsgoRetryUsesInjectedSleep(t *testing.T) {
	other := adtLocks.Open("OTHER")
	defer adtLocks.End(other)
	if result := adtLocks.EnqueueWith(other, lockRequest("WAIT"), false, nil); result.Subrc != 0 {
		t.Fatalf("other: %+v", result)
	}
	step := &abap.Session{}
	adtHost.Begin(step)
	defer adtHost.Finish(step, false)
	var slept time.Duration
	result, err := adtHost.EnqueueWithSleep(step, lockRequest("WAIT"), true, func(duration time.Duration) {
		slept = duration
		adtLocks.Dequeue(other, lockRequest("WAIT"))
	})
	if err != nil || result.Subrc != 0 || slept != time.Second {
		t.Fatalf("result %+v err %v slept %v", result, err, slept)
	}
}

func TestOsgoEndedKeyDuringSleepIsError(t *testing.T) {
	const id = "osgo-ended-key"
	defer adtKernel.End(id)
	step := &abap.Session{}
	adtHost.Begin(step)
	defer adtHost.Finish(step, true)
	if ok, err := hostclass.ZCL_OSD_ENQ_KERNEL.Bind(step, id, "ALICE"); !ok || err != nil {
		t.Fatalf("bind: %v %v", ok, err)
	}
	other := adtLocks.Open("OTHER")
	defer adtLocks.End(other)
	adtLocks.EnqueueWith(other, lockRequest("ENDED"), false, nil)
	_, err := adtHost.EnqueueWithSleep(step, lockRequest("ENDED"), true, func(time.Duration) {
		if err := hostclass.ZCL_OSD_ENQ_KERNEL.End(step, id); err != nil {
			t.Fatal(err)
		}
	})
	if !errors.Is(err, adtlock.ErrSessionEnded) {
		t.Fatalf("err %v, want ErrSessionEnded", err)
	}
}
