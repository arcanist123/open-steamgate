package abap

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http/httputil"
	"osg/gogen/nodehdr"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// The host side of open-abap-core's CL_HTTP_CLIENT (ultra/httpc).
//
// On Node, IF_HTTP_CLIENT~SEND builds a JavaScript object `headers` out of
// the request entity's header fields, sends with Node's http / https module
// through an Agent of the client's own (keepAlive, maxSockets 1) and hands
// the answer back through kernel lines (WRITE '@KERNEL ...'). Here those
// lines are calls into these functions (frontend.mjs KERNEL), the ABAP
// around them -- the entity, the URL built out of mv_host and ~request_uri,
// the form fields, the gzip branch -- is open-abap-core's own, compiled.
//
// Node is the oracle: tools/gogen/httpc.mjs runs the same ABAP on both hosts
// against one recording server and compares the bytes the server received
// and what the ABAP got back. What the Node code does, and so what this
// does, including where a system would differ (not measured on A4H):
//
//   - the request line is METHOD (upper-cased, as Node does) and the path
//     and query of the URL; the header lines follow the object's key order
//     (keys that are array indices first, ascending, then in insertion
//     order; a key set twice keeps its first place), each name as the entity
//     holds it (lower case) and each value written as latin1; then Node's
//     own "Host" (without a default port) and "Connection: keep-alive", and
//     "Transfer-Encoding: chunked" with an empty last chunk for a POST, PUT
//     or PATCH (any method but GET HEAD DELETE OPTIONS TRACE CONNECT)
//     without a body -- a body always has a content-length
//   - accept-encoding is always "gzip" (a value the ABAP set is replaced in
//     its place), and the ABAP inflates a gzip answer with cl_abap_gzip
//   - the body is the entity's text (get_cdata) written with Node's "binary"
//     encoding: one byte per UTF-16 code unit, its low eight bits, so only
//     latin1 text arrives as it was (a system sends the text's UTF-8 bytes);
//     content-length is the text's length in UTF-16 code units. A body set
//     with set_data that is not UTF-8 raises CX_SY_CONVERSION_CODEPAGE out of
//     get_cdata before anything is sent
//   - the answer's header fields are Node's IncomingMessage headers: names
//     lower case, values latin1 and trimmed, duplicates joined with ", "
//     ("; " for cookie) or the first kept (content-type, server, etag ...),
//     and set-cookie, an array there, left out by the ABAP; the order is
//     the object's, as above. The status is the code alone (the reason
//     stays empty), the body the raw bytes as they came (chunks joined, a
//     1xx answer skipped)
//   - the connection is kept for the next send of the same client object
//     unless the answer closes it; nothing is ever timed out (Node sets no
//     timeout, and SEND's TIMEOUT parameter is ignored there too)
//   - a failure of the connection or of the protocol, and a URL or header
//     Node refuses, is a JavaScript error there, which no CATCH and no
//     EXCEPTIONS take: a dump. No classic exception is ever raised
//     (http_communication_failure and the others are unreachable on Node),
//     and sy-subrc is 0 after a SEND and a RECEIVE that return
//
// TLS is Go's with the system roots, HTTP/1.1 only (Node's https sends no
// ALPN), no proxy from the environment (Node's http ignores it too).

// httpcRoots are the certificate authorities a TLS connection trusts: nil,
// the system's (a test sets its own server's)
var httpcRoots *x509.CertPool

// httpcClient is what Node keeps on the client object: the headers of the
// SEND in progress, the answer, and the Agent's one socket.
type httpcClient struct {
	headers jsObject
	resp    *httpcResponse
	conn    net.Conn
	br      *bufio.Reader
	connKey string
}

type httpcResponse struct {
	status  int32
	headers jsObject
	body    []byte
}

// jsObject is a JavaScript object with string keys and values, in the order
// JavaScript enumerates them.
type jsObject struct {
	keys []string
	vals map[string]string
}

func (o *jsObject) set(k, v string) {
	if o.vals == nil {
		o.vals = map[string]string{}
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *jsObject) get(k string) (string, bool) {
	v, ok := o.vals[k]
	return v, ok
}

// jsArrayIndex: a key JavaScript enumerates first, as a number (a canonical
// decimal below 2^32 - 1)
func jsArrayIndex(k string) (uint64, bool) {
	if k == "" || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n >= 1<<32-1 {
		return 0, false
	}
	return n, true
}

// ordered is for (const k in o): array indices ascending, then the rest in
// insertion order.
func (o *jsObject) ordered() []string {
	var idx, rest []string
	for _, k := range o.keys {
		if _, ok := jsArrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(idx, func(i, j int) bool {
		a, _ := jsArrayIndex(idx[i])
		b, _ := jsArrayIndex(idx[j])
		return a < b
	})
	return append(idx, rest...)
}

const httpcWhere = "CL_HTTP_CLIENT=>IF_HTTP_CLIENT~SEND"

func httpcOf(s *Session, me any) *httpcClient {
	if s.httpc == nil {
		s.httpc = map[any]*httpcClient{}
	}
	c := s.httpc[me]
	if c == nil {
		c = &httpcClient{}
		s.httpc[me] = c
	}
	return c
}

// HTTPCHeadersNew is `let headers = {};`
func HTTPCHeadersNew(s *Session, me any) {
	httpcOf(s, me).headers = jsObject{}
}

// HTTPCHeader is headers[name] = value, for each header field of the request
// entity but ~request_uri.
func HTTPCHeader(s *Session, me any, name, value string) {
	httpcOf(s, me).headers.set(name, value)
}

// HTTPCContentType is headers["content-type"] = lv_content_type.
func HTTPCContentType(s *Session, me any, value string) {
	httpcOf(s, me).headers.set("content-type", value)
}

// HTTPCAcceptGzip is headers["accept-encoding"] = "gzip".
func HTTPCAcceptGzip(s *Session, me any) {
	httpcOf(s, me).headers.set("accept-encoding", "gzip")
}

// HTTPCContentLength is headers["content-length"] = lv_body.length: UTF-16
// code units.
func HTTPCContentLength(s *Session, me any, body string) {
	httpcOf(s, me).headers.set("content-length", strconv.Itoa(len(utf16.Encode([]rune(body)))))
}

// the octets of a text written with Node's "binary" (latin1) encoding: the
// low byte of each UTF-16 code unit
func latin1Bytes(text string) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, len(units))
	for i, u := range units {
		out[i] = byte(u)
	}
	return out
}

// a latin1 byte string as text: each byte the code point of its value
func latin1Text(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// Node's checkIsHttpToken
var httpToken = regexp.MustCompile("^[\\^_`a-zA-Z\\-0-9!#$%&'*+.|~]+$")

// Node's checkInvalidHeaderChar: tab, printable ASCII and 0x80-0xff
func validHeaderValue(v string) bool {
	for _, r := range v {
		if !(r == '\t' || (r >= 0x20 && r <= 0x7e) || (r >= 0x80 && r <= 0xff)) {
			return false
		}
	}
	return true
}

func hostError(text string) {
	panic(HostError{Where: httpcWhere, Text: text})
}

// httpcTarget is what new URL(url) gives Node's request for the subset of
// URLs whose WHATWG form is the text itself: scheme, host, port and the
// request target. A URL the WHATWG parser would rewrite (dot segments,
// characters it percent-encodes, a numeric host it reads as IPv4,
// credentials, an IPv6 or IDN host) is refused, not guessed.
type httpcTarget struct {
	tls      bool
	hostname string
	port     int
	hostHdr  string
	target   string
}

var (
	schemeRe   = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9+.\-]*):`)
	hostnameRe = regexp.MustCompile(`^[a-z0-9._\-]+$`)
	pathChars  = regexp.MustCompile(`^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$`)
	queryChars = regexp.MustCompile(`^[A-Za-z0-9\-._~!$&()*+,;=:@/%?]*$`)
	numLabel   = regexp.MustCompile(`^(0[xX][0-9A-Fa-f]*|[0-9]+)$`)
)

func parseTarget(raw string) httpcTarget {
	// prot = url.startsWith("http://") ? http : https; each module accepts
	// its own protocol only (ERR_INVALID_PROTOCOL), after new URL (ERR_INVALID_URL)
	m := schemeRe.FindStringSubmatch(raw)
	if m == nil {
		hostError("TypeError [ERR_INVALID_URL]: Invalid URL")
	}
	scheme := strings.ToLower(m[1])
	useTLS := !strings.HasPrefix(raw, "http://")
	if (useTLS && scheme != "https") || (!useTLS && scheme != "http") {
		if scheme != "http" && scheme != "https" {
			// a scheme Node's URL parses but neither module takes; what a
			// non-special URL parses to is not followed here
			hostError("TypeError [ERR_INVALID_PROTOCOL]: Protocol \"" + scheme + ":\" not supported")
		}
		hostError("TypeError [ERR_INVALID_PROTOCOL]: Protocol \"" + scheme + ":\" not supported. Expected \"" + map[bool]string{true: "https:", false: "http:"}[useTLS] + "\"")
	}
	rest := raw[len(m[0]):]
	if !strings.HasPrefix(rest, "//") {
		panic(NotCompiled(httpcWhere, "a URL without // after the scheme: the WHATWG parse of "+raw+" is not followed"))
	}
	rest = rest[2:]
	if i := strings.IndexByte(rest, '#'); i >= 0 {
		rest = rest[:i] // the fragment is not sent
	}
	end := strings.IndexAny(rest, "/?")
	if end < 0 {
		end = len(rest)
	}
	authority, target := rest[:end], rest[end:]
	if strings.ContainsAny(authority, "@\\[]%") {
		panic(NotCompiled(httpcWhere, "the authority "+authority+": credentials, IPv6 or escapes in a URL are not followed"))
	}
	host, portText, hasPort := strings.Cut(authority, ":")
	host = strings.ToLower(host)
	if host == "" {
		hostError("TypeError [ERR_INVALID_URL]: Invalid URL")
	}
	if !hostnameRe.MatchString(host) {
		panic(NotCompiled(httpcWhere, "the host "+host+": the WHATWG host parser (IDNA) is not followed"))
	}
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	if numLabel.MatchString(labels[len(labels)-1]) {
		// read as IPv4 by WHATWG: only its canonical form is its own text
		if ip := net.ParseIP(host); ip == nil || ip.To4() == nil || ip.String() != host {
			panic(NotCompiled(httpcWhere, "the host "+host+": WHATWG reads it as an IPv4 address, whose normal form is not followed"))
		}
	}
	port := 80
	if useTLS {
		port = 443
	}
	hostHdr := host
	if hasPort && portText != "" {
		n, err := strconv.Atoi(portText)
		if err != nil || strings.TrimLeft(portText, "0123456789") != "" {
			hostError("TypeError [ERR_INVALID_URL]: Invalid URL")
		}
		if n > 65535 {
			hostError("TypeError [ERR_INVALID_URL]: Invalid URL")
		}
		if strconv.Itoa(n) != portText {
			panic(NotCompiled(httpcWhere, "the port "+portText+": its WHATWG normal form is not followed"))
		}
		if n != port {
			hostHdr = host + ":" + portText
			port = n
		}
	}
	path, query, hasQuery := strings.Cut(target, "?")
	if path == "" {
		path = "/"
	}
	if !pathChars.MatchString(path) || (hasQuery && !queryChars.MatchString(query)) {
		panic(NotCompiled(httpcWhere, "the path or query "+target+": characters WHATWG percent-encodes are not followed"))
	}
	for _, seg := range strings.Split(path, "/") {
		if l := strings.ToLower(strings.ReplaceAll(seg, "%2e", ".")); l == "." || l == ".." {
			panic(NotCompiled(httpcWhere, "the path "+path+": dot segments are not followed"))
		}
	}
	if hasQuery {
		path += "?" + query
	}
	return httpcTarget{tls: useTLS, hostname: host, port: port, hostHdr: hostHdr, target: path}
}

// the request headers Node's writer treats on its own; one the ABAP set
// would change what Node writes in ways not followed here
var nodeOwnHeaders = map[string]bool{"host": true, "connection": true, "transfer-encoding": true, "expect": true, "trailer": true, "upgrade": true}

// methods Node sends without a chunked body unless asked
// (useChunkedEncodingByDefault)
var noChunkByDefault = map[string]bool{"GET": true, "HEAD": true, "DELETE": true, "OPTIONS": true, "TRACE": true, "CONNECT": true}

// HTTPCSend is `let response = await postData(url, {method, headers, agent}, body)`.
func HTTPCSend(s *Session, me any, rawURL, method, body string) {
	c := httpcOf(s, me)
	t := parseTarget(rawURL)
	if !httpToken.MatchString(method) {
		hostError("TypeError [ERR_INVALID_HTTP_TOKEN]: Method must be a valid HTTP token [\"" + method + "\"]")
	}
	method = strings.ToUpper(method)
	var head bytes.Buffer
	head.WriteString(method + " " + t.target + " HTTP/1.1\r\n")
	hasLength := false
	for _, k := range c.headers.ordered() {
		v, _ := c.headers.get(k)
		if !httpToken.MatchString(k) {
			hostError("TypeError [ERR_INVALID_HTTP_TOKEN]: Header name must be a valid HTTP token [\"" + k + "\"]")
		}
		if !validHeaderValue(v) {
			hostError("TypeError [ERR_INVALID_CHAR]: Invalid character in header content [\"" + k + "\"]")
		}
		lk := strings.ToLower(k)
		if nodeOwnHeaders[lk] {
			panic(NotCompiled(httpcWhere, "a request header "+k+" set by the ABAP: what Node's writer does with it is not followed"))
		}
		if lk == "content-length" {
			hasLength = true
		}
		head.Write(latin1Bytes(k + ": " + v + "\r\n"))
	}
	head.WriteString("Host: " + t.hostHdr + "\r\n")
	head.WriteString("Connection: keep-alive\r\n")
	payload := latin1Bytes(body)
	chunked := !hasLength && !noChunkByDefault[method]
	if chunked {
		head.WriteString("Transfer-Encoding: chunked\r\n")
	}
	head.WriteString("\r\n")
	if chunked {
		// req.write(body) then req.end(): the body is empty here (a body has a
		// content-length), and the last chunk ends it
		if len(payload) > 0 {
			head.WriteString(strconv.FormatInt(int64(len(payload)), 16) + "\r\n")
			head.Write(payload)
			head.WriteString("\r\n")
		}
		head.WriteString("0\r\n\r\n")
	} else {
		head.Write(payload)
	}
	key := strconv.FormatBool(t.tls) + "|" + t.hostname + "|" + strconv.Itoa(t.port)
	c.resp = nil
	resp, err := c.roundTrip(key, t, head.Bytes(), method == "HEAD")
	if err != nil {
		c.drop()
		hostError(err.Error())
	}
	c.resp = resp
}

func (c *httpcClient) drop() {
	if c.conn != nil {
		c.conn.Close()
	}
	c.conn, c.br, c.connKey = nil, nil, ""
}

// alive: whether the kept socket is still open, as Node knows it by the
// time the next request goes out (the peer's FIN has arrived)
func (c *httpcClient) alive() bool {
	if c.conn == nil {
		return false
	}
	if c.br.Buffered() > 0 {
		return false // bytes nobody asked for: Node's parser would fail on them
	}
	c.conn.SetReadDeadline(time.Now().Add(time.Millisecond))
	_, err := c.br.Peek(1)
	c.conn.SetReadDeadline(time.Time{})
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (c *httpcClient) roundTrip(key string, t httpcTarget, req []byte, head bool) (*httpcResponse, error) {
	if c.connKey != key || !c.alive() {
		c.drop()
		conn, err := net.Dial("tcp", net.JoinHostPort(t.hostname, strconv.Itoa(t.port)))
		if err != nil {
			return nil, err
		}
		if t.tls {
			tc := tls.Client(conn, &tls.Config{ServerName: t.hostname, RootCAs: httpcRoots})
			if err := tc.Handshake(); err != nil {
				conn.Close()
				return nil, err
			}
			conn = tc
		}
		c.conn, c.br, c.connKey = conn, bufio.NewReader(conn), key
	}
	if _, err := c.conn.Write(req); err != nil {
		return nil, err
	}
	resp, keep, err := readResponse(c.br, head)
	if err != nil {
		return nil, err
	}
	if !keep {
		c.drop()
	}
	return resp, nil
}

// Node's IncomingMessage keeps the first of these, joins cookie with "; "
// and the rest with ", " (nodeFirstWins in icf.go); set-cookie is an array
func addNodeHeader(o *jsObject, name, value string) {
	prev, seen := o.get(name)
	switch {
	case name == "set-cookie":
		o.set(name, "") // an array there, always: the ABAP's loop skips it
	case !seen:
		o.set(name, value)
	default:
		o.set(name, nodehdr.Merge(name, prev, value))
	}
}

// readResponse reads one answer: a 1xx is skipped, the body framed by
// Transfer-Encoding chunked, Content-Length or the end of the connection.
// keep: whether the socket may carry the next request.
func readResponse(br *bufio.Reader, head bool) (*httpcResponse, bool, error) {
	for {
		line, err := readLine(br)
		if err != nil {
			return nil, false, err
		}
		f := strings.SplitN(line, " ", 3)
		if len(f) < 2 || (f[0] != "HTTP/1.1" && f[0] != "HTTP/1.0") || len(f[1]) != 3 {
			return nil, false, errors.New("Parse Error: Invalid response status")
		}
		code, err := strconv.Atoi(f[1])
		if err != nil {
			return nil, false, errors.New("Parse Error: Invalid response status")
		}
		r := &httpcResponse{status: int32(code)}
		var te, cl, connection string
		for {
			l, err := readLine(br)
			if err != nil {
				return nil, false, err
			}
			if l == "" {
				break
			}
			if l[0] == ' ' || l[0] == '\t' {
				panic(NotCompiled(httpcWhere, "a folded header line in the answer: what Node's parser does with it is not followed"))
			}
			name, value, ok := strings.Cut(l, ":")
			if !ok || !httpToken.MatchString(name) {
				return nil, false, errors.New("Parse Error: Invalid header token")
			}
			name = strings.ToLower(name)
			value = strings.Trim(value, " \t")
			switch name {
			case "transfer-encoding":
				te = value
			case "content-length":
				if cl != "" && cl != value {
					return nil, false, errors.New("Parse Error: Duplicate Content-Length")
				}
				cl = value
			case "connection":
				connection = strings.ToLower(value)
			}
			addNodeHeader(&r.headers, name, latin1Text([]byte(value)))
		}
		if code == 101 {
			panic(NotCompiled(httpcWhere, "a 101 answer (an upgrade): not followed"))
		}
		if code >= 100 && code < 200 {
			continue // Node emits 'information' and waits for the answer
		}
		keep := f[0] == "HTTP/1.1" && !hasToken(connection, "close") || f[0] == "HTTP/1.0" && hasToken(connection, "keep-alive")
		switch {
		case head || code == 204 || code == 304:
		case hasToken(strings.ToLower(te), "chunked"):
			b, err := io.ReadAll(httputil.NewChunkedReader(br))
			if err != nil {
				return nil, false, err
			}
			for { // trailers, which Node keeps apart from the headers
				l, err := readLine(br)
				if err != nil {
					return nil, false, err
				}
				if l == "" {
					break
				}
			}
			r.body = b
		case cl != "":
			n, err := strconv.ParseInt(cl, 10, 64)
			if err != nil || n < 0 {
				return nil, false, errors.New("Parse Error: Invalid character in Content-Length")
			}
			r.body = make([]byte, n)
			if _, err := io.ReadFull(br, r.body); err != nil {
				return nil, false, errors.New("aborted")
			}
		default:
			b, err := io.ReadAll(br)
			if err != nil {
				return nil, false, err
			}
			r.body, keep = b, false
		}
		return r, keep, nil
	}
}

func hasToken(list, tok string) bool {
	for _, t := range strings.Split(list, ",") {
		if strings.TrimSpace(t) == tok {
			return true
		}
	}
	return false
}

func readLine(br *bufio.Reader) (string, error) {
	l, err := br.ReadString('\n')
	if err != nil {
		if err == io.EOF {
			return "", errors.New("socket hang up")
		}
		return "", err
	}
	return strings.TrimSuffix(strings.TrimSuffix(l, "\n"), "\r"), nil
}

func httpcResp(s *Session, me any) *httpcResponse {
	c := httpcOf(s, me)
	if c.resp == nil {
		panic(HostError{Where: httpcWhere, Text: "no answer to read (response is undefined)"})
	}
	return c.resp
}

// HTTPCResponseHeaders is for (const h in response.headers), set-cookie
// left out as the loop's Array.isArray skips it.
func HTTPCResponseHeaders(s *Session, me any) [][2]string {
	r := httpcResp(s, me)
	out := [][2]string{}
	for _, k := range r.headers.ordered() {
		v, _ := r.headers.get(k)
		if k == "set-cookie" {
			continue
		}
		out = append(out, [2]string{k, v})
	}
	return out
}

// HTTPCResponseContentType is mv_content_type.set(response.headers["content-type"] || "").
func HTTPCResponseContentType(s *Session, me any, out *string) {
	v, _ := httpcResp(s, me).headers.get("content-type")
	*out = v
}

// HTTPCResponseStatus is mv_status.set(response.statusCode).
func HTTPCResponseStatus(s *Session, me any, out *int32) {
	*out = httpcResp(s, me).status
}

// HTTPCResponseBody is mv_data.set(response.body as hex): the bytes.
func HTTPCResponseBody(s *Session, me any, out *string) {
	*out = string(httpcResp(s, me).body)
}
