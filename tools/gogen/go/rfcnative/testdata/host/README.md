# Wire-test launcher

Test-only executable: reads configuration from stdin and mounts production
native packages on random loopback ports. RFC forwards to the suite's mock HTTP
backend through a reverse proxy; real osgo parity uses the actual native ADT
handler separately. No protocol parsing is implemented here.
