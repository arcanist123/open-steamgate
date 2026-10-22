# Instance ports

`Port(prefix, nn)` validates the shared two-digit ASCII `INSTANCE` value.
HTTP uses prefix 80, HTTPS 443, DIAG 32 and RFC 33. Empty means `00`;
hosts retain their own defaults when INSTANCE is unset. Resolve explicit
flags and port environment variables first, then call this helper for a default.
This package has no ABAP or listener dependencies.
