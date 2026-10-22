package rfcnative

import "testing"

func TestConfig(t *testing.T) {
	for _, tc := range []struct {
		values  map[string]string
		enabled bool
		port    int
		fail    bool
	}{
		{nil, false, 0, false}, {nil, true, 3300, false},
		{map[string]string{"INSTANCE": "95"}, true, 3395, false},
		{map[string]string{"OSD_OSGO_RFC": "1", "STG_RFC_PORT": "0"}, false, 0, false},
		{map[string]string{"INSTANCE": "x1"}, true, 0, true},
		{map[string]string{"STG_RFC_PORT": "65536"}, true, 0, true},
		{map[string]string{"STG_RFC_AUTH_MODE": "static"}, true, 0, true},
		{map[string]string{"STG_ADT_PASSWORD": "secret"}, true, 0, true},
	} {
		c, err := FromEnv(tc.enabled, "OSD", func(k string) string { return tc.values[k] })
		if (err != nil) != tc.fail {
			t.Fatalf("%v: %v", tc.values, err)
		}
		if !tc.fail && c.Port != tc.port {
			t.Fatalf("port %d, want %d", c.Port, tc.port)
		}
	}
}
