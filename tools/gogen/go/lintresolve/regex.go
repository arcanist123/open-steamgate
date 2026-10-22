package lintresolve

import (
	"fmt"
	"regexp"
	"strings"
)

// Compile accepts a deliberately portable JS-without-flags subset. Reject
// constructs whose JS/RE2 meanings differ rather than guessing at runtime.
// $ and dot are translated because JS also recognizes CR/LS/PS line endings.
func Compile(source string, insensitive bool) (*regexp.Regexp, error) {
	var out strings.Builder
	inClass := false
	for i := 0; i < len(source); i++ {
		c := source[i]
		if c < 32 || c >= 128 {
			return nil, fmt.Errorf("rebuild: regex must use portable ASCII: %q", source)
		}
		if c == '\\' {
			i++
			if i == len(source) {
				return nil, fmt.Errorf("rebuild: trailing regex escape")
			}
			next := source[i]
			if !strings.ContainsRune(`dDwWnrtfv\/.+*?^$()|[]{}-`, rune(next)) {
				return nil, fmt.Errorf("rebuild: unsupported JS/RE2 regex escape in %q", source)
			}
			if next == 'v' {
				out.WriteString(`\x0b`)
			} else if next == 'f' {
				out.WriteString(`\x0c`)
			} else if next == '/' {
				out.WriteByte('/')
			} else {
				out.WriteByte('\\')
				out.WriteByte(next)
			}
			continue
		}
		if c == '[' {
			inClass = true
		}
		if c == ']' {
			inClass = false
		}
		if !inClass && c == '(' && i+1 < len(source) && source[i+1] == '?' {
			if !strings.HasPrefix(source[i:], "(?:") {
				return nil, fmt.Errorf("rebuild: unsupported JS/RE2 regex group in %q", source)
			}
		}
		if !inClass && c == '$' {
			out.WriteString(`(?:\z|[\n\r\x{2028}\x{2029}]\z)`)
			continue
		}
		if !inClass && c == '.' {
			out.WriteString(`[^\n\r\x{2028}\x{2029}]`)
			continue
		}
		// POSIX classes and JS empty character classes do not share RE2 semantics.
		if c == '[' && (strings.HasPrefix(source[i:], "[[:") || strings.HasPrefix(source[i:], "[]") || strings.HasPrefix(source[i:], "[^]")) {
			return nil, fmt.Errorf("rebuild: unsupported JS/RE2 character class in %q", source)
		}
		out.WriteByte(c)
	}
	pattern := out.String()
	// ASCII source case-insensitivity: expand literals rather than RE2's Unicode
	// fold (which additionally folds Kelvin sign and long s, unlike legacy JS /i).
	if insensitive {
		pattern = "(?i)" + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("rebuild: JS/RE2 regex %q: %w", source, err)
	}
	return re, nil
}

func matches(patterns []*regexp.Regexp, value string, insensitive bool) bool {
	if insensitive {
		value = strings.NewReplacer("K", "\x00", "ſ", "\x00").Replace(value)
	}
	for _, re := range patterns {
		if re.MatchString(value) {
			return true
		}
	}
	return false
}

func patterns(sources []string, insensitive bool) ([]*regexp.Regexp, error) {
	out := []*regexp.Regexp{}
	for _, s := range sources {
		re, err := Compile(s, insensitive)
		if err != nil {
			return nil, err
		}
		out = append(out, re)
	}
	return out, nil
}
