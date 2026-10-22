package rfcnative

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestConfig(t *testing.T) {
	for _, tc := range []struct {
		values  map[string]string
		enabled bool
		port    int
		fail    bool
	}{
		{nil, false, 0, false}, {nil, true, 3300, false},
		{map[string]string{"INSTANCE": "95"}, true, 3395, false},
		{map[string]string{"INSTANCE": "bad", "STG_RFC_PORT": "3396"}, true, 3396, false},
		{map[string]string{"OSD_OSGO_RFC": "1", "STG_RFC_PORT": "0"}, false, 0, false},
		{map[string]string{"INSTANCE": "x1"}, true, 0, true},
		{map[string]string{"STG_RFC_PORT": "65536"}, true, 0, true},
		{map[string]string{"STG_RFC_AUTH_MODE": "static"}, true, 0, true},
		{map[string]string{"STG_ADT_PASSWORD": "secret"}, true, 0, true},
	} {
		c, err := FromEnv(tc.enabled, "OSD", func(k string) (string, bool) { v, ok := tc.values[k]; return v, ok })
		if (err != nil) != tc.fail {
			t.Fatalf("%v: %v", tc.values, err)
		}
		if !tc.fail && c.Port != tc.port {
			t.Fatalf("port %d, want %d", c.Port, tc.port)
		}
	}
}

func TestAuthConfiguration(t *testing.T) {
	values := map[string]string{"STG_RFC_AUTH_MODE": "static", "STG_RFC_USER": "DEVELOPER", "STG_RFC_PASSWORD": "secret", "STG_RFC_CLIENT": "001", "STG_ADT_USER": "BACKEND", "STG_ADT_PASSWORD": "backend-secret", "STG_ADT_CLIENT": "123", "STG_ADT_LANGUAGE": "EN"}
	env := func(k string) (string, bool) { v, ok := values[k]; return v, ok }
	c, err := FromEnv(true, "QRS", env)
	if err != nil {
		t.Fatal(err)
	}
	o := c.Options
	if o.AuthMode != "static" || o.RFCUser != "DEVELOPER" || o.RFCPassword != "secret" || o.RFCClient != "001" || o.Backend.User != "BACKEND" || o.Backend.Password != "backend-secret" || o.Backend.Client != "123" || o.Backend.Language != "EN" || o.Backend.SystemID != "QRS" {
		t.Fatal("configured identities were not preserved")
	}
	for _, tc := range []struct{ key, value, want string }{
		{"STG_RFC_AUTH_MODE", "unknown", "demo or static"},
		{"STG_RFC_USER", "", "STG_RFC_USER and STG_RFC_PASSWORD"},
		{"STG_RFC_PASSWORD", "", "STG_RFC_USER and STG_RFC_PASSWORD"},
		{"STG_ADT_USER", "", "STG_ADT_USER"},
	} {
		old := values[tc.key]
		values[tc.key] = tc.value
		_, err := FromEnv(true, "QRS", env)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: %v", tc.key, err)
		}
		values[tc.key] = old
	}
	// Start must also reject a manually constructed invalid config before binding.
	c.Options.RFCPassword = ""
	err = Start(context.Background(), c, []string{"invalid bind"}, http.NotFoundHandler(), func(string, ...any) {})
	if err == nil || !strings.Contains(err.Error(), "STG_RFC_PASSWORD") {
		t.Fatalf("Start: %v", err)
	}
}

// Configured RFC/backend credentials must never turn an empty mode into demo.
func TestAuthModePresence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		present bool
		mode    string
		want    string
		fail    bool
	}{
		{"absent", false, "", "demo", false},
		{"empty", true, "", "", true},
		{"demo", true, "demo", "demo", false},
		{"static", true, "static", "static", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			values := map[string]string{"STG_RFC_USER": "DEVELOPER", "STG_RFC_PASSWORD": "secret", "STG_ADT_USER": "BACKEND", "STG_ADT_PASSWORD": "backend-secret"}
			if tc.present {
				values["STG_RFC_AUTH_MODE"] = tc.mode
			}
			c, err := FromEnv(true, "OSD", func(k string) (string, bool) { v, ok := values[k]; return v, ok })
			if tc.fail {
				if err == nil || !strings.Contains(err.Error(), "RFC auth mode must be demo or static") {
					t.Fatalf("FromEnv: %v", err)
				}
				// Even bypassing FromEnv must fail before attempting a bind.
				err = Start(context.Background(), c, []string{"invalid bind"}, http.NotFoundHandler(), func(string, ...any) {})
				if err == nil || !strings.Contains(err.Error(), "RFC auth mode must be demo or static") {
					t.Fatalf("Start: %v", err)
				}
				return
			}
			if err != nil || c.Options.AuthMode != tc.want {
				t.Fatalf("mode %q, err %v", c.Options.AuthMode, err)
			}
		})
	}
}

func TestNullishDefaults(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values map[string]string
		port   int
		host   string
		fail   bool
	}{
		{"absent", nil, 3300, "osd-bridge", false},
		{"empty port", map[string]string{"STG_RFC_PORT": ""}, 0, "osd-bridge", false},
		{"empty host", map[string]string{"STG_HOST_NAME": ""}, 3300, "", false},
		{"explicit", map[string]string{"STG_RFC_PORT": "3395", "STG_HOST_NAME": "bridge.example.test"}, 3395, "bridge.example.test", false},
		{"empty instance", map[string]string{"INSTANCE": ""}, 0, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := FromEnv(true, "OSD", func(k string) (string, bool) { v, ok := tc.values[k]; return v, ok })
			if (err != nil) != tc.fail {
				t.Fatalf("FromEnv: %v", err)
			}
			if !tc.fail && (c.Port != tc.port || c.Options.Backend.HostName != tc.host) {
				t.Fatalf("port %d host %q", c.Port, c.Options.Backend.HostName)
			}
		})
	}
}
