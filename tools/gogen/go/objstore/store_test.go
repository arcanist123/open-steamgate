package objstore

import (
	"encoding/json"
	"math"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// JavaScript's localeCompare over the characters an object name holds, as
// Node 26 sorted them (ICU root collation): the order LIST answers in
func TestCollateIsLocaleCompare(t *testing.T) {
	got := []string{"ZCLA_", "ZCL1", "ZCL$", "ZCL/A", "ZCLA", "ZCL_A", "ZCL"}
	sort.SliceStable(got, func(i, j int) bool { return collateLess(got[i], got[j]) })
	want := "ZCL ZCL_A ZCL/A ZCL$ ZCL1 ZCLA ZCLA_"
	if strings.Join(got, " ") != want {
		t.Fatalf("names: %s, want %s", strings.Join(got, " "), want)
	}
	chars := strings.Split(`~ | > = < + ^ `+"`"+` % # & \ / * @ } { ] [ ) ( " ' . ? ! : ; , - _ $ 0 1 9 a A B z Z`, " ")
	sort.SliceStable(chars, func(i, j int) bool { return collateLess(chars[i], chars[j]) })
	wantChars := `_ - , ; : ! ? . ' " ( ) [ ] { } @ * / \ & # % ` + "`" + ` ^ + < = > | ~ $ 0 1 9 a A B z Z`
	if strings.Join(chars, " ") != wantChars {
		t.Fatalf("characters: %s\nwant        %s", strings.Join(chars, " "), wantChars)
	}
	if !collateLess("ab", "aB") || !collateLess("aB", "Ab") || !collateLess("Ab", "AB") {
		t.Fatalf("case breaks a tie only, lower first")
	}
}

// CAPABILITIES names what this host does; discovery is independent of the source tree
func TestStoreCapabilities(t *testing.T) {
	cmd := "CAPABILITIES"
	if a := Call(map[string]*string{"IV_COMMAND": &cmd}); a.Scalars["EV_ERROR"] != "" || a.Scalars["EV_NOTE"] != strings.Join(Capabilities, " ") {
		t.Fatalf("capabilities without a store: %v", a.Scalars)
	}
	storeState.cfg = &Config{Roots: []Root{{Path: "src", Writable: true}}}
	defer func() { storeState.cfg = nil }()
	a := Call(map[string]*string{"IV_COMMAND": &cmd})
	if a.Scalars["EV_ERROR"] != "" || a.Scalars["EV_NOTE"] != "LIST READ WRITE HISTORY REVISION OBJECT PACKAGE PACKAGES SEARCH CHECKRUN" {
		t.Fatalf("CAPABILITIES: note %q error %q", a.Scalars["EV_NOTE"], a.Scalars["EV_ERROR"])
	}
}

// a WRITE touches only a file inside a writable root of the tree
func TestStoreConfined(t *testing.T) {
	storeState.cfg = &Config{Roots: []Root{{Path: "src", Writable: true}, {Path: "gen"}, {Path: "packs/o4d/src", Writable: true}}}
	defer func() { storeState.cfg = nil }()
	for file, want := range map[string]bool{
		"src/osd/x.prog.abap":             true,
		"packs/o4d/src/x.clas.abap":       true,
		"src/osd/..#..#x.prog.abap":       true,
		"gen/x.clas.abap":                 false,
		"src/../gen/x.clas.abap":          false,
		"../outside.prog.abap":            false,
		"/etc/passwd":                     false,
		"srcx/x.prog.abap":                false,
		"packs/o4d/src/../../../x.abap":   false,
		"src/osd/../../packs/x.prog.abap": false,
	} {
		if got := storeConfined(file); got != want {
			t.Errorf("%s: confined %v, want %v", file, got, want)
		}
	}
}

func TestStoreCommandsAndUnknownWithoutTree(t *testing.T) {
	defer func() { storeState.cfg = nil }()
	for _, cfg := range []*Config{nil, {}} {
		storeState.cfg = cfg
		cmd := "COMMANDS"
		a := Call(map[string]*string{"IV_COMMAND": &cmd})
		var discovery struct {
			Commands []string `json:"commands"`
		}
		if err := json.Unmarshal([]byte(a.Scalars["EV_JSON"]), &discovery); err != nil || !reflect.DeepEqual(discovery.Commands, Commands) || a.Scalars["EV_ERROR"] != "" {
			t.Fatalf("COMMANDS: %v, %v", a.Scalars, err)
		}
		cmd = "PARSE"
		a = Call(map[string]*string{"IV_COMMAND": &cmd})
		var refusal struct {
			Error struct{ Code, Message string }
		}
		if err := json.Unmarshal([]byte(a.Scalars["EV_JSON"]), &refusal); err != nil || refusal.Error.Code != "NOT_SUPPORTED" || refusal.Error.Message != "unknown store command PARSE" || a.Scalars["EV_ERROR"] != refusal.Error.Message {
			t.Fatalf("unknown command: %v, %v", a.Scalars, err)
		}
	}
	storeState.cfg = nil
}

func TestSearchLimitMatchesJavaScriptNumber(t *testing.T) {
	for _, test := range []struct {
		input any
		want  float64
	}{
		{nil, math.NaN()}, {float64(0), 0}, {float64(2), 2}, {"4", 4},
		{float64(0.5), 0.5}, {"Infinity", math.Inf(1)}, {"NaN", math.NaN()}, {"junk", math.NaN()}, {"", 0}, {" 2 ", 2}, {"0x2", 2}, {true, 1}, {false, 0}, {float64(-2), -2},
	} {
		if got := storeSearchLimit(test.input); got != test.want && !(math.IsNaN(got) && math.IsNaN(test.want)) {
			t.Errorf("limit(%#v) = %v, want %v", test.input, got, test.want)
		}
	}
}

type nativeCapabilityCompiler struct {
	testCompiler
	linked bool
}

func (c *nativeCapabilityCompiler) SupportsCheckSource() bool { return c.linked }

func TestStoreNativeCheckCapability(t *testing.T) {
	defer SetCompiler(nil, "")
	cmd := "CAPABILITIES"
	for _, linked := range []bool{false, true} {
		SetCompiler(&nativeCapabilityCompiler{linked: linked}, "")
		caps := strings.Fields(Call(map[string]*string{"IV_COMMAND": &cmd}).Scalars["EV_NOTE"])
		has := func(command string) bool {
			for _, c := range caps {
				if c == command {
					return true
				}
			}
			return false
		}
		if has("CHECK") != linked || has("ACTIVATE") {
			t.Fatalf("linked=%v capabilities=%v", linked, caps)
		}
	}
}
