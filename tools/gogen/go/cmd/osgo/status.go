package main

// The system status of this process (ultra/json): the snapshot
// tools/osd-status.mjs computes for a Node host, computed here for OSGo and
// written the same way, through ZCL_OSD_STATUS=>REFRESH (compiled), at start
// and before every request to ZOSD_STATUS_SRV (test/start.mjs
// withFreshStatus). A refresh that fails never fails the read: the rows of
// the last one stay.
//
// The shape is the contract of ZCL_OSD_STATUS (system, processes, ports,
// services, packs, database). Every value is a fact of this process or of
// this build; where the Node snapshot has a fact OSGo has no counterpart for,
// the row is left out rather than invented:
//   - host_kind "abap-go" (ZOSD_SYS-HOST_KIND is c8, free text: the status
//     app and ZCL_OSD_WEBGUI print it, nothing compares it);
//   - gen_serving and the process's generation: this program by content
//     (buildGeneration, "go:" and 16 hex digits, zz_status.go); gen_live the
//     tree's live generation (-root/build/live), which names a Node build, so
//     synced is true only if the two ever are one name, which they are not;
//   - workers M (the work processes of go/workpool, ADR 0010 slice 5) and
//     one process, role "facade", as the Node host inline: the work
//     processes are goroutines of this process, not pool children, and
//     their rows are the workprocesses section (ZOSD_WP, the SM50 shape);
//   - ports: this listener only. The RFC and DIAG rows Node adds are its
//     built-in JS protocol listeners, which OSGo does not have;
//   - services: the OData services and SICF nodes this binary serves
//     (zz_status.go), and the apps under -root, read from their manifests as
//     osd-status.mjs appsOf reads them; no push channels, OSGo serves none;
//   - packs: the ones OSGo serves a page of (zz_status.go);
//   - database: the SQLite this process holds (connected), memory or file,
//     and the platform labels osd-status.mjs platformFacts gives, from the
//     same files; the architecture in Go's names (linux/amd64).

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"osg/gogen/abap"
)

type statusService struct {
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Handler string `json:"handler"`
	Text    string `json:"text"`
	Pack    string `json:"pack"`
}

type statusPack struct {
	Name        string `json:"name"`
	Order       int    `json:"order"`
	Objects     int    `json:"objects"`
	Folders     string `json:"folders"`
	Description string `json:"description"`
}

type statusSystem struct {
	Sid        string `json:"sid"`
	HostKind   string `json:"host_kind"`
	GenLive    string `json:"gen_live"`
	GenServing string `json:"gen_serving"`
	Synced     bool   `json:"synced"`
	Workers    int    `json:"workers"`
	StartedAt  string `json:"started_at"`
	SnapAt     string `json:"snap_at"`
	RootHint   string `json:"root_hint"`
	Pid        int    `json:"pid"`
}

type statusProcess struct {
	Pid        int    `json:"pid"`
	Role       string `json:"role"`
	Port       int    `json:"port"`
	Generation string `json:"generation"`
	Epoch      int    `json:"epoch"`
	Since      string `json:"since"`
	Sockets    int    `json:"sockets"`
	RssMb      int    `json:"rss_mb"`
	Alive      bool   `json:"alive"`
}

// statusWP is one work process of the sidecar (ZOSD_WP): what a system's
// SM50 shows, the dispatcher's table as data. The host records each step's
// begin and end in the pool's registry; the rows land here, at the refresh
// the other tables land at, because a read step's connection is query_only
// and writes nothing.
type statusWP struct {
	Wpno       int    `json:"wpno"`
	Kind       string `json:"kind"`
	State      string `json:"state"`
	Generation string `json:"generation"`
	Started    string `json:"started"`
	User       string `json:"user"`
	Report     string `json:"report"`
}

type statusPort struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Purpose  string `json:"purpose"`
	State    string `json:"state"`
	Note     string `json:"note"`
}

type statusFact struct {
	Section string `json:"section"`
	Name    string `json:"name"`
	Value   string `json:"value"`
	Note    string `json:"note"`
}

type statusSnapshotJSON struct {
	System        statusSystem    `json:"system"`
	Processes     []statusProcess `json:"processes"`
	WorkProcesses []statusWP      `json:"workprocesses"`
	Ports         []statusPort    `json:"ports"`
	Services      []statusService `json:"services"`
	Packs         []statusPack    `json:"packs"`
	Database      []statusFact    `json:"database"`
}

// statusHost is what the snapshot needs of main: the listener, the tree,
// the database, and when this process started
type statusHost struct {
	port    int
	root    string
	dbFile  string
	started time.Time
}

// the ISO form JavaScript's toISOString gives, which the Node rows carry
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// procTCP is /proc/net/tcp and tcp6: local port and state per socket
// (osd-status.mjs procTcp); nothing when /proc cannot be read
func procTCP() [][2]int {
	var rows [][2]int
	for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(file)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Scan()
		for sc.Scan() {
			parts := strings.Fields(sc.Text())
			if len(parts) < 4 {
				continue
			}
			_, portHex, ok := strings.Cut(parts[1], ":")
			if !ok {
				continue
			}
			port, err1 := strconv.ParseInt(portHex, 16, 32)
			state, err2 := strconv.ParseInt(parts[3], 16, 32)
			if err1 == nil && err2 == nil {
				rows = append(rows, [2]int{int(port), int(state)})
			}
		}
		f.Close()
	}
	return rows
}

// countState: sockets on port in a TCP state (0x01 established, 0x0A listen)
func countState(rows [][2]int, port, state int) int {
	n := 0
	for _, r := range rows {
		if r[0] == port && r[1] == state {
			n++
		}
	}
	return n
}

// rssMb is this process's resident size (osd-status.mjs rssMb, statm)
func rssMb() int {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) < 2 {
		return 0
	}
	pages, err := strconv.ParseFloat(f[1], 64)
	if err != nil {
		return 0
	}
	return int(math.Round(pages * float64(os.Getpagesize()) / 1048576))
}

// liveGeneration is the tree's live generation (osd-build.mjs liveHash)
func liveGeneration(root string) string {
	t, err := os.Readlink(filepath.Join(root, "build", "live"))
	if err != nil {
		return ""
	}
	return filepath.Base(t)
}

// statusApps is osd-status.mjs appsOf for the folders this binary serves:
// the tree's webapp/ and each folder below it, then the pack pages; an app
// is a folder with a manifest.json, found at its inbound intent in the
// launchpad, else at its page
func statusApps(root string) []statusService {
	type folder struct{ name, dir, pack string }
	webapp := filepath.Join(root, "webapp")
	folders := []folder{{"", webapp, ""}}
	if entries, err := os.ReadDir(webapp); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				folders = append(folders, folder{e.Name(), filepath.Join(webapp, e.Name()), ""})
			}
		}
	}
	var packs []string
	for p := range packWebapps {
		packs = append(packs, p)
	}
	sort.Strings(packs)
	for _, p := range packs {
		dir := filepath.Join(root, packWebapps[p])
		name := strings.TrimPrefix(p, "/app/")
		folders = append(folders, folder{name, dir, name})
	}
	var out []statusService
	for _, f := range folders {
		b, err := os.ReadFile(filepath.Join(f.dir, "manifest.json"))
		if err != nil {
			continue
		}
		var m struct {
			App struct {
				ID              any `json:"id"`
				Title           any `json:"title"`
				CrossNavigation struct {
					Inbounds map[string]json.RawMessage `json:"inbounds"`
				} `json:"crossNavigation"`
			} `json:"sap.app"`
		}
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		page := "/app/index.html"
		if f.name != "" {
			page = "/app/" + f.name + "/index.html"
		}
		// the first inbound as JavaScript's Object.keys gives it: the order
		// written (encoding/json has no order, so the text is read again)
		path := page
		if intent := firstKey(b, "inbounds"); intent != "" {
			path = "/app/flp.html#" + intent
		}
		str := func(v any) string {
			if v == nil {
				return ""
			}
			return fmt.Sprint(v)
		}
		text := str(m.App.Title)
		if m.App.Title == nil {
			text = str(m.App.ID)
			if m.App.ID == nil {
				text = f.name
			}
		}
		out = append(out, statusService{Path: path, Kind: "APP", Handler: str(m.App.ID), Text: text, Pack: f.pack})
	}
	return out
}

// firstKey is the first member name of the first object named key in a JSON
// text, in written order; "" when there is none
func firstKey(b []byte, key string) string {
	dec := json.NewDecoder(strings.NewReader(string(b)))
	depthKey := false
	for {
		t, err := dec.Token()
		if err != nil {
			return ""
		}
		if s, ok := t.(string); ok && s == key && !depthKey {
			if d, err := dec.Token(); err != nil || d != json.Delim('{') {
				return ""
			}
			if k, err := dec.Token(); err == nil {
				if s, ok := k.(string); ok {
					return s
				}
			}
			return ""
		}
	}
}

// osRelease is osd-status.mjs osRelease: NAME VERSION_ID (CODENAME)
func osRelease(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	text := string(b)
	if len(text) > 4096 {
		text = text[:4096]
	}
	fields := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok || k == "" || strings.Trim(k, "ABCDEFGHIJKLMNOPQRSTUVWXYZ_") != "" {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		v = strings.NewReplacer(`\"`, `"`, `\'`, `'`, `\\`, `\`).Replace(v)
		fields[k] = v
	}
	name := fields["NAME"]
	if name == "" {
		name = fields["ID"]
	}
	var parts []string
	for _, p := range []string{name, fields["VERSION_ID"]} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if c := fields["VERSION_CODENAME"]; c != "" {
		parts = append(parts, "("+c+")")
	}
	return strings.Join(parts, " ")
}

// safeLabel: control characters out, runs of blanks one, at most 120 characters
func safeLabel(v string) string {
	v = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, v)
	v = strings.Join(strings.Fields(v), " ")
	if r := []rune(v); len(r) > 120 {
		v = string(r[:120])
	}
	return v
}

func readText(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

// platformFacts is osd-status.mjs platformFacts, in Go's names for the platform
func platformFacts() []statusFact {
	facts := []statusFact{
		{"Platform", "Architecture", safeLabel(runtime.GOOS + "/" + runtime.GOARCH), "runtime platform"},
		{"Platform", "Kernel", safeLabel(readText("/proc/sys/kernel/osrelease")), "host kernel shared with the container"},
	}
	if v := safeLabel(osRelease("/etc/os-release")); v != "" {
		facts = append(facts, statusFact{"Platform", "Runtime OS", v, "OS inside the container or local runtime"})
	}
	if v := safeLabel(osRelease("/run/host/os-release")); v != "" {
		facts = append(facts, statusFact{"Platform", "Host OS", v, "operator-provided read-only host release"})
	}
	model := readText("/run/host/device-model")
	if model == "" {
		model = readText("/proc/device-tree/model")
	}
	if model == "" {
		model = readText("/sys/firmware/devicetree/base/model")
	}
	if v := safeLabel(model); v != "" {
		facts = append(facts, statusFact{"Platform", "Device", v, "board model; no serial number"})
	}
	return facts
}

// statusSnapshot is the whole snapshot, as JSON
func statusSnapshot(h statusHost) []byte {
	rows := procTCP()
	now := time.Now()
	root, _ := filepath.Abs(h.root)
	live := liveGeneration(root)
	state := "absent"
	if countState(rows, h.port, 0x0A) > 0 {
		state = "listening"
	}
	services := append(append([]statusService{}, statusServed...), statusApps(root)...)
	sort.Slice(services, func(i, j int) bool { return services[i].Path < services[j].Path })
	storage, note := "memory", "process memory"
	if h.dbFile != "" {
		storage, note = "file", "persistent database storage"
	}
	workers := 0
	var wps []statusWP
	if wp != nil {
		workers = wp.Workers()
		for _, row := range wpSnapshot() {
			wps = append(wps, statusWP{Wpno: row.Number, Kind: row.Kind, State: row.State,
				Generation: row.Generation, Started: wpStarted(row.Started),
				User: safeLabel(abap.UName), Report: safeLabel(row.Report)})
		}
	}
	snap := statusSnapshotJSON{
		System: statusSystem{Sid: strings.TrimSpace(abap.SysID), HostKind: "abap-go", GenLive: live, GenServing: buildGeneration,
			Synced: live != "" && live == buildGeneration, Workers: workers, StartedAt: isoTime(h.started), SnapAt: isoTime(now),
			RootHint: filepath.Base(root), Pid: os.Getpid()},
		Processes: []statusProcess{{Pid: os.Getpid(), Role: "facade", Port: h.port, Generation: buildGeneration, Epoch: 0,
			Since: isoTime(h.started), Sockets: countState(rows, h.port, 0x01), RssMb: rssMb(), Alive: true}},
		WorkProcesses: wps,
		Ports:         []statusPort{{Port: h.port, Protocol: "HTTP", Purpose: "OData, apps, ICF", State: state, Note: ""}},
		Services:      services,
		Packs:         append([]statusPack{}, statusPacksServed...),
		Database: append([]statusFact{
			{"Database", "Engine", "sqlite", "connected backend"},
			{"Database", "Storage", storage, note},
		}, platformFacts()...),
	}
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(snap)
	return []byte(strings.TrimSuffix(b.String(), "\n"))
}

// refreshStatus writes the snapshot into the status tables through the
// compiled ZCL_OSD_STATUS=>REFRESH, one modifying dialog step on a work
// process (the five tables are rows); the rows written, or the error that
// stopped it
func refreshStatus(h statusHost) (rows int32, err error) {
	body := string(statusSnapshot(h))
	stepErr := runSystemStep(abap.WriteStep, "status refresh", func(s *abap.Session) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("%s  at %s", dumpText(r), strings.Join(abapStack(r), " <- "))
			}
		}()
		rows = statusRefresh(s, body)
	})
	if err == nil {
		err = stepErr
	}
	return rows, err
}

// freshPath: a route at or below one of statusFreshPrefixes (the glob
// "<prefix>*" of test/start.mjs, case as the mux compares)
func freshPath(route string) bool {
	for _, p := range statusFreshPrefixes {
		if len(route) >= len(p) && strings.EqualFold(route[:len(p)], p) {
			return true
		}
	}
	return false
}

// withFreshStatus refreshes the tables before the request, as test/start.mjs
// does for ZOSD_STATUS_SRV and the webgui; a refresh that fails is logged and
// the read goes on
func withFreshStatus(h statusHost, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if candidate.Load() {
			// read-only until promoted (candidate.go): the tables as they are
		} else if _, err := refreshStatus(h); err != nil {
			log.Printf("status refresh: %v", err)
		}
		next(w, r)
	}
}

// statusPostPath is the SICF node ZCL_OSD_STATUS_HTTP answers; a POST to it
// is a snapshot for REFRESH.
const statusPostPath = "/sap/bc/osd/status"

// statusBodyLimit bounds what a POST to statusPostPath may carry, decoded
// (ultra/json fix round, critic finding 4). /UI2/CL_JSON reads its node
// table through sorted secondary keys, which the Go runtime scans instead
// of indexing (seckey.go KeyRead, KeyOrder), so the parse grows with the
// square of the members: 1000 services took 0.4 s, 3000 3.1 s and 6000
// 14 s, all under the one work process lock. This process's own snapshot
// is about 11 KB and Node's the same; 128 KB is some 1500 services, under
// a second. Node takes express.raw's 16 MB here: the difference is only in
// which bodies answer 413, and is OSGo's alone.
const statusBodyLimit = 128 << 10

// limitStatusBody answers 413, as the body parser does past its limit, for
// a body to statusPostPath above statusBodyLimit, raw or inflated; anything
// else goes on with the body as it came.
func limitStatusBody(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Body == nil || r.Body == http.NoBody {
			next(w, r)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, statusBodyLimit+1))
		if err != nil {
			http.Error(w, "request aborted", 400)
			return
		}
		if len(raw) > statusBodyLimit {
			http.Error(w, "request entity too large", 413)
			return
		}
		var z io.Reader
		switch strings.ToLower(r.Header.Get("Content-Encoding")) {
		case "gzip":
			z, _ = gzip.NewReader(bytes.NewReader(raw))
		case "deflate":
			z, _ = zlib.NewReader(bytes.NewReader(raw))
		}
		if z != nil {
			if n, _ := io.Copy(io.Discard, io.LimitReader(z, statusBodyLimit+1)); n > statusBodyLimit {
				http.Error(w, "request entity too large", 413)
				return
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		next(w, r)
	}
}
