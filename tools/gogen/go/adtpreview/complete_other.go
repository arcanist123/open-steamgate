//go:build wasm || nodatabase

package adtpreview

import "strings"

// oneStatement without SQLite's tokenizer at hand refuses every ';'.
func oneStatement(sql string) error {
	if strings.Contains(sql, ";") {
		return notAllowed("a second statement")
	}
	return nil
}
