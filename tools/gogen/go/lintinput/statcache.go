package lintinput

import (
	"log"
	"os"
	"time"

	"osg/gogen/objstore"
)

// Read once per New, never during capture. Invalid settings fail closed to
// full reads because New has no configuration-error return channel.
func statCacheFromEnv() *objstore.LintCache {
	mode := os.Getenv("OSD_LINT_STAT_CACHE")
	if mode == "off" {
		return nil
	}
	if mode != "" && mode != "auto" {
		log.Printf("lint: invalid OSD_LINT_STAT_CACHE %q; using full reads", mode)
		return nil
	}
	window := 2 * time.Second
	if value := os.Getenv("OSD_LINT_STAT_CACHE_WINDOW"); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil || parsed < window {
			log.Printf("lint: invalid OSD_LINT_STAT_CACHE_WINDOW %q (need >=2s); using full reads", value)
			return nil
		}
		window = parsed
	}
	return &objstore.LintCache{Granularity: window}
}
