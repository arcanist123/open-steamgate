package objstore

import (
	"fmt"
	"os"
	"time"
)

// LintCache avoids reading and hashing stable files. The zero value uses a
// conservative two-second timestamp window.
// Set Granularity larger for a coarser filesystem, or negative to disable reuse.
// Only allowlisted coherent local filesystems reuse bytes; all others read.
// Unsupported stat identities always read. Not safe for concurrent use.
type LintCache struct {
	Granularity time.Duration
	entries     map[string]lintContent
	fsType      func(string) (int64, error) // injectable statfs probe
}

type lintContent struct {
	raw, digest string
	identity    fileIdentity
	observed    time.Time
}

type lintReader struct {
	cache *LintCache
	start time.Time
	next  map[string]lintContent
	dirs  map[lintDirectory]bool
}

func (c *LintCache) begin() *lintReader {
	r := &lintReader{cache: c, start: time.Now()}
	if c != nil {
		r.next = map[string]lintContent{}
		r.dirs = map[lintDirectory]bool{}
	}
	return r
}

func (r *lintReader) finish() {
	if r.cache != nil {
		r.cache.entries = r.next
	}
}

func (r *lintReader) read(file string, info os.FileInfo) (lintContent, error) {
	if r.cache == nil {
		bytes, err := os.ReadFile(file)
		return lintContent{raw: string(bytes), digest: storeDigestBytes(bytes)}, err
	}
	var err error
	if info == nil {
		info, err = os.Stat(file)
		if err != nil {
			return lintContent{}, err
		}
	}
	id, supported := lintIdentity(info)
	// Unproven filesystems retain unconditional open/read behavior, including
	// close-to-open validation. Do not reject their stale pre-open attributes.
	supported = supported && r.cache.Granularity >= 0 && r.coherent(file, id)
	if r.cache != nil && supported {
		window := r.cache.Granularity
		if window == 0 {
			window = 2 * time.Second
		}
		old, exists := r.cache.entries[file]
		// Compare with the previous read's start, never today's wall clock: a
		// racy read must be repeated even after the timestamp window has elapsed.
		if exists && window > 0 && id == old.identity &&
			time.Unix(0, id.modified).Before(old.observed.Add(-window)) &&
			time.Unix(0, id.changed).Before(old.observed.Add(-window)) {
			r.next[file] = old
			return old, nil
		}
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		return lintContent{}, err
	}
	out := lintContent{raw: string(bytes), digest: storeDigestBytes(bytes), identity: id, observed: r.start}
	if r.cache != nil && supported {
		after, err := os.Stat(file)
		if err != nil {
			return lintContent{}, err
		}
		current, ok := lintIdentity(after)
		if !ok || id != current {
			return lintContent{}, fmt.Errorf("lint input changed while reading %s; retry", file)
		}
		r.next[file] = out
	}
	return out, nil
}
