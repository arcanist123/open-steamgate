package adtlock

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"osg/gogen/adtenq"
	"osg/gogen/enq"
)

func request(value string) enq.Request {
	return enq.Request{Table: "ZOSD_TEST", Object: "EZOSD_TEST", Fields: []enq.Field{{Value: value}}, Mode: "E"}
}

func newHost(t *testing.T) (*Host, func()) {
	t.Helper()
	server := enq.New("test")
	kernel := adtenq.New(server)
	host := New(server, kernel)
	host.User = func() string { return "DEVELOPER" }
	return host, func() { server.Close() }
}

func TestStepKeyedHolderSessions(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()

	first, second := new(struct{ int }), new(struct{ int })
	host.Begin(first)
	host.Begin(second)
	defer host.Finish(first, false)
	defer host.Finish(second, false)

	if result, err := host.Enqueue(first, request("A"), nil); err != nil || result.Subrc != 0 {
		t.Fatalf("first enqueue: result %+v err %v", result, err)
	}
	result, err := host.Enqueue(second, request("A"), nil)
	if err != nil || result.Subrc != 1 || result.Msgno != "601" || result.Holder != "DEVELOPER" {
		t.Fatalf("second enqueue: result %+v err %v", result, err)
	}
}

func TestHolderSessionIsReleasedAtStepEnd(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()

	step := new(struct{ int })
	host.Begin(step)
	if _, err := host.Enqueue(step, request("HOLDER"), nil); err != nil {
		t.Fatal(err)
	}
	host.Finish(step, false)
	if rows := host.server.Read(enq.Filter{Table: "ZOSD_TEST"}); len(rows) != 0 {
		t.Fatalf("successful step left %d locks", len(rows))
	}
}

func TestBoundContextSurvivesStepAndDroppedOnDump(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()
	const id = "bound-context"
	defer host.kernel.End(id)

	normal := new(struct{ int })
	host.Begin(normal)
	if ok, err := host.bind(normal, id, "ALICE"); !ok || err != nil {
		t.Fatalf("bind: %v %v", ok, err)
	}
	if _, err := host.Enqueue(normal, request("BOUND"), nil); err != nil {
		t.Fatal(err)
	}
	host.Finish(normal, false)
	if rows := host.server.Read(enq.Filter{Table: "ZOSD_TEST"}); len(rows) != 1 {
		t.Fatalf("bound context lost its lock: %+v", rows)
	}

	dumped := new(struct{ int })
	host.Begin(dumped)
	if ok, err := host.bind(dumped, id, "ALICE"); !ok || err != nil {
		t.Fatalf("rebind: %v %v", ok, err)
	}
	host.Finish(dumped, true)
	if host.kernel.ContextAlive(id) || len(host.server.Read(enq.Filter{Table: "ZOSD_TEST"})) != 0 {
		t.Fatal("dump did not retire the bound context and its locks")
	}
}

func TestRebindingUnpinsPreviousContext(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()
	const first, second = "bound-first", "bound-second"
	defer host.kernel.End(first)
	defer host.kernel.End(second)

	step := new(struct{ int })
	host.Begin(step)
	for _, id := range []string{first, second} {
		if ok, err := host.bind(step, id, "ALICE"); !ok || err != nil {
			t.Fatalf("bind %s: %v %v", id, ok, err)
		}
	}
	if _, err := host.Enqueue(step, request("REBOUND"), nil); err != nil {
		t.Fatal(err)
	}
	host.Finish(step, false)
	rebound := new(struct{ int })
	host.Begin(rebound)
	if ok, err := host.bind(rebound, first, "ALICE"); !ok || err != nil {
		t.Fatalf("rebind first: %v %v", ok, err)
	}
	if _, err := host.Enqueue(rebound, request("FIRST"), nil); err != nil {
		t.Fatal(err)
	}
	host.Finish(rebound, true)
	var firstRows int
	for _, row := range host.server.Read(enq.Filter{Table: "ZOSD_TEST"}) {
		if row.Arg == "FIRST" {
			firstRows++
		}
	}
	if firstRows != 0 {
		t.Fatal("rebinding left the first context pinned")
	}
}

func TestBindEndsHolderSessionTakenEarlierInStep(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()
	const id = "bound-after-holder"
	defer host.kernel.End(id)

	step := new(struct{ int })
	host.Begin(step)
	if _, err := host.Enqueue(step, request("BEFORE-BIND"), nil); err != nil {
		t.Fatal(err)
	}
	if ok, err := host.bind(step, id, "ALICE"); !ok || err != nil {
		t.Fatalf("bind: %v %v", ok, err)
	}
	host.Finish(step, false)
	if rows := host.server.Read(enq.Filter{Table: "ZOSD_TEST"}); len(rows) != 0 {
		t.Fatalf("the pre-bind holder session survived the step: %+v", rows)
	}
}

func TestRetryUsesInjectedSleep(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()

	other := host.server.Open("OTHER")
	if result := host.server.EnqueueWith(other, request("RETRY"), false, nil); result.Subrc != 0 {
		t.Fatalf("other enqueue: %+v", result)
	}
	step := new(struct{ int })
	host.Begin(step)
	defer host.Finish(step, false)
	var slept []time.Duration
	result, err := host.EnqueueWithSleep(step, request("RETRY"), true, func(duration time.Duration) {
		slept = append(slept, duration)
		host.server.Dequeue(other, request("RETRY"))
	})
	if err != nil || result.Subrc != 0 || len(slept) != 1 || slept[0] != time.Second {
		t.Fatalf("result %+v err %v slept %v", result, err, slept)
	}
}

func TestEndedContextDuringSleepReturnsError(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()
	const id = "ended-in-sleep"
	defer host.kernel.End(id)

	step := new(struct{ int })
	host.Begin(step)
	if ok, err := host.bind(step, id, "ALICE"); !ok || err != nil {
		t.Fatalf("bind: %v %v", ok, err)
	}
	other := host.server.Open("OTHER")
	host.server.EnqueueWith(other, request("ENDED"), false, nil)
	_, err := host.EnqueueWithSleep(step, request("ENDED"), true, func(time.Duration) {
		host.end(id)
	})
	if !errors.Is(err, ErrSessionEnded) {
		t.Fatalf("err %v, want ErrSessionEnded", err)
	}
	host.Finish(step, true)
}

func TestNonErrorPanicFromSleepIsRethrown(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()

	other := host.server.Open("OTHER")
	defer host.server.End(other)
	host.server.EnqueueWith(other, request("SLEEP-DUMP"), false, nil)
	step := new(struct{ int })
	host.Begin(step)
	defer host.Finish(step, true)
	defer func() {
		if recovered := recover(); recovered != "sleep dump" {
			t.Fatalf("recovered %v (%T), want the original string panic", recovered, recovered)
		}
	}()
	host.EnqueueWithSleep(step, request("SLEEP-DUMP"), true, func(time.Duration) { panic("sleep dump") })
	t.Fatal("a dump during the sleep became a successful enqueue")
}

func TestPinnedContextSurvivesAnotherStepsDump(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()
	const id = "pinned-context"
	defer host.end(id)

	parked, dumping := new(struct{ int }), new(struct{ int })
	host.Begin(parked)
	host.Begin(dumping)
	defer host.Finish(parked, false)
	for _, step := range []any{parked, dumping} {
		if ok, err := host.bind(step, id, "ALICE"); !ok || err != nil {
			t.Fatalf("bind: %v %v", ok, err)
		}
	}
	host.Finish(dumping, true)
	if host.kernel.ContextAlive(id) {
		t.Fatal("dumping step did not retire the key's current context")
	}
	if result, err := host.Enqueue(parked, request("PARKED"), nil); err != nil || result.Subrc != 0 {
		t.Fatalf("parked enqueue: result %+v err %v", result, err)
	}
}

func TestDequeueAndDequeueAllFollowNode(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()

	step := new(struct{ int })
	host.Begin(step)
	first, second := request("ONE"), request("TWO")
	host.Enqueue(step, first, nil)
	host.Enqueue(step, second, nil)
	if err := host.Dequeue(step, first); err != nil {
		t.Fatal(err)
	}
	if rows := host.server.Read(enq.Filter{Table: "ZOSD_TEST"}); len(rows) != 1 || rows[0].Arg != "TWO" {
		t.Fatalf("after Dequeue: %+v", rows)
	}
	if err := host.DequeueAll(step); err != nil {
		t.Fatal(err)
	}
	if rows := host.server.Read(enq.Filter{Table: "ZOSD_TEST"}); len(rows) != 0 {
		t.Fatalf("after DequeueAll: %+v", rows)
	}
	host.Finish(step, false)
}

func TestEndedKeyLedgerIsBoundedAndRefreshed(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()

	host.end("repeat")
	for i := 0; i < 10000; i++ {
		host.end(fmt.Sprintf("id-%d", i))
		if i == 5000 {
			host.end("repeat")
		}
	}
	if len(host.ended) != 10000 {
		t.Fatalf("ended ledger has %d keys, want %d", len(host.ended), 10000)
	}
	_, ended := host.ended["repeat"]
	if !ended {
		t.Fatal("a repeated end did not refresh its position")
	}
	if _, ended := host.ended["id-0"]; ended {
		t.Fatal("the oldest distinct end was not evicted")
	}
}

// A refused rebind must not release the step's current pin early: two steps
// share retired context A; the first tries to rebind to a key ended with
// trailing blanks (the kernel's trimEnd), is refused, and finishes; the second
// step's lock on A must survive until that step ends.
func TestRefusedRebindKeepsOnePin(t *testing.T) {
	host, closeServer := newHost(t)
	defer closeServer()
	const shared, ended = "rebind-shared", "rebind-ended"
	defer host.kernel.End(shared)
	first, second := new(struct{ int }), new(struct{ int })
	host.Begin(first)
	host.Begin(second)
	for _, step := range []any{first, second} {
		if ok, err := host.bind(step, shared, "ALICE"); !ok || err != nil {
			t.Fatalf("bind shared: %v %v", ok, err)
		}
	}
	if _, err := host.Enqueue(second, request("KEPT"), nil); err != nil {
		t.Fatal(err)
	}
	sid, _ := host.kernel.Handle(shared)
	host.kernel.DropContext(shared, sid) // retired: ends with its last pin
	host.end(ended + "  ")
	if ok, err := host.bind(first, ended, "ALICE"); ok || err != nil {
		t.Fatalf("bind to an ended key: %v %v", ok, err)
	}
	host.Finish(first, false)
	kept := 0
	for _, row := range host.server.Read(enq.Filter{Table: "ZOSD_TEST"}) {
		if row.Arg == "KEPT" {
			kept++
		}
	}
	if kept != 1 {
		t.Fatal("a refused rebind released the shared context under the other step")
	}
	host.Finish(second, false)
}
