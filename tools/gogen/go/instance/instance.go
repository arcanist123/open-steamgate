// SPDX-License-Identifier: MIT

// Package instance implements the shared two-digit OSG instance port convention.
package instance

import "fmt"

// Port validates nn (empty means 00) and returns prefix*100 + nn.
// Call only for defaults: explicit ports take precedence over INSTANCE.
func Port(prefix int, nn string) (int, error) {
	if nn == "" {
		nn = "00"
	}
	if len(nn) != 2 || nn[0] < '0' || nn[0] > '9' || nn[1] < '0' || nn[1] > '9' {
		return 0, fmt.Errorf("INSTANCE must be two digits")
	}
	return prefix*100 + int(nn[0]-'0')*10 + int(nn[1]-'0'), nil
}
