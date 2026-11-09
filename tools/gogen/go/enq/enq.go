// Package enq is the lock server (ENQ E1): the table that ENQUEUE_<object>,
// DEQUEUE_<object>, DEQUEUE_ALL and ENQUEUE_READ work on, as measured on a
// system and written down in docs/enq-contract.md (the fixtures are
// test/fixtures/enq/contract.json).
//
// One goroutine owns the table; every request is a function it runs, sent
// over a channel, so there is no mutex and no request sees another half
// done. Waiting (_WAIT) happens in the caller, between requests, so a
// waiting session never holds the server.
//
// The owner model is the measured one. A session has two owners: the dialog
// owner (GUSR), which holds _SCOPE 1 and lives as long as the session, and
// the update owner (GUSRVB), which holds _SCOPE 2 and belongs to the SAP
// LUW. _SCOPE 3 is one row carrying both. ROLLBACK WORK releases the update
// halves and starts a new update owner; COMMIT WORK starts a new one only
// when it ran an update, and the update halves go when that update has run
// (UpdateDone), not at the COMMIT. A COMMIT with nothing to update releases
// nothing. The end of a session releases everything.
package enq

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Field is one key field of a lock argument. A generic field (an initial
// value without X_<field>) matches every value.
type Field struct {
	Value   string
	Generic bool
	Length  int
}

// Request is one ENQUEUE or DEQUEUE.
type Request struct {
	Client string
	Table  string // GNAME
	Object string // the lock object (GOBJ)
	Fields []Field
	Mode   string // E, S, X or O
	Scope  int    // 1, 2 (the default) or 3
}

// Result of an ENQUEUE: Subrc 0, or 1 = FOREIGN_LOCK with message MC Msgno
// (601: another owner holds it, 602: the caller's own lock refuses it) and
// Holder the user of the lock in the way (sy-msgv1), or 2 = SYSTEM_FAILURE
// (an unknown session, a closed server).
type Result struct {
	Subrc  int
	Msgno  string
	Holder string
}

// Row is one row of ENQUEUE_READ.
type Row struct {
	Client, Table, Object, Arg, Mode, User string
	Dialog, Update                         string // GUSR, GUSRVB; "" = none
	Dialogs, Updates                       int    // GUSE, GUSEVB
	Taken                                  time.Time
	Session                                int64  // the session the row belongs to
	Generation                             string // the generation whose step opened the session ("" in one process)
}

// Filter of ENQUEUE_READ: an empty field matches every row.
type Filter struct {
	Client, Table, User string
}

type row struct{ Row }

type session struct {
	user           string
	dialog, update string
	generation     string
}

type state struct {
	rows     []*row
	sessions map[int64]*session
	seq      int64
	instance string
	now      func() time.Time
}

// Server is a running lock server.
type Server struct {
	reqs   chan func(*state)
	done   chan struct{}
	closed sync.Once
}

// New starts a lock server. instance names the server in owner ids, as an
// application server's instance name does on a system.
func New(instance string) *Server {
	srv := &Server{reqs: make(chan func(*state)), done: make(chan struct{})}
	st := &state{sessions: map[int64]*session{}, instance: instance, now: time.Now}
	go func() {
		for {
			select {
			case f := <-srv.reqs:
				f(st)
			case <-srv.done:
				return
			}
		}
	}()
	return srv
}

// do runs f on the server's goroutine and waits for it; false when the
// server is closed, and f did not run
func (srv *Server) do(f func(*state)) bool {
	ran := make(chan struct{})
	select {
	case srv.reqs <- func(st *state) { f(st); close(ran) }:
		<-ran
		return true
	case <-srv.done:
		return false
	}
}

// Close stops the server; closing it again does nothing, and a request
// after it answers as for an unknown session.
func (srv *Server) Close() { srv.closed.Do(func() { close(srv.done) }) }

// Closed says whether Close has run.
func (srv *Server) Closed() bool {
	select {
	case <-srv.done:
		return true
	default:
		return false
	}
}

// ownerID is 58 characters like a system's: a timestamp, a sequence and the
// instance, padded with dots. It is compared, never parsed.
func (st *state) ownerID() string {
	st.seq++
	id := fmt.Sprintf("%s%06d%s", strings.ReplaceAll(st.now().UTC().Format("20060102150405.000000"), ".", ""), st.seq%1000000, st.instance)
	if len(id) > 58 {
		id = id[:58]
	}
	return id + strings.Repeat(".", 58-len(id))
}

// Open starts a session of user and returns its handle.
func (srv *Server) Open(user string) (id int64) { return srv.OpenIn(user, "") }

// OpenIn starts a session of user for a step of generation: an owner is then
// (generation, session, LUW) -- the generation that opened it, the handle,
// and the update owner of its LUW (UpdateOwner) -- and its rows say which
// generation they belong to (Row.Generation). Several processes share one
// table this way (ADR 0010 slice 3, the E3 socket: go/enqnet).
func (srv *Server) OpenIn(user, generation string) (id int64) {
	srv.do(func(st *state) {
		st.seq++
		id = st.seq
		st.sessions[id] = &session{user: user, dialog: st.ownerID(), update: st.ownerID(), generation: generation}
	})
	return id
}

// garg is the argument as ENQUEUE_READ shows it: the client and each field
// at its length, U+FFFF in every position of a generic field
func garg(client string, fields []Field) string {
	var b strings.Builder
	b.WriteString(client)
	for _, f := range fields {
		if f.Generic {
			b.WriteString(strings.Repeat("￿", f.Length))
			continue
		}
		v := f.Value
		if rs := []rune(v); f.Length > 0 && len(rs) > f.Length {
			v = string(rs[:f.Length])
		}
		if n := len([]rune(v)); n < f.Length {
			v += strings.Repeat(" ", f.Length-n)
		}
		b.WriteString(v)
	}
	return strings.TrimRight(b.String(), " ")
}

// collide says whether two arguments of one table touch a common key: the
// arguments as ENQUEUE_READ shows them, position by position, U+FFFF (a
// generic field) matching anything and a missing position a blank
func collide(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < max(len(ra), len(rb)); i++ {
		x, y := ' ', ' '
		if i < len(ra) {
			x = ra[i]
		}
		if i < len(rb) {
			y = rb[i]
		}
		if x != y && x != '\uffff' && y != '\uffff' {
			return false
		}
	}
	return true
}

// owns says whether the session holds the row: its dialog half, or an
// update half of its current update owner. The half of an update owner a
// COMMIT ended belongs to the update task until UpdateDone, so to anyone
// else it is another owner's (not measured: docs/enq-contract.md)
func (s *session) owns(w *row) bool {
	return w.Dialogs > 0 && w.Dialog == s.dialog || w.Updates > 0 && w.Update == s.update
}

func shared(mode string) bool { return mode == "S" || mode == "O" }

func scopeOf(r Request) int {
	if r.Scope == 1 || r.Scope == 3 {
		return r.Scope
	}
	return 2
}

func (st *state) enqueue(sid int64, r Request) Result {
	s := st.sessions[sid]
	if s == nil {
		return Result{Subrc: 2}
	}
	arg := garg(r.Client, r.Fields)
	// the conflicting lock taken first decides, whoever holds it (measured,
	// precedence-* in E0): another owner's E or X, or any of its own when one
	// side is X; S and O are shared with other owners, the caller's own
	// locks stack. The rows are in the order they were taken.
	var same *row
	for _, w := range st.rows {
		if w.Client != r.Client || w.Table != r.Table || !collide(w.Arg, arg) {
			continue
		}
		// halves, not rows: another session's row, or the half of an update
		// owner a COMMIT ended (the update task's), is another owner's even
		// when the row's dialog half is the caller's
		if (w.Session != sid || w.Updates > 0 && w.Update != s.update) && (!shared(w.Mode) || !shared(r.Mode)) {
			return Result{Subrc: 1, Msgno: "601", Holder: w.User}
		}
		if !s.owns(w) {
			continue
		}
		if w.Mode == "X" || r.Mode == "X" {
			return Result{Subrc: 1, Msgno: "602", Holder: w.User}
		}
		// a lock is the table, the argument and the mode (GOBJ is shown only)
		if w.Arg == arg && w.Mode == r.Mode && (w.Updates == 0 || w.Update == s.update) {
			same = w
		}
	}
	if same == nil {
		same = &row{Row: Row{Client: r.Client, Table: r.Table, Object: r.Object, Arg: arg, Mode: r.Mode, User: s.user, Taken: st.now(), Session: sid, Generation: s.generation}}
		st.rows = append(st.rows, same)
	}
	scope := scopeOf(r)
	if scope == 1 || scope == 3 {
		same.Dialogs++
		same.Dialog = s.dialog
	}
	if scope == 2 || scope == 3 {
		same.Updates++
		same.Update = s.update
	}
	return Result{}
}

// Enqueue takes a lock for the session. With wait, a refusal is retried
// once a second for five seconds before it is answered (measured: a lock
// that stays held fails after about 4.7 s, one released after about 1 s is
// granted after about 1.0 s; the interval itself was not measured).
func (srv *Server) Enqueue(sid int64, r Request, wait bool) Result {
	return srv.EnqueueWith(sid, r, wait, time.Sleep)
}

const (
	waitInterval = time.Second
	waitTries    = 5
)

func (srv *Server) EnqueueWith(sid int64, r Request, wait bool, sleep func(time.Duration)) Result {
	return Retry(func() (res Result, ok bool) {
		ok = srv.do(func(st *state) { res = st.enqueue(sid, r) })
		return res, ok
	}, wait, sleep)
}

// Retry is the _WAIT schedule around one attempt (false: the server is
// gone), run in the caller so a waiting session never holds the server; a
// remote client (go/enqnet) runs it on its side of the socket for the same
// reason.
func Retry(attempt func() (Result, bool), wait bool, sleep func(time.Duration)) Result {
	for try := 0; ; try++ {
		res, ok := attempt()
		if !ok {
			return Result{Subrc: 2} // SYSTEM_FAILURE: the server is gone
		}
		if res.Subrc != 1 || !wait || try >= waitTries {
			return res
		}
		sleep(waitInterval)
	}
}

// Dequeue releases one count of a lock the session holds with exactly this
// argument, mode and scope; anything else is a silent no-op, as on a system.
func (srv *Server) Dequeue(sid int64, r Request) {
	srv.do(func(st *state) {
		s := st.sessions[sid]
		if s == nil {
			return
		}
		arg := garg(r.Client, r.Fields)
		scope := scopeOf(r)
		for _, w := range st.rows {
			if !s.owns(w) || w.Client != r.Client || w.Table != r.Table || w.Arg != arg || w.Mode != r.Mode {
				continue
			}
			released := false
			if (scope == 1 || scope == 3) && w.Dialogs > 0 && w.Dialog == s.dialog {
				w.Dialogs--
				released = true
			}
			if (scope == 2 || scope == 3) && w.Updates > 0 && w.Update == s.update {
				w.Updates--
				released = true
			}
			if released {
				break
			}
		}
		st.sweep()
	})
}

// sweep drops the rows no half holds any more and blanks a released half
func (st *state) sweep() {
	kept := st.rows[:0]
	for _, w := range st.rows {
		if w.Dialogs == 0 {
			w.Dialog = ""
		}
		if w.Updates == 0 {
			w.Update = ""
		}
		if w.Dialogs > 0 || w.Updates > 0 {
			kept = append(kept, w)
		}
	}
	st.rows = kept
}

// DequeueAll releases every lock of the session, in every scope.
func (srv *Server) DequeueAll(sid int64) {
	srv.do(func(st *state) { st.release(sid) })
}

// release drops the session's own halves; the half of an update owner a
// COMMIT ended stays until UpdateDone, so the update task that runs after
// the session still holds its locks (not measured)
func (st *state) release(sid int64) {
	s := st.sessions[sid]
	if s == nil {
		return
	}
	for _, w := range st.rows {
		if w.Session != sid {
			continue
		}
		if w.Dialog == s.dialog {
			w.Dialogs = 0
		}
		if w.Update == s.update {
			w.Updates = 0
		}
	}
	st.sweep()
}

// Rollback is ROLLBACK WORK: the update halves go and a new update owner
// starts.
func (srv *Server) Rollback(sid int64) {
	srv.do(func(st *state) {
		s := st.sessions[sid]
		if s == nil {
			return
		}
		st.releaseUpdate(sid, s.update)
		s.update = st.ownerID()
	})
}

func (st *state) releaseUpdate(sid int64, owner string) {
	for _, w := range st.rows {
		if w.Session == sid && w.Update == owner && owner != "" {
			w.Updates = 0
		}
	}
	st.sweep()
}

// Commit is COMMIT WORK. With nothing in the update task it releases
// nothing and keeps the update owner (measured). With an update it starts a
// new update owner and returns the one that ended: its locks go when the
// update has run, which the host says with UpdateDone (COMMIT WORK AND WAIT
// says it before it returns).
func (srv *Server) Commit(sid int64, updated bool) (ended string) {
	srv.do(func(st *state) {
		s := st.sessions[sid]
		if s == nil || !updated {
			return
		}
		ended = s.update
		s.update = st.ownerID()
	})
	return ended
}

// UpdateDone releases the locks of an update owner Commit ended.
func (srv *Server) UpdateDone(sid int64, owner string) {
	if owner == "" {
		return
	}
	srv.do(func(st *state) { st.releaseUpdate(sid, owner) })
}

// End ends the session: all its locks go.
func (srv *Server) End(sid int64) {
	srv.do(func(st *state) {
		st.release(sid)
		delete(st.sessions, sid)
	})
}

// Lost ends the session of a process that died (a sidecar crash, ADR 0010
// "Failure modes"): its dialog halves and the halves of its current update
// owner go -- the LUW that never committed rolled back with the process's
// connection -- exactly as End does. The halves of an update owner a COMMIT
// already handed to the update task stay until that update completes
// (UpdateDone), unless inlineUpdates says the update ran inside the process
// that died, which aborts it: then they go too.
func (srv *Server) Lost(sid int64, inlineUpdates bool) {
	srv.do(func(st *state) {
		st.release(sid)
		delete(st.sessions, sid)
		if !inlineUpdates {
			return
		}
		for _, w := range st.rows {
			if w.Session == sid {
				w.Updates = 0
			}
		}
		st.sweep()
	})
}

// UpdateOwner is the session's current update owner id (GUSRVB of its next
// _SCOPE 2 lock).
func (srv *Server) UpdateOwner(sid int64) (id string) {
	srv.do(func(st *state) {
		if s := st.sessions[sid]; s != nil {
			id = s.update
		}
	})
	return id
}

// Read is ENQUEUE_READ.
func (srv *Server) Read(f Filter) (rows []Row) {
	srv.do(func(st *state) {
		for _, w := range st.rows {
			if (f.Client == "" || f.Client == w.Client) && (f.Table == "" || f.Table == w.Table) && (f.User == "" || f.User == w.User) {
				rows = append(rows, w.Row)
			}
		}
	})
	return rows
}

// Holder returns the first colliding lock, as the host's enqHolder does.
// It opens no session and changes no lock state.
func (srv *Server) Holder(r Request) (held Row, found bool) {
	srv.do(func(st *state) {
		arg := garg(r.Client, r.Fields)
		for _, w := range st.rows {
			if w.Table == r.Table && collide(w.Arg, arg) {
				held = w.Row
				found = true
				return
			}
		}
	})
	return
}
