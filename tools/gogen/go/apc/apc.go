// Package apc is APC, the ABAP Push Channel, for a Go host: the socket part
// of what the ICF does around an IF_APC_WSP_EXTENSION handler.
//
// The ABAP part stays ABAP. open-abap-apc's ZCL_APC_HOST holds one
// connection to one handler: its constructor creates the handler class by
// name, open( ) asks ON_ACCEPT and calls ON_START, message( ) hands a text
// to ON_MESSAGE, close( ) calls ON_CLOSE, drain( ) returns what the handler
// SENT through its message manager since the last call. The Node hosts
// drive the same class (web/preview-backend.mjs), so the handler meets the
// same framework on every host and on a system.
//
// A program compiled by tools/gogen provides a Host per connection,
// normally a few lines over its compiled ZCL_APC_HOST (the types are the
// program's own, so the adapter lives with the program), and mounts a
// Channel at /sap/bc/apc/sap/<app>. The channel does the rest:
//
//   - a request that is not a WebSocket handshake (RFC 6455 4.2.1), or whose
//     Origin is neither this host nor one of OriginPatterns, is answered
//     426 / 400 / 405 / 403 before any ABAP runs: on a system such a request
//     never reaches the extension;
//   - one Session per socket (a stateful handler keeps its attributes),
//     made by the host (NewSession) so it runs on the host's database;
//   - every call into ABAP is one dialog step (Step), run one at a time in
//     the process (abap.WorkProcess), inside abap.DialogStep, so a step that
//     dumps rolls its database work back;
//   - a dump in the constructor or ON_START is a 503 "<handler>: <dump>",
//     a dump in ON_MESSAGE closes the socket 1011 "handler failed": what
//     the Node host does (tools/osd-apc.mjs), chosen over keeping the
//     socket up because then the page hears nothing and waits (ZO4D's
//     outro did). What a system does has not been measured;
//   - ON_ACCEPT and ON_START run before the upgrade is answered, and what
//     ON_START sent is written after it. That is "open before drain"
//     (CLAUDE.md): a message delivered before the page's socket is open is
//     refused by the page, and a handler that speaks from ON_START would
//     otherwise race its own handshake. A rejected connection is answered
//     403 and never upgraded;
//   - what a step sent is written in order after the step, outside the
//     work process, so a slow client never holds the lock;
//   - a text frame is ON_MESSAGE; a binary frame is ignored and the socket
//     stays up, as on the Node host (ZCL_APC_HOST takes text only);
//   - a close frame from the peer is ON_CLOSE with "closed by the client"
//     and 1000 whatever code it carried, as on the Node host; a connection
//     that broke without one (or a write that failed) is ON_CLOSE with the
//     error and 1006 (RFC 6455 7.1.5), where the Node host calls no
//     ON_CLOSE. The close frame sent back is github.com/coder/websocket's
//     echo of the peer's code, where Node answers 1000 "bye": the library
//     answers a close frame itself, before ON_CLOSE runs.
package apc

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"

	"github.com/coder/websocket"

	"osg/gogen/abap"
)

// Host is one connection's APC runtime.
type Host interface {
	// Open is ON_ACCEPT then ON_START; false when ON_ACCEPT rejected.
	Open(s *abap.Session) bool
	// Message is ON_MESSAGE with a text message.
	Message(s *abap.Session, text string)
	// Close is ON_CLOSE.
	Close(s *abap.Session, reason string, code int32)
	// Drain is what the handler sent since the last call, in order.
	Drain(s *abap.Session) []string
}

// Channel is an http.Handler for one APC application.
type Channel struct {
	// Name is the application, for the log (zo4d_demo).
	Name string
	// Handler is the handler class, named in the 503 of a dump at start
	// (Node: "<handler>: <why>").
	Handler string
	// New makes the connection's host: runs in a step of its own, after the
	// handshake is checked and before the upgrade; a dump answers 503 and
	// the socket is not opened, nil (no host class) answers 500.
	New func(s *abap.Session, r *http.Request) Host
	// Step runs one dialog step; nil is abap.APCStep.
	Step func(s *abap.Session, name string, work func()) error
	// NewSession makes the Session of a socket: the host's
	// (abap.Instance.NewSession), so the channel's sessions run on the
	// host's database and share its statics. Nil is a private Session
	// without a database.
	NewSession func() *abap.Session
	// OriginPatterns are the cross-origin pages allowed to connect, as
	// github.com/coder/websocket's AcceptOptions.OriginPatterns (host
	// patterns of path.Match, or scheme://host). Empty is same origin only:
	// a request with an Origin header whose host is not the request's Host
	// is refused 403. A request without Origin (not a browser) is let in.
	OriginPatterns []string
	// AnyOrigin lets every origin in, as the Node host does (it never looks
	// at Origin); OriginPatterns is then not read.
	AnyOrigin bool
	// ReadLimit is the largest message read; 0 is 1 MB.
	ReadLimit int64
	// Logf logs; nil is log.Printf.
	Logf func(format string, args ...any)

	mu      sync.Mutex
	counter int
}

func (ch *Channel) logf(format string, args ...any) {
	if ch.Logf != nil {
		ch.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (ch *Channel) step(s *abap.Session, name, text string, work func()) error {
	run := ch.Step
	if run == nil {
		run = func(s *abap.Session, name string, work func()) error { return abap.APCStep(s, name, work) }
	} else {
		// Custom Step hosts also hold the work process around the callback.
		body := work
		work = func() {
			s.HoldsWorkProcess = true
			defer func() { s.HoldsWorkProcess = false }()
			body()
		}
	}
	err := run(s, name, work)
	if err != nil {
		ch.logf("%s: %v (%.80s)", ch.Name, err, text)
	}
	return err
}

// Connections is how many sockets this channel has opened.
func (ch *Channel) Connections() int {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	return ch.counter
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

// handshake checks what websocket.Accept checks, before any ABAP runs: the
// status to answer and why, or 0.
func handshake(r *http.Request) (int, string) {
	if !r.ProtoAtLeast(1, 1) {
		return http.StatusUpgradeRequired, "a WebSocket handshake is HTTP/1.1"
	}
	if !headerHasToken(r.Header, "Connection", "Upgrade") || !headerHasToken(r.Header, "Upgrade", "websocket") {
		return http.StatusUpgradeRequired, "this is an APC channel: a WebSocket upgrade is required"
	}
	if r.Method != http.MethodGet {
		return http.StatusMethodNotAllowed, "a WebSocket handshake is a GET"
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return http.StatusBadRequest, "Sec-WebSocket-Version 13 is required"
	}
	keys := r.Header.Values("Sec-WebSocket-Key")
	if len(keys) != 1 {
		return http.StatusBadRequest, "one Sec-WebSocket-Key is required"
	}
	if v, err := base64.StdEncoding.DecodeString(strings.TrimSpace(keys[0])); err != nil || len(v) != 16 {
		return http.StatusBadRequest, "Sec-WebSocket-Key is not 16 bytes of base64"
	}
	return 0, ""
}

// originAllowed is websocket.Accept's origin rule, so a refusal happens
// before any ABAP runs rather than after ON_START.
func originAllowed(r *http.Request, patterns []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(r.Host, u.Host) {
		return true
	}
	for _, p := range patterns {
		target := u.Host
		if strings.Contains(p, "://") {
			target = u.Scheme + "://" + u.Host
		}
		if ok, err := path.Match(strings.ToLower(p), strings.ToLower(target)); err == nil && ok {
			return true
		}
	}
	return false
}

func (ch *Channel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if status, why := handshake(r); status != 0 {
		if status == http.StatusUpgradeRequired {
			w.Header().Set("Connection", "Upgrade")
			w.Header().Set("Upgrade", "websocket")
		}
		if status == http.StatusBadRequest {
			w.Header().Set("Sec-WebSocket-Version", "13")
		}
		http.Error(w, why, status)
		return
	}
	if !ch.AnyOrigin && !originAllowed(r, ch.OriginPatterns) {
		http.Error(w, "origin not allowed for this APC channel", http.StatusForbidden)
		return
	}
	s := &abap.Session{}
	if ch.NewSession != nil {
		s = ch.NewSession()
	}
	var host Host
	// a dump while the handler starts: 503 and why, in text (Node's answer)
	unavailable := func(err error) {
		why := err.Error()
		var d *abap.ErrDump
		if errors.As(err, &d) {
			why = fmt.Sprint(d.Dump)
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "%s: %s", ch.Handler, why)
	}
	if err := ch.step(s, "CONSTRUCTOR", "", func() { host = ch.New(s, r) }); err != nil {
		unavailable(err)
		return
	}
	if host == nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	var accepted bool
	var out []string
	if err := ch.step(s, "ON_START", "", func() { accepted = host.Open(s); out = host.Drain(s) }); err != nil {
		unavailable(err)
		return
	}
	if !accepted {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, "the handler refused the connection")
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: ch.OriginPatterns, InsecureSkipVerify: ch.AnyOrigin})
	if err != nil {
		// checked above, so this is the hijack failing: the handler was
		// started for a socket that never opened, and it ends
		ch.step(s, "ON_CLOSE", "", func() { host.Close(s, "upgrade failed", 1006) })
		return
	}
	ch.mu.Lock()
	ch.counter++
	ch.mu.Unlock()
	limit := ch.ReadLimit
	if limit == 0 {
		limit = 1 << 20
	}
	c.SetReadLimit(limit)
	defer c.CloseNow()
	ctx := r.Context()
	// open before drain: the upgrade is answered, then what ON_START sent
	write := func(msgs []string) bool {
		for _, m := range msgs {
			if c.Write(ctx, websocket.MessageText, []byte(m)) != nil {
				return false
			}
		}
		return true
	}
	reason, code := "", int32(1005)
	alive := write(out)
	for alive {
		typ, data, err := c.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				// the Node host's ON_CLOSE for any close frame of the client
				reason, code = "closed by the client", 1000
			} else {
				reason, code = err.Error(), 1006
			}
			break
		}
		if typ != websocket.MessageText {
			// ignored, as the Node host ignores an opcode it does not serve
			continue
		}
		text := string(data)
		out = nil
		if ch.step(s, "ON_MESSAGE", text, func() { host.Message(s, text); out = host.Drain(s) }) != nil {
			// the Node host's queue: a callback that failed ends the socket
			// 1011 "handler failed"; what the step had sent goes nowhere
			if c.Close(websocket.StatusInternalError, "handler failed") == nil {
				// the client answered the close frame: on Node that answer
				// is read as the client's close
				reason, code = "closed by the client", 1000
			} else {
				reason, code = "handler failed", 1006
			}
			ch.step(s, "ON_CLOSE", "", func() { host.Close(s, reason, code) })
			return
		}
		alive = write(out)
	}
	if !alive {
		// the connection broke under a write: no close frame was seen
		reason, code = "write failed", 1006
	}
	ch.step(s, "ON_CLOSE", "", func() { host.Close(s, reason, code) })
}

// RequestPath is the path an upgrade is matched on, as the Node host takes
// it (tools/osd-apc.mjs mountChannels): the request target as sent, before
// "?", trailing slashes dropped, not percent-decoded, so /sap/bc/apc/sap/%7Aork
// is not /sap/bc/apc/sap/zork on either host.
func RequestPath(r *http.Request) string {
	p := r.RequestURI
	if p == "" {
		p = r.URL.RequestURI()
	}
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	return strings.TrimRight(p, "/")
}

// FormFields is the query of the upgrade as URLSearchParams reads it (the
// WHATWG application/x-www-form-urlencoded parser the Node host uses), in
// URL order: split on '&', empty pieces skipped, name and value at the
// first '=', '+' is a space, a '%' not followed by two hex digits stays as
// it is, and bytes that are not UTF-8 become U+FFFD. url.ParseQuery would
// drop a pair with a bad escape or a ';'; URLSearchParams keeps it.
func FormFields(rawQuery string) [][2]string {
	var out [][2]string
	for _, piece := range strings.Split(rawQuery, "&") {
		if piece == "" {
			continue
		}
		name, value, _ := strings.Cut(piece, "=")
		out = append(out, [2]string{formDecode(name), formDecode(value)})
	}
	return out
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

func formDecode(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '+' {
			b = append(b, ' ')
			continue
		}
		if c == '%' && i+2 <= len(s)-1 {
			h, ok1 := unhex(s[i+1])
			l, ok2 := unhex(s[i+2])
			if ok1 && ok2 {
				b = append(b, h<<4|l)
				i += 2
				continue
			}
		}
		b = append(b, c)
	}
	return utf8Decode(b)
}

// utf8Decode is the WHATWG "UTF-8 decode without BOM": each maximal
// subpart of an ill-formed sequence is one U+FFFD (strings.ToValidUTF8
// would give one for a whole run of them).
func utf8Decode(b []byte) string {
	var sb strings.Builder
	var cp rune
	need, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if need == 0 {
			switch {
			case c <= 0x7F:
				sb.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				need, cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				} else if c == 0xED {
					upper = 0x9F
				}
				need, cp = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				} else if c == 0xF4 {
					upper = 0x8F
				}
				need, cp = 3, rune(c&0x07)
			default:
				sb.WriteRune('�')
			}
			continue
		}
		if c < lower || c > upper {
			need, seen, cp = 0, 0, 0
			lower, upper = 0x80, 0xBF
			sb.WriteRune('�')
			i-- // the byte is read again as the start of a sequence
			continue
		}
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		seen++
		if seen == need {
			sb.WriteRune(cp)
			need, seen, cp = 0, 0, 0
		}
	}
	if need != 0 {
		sb.WriteRune('�')
	}
	return sb.String()
}
