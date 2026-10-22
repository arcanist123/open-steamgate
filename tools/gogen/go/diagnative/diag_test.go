package diagnative

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"osg/gogen/osdbind"
)

func TestPort(t *testing.T) {
	for _, tc := range []struct {
		env     map[string]string
		enabled bool
		port    int
		fail    bool
	}{
		{nil, false, -1, false}, {nil, true, 3200, false},
		{map[string]string{"INSTANCE": "95"}, true, 3295, false},
		{map[string]string{"INSTANCE": "bad", "DIAG_PORT": "3296"}, true, 3296, false},
		{map[string]string{"INSTANCE": "95", "STG_DIAG_PORT": "3297", "DIAG_PORT": "3296"}, true, 3297, false},
		{map[string]string{"STG_DIAG_PORT": "0", "DIAG_PORT": "123"}, true, 0, false},
		{map[string]string{"INSTANCE": "-1"}, true, 0, true},
		{map[string]string{"DIAG_PORT": "65536"}, true, 0, true},
	} {
		got, err := Port(tc.enabled, func(k string) string { return tc.env[k] })
		if (err != nil) != tc.fail || (!tc.fail && got != tc.port) {
			t.Fatalf("%v: %d %v", tc, got, err)
		}
	}
}

func TestTapeService(t *testing.T) {
	// Reserve then release a port: Start owns the real listeners, selected by
	// the same helper as production. This test exercises both address families.
	probe, err := osdbind.ListenAll([]string{"127.0.0.1"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	port := probe[0].Addr().(*net.TCPAddr).Port
	probe[0].Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := Start(ctx, port, []string{"127.0.0.1", "::1"}, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	frame := append([]byte{0, 0, 0, 8}, []byte("NI_PING\x00")...)
	if _, err := c.Write(frame); err != nil {
		t.Fatal(err)
	}
	size := make([]byte, 4)
	if _, err := io.ReadFull(c, size); err != nil {
		t.Fatal(err)
	}
	body := make([]byte, binary.BigEndian.Uint32(size))
	if _, err := io.ReadFull(c, body); err != nil {
		t.Fatal(err)
	}
	if string(body) != "NI_PONG\x00" {
		t.Fatalf("pong %q", body)
	}
	cancel()
}
