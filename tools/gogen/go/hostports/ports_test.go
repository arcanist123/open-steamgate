package hostports

import (
	"crypto/x509"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstanceHTTPPrecedence(t *testing.T) {
	for _, tc := range []struct {
		env      map[string]string
		flag     string
		explicit bool
		port     int
		fail     bool
	}{
		{map[string]string{"INSTANCE": "00"}, "", false, 8000, false},
		{map[string]string{"INSTANCE": "99"}, "", false, 8099, false},
		{map[string]string{"INSTANCE": "x1"}, "", false, 0, true},
		{map[string]string{"INSTANCE": "x1", "STG_PORT": "8080"}, "", false, 8080, false},
		{map[string]string{"INSTANCE": "01", "OSD_PORT": "8081", "STG_PORT": "8080"}, "", false, 8081, false},
		{map[string]string{"INSTANCE": "01", "OSD_PORT": "bad"}, "8082", true, 8082, false},
	} {
		got, _, err := SelectedHTTP(tc.flag, tc.explicit, func(k string) string { return tc.env[k] })
		if (err != nil) != tc.fail || (!tc.fail && got != tc.port) {
			t.Fatalf("%+v: %d %v", tc, got, err)
		}
	}
}

func TestHTTPSSelection(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".local", "tls")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// Use a real PEM pair to exercise credential loading, without openssl.
	server := httptest.NewTLSServer(nil)
	certificate := server.TLS.Certificates[0]
	server.Close()
	cert := filepath.Join(dir, "osd.crt")
	key := filepath.Join(dir, "osd.key")
	rawKey, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: rawKey}), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name            string
		env             map[string]string
		port, cert, key string
		explicit        map[string]bool
		want            int
		fail            bool
	}{
		{name: "unchanged default"},
		{name: "instance", env: map[string]string{"INSTANCE": "01"}, want: 44301},
		{name: "environment", env: map[string]string{"INSTANCE": "bad", "STG_TLS_PORT": "4443"}, want: 4443},
		{name: "flag", env: map[string]string{"INSTANCE": "bad", "STG_TLS_PORT": "bad"}, port: "4444", explicit: map[string]bool{"tls-port": true}, want: 4444},
		{name: "flag disables", env: map[string]string{"INSTANCE": "01"}, port: "0", explicit: map[string]bool{"tls-port": true}},
		{name: "env disables", env: map[string]string{"INSTANCE": "01", "STG_TLS": "0"}},
		{name: "missing pair", env: map[string]string{"INSTANCE": "01", "OSD_TLS_DIR": filepath.Join(root, "missing")}},
		{name: "isolated pair", env: map[string]string{"INSTANCE": "01", "OSD_TLS_DIR": dir}, want: 44301},
		{name: "explicit env pair", env: map[string]string{"INSTANCE": "01", "OSD_TLS_CERT": cert, "OSD_TLS_KEY": key}, want: 44301},
		{name: "explicit flag pair", env: map[string]string{"INSTANCE": "01", "OSD_TLS_CERT": "bad", "OSD_TLS_KEY": "bad"}, cert: cert, key: key, explicit: map[string]bool{"tls-cert": true, "tls-key": true}, want: 44301},
		{name: "incomplete explicit pair", env: map[string]string{"INSTANCE": "01", "OSD_TLS_CERT": cert}, fail: true},
		{name: "invalid instance", env: map[string]string{"INSTANCE": "1"}, fail: true},
		{name: "invalid port", env: map[string]string{"STG_TLS_PORT": "65536"}, fail: true},
		{name: "empty port flag", explicit: map[string]bool{"tls-port": true}, fail: true},
		{name: "invalid pair", env: map[string]string{"INSTANCE": "01", "OSD_TLS_CERT": key, "OSD_TLS_KEY": cert}, fail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := SelectedHTTPS(root, tc.port, tc.cert, tc.key, tc.explicit, func(k string) string { return tc.env[k] })
			if (err != nil) != tc.fail || (!tc.fail && c.Port != tc.want) {
				t.Fatalf("%+v %v", c, err)
			}
		})
	}
	if err := os.Remove(key); err != nil {
		t.Fatal(err)
	}
	c, err := SelectedHTTPS(root, "", "", "", nil, func(k string) string {
		if k == "INSTANCE" {
			return "01"
		}
		return ""
	})
	if err != nil || c.Port != 0 {
		t.Fatalf("incomplete default pair: %+v %v", c, err)
	}
}

func TestEndpointBanner(t *testing.T) {
	got := EndpointBanner(8095, HTTPS{Port: 44395, Cert: "osd.crt"}, 3395, 3295, "127.0.0.1:8095, [::1]:8095")
	for _, want := range []string{"Listening on http://localhost:8095/sap/opu/odata/sap/", "HTTPS        on https://localhost:44395", "DIAG         on localhost:3295", "RFC          on localhost:3395", "bound to 127.0.0.1:8095, [::1]:8095"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %s", want, got)
		}
	}
	got = EndpointBanner(3095, HTTPS{}, -1, -1, "127.0.0.1:3095")
	for _, want := range []string{"HTTPS        off (No TLS:", "DIAG         off", "RFC          off"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %s", want, got)
		}
	}
}

func TestEphemeralProtocolBanner(t *testing.T) {
	banner := EndpointBanner(3095, HTTPS{}, 0, 0, "127.0.0.1:3095")
	if strings.Count(banner, "on an OS-selected port") != 2 || strings.Contains(banner, "localhost:0") {
		t.Fatal(banner)
	}
}
