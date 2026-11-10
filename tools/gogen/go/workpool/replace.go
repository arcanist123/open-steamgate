package workpool

// The replacement of a connection that cannot be proven clean (PR #900
// review rounds 1 and 2): the scrub, the discard, the reconnect retried
// within ReconnectGrace, and a work process stopped -- out of service, never
// lent or parked without a connection -- when none can be had.

import (
	"context"
	"database/sql/driver"
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
func (p *Pool) giveBack(w *worker) {
	if w.conn == nil {
		p.mu.Lock()
		w.state = "Reconnect"
		p.mu.Unlock()
		err := p.reconnectWithin(w, p.o.ReconnectGrace)
		if err != nil {
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
			return
		}
		p.mu.Lock()
		w.state = "Idle"
		p.mu.Unlock()
	}
	p.tokens <- w
}

// reconnectWithin is reconnect tried until it succeeds, grace passes or the
// pool closes.
func (p *Pool) reconnectWithin(w *worker, grace time.Duration) error {
	deadline := time.Now().Add(grace)
	backoff := 10 * time.Millisecond
	for {
		err := p.reconnect(w)
		if err == nil {
			return nil
		}
		p.mu.Lock()
		closed := p.closed
		p.mu.Unlock()
		left := time.Until(deadline)
		if closed || left <= 0 {
			return err
		}
		time.Sleep(min(backoff, left))
		backoff = min(2*backoff, time.Second)
	}
}

// discard closes the work process's connection for good.
func (p *Pool) discard(w *worker) {
	for q, st := range w.stmts {
		st.Close()
		delete(w.stmts, q)
	}
	_ = w.conn.Raw(func(any) error { return driver.ErrBadConn })
	w.conn = nil
	w.queryOnly = false
}

// reconnect gives a work process without a connection a new one, primed
// as New primes them.
func (p *Pool) reconnect(w *worker) error {
	ctx := context.Background()
	conn, err := p.o.DB.Conn(ctx)
	if err != nil {
		return err
	}
	w.conn, w.queryOnly = conn, false
	if err := w.prime(ctx, p.o.BusyTimeout); err != nil {
		p.discard(w)
		return err
	}
	return nil
}

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
