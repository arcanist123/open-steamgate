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
// the process that died.
//
// One attempt per ENQUEUE crosses the socket: the _WAIT schedule runs in the
// client (retry), as it runs in the caller in one process, so a waiting
// session never holds the server or the connection.

package enqnet

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"sync"
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

// Hello names the client to the server: the generation its steps run in
// (the owner's first part) and a free-form name for the log.
type Hello struct {
	Generation string `json:"generation"`
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
}

// ServeOptions decide what a lost connection releases.
type ServeOptions struct {
	// InlineUpdates: the client runs its update task inside its own process
	// (osgo does: COMMIT WORK runs the update and says UpdateDone before it
	// returns), so an update owner a COMMIT ended dies with the process too.
	InlineUpdates bool
	// Lost, when set, is told each session a lost connection released.
	Lost func(h Hello, sid int64)
	Logf func(string, ...any)
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
	defer func() {
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
		switch q.Op {
		case "hello":
			if q.Hello != nil {
				hello = *q.Hello
			}
		case "open":
			a.SID = srv.OpenIn(q.User, hello.Generation)
			if a.SID != 0 {
				owned[a.SID] = true
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
func NewClient(conn net.Conn, h Hello) (*Client, error) {
	c := &Client{conn: conn, w: bufio.NewWriter(conn), pending: map[int64]chan wireRes{}, done: make(chan struct{})}
	c.enc = json.NewEncoder(c.w)
	go c.read()
	if _, ok := c.call(wireReq{Op: "hello", Hello: &h}); !ok {
		c.Close()
		return nil, c.Err()
	}
	return c, nil
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
// connection is gone (before or during the call).
func (c *Client) call(q wireReq) (wireRes, bool) {
	ch := make(chan wireRes, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return wireRes{}, false
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
		return wireRes{}, false
	}
	if a.Err != "" {
		panic("enq wire: " + a.Err) // a protocol error is a defect, not a lock answer
	}
	return a, true
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
