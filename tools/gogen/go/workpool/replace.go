package workpool

// The replacement of a connection that cannot be proven clean (PR #900
// review rounds 1 and 2): the scrub, the discard, the reconnect retried
// within ReconnectGrace, and a work process stopped -- out of service, never
// lent or parked without a connection -- when none can be had.

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"time"
)

// scrub ends whatever transaction the connection still has, on a context
// of its own (the step's may be the cancelled one). "no transaction is
// active" is the clean answer; any other failure discards the connection
// (driver.ErrBadConn through Raw closes it instead of pooling it), which
// ends its transaction and with it the write lock; giveBack finds the
// work process a new one.
func (p *Pool) scrub(w *worker) {
	if w.conn == nil {
		return
	}
	_, err := w.conn.ExecContext(context.Background(), "ROLLBACK")
	if err == nil || strings.Contains(err.Error(), "no transaction is active") {
		return
	}
	p.discard(w)
}

// giveBack returns a work process to the channel -- only ever with a
// connection, so no lend and no WAIT's take ever gets one without. One whose
// connection was discarded tries for a new one, backing off from 10 ms to
// 1 s, for ReconnectGrace (the drain grace; it runs after the write token
// went, so it holds up no writer, only the step's own answer). Still none
// then, or the pool closed meanwhile: the work process is stopped -- out of
// service for good, counted, logged, its row saying Stopped -- and the pool
// goes on with one fewer rather than lend a work process that has nothing
// to run statements on (PR #900 review round 2).
//
// The grace is a bound on the caller, not on the attempts' count: every
// attempt -- database/sql admission, the driver's open, the priming -- runs
// under a context that ends with the grace or with Close, and is waited for
// no longer than that context even when the driver does not watch it (a
// hung open, a held file lock). A connection that arrives after that is
// closed, never published (PR #900 review round 3).
func (p *Pool) giveBack(w *worker) {
	if w.conn == nil {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			p.stopWorker(w, errors.New("the pool is closed"))
			return
		}
		w.state = "Reconnect"
		p.reconnecting.Add(1) // under mu: Close, which sets closed under it, waits for this
		p.mu.Unlock()
		err := p.reconnectWithin(w, p.o.ReconnectGrace)
		if err != nil {
			p.stopWorker(w, err)
			p.reconnecting.Done()
			return
		}
		p.mu.Lock()
		w.state = "Idle"
		p.mu.Unlock()
		p.reconnecting.Done()
	}
	p.tokens <- w
}

// stopWorker takes a work process without a connection out of service.
func (p *Pool) stopWorker(w *worker, err error) {
	p.mu.Lock()
	w.state, w.report, w.started = "Stopped", "out of service: no connection", time.Time{}
	p.outOfService++
	all := p.outOfService == len(p.workers)
	p.mu.Unlock()
	if p.o.Logf != nil {
		p.o.Logf("work process %d out of service (no new connection within %s): %v; %d of %d serve",
			w.number, p.o.ReconnectGrace, err, len(p.workers)-p.OutOfService(), len(p.workers))
	}
	if all {
		close(p.dead)
	}
	select {
	case p.changed <- struct{}{}:
	default:
	}
}

// reconnectWithin is reconnect tried until it succeeds, grace passes or the
// pool closes -- whichever comes first, also in the middle of an attempt.
func (p *Pool) reconnectWithin(w *worker, grace time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	go func() { // Close ends the attempt as the grace does
		select {
		case <-p.quit:
			cancel()
		case <-ctx.Done():
		}
	}()
	backoff := 10 * time.Millisecond
	for {
		conn, err := p.reconnect(ctx)
		if err == nil {
			w.conn, w.queryOnly = conn, false
			return nil
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, time.Second)
	}
}

// discard closes the work process's connection for good.
func (p *Pool) discard(w *worker) {
	for q, st := range w.stmts {
		st.Close()
		delete(w.stmts, q)
	}
	drop(w.conn)
	w.conn = nil
	w.queryOnly = false
}

// reconnect takes a new connection and primes it as New primes them. The
// attempt runs on a goroutine of its own and is waited for only as long as
// ctx lives: database/sql's admission watches ctx, a driver's Open does not
// (driver.Driver has no context). An attempt given up on hands what it got,
// whenever it gets it, to a closer instead of to the work process; a
// success that crosses the deadline is closed the same way.
func (p *Pool) reconnect(ctx context.Context) (*sql.Conn, error) {
	type got struct {
		conn *sql.Conn
		err  error
	}
	ch := make(chan got, 1)
	go func() {
		conn, err := p.o.DB.Conn(ctx)
		if err == nil {
			w := &worker{conn: conn}
			if err = w.prime(ctx, p.o.BusyTimeout); err != nil {
				drop(conn)
				conn = nil
			}
		}
		ch <- got{conn, err}
	}()
	select {
	case r := <-ch:
		if r.err == nil && ctx.Err() != nil { // too late: not published
			drop(r.conn)
			return nil, ctx.Err()
		}
		return r.conn, r.err
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.conn != nil {
				drop(r.conn)
			}
		}()
		return nil, fmt.Errorf("new connection: %w", ctx.Err())
	}
}

// drop closes a connection for good instead of pooling it.
func drop(conn *sql.Conn) { _ = conn.Raw(func(any) error { return driver.ErrBadConn }) }

// OutOfService is the number of work processes stopped for want of a
// connection (the rows say Stopped); the pool serves with the rest.
func (p *Pool) OutOfService() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.outOfService
}

// collect takes every work process in service out of the channel: the
// drain's wait. One that leaves service while this waits (giveBack found
// it no connection) is one fewer to wait for.
func (p *Pool) collect() {
	got := 0
	for {
		p.mu.Lock()
		need := len(p.workers) - p.outOfService
		p.mu.Unlock()
		if got >= need {
			return
		}
		select {
		case <-p.tokens:
			got++
		case <-p.changed:
		}
	}
}
