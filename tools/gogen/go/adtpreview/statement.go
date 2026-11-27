package adtpreview

// oneStatement proves that SQLite sees no ';' token in the text: the driver
// runs every statement of a text, so this is what keeps a guard that lexes
// differently from SQLite from ever running a second one. It is the
// tokenizer of SQLite's sqlite3_complete (complete.c, public domain), one
// linear pass over the bytes; the test checks it against the library's own
// sqlite3_complete. The CREATE TRIGGER states of that function do not
// arise: every text here starts with SELECT.
func oneStatement(sql string) error {
	for i := 0; i < len(sql); i++ {
		switch c := sql[i]; c {
		case 0:
			// C stops at NUL; nothing past one is proven
			return notAllowed("a NUL character")
		case ';':
			return notAllowed("a second statement")
		case '/':
			if i+1 < len(sql) && sql[i+1] == '*' {
				end := i + 2
				for end < len(sql) && !(sql[end] == '*' && end+1 < len(sql) && sql[end+1] == '/') {
					end++
				}
				if end >= len(sql) {
					return nil // an open comment: no token follows
				}
				i = end + 1
			}
		case '-':
			if i+1 < len(sql) && sql[i+1] == '-' {
				for i < len(sql) && sql[i] != '\n' {
					i++
				}
			}
		case '[', '`', '"', '\'':
			closing := c
			if c == '[' {
				closing = ']'
			}
			i++
			for i < len(sql) && sql[i] != closing {
				i++
			}
			if i >= len(sql) {
				return nil // an open quote: no token follows
			}
		}
	}
	return nil
}
