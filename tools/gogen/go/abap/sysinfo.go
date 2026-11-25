package abap

import (
	"fmt"
	"math/rand/v2"
	"os"
	"runtime"
	"strings"
	"time"
)

// The identity and the clock of this system as sy shows them (the Node boot
// sets the same from tools/osd-identity.mjs), and what ZCL_OSD_SYSINFO's
// environment tab says about the host.

var (
	SysID = "OSD"
	UName = "DEVELOPER"
	// sy-dbsys and sy-saprl as the Node hosts have them: the database
	// client's name (the Go host's database is SQLite) and the transpiler
	// runtime's release constant
	DBSys = "sqlite"
	SapRl = "OPEN"
	// HostFacts are lines "name\tvalue" a host adds (its database, the build)
	HostFacts []string
	started   = time.Now()
)

func Datum() string { return time.Now().UTC().Format("20060102") }
func Uzeit() string { return time.Now().UTC().Format("150405") }

// SysInfoEnv is ZCL_OSD_SYSINFO=>ENVIRONMENT: one "name\tvalue" line each.
func SysInfoEnv(s *Session) string {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	up := time.Since(started).Round(time.Second)
	lines := []string{
		"runtime\tABAP compiled to Go (abap-go, tools/gogen)",
		"go\t" + runtime.Version(),
		"platform\t" + runtime.GOOS + "/" + runtime.GOARCH,
		fmt.Sprintf("cpus\t%d", runtime.NumCPU()),
		fmt.Sprintf("process\t%d", os.Getpid()),
		"started\t" + started.UTC().Format("2006-01-02 15:04:05") + " UTC",
		"uptime\t" + up.String(),
		fmt.Sprintf("memory\t%.1f MB from the OS, %.1f MB heap in use", float64(m.Sys)/1048576, float64(m.HeapAlloc)/1048576),
		fmt.Sprintf("goroutines\t%d", runtime.NumGoroutine()),
	}
	lines = append(lines, HostFacts...)
	return strings.Join(lines, "\n")
}

// TimeStamp is GET TIME STAMP FIELD (ultra/events): now in UTC as a
// TIMESTAMP (dec 0, YYYYMMDDhhmmss) or a TIMESTAMPL (dec 7, a fraction of
// seven digits), in the decimal text a p value is held as.
func TimeStamp(dec int) string {
	now := time.Now().UTC()
	ts := now.Format("20060102150405")
	if dec == 7 {
		return ts + "." + fmt.Sprintf("%07d", now.Nanosecond()/100)
	}
	return ts
}

// RandomInt31 is CL_ABAP_RANDOM->INT as open-abap-core has it: 0 .. 2^31-2.
func RandomInt31(s *Session) int32 { return int32(rand.Int64N(2147483647)) }

// ADTOneRuntime is "X" once the host answers SYSTEM SQL in the request's own
// step (cmd/osgo -adt, adtpreview): the data preview routes then mount.
var ADTPreview bool

func ADTOneRuntime(_ *Session, on *string) {
	*on = map[bool]string{true: "X"}[ADTPreview]
}

// ADTUnavailable answers like Node's parent kernel / non-one-runtime case:
// neither seeded serving application tables nor generation is available.
func ADTUnavailable(_ *Session, available *string) {
	// Fixed CHAR values store trailing blanks implicitly in this runtime.
	*available = ""
}

// ADTAvailable answers a capability this host has: the cross-reference
// tables (ZCL_OSD_KERNEL_GUARD=>HAS_CROSS_REFERENCE) are seeded into the
// database at build, so the ADT step's SELECTs over them answer.
func ADTAvailable(_ *Session, available *string) {
	*available = "X"
}
