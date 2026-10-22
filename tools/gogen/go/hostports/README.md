# OSGo HTTP and HTTPS endpoints

Selects HTTP/HTTPS defaults from `INSTANCE` via `instance`, with explicit
flags and environment overrides first. With no instance, HTTP stays 3095
and HTTPS stays off unless a port was selected.

Reads the same existing `.local/tls/osd.crt` / `osd.key` pair as the JS host,
or `OSD_TLS_DIR`, with explicit cert/key overrides. Does not generate keys.
HTTPS requires a complete pair; missing default credentials disable it.
The caller supplies binds from `osdbind` and the common HTTP handler.
The four-endpoint startup banner reports disabled protocols explicitly.
No ABAP or generated-code dependencies.
