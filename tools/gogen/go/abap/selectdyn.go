package abap

import (
	"fmt"
	"strconv"
	"strings"
)

// Dynamic Open SQL: SELECT [*|(fields)] FROM <table>|(name) INTO
// [CORRESPONDING FIELDS OF] TABLE <itab> [WHERE (cond)] [GROUP BY (g)]
// [ORDER BY (o) | PRIMARY KEY], the form OSG's generated readers
// (gen/cds zcl_stg_tab_* and zcl_stg_cds_* =>READ, which SE16 and the SADL
// DPC go through) and open-abap-odata's search-help reader use.
//
// What the kernel does at run time, done here at run time:
//   - the table is looked up in the registry (tables.go) by name, any case;
//     a CDS name reads the logon client through its SQL view, where MANDT is
//   - the condition is parsed by the port of tools/ir-osql-where.mjs
//     (osqlwhere.go) against the table's columns, and its outcome is the
//     one A4H showed: CX_SY_DYNAMIC_OSQL_SYNTAX / _SEMANTICS (catchable), an
//     uncatchable runtime error, or NOT_COMPILED for what was not measured
//   - MANDT = sy-mandt is AND'ed for a client-dependent table, as a system
//     does implicitly (the transpiler does not: ANORMALIES)
//   - the statement is lowered to SQLite with every text bound (irsql.go)
//     and the rows are moved into the target through its descriptor.
//
// The field list, GROUP BY and ORDER BY are token lists: column names, a
// column AS alias, SUM / MIN / MAX( column ) AS alias, a column followed by
// ASCENDING or DESCENDING. What else a system reads there was not measured
// and is NOT_COMPILED here, as is a name the registry does not know.

// DynSelect is one dynamic SELECT as the generated code hands it over.
type DynSelect struct {
	Table         string
	Fields        []string // the lines of the field list; nil with Star
	Star          bool
	Where         string
	HasWhere      bool
	GroupBy       []string
	OrderBy       []string
	PrimaryKey    bool
	Corresponding bool
	Stmt          string // the ABAP statement, for the messages
}

// dynTokens are the lines of a dynamic token list as tokens: a line break
// separates tokens as a blank does (blanks: space, tab, CR, LF)
func dynTokens(lines []string) []string {
	var out []string
	for _, l := range lines {
		out = append(out, strings.FieldsFunc(l, blank)...)
	}
	return out
}

var dynName = func(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		ok := r == '_' || r == '/' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return false
		}
	}
	return true
}

// dynItem is one column of the result: its SQL and the name it goes by
type dynItem struct {
	sql  string
	name string
	col  *Column // the column it reads, typed as the column
	agg  string
}

func (q *DynSelect) refuse(why string) {
	panic(NotCompiled("SELECT ... FROM ("+strings.TrimSpace(q.Table)+")", why))
}

// OsqlColumns is a table's columns as the WHERE parser takes them: the IR
// type of each, NUMC marked. A column the IR has no type for (T, F) is
// still a column of the table: it is given its kind as the type, which the
// parser refuses by name ("column type"), instead of calling it unknown
// (which would be CX_SY_DYNAMIC_OSQL_SEMANTICS).
func (t *Table) OsqlColumns() []OsqlColumn {
	out := make([]OsqlColumn, 0, len(t.Columns))
	for _, c := range t.Columns {
		ir := c.IR
		if ir == nil {
			ir = &IRType{Abap: "KIND_" + string(c.Kind)}
		}
		oc := OsqlColumn{Name: c.Name, Type: ir}
		if c.Kind == 'N' {
			oc.Kind = "NUMC"
		}
		out = append(out, oc)
	}
	return out
}

// osqlWhereFailure is the parser's outcome as the program sees it
func osqlWhereFailure(q *DynSelect, err error) {
	switch x := err.(type) {
	case OsqlWhereSyntax:
		panic(ArithmeticError{Class: x.Abap(), Op: q.Stmt + ": " + x.Message})
	case OsqlWhereSemantics:
		panic(ArithmeticError{Class: x.Abap(), Op: q.Stmt + ": " + x.Message})
	case OsqlWhereData:
		panic(ArithmeticError{Class: x.Abap(), Op: q.Stmt + ": " + x.Message})
	case OsqlWhereDump:
		// uncatchable on A4H; its runtime error's name was not read there
		panic(ArithmeticError{Class: "DYNAMIC_OSQL_RUNTIME_ERROR", Op: q.Stmt + ": " + x.Message})
	case OsqlWhereRefused:
		q.refuse("the condition " + strconv.Quote(q.Where) + " is not carried (" + x.Reason + "): " + x.Message)
	case Refused:
		q.refuse("the condition was not lowered: " + x.Reason)
	}
	panic(err)
}

// SelectDyn runs a dynamic SELECT into the generic table target: sy-subrc
// 0 with rows and 4 without, sy-dbcnt the rows, the table replaced.
func SelectDyn(s *Session, q DynSelect, target Data) {
	if target.P == nil {
		panic(notAssigned("SELECT INTO TABLE of a field symbol"))
	}
	if target.T == nil || target.T.Kind != 'h' || target.T.Append == nil {
		q.refuse("the target is not a standard table")
	}
	t, ok := TableByName(q.Table)
	if !ok {
		q.refuse("not a table or view of this program's dictionary (what a system raises for an unknown name is not measured)")
	}
	rel := t
	if !t.Client {
		// a CDS name: the client is its SQL view's, which carries MANDT
		if ct, ok := ClientTable(q.Table); ok && ct.Client {
			rel = ct
		} else if t.HidesClient != "" {
			q.refuse(fmt.Sprintf("%s is a view over the client-dependent %s without MANDT: a system reads the logon client's rows, this one would read every client's", t.Name, t.HidesClient))
		}
	}
	col := func(name string) *Column {
		c, ok := t.Column(name)
		if !ok {
			q.refuse(fmt.Sprintf("%s is not a column of %s (what a system raises is not measured)", strings.ToUpper(name), t.Name))
		}
		return c
	}

	// the field list
	var items []dynItem
	if !q.Star {
		toks := dynTokens(q.Fields)
		if len(toks) == 1 && toks[0] == "*" {
			q.Star = true
		} else if len(toks) == 0 {
			// an initial field list reads every column (ABAP keyword
			// documentation, SELECT column_syntax)
			q.Star = true
		}
		for i := 0; !q.Star && i < len(toks); {
			tok := strings.ToUpper(toks[i])
			var it dynItem
			if agg, open := strings.CutSuffix(tok, "("); open && (agg == "SUM" || agg == "MIN" || agg == "MAX") {
				if i+2 >= len(toks) || toks[i+2] != ")" || !dynName(toks[i+1]) {
					q.refuse("the field list " + strconv.Quote(strings.Join(q.Fields, " ")) + " is not read here")
				}
				c := col(toks[i+1])
				it = dynItem{sql: agg + "(" + quote(c.Name) + ")", name: c.Name, col: c, agg: agg}
				i += 3
				if i+1 >= len(toks) || strings.ToUpper(toks[i]) != "AS" {
					q.refuse("an aggregate without AS in the field list")
				}
			} else {
				if !dynName(toks[i]) {
					q.refuse("the field list " + strconv.Quote(strings.Join(q.Fields, " ")) + " is not read here")
				}
				c := col(toks[i])
				it = dynItem{sql: quote(c.Name), name: c.Name, col: c}
				i++
			}
			if i+1 < len(toks) && strings.ToUpper(toks[i]) == "AS" {
				if !dynName(toks[i+1]) {
					q.refuse("the alias " + strconv.Quote(toks[i+1]) + " is not read here")
				}
				it.name = strings.ToUpper(toks[i+1])
				it.sql += " AS " + quote(it.name)
				i += 2
			}
			items = append(items, it)
		}
	}
	if q.Star {
		items = items[:0]
		for i := range t.Columns {
			c := &t.Columns[i]
			items = append(items, dynItem{sql: quote(c.Name), name: c.Name, col: c})
		}
	}

	// GROUP BY: columns; every column of the list that is not aggregated
	// must be one of them, and a list with an aggregate needs a GROUP BY
	// for its other columns (a system's check, not measured: refused)
	var group []string
	grouped := map[string]bool{}
	for _, g := range dynTokens(q.GroupBy) {
		if !dynName(g) {
			q.refuse("the GROUP BY " + strconv.Quote(strings.Join(q.GroupBy, " ")) + " is not read here")
		}
		c := col(g)
		group = append(group, quote(c.Name))
		grouped[c.Name] = true
	}
	aggs := false
	for _, it := range items {
		if it.agg != "" {
			aggs = true
		}
	}
	if len(group) > 0 || aggs {
		if q.Star {
			q.refuse("SELECT * with GROUP BY")
		}
		for _, it := range items {
			if it.agg == "" && !grouped[it.col.Name] {
				q.refuse(it.col.Name + " is in the field list and not in the GROUP BY")
			}
		}
	}

	// ORDER BY
	var order []string
	if q.PrimaryKey {
		if len(t.Key) == 0 {
			q.refuse("ORDER BY PRIMARY KEY of a view: the registry has no key for it")
		}
		for _, k := range t.Key {
			order = append(order, quote(k))
		}
	} else {
		toks := dynTokens(q.OrderBy)
		if len(toks) == 2 && strings.EqualFold(toks[0], "PRIMARY") && strings.EqualFold(toks[1], "KEY") {
			q.refuse("a dynamic ORDER BY PRIMARY KEY is not measured")
		}
		for i := 0; i < len(toks); i++ {
			name := strings.ToUpper(toks[i])
			if !dynName(name) {
				q.refuse("the ORDER BY " + strconv.Quote(strings.Join(q.OrderBy, " ")) + " is not read here")
			}
			by := ""
			for _, it := range items {
				if it.name == name {
					by = quote(name)
				}
			}
			if by == "" {
				by = quote(col(name).Name)
			}
			if i+1 < len(toks) {
				switch strings.ToUpper(toks[i+1]) {
				case "DESCENDING":
					by += " DESC"
					i++
				case "ASCENDING":
					i++
				}
			}
			order = append(order, by)
		}
	}

	// WHERE: the parsed condition and the client
	var pred *IR
	if q.HasWhere {
		p, err := OsqlWherePredicate(q.Where, t.OsqlColumns())
		if err != nil {
			osqlWhereFailure(&q, err)
		}
		pred = p
	}
	if rel.Client {
		m := Bin("=", Col("MANDT", TChar(3)), Lit(Mandt, TChar(3)), TBool)
		if pred == nil {
			pred = m
		} else {
			pred = Bin("AND", m, pred, TBool)
		}
	}
	cols := make([]string, len(items))
	for i, it := range items {
		cols[i] = it.sql
	}
	text := "SELECT " + strings.Join(cols, ", ") + " FROM " + quote(rel.Name)
	var params []Param
	if pred != nil {
		w, ps, err := LowerPredicate(pred)
		if err != nil {
			osqlWhereFailure(&q, err)
		}
		text += " WHERE " + w
		params = ps
	}
	if len(group) > 0 {
		text += " GROUP BY " + strings.Join(group, ", ")
	}
	if len(order) > 0 {
		text += " ORDER BY " + strings.Join(order, ", ")
	}

	// where each column goes: by name with CORRESPONDING, else by position;
	// a table of elementary rows takes one column
	row := target.T.Row
	dest := make([]int, len(items))
	structRow := row.Kind == 'u' || row.Kind == 'v'
	for i, it := range items {
		dest[i] = -1
		switch {
		case !structRow:
			if len(items) != 1 || q.Corresponding {
				q.refuse("rows of an elementary type take one column, without CORRESPONDING")
			}
			dest[i] = 0
		case q.Corresponding:
			for j, c := range row.Comps {
				if c.Name == it.name {
					dest[i] = j
				}
			}
		default:
			if i >= len(row.Comps) {
				q.refuse("more columns than the target's row has components")
			}
			dest[i] = i
		}
	}

	rows, err := s.conn().Query(text, values(params)...)
	if err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	defer rows.Close()
	ClearData(target)
	n := 0
	vals := make([]DBString, len(items))
	ptrs := make([]any, len(items))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		Must(rows.Scan(ptrs...))
		p := target.T.Append(target.P)
		for i, it := range items {
			if dest[i] < 0 {
				continue
			}
			src := columnData(it.col, vals[i])
			if structRow {
				c := row.Comps[dest[i]]
				moveColumn(Data{P: c.Get(p), T: c.T}, src)
			} else {
				moveColumn(Data{P: p, T: row}, src)
			}
		}
		n++
	}
	if err := rows.Err(); err != nil {
		panic(ArithmeticError{Class: "CX_SY_OPEN_SQL_DB", Op: err.Error()})
	}
	if n > 0 {
		s.Sy.Subrc, s.Sy.Dbcnt = 0, int32(n)
	} else {
		s.Sy.Subrc, s.Sy.Dbcnt = 4, 0
	}
}

// columnData is a column's value as the ABAP value of the column's type
func columnData(c *Column, v DBString) Data {
	switch c.Kind {
	case 'C':
		x := DBChar(v)
		return Data{P: &x, T: TC(c.Len)}
	case 'N':
		x := DBChar(v)
		return Data{P: &x, T: TN(c.Len)}
	case 'D':
		x := DBChar(v)
		return Data{P: &x, T: TD}
	case 'T':
		x := DBChar(v)
		return Data{P: &x, T: TT}
	case 'g':
		x := DBStr(v)
		return Data{P: &x, T: TString}
	case 'I':
		x := int32(dbInteger(v))
		return Data{P: &x, T: TI}
	case '8':
		x := dbInteger(v)
		return Data{P: &x, T: TInt8}
	case 'P':
		x := DBP(v, c.Len, c.Dec)
		return Data{P: &x, T: TP(c.Len, c.Dec)}
	case 'F':
		x, _ := strconv.ParseFloat(strings.TrimSpace(v.String), 64)
		return Data{P: &x, T: TF}
	case 'X':
		x := XFit(DBXStr(v), c.Len)
		return Data{P: &x, T: TX(c.Len)}
	case 'y':
		x := DBXStr(v)
		return Data{P: &x, T: TXString}
	}
	panic(NotCompiled("SELECT", "a column of type kind "+string(c.Kind)+" ("+c.Name+")"))
}

// dbInteger is an INT column as the driver hands it over (an integer, or
// the text of a REAL a SUM gave)
func dbInteger(v DBString) int64 {
	t := strings.TrimSpace(v.String)
	if t == "" {
		return 0
	}
	if i, err := strconv.ParseInt(t, 10, 64); err == nil {
		return i
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		panic(NotCompiled("SELECT", "an integer column holding "+strconv.Quote(t)))
	}
	return int64(f)
}

// moveColumn is a column moved into a field: character-like into
// character-like as a move does it (cut or padded), the rest through
// MoveData's conversions
func moveColumn(dst, src Data) {
	charlike := func(k byte) bool { return k == 'C' || k == 'N' || k == 'D' || k == 'T' || k == 'g' }
	dk, sk := dst.T.Kind, src.T.Kind
	if dk == sk && dk != 'C' && dk != 'X' && (dk != 'N' || dst.T.Len == src.T.Len) && (dk != 'P' || dst.T.Len == src.T.Len) {
		switch dk {
		case 'I':
			*dst.P.(*int32) = *src.P.(*int32)
		case '8':
			*dst.P.(*int64) = *src.P.(*int64)
		case 'F':
			*dst.P.(*float64) = *src.P.(*float64)
		default:
			*dst.P.(*string) = *src.P.(*string)
		}
		return
	}
	if charlike(sk) && sk != 'g' && (dk == 'C' || dk == 'g') {
		v := *src.P.(*string)
		if dk == 'C' {
			v = CFit(v, dst.T.Len)
		}
		*dst.P.(*string) = v
		return
	}
	MoveData(dst, src)
}
