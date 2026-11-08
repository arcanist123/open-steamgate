// Package adtpreview answers the ADT data preview's SYSTEM SQL and SQLCHECK
// on the Go host, on the connection of the calling dialog step. It is the
// Go form of tools/adt-preview-sql.mjs with tools/adt-single-select.mjs and
// the Data.query / Data.check seams of tools/osd-data.mjs.
package adtpreview

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Refusal is a statement this door does not run; Code is what the ABAP
// front reads (NOT_ALLOWED becomes a 400, as on Node).
type Refusal struct{ Code, Message string }

func (r *Refusal) Error() string { return r.Message }

func notAllowed(word string) error {
	return &Refusal{Code: "NOT_ALLOWED", Message: "only SELECT is allowed here, not " + strings.ToUpper(word)}
}

var (
	wordAtStart = regexp.MustCompile(`^\w+`)
	selectWord  = regexp.MustCompile(`(?i)^select\b`)
)

// indexFrom is the index of s in text at or after from, or -1, without
// copying the rest of the text (the guard stays linear).
func indexFrom(text []rune, s string, from int) int {
	pattern := []rune(s)
	for i := from; i+len(pattern) <= len(text); i++ {
		match := true
		for k, r := range pattern {
			if text[i+k] != r {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// MaxStatement caps the text a preview accepts, in bytes. Node has no cap;
// osgo answers inside the work-process lock, so a guard over an unbounded
// text would hold every other request.
const MaxStatement = 64 << 10

// SingleSelect admits one SELECT, lexed as SQLite lexes it (the Node guard
// also knows PostgreSQL's dollar quotes and E-prefixed escapes, which SQLite does
// not have and which would hide a statement from this guard): comments
// become blanks, quoted text and identifiers are opaque, and nothing may
// follow a ';'. It returns the statement without comments, trimmed.
func SingleSelect(sql string) (string, error) {
	if strings.ContainsRune(sql, 0) {
		return "", notAllowed("a NUL character")
	}
	if len(sql) > MaxStatement {
		return "", &Refusal{Code: "NOT_ALLOWED", Message: "the statement is longer than " + strconv.Itoa(MaxStatement) + " bytes, the most a data preview accepts here"}
	}
	text := []rune(strings.TrimSpace(sql))
	out := []rune{}
	ended := false
	for i := 0; i < len(text); {
		c := text[i]
		var next rune
		if i+1 < len(text) {
			next = text[i+1]
		}
		if unicode.IsSpace(c) {
			out = append(out, c)
			i++
			continue
		}
		if c == '-' && next == '-' {
			if end := indexFrom(text, "\n", i+2); end < 0 {
				i = len(text)
			} else {
				i = end
			}
			out = append(out, ' ')
			continue
		}
		if c == '/' && next == '*' {
			// SQLite's block comments do not nest: the first */ ends one.
			end := indexFrom(text, "*/", i+2)
			if end < 0 {
				return "", notAllowed("unterminated comment")
			}
			i = end + 2
			out = append(out, ' ')
			continue
		}
		if ended {
			word := wordAtStart.FindString(string(text[i:]))
			if word == "" {
				word = string(c)
			}
			return "", notAllowed(word)
		}
		if c == ';' {
			ended = true
			i++
			continue
		}
		if c == '\'' || c == '"' || c == '`' || c == '[' {
			closing := c
			if c == '[' {
				closing = ']'
			}
			start := i
			i++
			// SQLite has no backslash escapes and no dollar quoting: a quote
			// is doubled to stay inside, and [...] ends at its first ].
			for i < len(text) {
				ch := text[i]
				i++
				if ch == closing {
					if closing != ']' && i < len(text) && text[i] == closing {
						i++
						continue
					}
					break
				}
			}
			out = append(out, text[start:min(i, len(text))]...)
			continue
		}
		out = append(out, c)
		i++
	}
	s := strings.TrimSpace(string(out))
	if !selectWord.MatchString(s) {
		word := ""
		if f := strings.Fields(s); len(f) > 0 {
			word = f[0]
		}
		return "", notAllowed(word)
	}
	return s, nil
}

var (
	selectHead = regexp.MustCompile(`(?is)^(select\s+(?:distinct\s+)?)(.+?)(\s+from\s+)`)
	plainList  = regexp.MustCompile(`^[A-Za-z_/$][\w/$~]*(?:\s+[A-Za-z_/$][\w/$~]*)+$`)
	upToRows   = regexp.MustCompile(`(?i)\s+up\s+to\s+(\d+)\s+rows\b`)
)

// OpenSQLToSQL turns the old comma-less field list into a comma list and
// UP TO n ROWS into LIMIT n (osd-data.mjs openSqlToSql).
func OpenSQLToSQL(text string) string {
	out := text
	if m := selectHead.FindStringSubmatchIndex(out); m != nil {
		keyword, list, from := out[m[2]:m[3]], out[m[4]:m[5]], out[m[6]:m[7]]
		if !strings.Contains(list, ",") && plainList.MatchString(strings.TrimSpace(list)) {
			out = keyword + strings.Join(strings.Fields(list), ", ") + from + out[m[1]:]
		}
	}
	if m := upToRows.FindStringSubmatch(out); m != nil {
		out = strings.Replace(out, m[0], "", 1) + " LIMIT " + m[1]
	}
	return out
}

func replaceFirst(re *regexp.Regexp, s, template string) string {
	m := re.FindStringSubmatchIndex(s)
	if m == nil {
		return s
	}
	return s[:m[0]] + string(re.ExpandString(nil, template, s, m)) + s[m[1]:]
}

var (
	upToTail    = regexp.MustCompile(`(?i) UP TO (\d+) ROWS(.*)`)
	primaryKey  = regexp.MustCompile(`(?i) ORDER BY PRIMARY KEY`)
	ascending   = regexp.MustCompile(`(?i) ASCENDING`)
	descending  = regexp.MustCompile(`(?i) DESCENDING`)
	leftCall    = regexp.MustCompile(`(?i)\bLEFT\s*\(\s*(.+?)\s*,\s*(\d+)\s*\)`)
	rightCall   = regexp.MustCompile(`(?i)\bRIGHT\s*\(\s*(.+?)\s*,\s*(\d+)\s*\)`)
	limitAtEnd  = regexp.MustCompile(`(?i) LIMIT \d+`)
	limitZeroes = " LIMIT 0"
)

// SQLite renders the SELECT the way the published SQLite client and
// rewritePreview do before they prepare it.
func SQLite(sql string) string {
	s := replaceFirst(upToTail, sql, "${2} LIMIT ${1}")
	s = replaceFirst(primaryKey, s, "")
	s = ascending.ReplaceAllString(s, " ASC")
	s = descending.ReplaceAllString(s, " DESC")
	s = strings.ReplaceAll(s, "~", ".")
	s = leftCall.ReplaceAllString(s, "substr(${1}, 1, ${2})")
	return rightCall.ReplaceAllString(s, "substr(${1}, -${2})")
}
