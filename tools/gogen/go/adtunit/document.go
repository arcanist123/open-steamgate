package adtunit

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"osg/gogen/adtref"
)

func urlUnescape(s string) (string, error) { return url.PathUnescape(s) }

var esc = adtref.Escape
var enc = adtref.EncodeURIComponent

// the include of a class pool file name, and its CCxx suffix
var frameIncludes = map[string]string{"locals_def": "definitions", "locals_imp": "implementations", "macros": "macros", "testclasses": "testclasses"}
var poolIncludes = map[string]string{"definitions": "CCDEF", "implementations": "CCIMP", "macros": "CCMAC", "testclasses": "CCAU", "main": "CP"}
var classFile = regexp.MustCompile(`(?i)^(.+)\.clas(?:\.([a-z_]+))?\.abap$`)
var progFile = regexp.MustCompile(`^(.+)\.prog\.abap$`)

func classFrame(file string) (name, include string, ok bool) {
	base := file[strings.LastIndex(file, "/")+1:]
	m := classFile.FindStringSubmatch(base)
	if m == nil {
		return "", "", false
	}
	include = "main"
	if m[2] != "" {
		if include, ok = frameIncludes[strings.ToLower(m[2])]; !ok {
			return "", "", false
		}
	}
	return strings.ToUpper(strings.ReplaceAll(m[1], "#", "/")), include, true
}

func frameURI(file string, line, column int) string {
	at := "#start=" + strconv.Itoa(line) + "," + strconv.Itoa(column)
	if name, include, ok := classFrame(file); ok {
		if include != "main" {
			return adtref.URIOf("CLAS", name) + "/includes/" + include + at
		}
		return adtref.URIOf("CLAS", name) + at
	}
	if m := progFile.FindStringSubmatch(file[strings.LastIndex(file, "/")+1:]); m != nil {
		return adtref.URIOf("PROG", m[1]) + "/source/main" + at
	}
	return ""
}

func pool(name string) string { return name + strings.Repeat("=", max(0, 30-len(name))) }

// camel is deliberate_failure -> deliberateFailure, as the Node title has it.
func camel(name string) string {
	parts := strings.Split(strings.ToLower(name), "_")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

func seconds(s float64) string {
	text := strconv.FormatFloat(s, 'f', 3, 64)
	if strings.HasSuffix(text, ".000") {
		return strings.TrimSuffix(text, ".000")
	}
	return text
}

// Document is the class protocol aunit:runResult of tools/adt-unit-result.mjs.
func Document(program string, classes []ClassResult, navigation bool) string {
	program = strings.ToUpper(program)
	base := adtref.URIOf("CLAS", program)
	includeURI := func(include string) string {
		if include == "main" {
			return base
		}
		if include == "" {
			include = "testclasses"
		}
		return base + "/includes/" + include
	}
	nav := func(typ, uri string) string {
		if !navigation {
			return ""
		}
		return ` adtcore:type="` + typ + `" navigationUri="` + esc(uri) + `"`
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>
<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit">
  <program xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="` + esc(program) + `" adtcore:type="CLAS/OC" adtcore:uri="` + esc(base) + `" uriType="semantic">
    <testClasses>
`)
	for _, c := range classes {
		risk, duration := c.Risk, c.Duration
		if risk == "" {
			risk = "harmless"
		}
		if duration == "" {
			duration = "short"
		}
		b.WriteString(`    <testClass adtcore:name="` + esc(c.Name) + `" adtcore:uri="` + esc(base+"#testclass="+enc(c.Name)) + `" durationCategory="` + esc(duration) +
			`" riskLevel="` + esc(risk) + `" uriType="semantic"` + nav("CLAS/OL", includeURI(c.Include)+"#type=CLAS%2FOCL;name="+enc(c.Name)) + ">\n")
		if len(c.Alerts) > 0 {
			b.WriteString(alerts(c.Alerts, "      ", c.Name, "", program) + "\n")
		}
		b.WriteString("      <testMethods>\n")
		for _, m := range c.Results {
			identity := base + "#testclass=" + enc(c.Name) + ";testmethod=" + enc(m.Name)
			target := includeURI(c.Include) + "#type=CLAS%2FOLD;name=" + enc(c.Name+strings.Repeat(" ", max(0, 30-len(c.Name)))+m.Name)
			open := `      <testMethod adtcore:name="` + esc(m.Name) + `" adtcore:uri="` + esc(identity) + `" executionTime="` + seconds(m.Seconds) +
				`" unit="s" uriType="semantic"` + nav("CLAS/OLI", target)
			if len(m.Alerts) == 0 {
				b.WriteString(open + "/>\n")
			} else {
				b.WriteString(open + ">\n" + alerts(m.Alerts, "        ", c.Name, m.Name, program) + "\n      </testMethod>\n")
			}
		}
		b.WriteString("      </testMethods>\n    </testClass>\n")
	}
	b.WriteString("    </testClasses>\n  </program>\n</aunit:runResult>\n")
	return b.String()
}

func alerts(items []Alert, indent, class, method, program string) string {
	var rows []string
	for _, a := range items {
		rows = append(rows, alert(a, class, method, program))
	}
	return indent + "<alerts>\n" + strings.Join(rows, "\n") + "\n" + indent + "</alerts>"
}

func detail(text string) string { return `            <detail text="` + esc(text) + `"/>` }

func alert(a Alert, class, method, program string) string {
	kind, severity := a.Kind, a.Severity
	if kind == "" {
		kind = "failedAssertion"
	}
	if severity == "" {
		severity = "critical"
	}
	methodName := method
	if methodName == "" {
		for _, d := range a.Details {
			if strings.HasPrefix(d, "Raised in ") {
				methodName = strings.ToUpper(strings.TrimPrefix(d, "Raised in "))
			}
		}
	}
	title := a.Title
	if title == "" {
		title = "Unit test assertion failed"
	}
	failed := kind == "failedAssertion"
	if failed && methodName != "" && !strings.HasPrefix(title, "Critical Assertion Error:") {
		message := a.Message
		if message == "" {
			what := a.AssertMethod
			if what == "" {
				what = title
			}
			message = camel(methodName) + ": " + what
		}
		title = "Critical Assertion Error: '" + message + "'"
	}
	var details []string
	if failed && (a.Expected != "" || a.Actual != "") {
		details = append(details, `            <detail text="Different values"><details><detail text="`+esc("Expected ["+a.Expected+"] Actual ["+a.Actual+"]")+`"/></details></detail>`)
	}
	for _, d := range a.Details {
		if methodName != "" && strings.EqualFold(d, "raised in "+methodName) {
			continue
		}
		details = append(details, detail(d))
	}
	if methodName != "" {
		details = append(details, detail("Test '"+class+"->"+methodName+"' in Main Program '"+pool(program)+"CP'"))
	}
	var stack []string
	for _, f := range a.Stack {
		name, include, ok := classFrame(f.File)
		if !ok {
			uri := frameURI(f.File, f.Line, 1)
			if uri == "" {
				uri = f.File
			}
			stack = append(stack, `            <stackEntry adtcore:uri="`+esc(uri)+`" adtcore:name="" adtcore:description="`+esc("line "+strconv.Itoa(f.Line))+`"/>`)
			continue
		}
		description := "Include: <" + pool(name) + poolIncludes[include] + "> Line: <" + strconv.Itoa(f.Line) + ">"
		if methodName != "" {
			description += " (" + methodName + ")"
		}
		stack = append(stack, `            <stackEntry adtcore:uri="`+esc(frameURI(f.File, f.Line, 0))+`" adtcore:type="CLAS/OCN/`+include+`" adtcore:name="`+esc(name)+`" adtcore:description="`+esc(description)+`"/>`)
	}
	return `        <alert kind="` + esc(kind) + `" severity="` + esc(severity) + `">
          <title>` + esc(title) + `</title>
          <details>
` + strings.Join(details, "\n") + `
          </details>
          <stack>
` + strings.Join(stack, "\n") + `
          </stack>
        </alert>`
}
