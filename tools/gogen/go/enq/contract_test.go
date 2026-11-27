package enq

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// The gate of E1: every case of the measured contract (ENQ E0,
// test/fixtures/enq/contract.json) gives what the system gave.
//
// What the system does asynchronously is the harness's to model, not the
// lock server's: the update task that releases the update owner's locks
// after a COMMIT WORK, and the teardown of an ended session. Both are queued
// and happen at the next WAIT UP TO or at a read with a deadline
// (eventuallyWithinMs); an END_SESSION with async fires on the fake clock,
// so _WAIT runs in no real time. Informational steps run and are not
// checked.

type contract struct {
	LockObject struct {
		Name, Table string
		Args        []struct {
			Name   string
			Length int
		}
	} `json:"lockObject"`
	Cases []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Steps []struct {
			Owner         string         `json:"owner"`
			Call          string         `json:"call"`
			Params        map[string]any `json:"params"`
			Expect        map[string]any `json:"expect"`
			Informational bool           `json:"informational"`
			Async         *struct {
				DelayMs int `json:"delayMs"`
			} `json:"async"`
		} `json:"steps"`
	} `json:"cases"`
}

const client = "001"

type event struct {
	at time.Duration
	do func()
}

type harness struct {
	t       *testing.T
	srv     Locks
	c       *contract
	owners  map[string]int64
	updated map[string]bool
	pending []func()
	timed   []event
	now     time.Duration
	// the update owner before the last COMMIT or ROLLBACK and whether it
	// ended there: the next _SCOPE 2 lock must carry a new one, or the same
	ended   map[string]string
	renewed map[string]bool
	// when the last timed END_SESSION ran (grantedWithinMsOfRelease)
	released time.Duration
	// how long the update module of the open LUW runs (params.durationMs)
	duration map[string]int
}

func (h *harness) session(name string) int64 {
	if id, ok := h.owners[name]; ok {
		return id
	}
	id := h.srv.Open("<USER>")
	h.owners[name] = id
	return id
}

func (h *harness) advance(d time.Duration) {
	h.now += d
	sort.SliceStable(h.timed, func(i, j int) bool { return h.timed[i].at < h.timed[j].at })
	for len(h.timed) > 0 && h.timed[0].at <= h.now {
		e := h.timed[0]
		h.timed = h.timed[1:]
		e.do()
	}
}

func (h *harness) request(call string, p map[string]string) Request {
	r := Request{Client: client, Table: h.c.LockObject.Table, Object: h.c.LockObject.Name, Mode: p["MODE_ZOSD_PRB"]}
	if at := strings.Index(call, "_"); at >= 0 {
		r.Object = call[at+1:] // ENQUEUE_EZOSD_PRB2: the second lock object on the table
	}
	if r.Mode == "" {
		r.Mode = "E"
	}
	for _, a := range h.c.LockObject.Args {
		if a.Name == "MANDT" {
			continue
		}
		v, ok := p[a.Name]
		if !ok && a.Name == "K2" {
			v = "K" // the fixture's notation for a K2 the case text leaves out
		}
		generic := strings.TrimSpace(v) == "" && p["X_"+a.Name] != "X"
		r.Fields = append(r.Fields, Field{Value: v, Generic: generic, Length: a.Length})
	}
	fmt.Sscan(p["_SCOPE"], &r.Scope)
	return r
}

func number(v any) int {
	f, _ := v.(float64)
	return int(f)
}

// renewal checks expect.newUpdateOwner of a COMMIT or ROLLBACK step
func (h *harness) renewal(expect map[string]any, before string, sid int64) string {
	want, ok := expect["newUpdateOwner"]
	if !ok {
		return ""
	}
	if got := h.srv.UpdateOwner(sid) != before; got != want.(bool) {
		return fmt.Sprintf("newUpdateOwner %v", got)
	}
	return ""
}

func (h *harness) flush() {
	for _, f := range h.pending {
		f()
	}
	h.pending = nil
}

// step runs one step; delay is an async step's delay in ms, -1 for none
func (h *harness) step(owner, call string, p map[string]string, expect map[string]any, delay int) string {
	sid := h.session(owner)
	switch {
	case strings.HasPrefix(call, "ENQUEUE_") && call != "ENQUEUE_READ":
		if len(p) == 0 {
			p = map[string]string{"K1": "NEWOWNER"}
		}
		start := h.now
		r := h.request(call, p)
		res := h.srv.EnqueueWith(sid, r, p["_WAIT"] == "X", h.advance)
		// the GUSRVB the row just taken carries, against the one before the
		// last COMMIT or ROLLBACK: new after a ROLLBACK or a COMMIT that ran
		// an update, the same after a COMMIT that had nothing to update
		if before, ok := h.ended[owner]; ok && res.Subrc == 0 && r.Scope != 1 {
			stamped := h.stamp(sid, r)
			if want, ok := expect["newUpdateOwner"]; ok && (stamped != before) != want.(bool) {
				return fmt.Sprintf("newUpdateOwner %v", stamped != before)
			}
			if (stamped != before) != h.renewed[owner] {
				return fmt.Sprintf("update owner renewed %v, the contract says %v", stamped != before, h.renewed[owner])
			}
			delete(h.ended, owner)
		}
		if v, ok := expect["subrc"]; ok && number(v) != res.Subrc {
			return fmt.Sprintf("subrc %d, msgno %s", res.Subrc, res.Msgno)
		}
		if v, ok := expect["sy-msgno"]; ok && v != res.Msgno {
			return "msgno " + res.Msgno
		}
		if v, ok := expect["sy-msgv1"]; ok && v != res.Holder {
			return "holder " + res.Holder
		}
		if e, ok := expect["elapsedMs"].(map[string]any); ok {
			took := h.now - start
			if v, ok := e["min"]; ok && took < time.Duration(number(v))*time.Millisecond {
				return fmt.Sprintf("elapsed %v", took)
			}
			if v, ok := e["max"]; ok && took > time.Duration(number(v))*time.Millisecond {
				return fmt.Sprintf("elapsed %v", took)
			}
		}
		if v, ok := expect["grantedWithinMsOfRelease"]; ok {
			if h.released == 0 || h.now-h.released > time.Duration(number(v))*time.Millisecond {
				return fmt.Sprintf("granted at %v, released at %v", h.now, h.released)
			}
		}
	case strings.HasPrefix(call, "DEQUEUE_ALL"):
		h.srv.DequeueAll(sid)
	case strings.HasPrefix(call, "DEQUEUE_"):
		h.srv.Dequeue(sid, h.request(call, p))
	case call == "ENQUEUE_READ":
		if v, ok := expect["eventuallyWithinMs"]; ok {
			// a release that is asynchronous on a system has happened by the
			// deadline: the queued teardowns run, and the clock goes to it
			h.flush()
			h.advance(time.Duration(number(v)) * time.Millisecond)
		}
		return h.read(p, expect)
	case strings.HasPrefix(call, "CALL FUNCTION") && strings.Contains(call, "IN UPDATE TASK"):
		h.updated[owner] = true
		h.duration[owner] = 0
		if v, ok := p["durationMs"]; ok {
			var ms int
			fmt.Sscan(v, &ms)
			h.duration[owner] = ms
		}
	case call == "COMMIT WORK" || call == "COMMIT WORK AND WAIT":
		h.ended[owner], h.renewed[owner] = h.srv.UpdateOwner(sid), h.updated[owner]
		before := h.srv.UpdateOwner(sid)
		ended := h.srv.Commit(sid, h.updated[owner])
		took := time.Duration(h.duration[owner]) * time.Millisecond
		h.updated[owner] = false
		switch {
		case call == "COMMIT WORK AND WAIT":
			h.advance(took)
			h.srv.UpdateDone(sid, ended)
		case took > 0:
			// an update that runs for durationMs: its locks go when it ends
			h.timed = append(h.timed, event{at: h.now + took, do: func() { h.srv.UpdateDone(sid, ended) }})
		default:
			h.pending = append(h.pending, func() { h.srv.UpdateDone(sid, ended) })
		}
		if msg := h.renewal(expect, before, sid); msg != "" {
			return msg
		}
	case call == "ROLLBACK WORK":
		h.ended[owner], h.renewed[owner] = h.srv.UpdateOwner(sid), true
		h.updated[owner] = false
		before := h.srv.UpdateOwner(sid)
		h.srv.Rollback(sid)
		if msg := h.renewal(expect, before, sid); msg != "" {
			return msg
		}
	case strings.HasPrefix(call, "WAIT UP TO"):
		var n int
		fmt.Sscanf(strings.TrimPrefix(call, "WAIT UP TO "), "%d", &n)
		h.flush()
		h.advance(time.Duration(n) * time.Second)
	case call == "END_SESSION":
		if delay >= 0 {
			h.timed = append(h.timed, event{at: h.now + time.Duration(delay)*time.Millisecond, do: func() {
				h.srv.End(sid)
				h.released = h.now
			}})
		} else {
			h.pending = append(h.pending, func() { h.srv.End(sid) })
		}
	case strings.HasPrefix(call, "RFC_CONNECTION_CLOSE"):
		at := strings.Index(call, "(ends ")
		if at < 0 {
			return "which session the close ends: " + call
		}
		var name string
		fmt.Sscanf(call[at+len("(ends "):], "%2s", &name)
		ended := h.session(name)
		h.pending = append(h.pending, func() { h.srv.End(ended) })
	case strings.HasPrefix(call, "return from the RFC call"):
		// a stateful connection: the session goes on
	default:
		return "unknown call " + call
	}
	return ""
}

// stamp is the GUSRVB of the session's row for this request
func (h *harness) stamp(sid int64, r Request) string {
	arg := garg(r.Client, r.Fields)
	for _, row := range h.srv.Read(Filter{Client: r.Client, Table: r.Table}) {
		if row.Session == sid && row.Arg == arg && row.Mode == r.Mode {
			return row.Update
		}
	}
	return ""
}

func (h *harness) read(p map[string]string, expect map[string]any) string {
	rows := h.srv.Read(Filter{Client: client, Table: p["GNAME"]})
	if n, ok := expect["NUMBER"]; ok && number(n) != len(rows) {
		return fmt.Sprintf("NUMBER %d: %s", len(rows), show(rows))
	}
	want, _ := expect["rows"].([]any)
	used := make([]bool, len(rows))
	for _, w := range want {
		m := w.(map[string]any)
		found := false
		for i, r := range rows {
			if !used[i] && h.matches(r, m) {
				used[i], found = true, true
				break
			}
		}
		if !found {
			return fmt.Sprintf("no row %v in %s", m, show(rows))
		}
	}
	return ""
}

func (h *harness) matches(r Row, m map[string]any) bool {
	arg := strings.TrimRight(strings.ReplaceAll(m["GARG"].(string), "{MANDT}", client), " ")
	if r.Arg != arg || r.Mode != m["GMODE"] || r.Dialogs != number(m["GUSE"]) || r.Updates != number(m["GUSEVB"]) {
		return false
	}
	owned := func(id string, who any) bool {
		if who == nil {
			return id == ""
		}
		return id != "" && h.owners[who.(string)] == r.Session
	}
	// GUSRVB "S" is S's current update owner, "S^" the one S handed to its
	// update task at a COMMIT
	update := func(who any) bool {
		if who == nil {
			return r.Update == ""
		}
		name := who.(string)
		sid := h.owners[strings.TrimSuffix(name, "^")]
		if r.Update == "" || sid != r.Session {
			return false
		}
		return (r.Update == h.srv.UpdateOwner(sid)) != strings.HasSuffix(name, "^")
	}
	return owned(r.Dialog, m["GUSR"]) && update(m["GUSRVB"])
}

func show(rows []Row) string {
	var b strings.Builder
	for _, r := range rows {
		fmt.Fprintf(&b, "[%q %s use=%d/%d s=%d] ", r.Arg, r.Mode, r.Dialogs, r.Updates, r.Session)
	}
	return b.String()
}

func TestContract(t *testing.T) {
	runContract(t, func(t *testing.T) Locks {
		srv := New("osdhost_OSD_00")
		t.Cleanup(srv.Close)
		return srv
	})
}

// RunContract runs every case against the table open gives -- exported
// for the external test that runs them over the E3 socket (go/enqnet), which
// imports this package and so cannot live inside it.
func RunContract(t *testing.T, open func(*testing.T) Locks) { runContract(t, open) }

func runContract(t *testing.T, open func(*testing.T) Locks) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "test", "fixtures", "enq", "contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, tc := range c.Cases {
		t.Run(tc.ID, func(t *testing.T) {
			h := &harness{t: t, srv: open(t), c: &c, owners: map[string]int64{}, updated: map[string]bool{}, ended: map[string]string{}, renewed: map[string]bool{}, duration: map[string]int{}}
			for i, st := range tc.Steps {
				delay := -1
				if st.Async != nil {
					delay = st.Async.DelayMs
				}
				expect := st.Expect
				if st.Informational {
					expect = nil // what the sandbox showed in a race, not a gate
				}
				params := map[string]string{}
				for k, v := range st.Params {
					params[k] = fmt.Sprint(v)
				}
				if msg := h.step(st.Owner, st.Call, params, expect, delay); msg != "" {
					t.Fatalf("%s: step %d %s %s %v: %s", tc.Title, i+1, st.Owner, st.Call, st.Params, msg)
				}
			}
		})
	}
}
