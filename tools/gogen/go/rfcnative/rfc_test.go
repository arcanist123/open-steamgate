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
		c, err := FromEnv(tc.enabled, "OSD", func(k string) string { return tc.values[k] })
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
	env := func(k string) string { return values[k] }
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
