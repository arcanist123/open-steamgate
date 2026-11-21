// Package enqnet is the E3 socket (ADR 0008 E3, ADR 0010 slice 3): the lock table served to
// other processes, so a gateway owns one table and every sidecar's
// ENQUEUE_* is a client of it. Newline-delimited JSON over any stream
// (a Unix socket in practice); the first message of a connection is the
// hello naming the generation whose steps the connection carries, and every
// session the connection opens is owned by (that generation, the session,
// its LUW). When the connection goes -- the sidecar exited or crashed --
// each session it opened and did not end is Lost: dialog locks and the
// uncommitted LUW's locks go, locks a COMMIT handed to an update task stay
// until UpdateDone unless ServeOptions.InlineUpdates says the update ran in
// the process that died (sound because osgo commits the database before it
// hands the locks over; README.md). ServeOptions.BeforeRelease runs before
// any of it, so a process whose connection broke is ended first.
//
// One attempt per ENQUEUE crosses the socket: the _WAIT schedule runs in the
// client (retry), as it runs in the caller in one process, so a waiting
// session never holds the server or the connection.

package enqnet

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"osg/gogen/enq"
)

// Request, Result, Row and Filter are the lock server's own.
type (
	Request = enq.Request
	Result  = enq.Result
	Row     = enq.Row
	Filter  = enq.Filter
)

var _ enq.Locks = (*Client)(nil)

// ProtocolVersion is the E3 wire's version. The hello carries it both ways
// and either side refuses another: a client and a server built from
// different trees fail at Dial with a clear error rather than at the first
// operation one of them does not know.
const ProtocolVersion = 1

// ErrProtocol is what Dial and NewClient wrap when the server speaks
// another protocol version (or none) or refuses the hello.
var ErrProtocol = errors.New("enq wire: protocol mismatch")

// Hello names the client to the server: the generation its steps run in
// (the owner's first part), the process the connection belongs to (PID,
// 0 = not a process the server should know, a test's pipe) and a
// free-form name for the log. Version is set by NewClient.
type Hello struct {
	Version    int    `json:"version"`
	Generation string `json:"generation"`
	PID        int    `json:"pid,omitempty"`
	Name       string `json:"name,omitempty"`
}

type wireReq struct {
	ID      int64    `json:"id"`
	Op      string   `json:"op"`
	SID     int64    `json:"sid,omitempty"`
	User    string   `json:"user,omitempty"`
	Hello   *Hello   `json:"hello,omitempty"`
	Req     *Request `json:"req,omitempty"`
	Updated bool     `json:"updated,omitempty"`
	Owner   string   `json:"owner,omitempty"`
	Filter  *Filter  `json:"filter,omitempty"`
}

type wireRes struct {
	ID    int64   `json:"id"`
	SID   int64   `json:"sid,omitempty"`
	Res   *Result `json:"res,omitempty"`
	Owner string  `json:"owner,omitempty"`
	Rows  []Row   `json:"rows,omitempty"`
	Row   *Row    `json:"row,omitempty"`
	Found bool    `json:"found,omitempty"`
	Gone  bool    `json:"gone,omitempty"` // the server is closed: SYSTEM_FAILURE
	Err   string  `json:"err,omitempty"`
	// Version answers a hello: the server's ProtocolVersion
	Version int `json:"version,omitempty"`
}

// ServeOptions decide what a lost connection releases.
type ServeOptions struct {
	// InlineUpdates: the client runs its update task inside its own process
	// (osgo does: COMMIT WORK runs the update and says UpdateDone before it
	// returns), so an update owner a COMMIT ended dies with the process too.
	InlineUpdates bool
	// Lost, when set, is told each session a lost connection released.
	Lost func(h Hello, sid int64)
	// BeforeRelease, when set, runs when a connection that opened sessions
	// is gone and before any of them is released; it returns once the
	// process the hello named can no longer write (the gateway kills a
	// sidecar that is still alive and waits for its exit). A connection can
	// break while its process lives on and may still commit: its locks must
	// not go before that process does.
	BeforeRelease func(h Hello)
	Logf          func(string, ...any)
}

// Serve accepts connections on ln until it is closed and serves each from srv.
func Serve(srv *enq.Server, ln net.Listener, o ServeOptions) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go ServeConn(srv, conn, o)
	}
}

// ServeConn serves one client until it disconnects, then releases what its
// sessions held by the rule above. Requests of one connection run in the
// order they were sent.
func ServeConn(srv *enq.Server, conn net.Conn, o ServeOptions) {
	defer conn.Close()
	logf := o.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	dec := json.NewDecoder(bufio.NewReader(conn))
	w := bufio.NewWriter(conn)
	enc := json.NewEncoder(w)
	var hello Hello
	owned := map[int64]bool{}
	mine := map[int64]bool{} // every session this connection opened, ended or not
	defer func() {
		if len(owned) > 0 && o.BeforeRelease != nil {
			o.BeforeRelease(hello)
		}
		for sid := range owned {
			srv.Lost(sid, o.InlineUpdates)
			if o.Lost != nil {
				o.Lost(hello, sid)
			}
		}
		if len(owned) > 0 {
			logf("enq: %s (%s) gone: %d session(s) released", hello.Name, hello.Generation, len(owned))
		}
	}()
	for {
		var q wireReq
		if err := dec.Decode(&q); err != nil {
			return
		}
		a := wireRes{ID: q.ID}
		helloed := hello.Version != 0
		switch {
		case q.Op == "hello":
			if helloed {
				a.Err = "a second hello"
			} else if q.Hello == nil || q.Hello.Version != ProtocolVersion {
				v := 0
				if q.Hello != nil {
					v = q.Hello.Version
				}
				a.Err = fmt.Sprintf("protocol version %d, this server speaks %d", v, ProtocolVersion)
			} else {
				hello = *q.Hello
				a.Version = ProtocolVersion
			}
			if a.Err != "" {
				logf("enq: hello refused: %s", a.Err)
				_ = enc.Encode(&a)
				_ = w.Flush()
				return
			}
		case !helloed:
			a.Err = "hello first"
			_ = enc.Encode(&a)
			_ = w.Flush()
			return
		case q.SID != 0 && !mine[q.SID] && q.Op != "updateDone":
			// a session is its connection's; UpdateDone may come from
			// anywhere (an update task outside the process that committed)
			a.Err = fmt.Sprintf("session %d is not this connection's", q.SID)
		}
		if a.Err != "" || q.Op == "hello" {
			goto answer
		}
		switch q.Op {
		case "open":
			a.SID = srv.OpenIn(q.User, hello.Generation)
			if a.SID != 0 {
				owned[a.SID] = true
				mine[a.SID] = true
			} else {
				a.Gone = true
			}
		case "enqueue":
			if q.Req == nil {
				a.Err = "enqueue without a request"
				break
			}
			// one attempt: the client runs the _WAIT schedule (enq.Retry)
			res := srv.EnqueueWith(q.SID, *q.Req, false, nil)
			a.Gone = res.Subrc == 2 && srv.Closed()
			a.Res = &res
		case "dequeue":
			if q.Req != nil {
				srv.Dequeue(q.SID, *q.Req)
			}
		case "dequeueAll":
			srv.DequeueAll(q.SID)
		case "rollback":
			srv.Rollback(q.SID)
		case "commit":
			a.Owner = srv.Commit(q.SID, q.Updated)
		case "updateDone":
			srv.UpdateDone(q.SID, q.Owner)
		case "end":
			srv.End(q.SID)
			delete(owned, q.SID)
		case "updateOwner":
			a.Owner = srv.UpdateOwner(q.SID)
		case "read":
			var f Filter
			if q.Filter != nil {
				f = *q.Filter
			}
			a.Rows = srv.Read(f)
		case "holder":
			if q.Req != nil {
				row, found := srv.Holder(*q.Req)
				a.Found = found
				if found {
					a.Row = &row
				}
			}
		default:
			a.Err = "unknown op " + q.Op
		}
	answer:
		if err := enc.Encode(&a); err != nil {
			return
		}
		if err := w.Flush(); err != nil {
			return
		}
	}
}

// Client is a lock table in another process, reached over the E3 socket.
// It is safe for concurrent use; a call after the connection is gone
// answers as a closed Server does (Open 0, ENQUEUE SYSTEM_FAILURE).
type Client struct {
	conn    net.Conn
	wmu     sync.Mutex
	w       *bufio.Writer
	enc     *json.Encoder
	mu      sync.Mutex
	next    int64
	pending map[int64]chan wireRes
	done    chan struct{}
	err     error
	// refused counts answers the server refused (an unknown op, a session
	// of another connection): each answered the caller as a closed server
	refused  atomic.Int64
	lastFail atomic.Value // string: the last refusal
}

// Dial connects to a lock server and says hello.
func Dial(network, address string, h Hello) (*Client, error) {
	conn, err := net.Dial(network, address)
	if err != nil {
		return nil, err
	}
	return NewClient(conn, h)
}

// NewClient speaks the protocol over an open connection (a test's pipe).
// It sends the hello with this build's ProtocolVersion and refuses a
// server that answers with another one, or with none (an older server),
// wrapping ErrProtocol.
func NewClient(conn net.Conn, h Hello) (*Client, error) {
	c := &Client{conn: conn, w: bufio.NewWriter(conn), pending: map[int64]chan wireRes{}, done: make(chan struct{})}
	c.enc = json.NewEncoder(c.w)
	go c.read()
	h.Version = ProtocolVersion
	a, err := c.roundTrip(wireReq{Op: "hello", Hello: &h})
	if err == nil && a.Version != ProtocolVersion {
		err = fmt.Errorf("%w: the server speaks version %d, this client %d", ErrProtocol, a.Version, ProtocolVersion)
	}
	if err != nil {
		c.Close()
		<-c.done
		return nil, err
	}
	return c, nil
}

// Refused says how many calls the server refused and the last reason; each
// such call answered as a closed server does (ENQUEUE SYSTEM_FAILURE).
func (c *Client) Refused() (int64, string) {
	s, _ := c.lastFail.Load().(string)
	return c.refused.Load(), s
}

// Done is closed when the connection is gone; Err then says why.
func (c *Client) Done() <-chan struct{} { return c.done }

// Err is why the connection ended, nil while it lives.
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Close ends the connection; the server releases this client's sessions.
func (c *Client) Close() error { return c.conn.Close() }

func (c *Client) read() {
	dec := json.NewDecoder(bufio.NewReader(c.conn))
	var err error
	for {
		var a wireRes
		if err = dec.Decode(&a); err != nil {
			break
		}
		c.mu.Lock()
		ch := c.pending[a.ID]
		delete(c.pending, a.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- a
		}
	}
	c.mu.Lock()
	if err == nil {
		err = errors.New("enq: connection closed")
	}
	c.err = err
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	close(c.done)
	c.conn.Close()
}

// call sends one request and waits for its answer; false when the
// connection is gone (before or during the call) or the server refused the
// request. A refusal (an op the server does not know, a session that is
// not this connection's) is not a lock answer: the caller answers it as a
// closed server, ENQUEUE with SYSTEM_FAILURE, and the work process goes on
// rather than dumping on a defect of the other side.
func (c *Client) call(q wireReq) (wireRes, bool) {
	a, err := c.roundTrip(q)
	if err != nil {
		if errors.Is(err, errRefused) {
			c.refused.Add(1)
			c.lastFail.Store(err.Error())
		}
		return wireRes{}, false
	}
	return a, true
}

var errRefused = errors.New("enq wire: refused")

func (c *Client) roundTrip(q wireReq) (wireRes, error) {
	ch := make(chan wireRes, 1)
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return wireRes{}, err
	}
	c.next++
	q.ID = c.next
	c.pending[q.ID] = ch
	c.mu.Unlock()
	c.wmu.Lock()
	err := c.enc.Encode(&q)
	if err == nil {
		err = c.w.Flush()
	}
	c.wmu.Unlock()
	if err != nil {
		c.conn.Close() // read() sees it and fails every pending call
	}
	a, ok := <-ch
	if !ok {
		if err := c.Err(); err != nil {
			return wireRes{}, err
		}
		return wireRes{}, errors.New("enq: connection closed")
	}
	if a.Err != "" {
		if q.Op == "hello" {
			return wireRes{}, fmt.Errorf("%w: %s", ErrProtocol, a.Err)
		}
		return wireRes{}, fmt.Errorf("%w: %s: %s", errRefused, q.Op, a.Err)
	}
	return a, nil
}

func (c *Client) Open(user string) int64 {
	a, ok := c.call(wireReq{Op: "open", User: user})
	if !ok {
		return 0
	}
	return a.SID
}

func (c *Client) EnqueueWith(sid int64, r Request, wait bool, sleep func(time.Duration)) Result {
	return enq.Retry(func() (Result, bool) {
		a, ok := c.call(wireReq{Op: "enqueue", SID: sid, Req: &r})
		if !ok || a.Gone || a.Res == nil {
			return Result{}, false
		}
		return *a.Res, true
	}, wait, sleep)
}

func (c *Client) Dequeue(sid int64, r Request) { c.call(wireReq{Op: "dequeue", SID: sid, Req: &r}) }
func (c *Client) DequeueAll(sid int64)         { c.call(wireReq{Op: "dequeueAll", SID: sid}) }
func (c *Client) Rollback(sid int64)           { c.call(wireReq{Op: "rollback", SID: sid}) }
func (c *Client) End(sid int64)                { c.call(wireReq{Op: "end", SID: sid}) }

func (c *Client) Commit(sid int64, updated bool) string {
	a, _ := c.call(wireReq{Op: "commit", SID: sid, Updated: updated})
	return a.Owner
}

func (c *Client) UpdateDone(sid int64, owner string) {
	if owner == "" {
		return
	}
	c.call(wireReq{Op: "updateDone", SID: sid, Owner: owner})
}

func (c *Client) UpdateOwner(sid int64) string {
	a, _ := c.call(wireReq{Op: "updateOwner", SID: sid})
	return a.Owner
}

func (c *Client) Read(f Filter) []Row {
	a, _ := c.call(wireReq{Op: "read", Filter: &f})
	return a.Rows
}

func (c *Client) Holder(r Request) (Row, bool) {
	a, ok := c.call(wireReq{Op: "holder", Req: &r})
	if !ok || !a.Found || a.Row == nil {
		return Row{}, false
	}
	return *a.Row, true
}
