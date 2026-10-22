package instance

import (
	"fmt"
	"testing"
)

func TestPorts(t *testing.T) {
	for n := 0; n < 100; n++ {
		nn := fmt.Sprintf("%02d", n)
		for _, prefix := range []int{80, 443, 32, 33} {
			port, err := Port(prefix, nn)
			if err != nil || port != prefix*100+n {
				t.Fatalf("%d/%s: %d %v", prefix, nn, port, err)
			}
		}
	}
	if port, err := Port(33, ""); err != nil || port != 3300 {
		t.Fatalf("empty: %d %v", port, err)
	}
	for _, bad := range []string{"1", "100", "-1", " 01", "01 ", "a1", "１", "١٢"} {
		if _, err := Port(80, bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
