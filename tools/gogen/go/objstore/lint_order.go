package objstore

import "unicode/utf16"

// JSStringLess implements the UTF-16 ordering used by Node's Array.sort().
// UTF-8 byte ordering differs for astral versus high BMP filenames.
func JSStringLess(a, b string) bool {
	ascii := true
	for _, c := range a {
		if c > 127 {
			ascii = false
			break
		}
	}
	if ascii {
		for _, c := range b {
			if c > 127 {
				ascii = false
				break
			}
		}
	}
	if ascii {
		return a < b
	}
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
