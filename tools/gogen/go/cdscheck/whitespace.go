package cdscheck

import (
	"regexp"
	"strings"
)

// ECMAScript WhiteSpace + LineTerminator: RE2's \s omits vertical tab,
// nonbreaking spaces and BOM, while Go's TrimSpace additionally strips NEL.
const jsWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func jsTrim(s string) string { return strings.Trim(s, jsWhitespace) }
func jsRegexp(pattern string) *regexp.Regexp {
	return regexp.MustCompile(strings.ReplaceAll(pattern, `\s`, "["+jsWhitespace+"]"))
}
