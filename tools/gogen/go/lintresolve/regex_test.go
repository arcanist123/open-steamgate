package lintresolve

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"regexp"
	"testing"
)

// Differential tests exercise JS's real regex engine on line endings, UTF-16
// units, ASCII classes and legacy (non-u) case folding, not a Go approximation.
func TestPortableRegexMatchesJavaScript(t *testing.T) {
	sources := []string{`/src/.*/cockpit/`, `\.trace(?:\.meta)?\.json$`, `(#iwbep#if_mgw_odata_(action|parameter)\.intf|zcl_oao_action\.clas)\.`, `^a$`, `^..$`, `^.$`, `^[a-z]+$`, `[^a-z]`, `\w+`, `\W`, `\d+`, `\D`, `a\vb`, `a\fb`, `[.*]`, `(?:abc|DEF){1,3}`, `^unique\d+$`}
	values := []string{"", "a", "a\n", "a\r", "a\r\n", "a\u2028", "a\u2029", "𐀀", "𐀀𐀀", "Å", "å", "K", "ſ", "k", "s", "K", "S", "abcdef", "abcDEF", "unique123", "a\vb", "a\fb", ".", "*", "/src/a\rb/cockpit/z.abap", "/src/a\nb/cockpit/z.abap", "/src/a/b/cockpit/z.abap", "/src/a.trace.meta.json", "/src/a.trace.json\n", "#iwbep#if_mgw_odata_action.intf.abap"}
	input, _ := json.Marshal(struct{ Sources, Values []string }{sources, values})
	cmd := exec.Command("node", "--input-type=module", "-e", `let s=''; for await(const c of process.stdin) s+=c; const {Sources,Values}=JSON.parse(s); console.log(JSON.stringify([false,true].map(i=>Sources.map(s=>Values.map(v=>new RegExp(s,i?'i':'').test(v))))));`)
	cmd.Stdin = bytes.NewReader(input)
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Node test oracle: %v %s", err, raw)
	}
	var want [][][]bool
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	for mode, insensitive := range []bool{false, true} {
		for i, source := range sources {
			re, err := Compile(source, insensitive)
			if err != nil {
				t.Fatal(err)
			}
			for j, value := range values {
				if got := matches([]*regexp.Regexp{re}, value, insensitive); got != want[mode][i][j] {
					t.Errorf("/%s/ i=%v input=%q got=%v want=%v", source, insensitive, value, got, want[mode][i][j])
				}
			}
		}
	}
}

func TestUnsupportedRegexFails(t *testing.T) {
	for _, s := range []string{`(?=x)`, `(a)\1`, `\s`, `[[:alpha:]]`, `\u1234`, `(?i)x`, `é`, `[]`, `[^]`} {
		if _, err := Compile(s, false); err == nil {
			t.Errorf("accepted nonportable regex %q", s)
		}
	}
}
