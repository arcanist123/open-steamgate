// Package hostports selects OSGo HTTP/HTTPS ports and existing TLS credentials.
package hostports

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"osg/gogen/instance"
	"osg/gogen/osdbind"
)

// SelectedHTTP resolves -port, OSD_PORT, STG_PORT, INSTANCE, then 3095.
func SelectedHTTP(flagValue string, explicit bool, getenv func(string) string) (int, string, error) {
	value, source := flagValue, "-port"
	if !explicit {
		for _, name := range []string{"OSD_PORT", "STG_PORT"} {
			if value = getenv(name); value != "" {
				source = name
				break
			}
		}
	}
	if value == "" && !explicit {
		if getenv("INSTANCE") != "" {
			port, err := instance.Port(80, getenv("INSTANCE"))
			return port, "INSTANCE", err
		}
		return 3095, "default", nil
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, source, fmt.Errorf("%s: invalid port %q", source, value)
	}
	return port, source, nil
}

// HTTPS is the selected optional secure endpoint (Port 0 means off).
type HTTPS struct {
	Port      int
	Cert, Key string
}

// SelectedHTTPS resolves flags, environment and the existing JS-host TLS pair.
func SelectedHTTPS(root, port, cert, key string, explicit map[string]bool, env func(string) string) (HTTPS, error) {
	c := HTTPS{}
	if !explicit["tls-port"] {
		port = env("STG_TLS_PORT")
	}
	if port != "" || explicit["tls-port"] {
		n, err := strconv.Atoi(port)
		if err != nil || n < 0 || n > 65535 {
			return c, fmt.Errorf("invalid HTTPS port %q", port)
		}
		c.Port = n
	} else if env("INSTANCE") != "" {
		n, err := instance.Port(443, env("INSTANCE"))
		if err != nil {
			return c, err
		}
		c.Port = n
	}
	if env("STG_TLS") == "0" && !explicit["tls-port"] {
		c.Port = 0
	}
	if c.Port == 0 {
		return c, nil
	}
	if !explicit["tls-cert"] {
		cert = env("OSD_TLS_CERT")
	}
	if !explicit["tls-key"] {
		key = env("OSD_TLS_KEY")
	}
	pairExplicit := explicit["tls-cert"] || explicit["tls-key"] || cert != "" || key != ""
	if pairExplicit {
		if cert == "" || key == "" {
			return c, fmt.Errorf("HTTPS needs both -tls-cert/-tls-key or OSD_TLS_CERT/OSD_TLS_KEY")
		}
	} else {
		dir := env("OSD_TLS_DIR")
		if dir == "" {
			dir = filepath.Join(root, ".local", "tls")
		}
		cert, key = filepath.Join(dir, "osd.crt"), filepath.Join(dir, "osd.key")
		// As in tools/osd-tls.mjs credentials(): an incomplete default pair is off.
		if !fileExists(cert) || !fileExists(key) {
			c.Port = 0
			return c, nil
		}
	}
	if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
		return c, fmt.Errorf("HTTPS credentials: %w", err)
	}
	c.Cert, c.Key = cert, key
	return c, nil
}

// Start opens HTTPS on the same binds and handler as HTTP.
func (c HTTPS) Start(binds []string, handler http.Handler, logf func(string, ...any)) error {
	if c.Port == 0 {
		return nil
	}
	listeners, err := osdbind.ListenAll(binds, c.Port)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 30 * time.Second}
	for _, ln := range listeners {
		go func() { logf("HTTPS listener: %v", server.ServeTLS(ln, c.Cert, c.Key)) }()
	}
	return nil
}

// EndpointBanner keeps the JS host wording and labels disabled protocols.
func EndpointBanner(httpPort int, tls HTTPS, rfcPort, diagPort int, bound string) string {
	lines := []string{fmt.Sprintf("Listening on http://localhost:%d/sap/opu/odata/sap/  (bound to %s)", httpPort, bound)}
	if tls.Port > 0 {
		lines = append(lines, fmt.Sprintf("HTTPS        on https://localhost:%d  (certificate %s)", tls.Port, tls.Cert))
	} else {
		lines = append(lines, "HTTPS        off (No TLS: configure -tls-cert/-tls-key or run `npm run osd:tls`; select -tls-port or INSTANCE)")
	}
	for _, p := range []struct {
		name string
		port int
		hint string
	}{{"DIAG", diagPort, "-diag / OSD_OSGO_DIAG=1"}, {"RFC", rfcPort, "-rfc / OSD_OSGO_RFC=1, requires -adt"}} {
		if p.port < 0 {
			lines = append(lines, fmt.Sprintf("%-12s off (%s)", p.name, p.hint))
		} else if p.port == 0 {
			lines = append(lines, fmt.Sprintf("%-12s on an OS-selected port (see native listener address above)", p.name))
		} else {
			lines = append(lines, fmt.Sprintf("%-12s on localhost:%d", p.name, p.port))
		}
	}
	return strings.Join(lines, "\n")
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
