package cdscheck

import (
	"fmt"
	"strings"
)

var (
	spaces        = jsRegexp(`\s+`)
	dots          = jsRegexp(`\s*\.\s*`)
	colons        = jsRegexp(`\s*:\s*`)
	annoSpace     = jsRegexp(`@\s+`)
	aliasEnd      = jsRegexp(`(?i)\s+as\s+\w+$`)
	tableFunction = jsRegexp(`(?i)\bdefine\s+table\s+function\b`)
	virtualAnno   = jsRegexp(`(?i)@ObjectModel\.virtualElement:\s*true`)
	virtualBy     = jsRegexp(`(?i)@ObjectModel\.virtualElementCalculatedBy:\s*'ABAP:\s*([^']+)'`)
	castType      = jsRegexp(`(?i)as\s+abap\s*\.\s*(\w+)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?`)
	castInner     = jsRegexp(`(?i)^\s*cast\s*\(\s*(.*?)\s+as\s+abap\s*\.`)
	column        = jsRegexp(`^[\w.]+$`)
	expression    = jsRegexp(`[()+\-*/]|^'`)
	analytics     = jsRegexp(`(?i)@Analytics\.dataCategory`)
	writeFlag     = jsRegexp(`(?i)@ObjectModel\.(writeEnabled|createEnabled|updateEnabled|deleteEnabled):\s*true`)
)

func normalize(s string) string {
	return jsTrim(annoSpace.ReplaceAllString(colons.ReplaceAllString(dots.ReplaceAllString(s, "."), ": "), "@"))
}
func annotations(n *Expression) string {
	var out []string
	if n != nil {
		for _, c := range n.Children {
			if c.Kind == "CDSAnnotation" {
				out = append(out, normalize(c.Text))
			}
		}
	}
	return strings.Join(out, "\n")
}

// Node tests each annotation independently and chooses the first nonblank class.
func hasCalculatingClass(n *Expression) bool {
	for _, c := range n.Children {
		if c.Kind == "CDSAnnotation" {
			m := virtualBy.FindStringSubmatch(normalize(c.Text))
			if m != nil && jsTrim(m[1]) != "" {
				return true
			}
		}
	}
	return false
}
func upper(s string) string   { return strings.ToUpper(s) }
func compact(s string) string { return spaces.ReplaceAllString(s, "") }
func validCast(s string) bool {
	m := castType.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	switch strings.ToLower(m[1]) {
	case "char", "numc", "sstring", "string", "int1", "int2", "int4", "int8", "dats", "tims", "dec", "curr", "quan":
		return true
	}
	return false
}

type view struct {
	source, sql, skip      string
	fields, bases          []string
	mandt, asked, writable bool
	why                    string
}

func parse(obj Object, name string, inspect Inspector) (v *view, err error) {
	// ddlsIssues catches parseDDLS failures, but does not swallow checker failures.
	defer func() {
		if p := recover(); p != nil {
			v = nil
			err = fmt.Errorf("%v", p)
		}
	}()
	if obj.Tree == nil {
		return nil, nil
	}
	v = &view{sql: obj.SQLView}
	if v.sql == "" {
		v.sql = name
	}
	v.sql = upper(v.sql)
	selectNode := direct(obj.Tree, "CDSSelect")
	if selectNode == nil {
		v.skip = "no select"
		return &view{skip: v.skip}, nil
	}
	sources := find(selectNode, "CDSSource")
	if len(find(selectNode, "CDSJoin")) > 0 || len(sources) != 1 {
		v.skip = "joins are not supported yet"
		return &view{skip: v.skip}, nil
	}
	if len(find(selectNode, "CDSWhere")) > 0 {
		v.skip = "a WHERE in the view is not carried yet: the DDIC view would return every row, and a write through it could insert a row the view cannot show"
		return &view{skip: v.skip}, nil
	}
	v.source = compact(upper(jsTrim(aliasEnd.ReplaceAllString(sources[0].Text, ""))))
	table := inspect("TABL", v.source)
	isTable := table.Found
	if !isTable {
		table = inspect("VIEW", v.source)
	}
	comps := map[string]bool{}
	for _, c := range table.Components {
		comps[upper(c)] = true
	}
	v.mandt = comps["MANDT"]
	for _, el := range find(selectNode, "CDSElement") {
		annos := annotations(el)
		as := direct(el, "CDSAs")
		alias := text(direct(as, "CDSName"))
		src := direct(el, "CDSName", "CDSPrefixedName")
		srcName := compact(text(src))
		cast := direct(el, "CDSCast")
		if cast != nil && virtualAnno.MatchString(annos) {
			field := upper(alias)
			if field == "" || !hasCalculatingClass(el) {
				v.skip = "virtual element without an alias or a calculating class"
				return &view{skip: v.skip}, nil
			}
			if !validCast(cast.Text) {
				v.skip = "virtual element " + field + ": cannot read the cast type"
				return &view{skip: v.skip}, nil
			}
			continue
		}
		if cast != nil && srcName == "" {
			between := castInner.FindStringSubmatch(spaces.ReplaceAllString(cast.Text, " "))
			inner := ""
			if between != nil && column.MatchString(between[1]) {
				inner = between[1]
			}
			if inner == "" || !validCast(cast.Text) {
				why := "no ABAP type"
				if inner == "" {
					why = "no column inside it"
				}
				if alias == "" {
					alias = "?"
				}
				v.skip = upper(alias) + ": a cast this generator cannot read (" + why + ")"
				return &view{skip: v.skip}, nil
			}
			field := alias
			if field == "" {
				field = inner
			}
			v.fields = append(v.fields, upper(field))
			parts := strings.Split(inner, ".")
			v.bases = append(v.bases, upper(parts[len(parts)-1]))
			continue
		}
		if srcName == "" || strings.HasPrefix(srcName, "_") || expression.MatchString(srcName) {
			continue
		}
		parts := strings.Split(srcName, ".")
		base := upper(parts[len(parts)-1])
		field := alias
		if field == "" {
			field = base
		}
		v.fields = append(v.fields, upper(field))
		v.bases = append(v.bases, base)
	}
	annos := annotations(obj.Tree)
	v.asked = writeFlag.MatchString(annos)
	mapped := map[string]bool{}
	for _, b := range v.bases {
		if b != "" {
			mapped[b] = true
		}
	}
	var missing []string
	for _, k := range table.Keys {
		k = upper(k)
		if k != "MANDT" && !mapped[k] {
			missing = append(missing, k)
		}
	}
	v.writable = v.asked && isTable && len(missing) == 0 && !analytics.MatchString(annos)
	switch {
	case !v.asked:
		v.why = "the view does not ask for it"
	case !isTable:
		v.why = v.source + " is not a table"
	case len(missing) > 0:
		v.why = "the key " + strings.Join(missing, ", ") + " of " + v.source + " is not a field of the view"
	case analytics.MatchString(annos):
		v.why = "an analytical view is read-only"
	}
	return v, nil
}

// Issues preserves extra-before-abaplint ordering and the CDS warning severities.
func Issues(name string, inspect Inspector) []Issue {
	obj := inspect("DDLS", name)
	file := ""
	if len(obj.Files) > 0 {
		file = obj.Files[0].Filename
	}
	issue := func(severity, message string) Issue { return Issue{file, severity, message} }
	v, err := parse(obj, name, inspect)
	if err != nil {
		return []Issue{issue("E", "the view cannot be read: "+err.Error())}
	}
	if v == nil {
		return []Issue{issue("E", "the view has no parse tree: it is not a CDS view this system can read")}
	}
	var raw []string
	for _, f := range obj.Files {
		raw = append(raw, f.Raw)
	}
	if tableFunction.MatchString(strings.Join(raw, "\n")) {
		return []Issue{}
	}
	out := []Issue{}
	if v.source != "" && !inspect("TABL", v.source).Found && !inspect("VIEW", v.source).Found && !inspect("DDLS", v.source).Found {
		out = append(out, issue("E", name+" selects from "+v.source+", which is not a table or a view of this system"))
	}
	if v.skip != "" {
		out = append(out, issue("E", "the generator will not generate this view: "+v.skip))
	}
	generated := inspect("VIEW", v.sql)
	if generated.Found {
		fields := viewFields(v)
		var gone []string
		for _, c := range generated.Components {
			c = upper(c)
			if !fields[c] {
				gone = append(gone, c)
			}
		}
		if len(gone) > 0 {
			verb, pronoun := "are", "them"
			if len(gone) == 1 {
				verb, pronoun = "is", "it"
			}
			out = append(out, issue("W", strings.Join(gone, ", ")+" "+verb+" in the generated view "+v.sql+" and no longer in "+name+": whatever reads "+pronoun+" breaks when this is generated again"))
		}
	}
	if v.asked && !v.writable {
		out = append(out, issue("W", "the view asks to be written and is not: "+v.why))
	}
	return out
}

// viewFields is viewFieldsOf's default client=true branch, projected to names.
// Keep the first named client column and exclude any additional client aliases.
func viewFields(v *view) map[string]bool {
	fields := map[string]bool{}
	named := "MANDT"
	found := false
	for i, f := range v.fields {
		if v.mandt && v.bases[i] == "MANDT" {
			if !found {
				named, found = f, true
			}
			continue
		}
		fields[upper(f)] = true
	}
	if v.mandt {
		fields[upper(named)] = true
	}
	return fields
}
