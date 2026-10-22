package lintinput

import (
	"testing"
	"time"
)

func TestStatCacheSettings(t *testing.T) {
	for _, tc := range []struct {
		mode, window string
		want         time.Duration
	}{
		{"", "", 2 * time.Second}, {"auto", "", 2 * time.Second},
		{"auto", "5s", 5 * time.Second}, {"off", "", 0},
		{"invalid", "", 0}, {"auto", "bad", 0},
		{"auto", "-1s", 0}, {"auto", "1s", 0},
	} {
		t.Run(tc.mode+"/"+tc.window, func(t *testing.T) {
			t.Setenv("OSD_LINT_STAT_CACHE", tc.mode)
			t.Setenv("OSD_LINT_STAT_CACHE_WINDOW", tc.window)
			cache := statCacheFromEnv()
			if tc.want == 0 {
				if cache != nil {
					t.Fatal("expected full reads")
				}
				return
			}
			if cache == nil || cache.Granularity != tc.want {
				t.Fatal("wrong cache window", cache)
			}
		})
	}
}
