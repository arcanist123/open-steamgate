package lintresolve

import (
	"fmt"
	"regexp"
	"strings"
)

// Compile accepts a deliberately portable JS-without-flags subset. Reject
// constructs whose JS/RE2 meanings differ rather than guessing at runtime.
// Dot excludes all JS line terminators; Match compares UTF-16 units.
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
			out.WriteString(`\z`)
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
	// Match maps non-ASCII input units before RE2 case folding.
	if insensitive {
		pattern = "(?i)" + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("rebuild: JS/RE2 regex %q: %w", source, err)
	}
	return re, nil
}

// regexUnits gives RE2 the same units as legacy JS regexes. The accepted
// sources contain only ASCII literals: all other non-line-terminator units
// have identical membership in their character classes. Astral code points
// contribute two units; Kelvin/long-s cannot fold into ASCII under JS /i.
func regexUnits(value string) string {
	var b strings.Builder
	for _, c := range value {
		switch {
		case c < 128 || c == 0x2028 || c == 0x2029:
			b.WriteRune(c)
		case c > 0xffff:
			b.WriteRune(0xe000)
			b.WriteRune(0xe000)
		default:
			b.WriteRune(0xe000)
		}
	}
	return b.String()
}

func matches(patterns []*regexp.Regexp, value string, _ bool) bool {
	value = regexUnits(value)
	for _, re := range patterns {
		if re.MatchString(value) {
			return true
		}
	}
	return false
}

// ExclusionFilter shares logical-path and JS-regex semantics with capture.
// The callback accepts store-relative paths without the leading slash.
func ExclusionFilter(root string, r *Rules) (func(string) bool, error) {
	patterns, err := patterns(r.Excluded, false)
	if err != nil {
		return nil, err
	}
	return func(file string) bool {
		path := "/" + file
		if r.System {
			path = logical(root, file, r)
		}
		return matches(patterns, path, false)
	}, nil
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
