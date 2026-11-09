//go:build osabap_pickfile

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
	"osg/gogen/abap"
	"osg/gogen/filepick"
	"osg/gogen/termgui"
)

func TestDialogFilterReachesBrowser(t *testing.T) {
	options := abap.FrontendPickOptions{Kind: "save", Filter: "Text (*.txt)|*.txt|All (*.*)|*.*", Extension: "txt", Prompt: "X"}
	browser := browserForDialog(options)
	if browser.Mode != filepick.Save || !browser.ConfirmOverwrite || browser.Extension != "txt" || len(browser.Patterns) != 0 {
		t.Fatalf("save dialog options: %+v", browser)
	}
	options.Kind = "open-multiple"
	options.Filter = "Text (*.txt)|*.txt|Images (*.png)|*.png"
	browser = browserForDialog(options)
	if !browser.Multi || !reflect.DeepEqual(browser.Patterns, []string{"*.txt", "*.png"}) {
		t.Fatalf("open dialog options: %+v", browser)
	}
}

func TestSaveOverwritePromptDefaultAndSpace(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "existing.txt")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OSD_DATASET_WRITE", root)
	t.Setenv("OSD_DATASET_READ", "")
	t.Setenv("OSD_DATASET_HOME", "")
	screen := func(keys ...*tcell.EventKey) tcell.SimulationScreen {
		t.Helper()
		s := tcell.NewSimulationScreen("UTF-8")
		if err := s.Init(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(s.Fini)
		s.SetSize(100, 20)
		for _, key := range keys {
			s.PostEvent(key)
		}
		return s
	}
	key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }
	runeKey := func(r rune) *tcell.EventKey { return tcell.NewEventKey(tcell.KeyRune, r, tcell.ModNone) }
	options := abap.FrontendPickOptions{Kind: "save", Name: "existing.txt"}
	browser := browserForDialog(options)
	if !browser.ConfirmOverwrite {
		t.Fatal("omitted prompt did not default to enabled")
	}
	got, err := browser.Run(screen(runeKey('n'), key(tcell.KeyEnter), runeKey('n'), key(tcell.KeyEscape)))
	if err != filepick.ErrCancel || got != "" {
		t.Fatalf("declined overwrite: %q, %v", got, err)
	}
	options.Prompt = " "
	// This distinguishes the direct Go API only. The ABAP compiler lowers
	// explicit SPACE and an omitted optional argument to the same empty value.
	browser = browserForDialog(options)
	if browser.ConfirmOverwrite {
		t.Fatal("explicit space still prompts")
	}
	got, err = browser.Run(screen(runeKey('n'), key(tcell.KeyEnter)))
	if err != nil || got != path {
		t.Fatalf("save without prompt: %q, %v", got, err)
	}
}

func TestF4SelectionScreenDialogs(t *testing.T) {
	read := t.TempDir()
	write := t.TempDir()
	input := filepath.Join(read, "input.txt")
	if err := os.WriteFile(input, []byte("input"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OSD_DATASET_READ", read)
	t.Setenv("OSD_DATASET_WRITE", write)
	t.Setenv("OSD_DATASET_HOME", "")
	s := &abap.Session{}
	report := newReport(s)
	var result ZCL_GG_HOST__TY_RESULT
	abap.DialogStep(s, func() { result = hostRun(s, report, nil, "", "X") })
	terminal := tcell.NewSimulationScreen("UTF-8")
	if err := terminal.Init(); err != nil {
		t.Fatal(err)
	}
	defer terminal.Fini()
	terminal.SetSize(100, 20)
	key := func(k tcell.Key) { terminal.PostEvent(tcell.NewEventKey(k, 0, tcell.ModNone)) }
	runeKey := func(r rune) { terminal.PostEvent(tcell.NewEventKey(tcell.KeyRune, r, tcell.ModNone)) }
	key(tcell.KeyF4) // open: choose input.txt
	key(tcell.KeyEnter)
	key(tcell.KeyTab)
	key(tcell.KeyF4) // directory: choose current root
	runeKey(' ')
	key(tcell.KeyTab)
	key(tcell.KeyF4) // save: type a new name
	runeKey('n')
	key(tcell.KeyEnter)
	key(tcell.KeyEnter) // submit form
	fields, err := termgui.RunOnScreen(terminal, graphicalForm(s, report, result))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range fields {
		got[f.Name] = f.Value
	}
	if got["P_IN"] != input || got["P_DIR"] != read || got["P_OUT"] != filepath.Join(write, "output.txt") {
		t.Fatalf("F4 fields: %#v", got)
	}

	// A cancelled dialog returns the original value through the ABAP event.
	terminal.PostEvent(tcell.NewEventKey(tcell.KeyF4, 0, tcell.ModNone))
	terminal.PostEvent(tcell.NewEventKey(tcell.KeyEscape, 0, tcell.ModNone))
	terminal.PostEvent(tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone))
	form := graphicalForm(s, report, result)
	form.Fields[0].Value = "previous"
	fields, err = termgui.RunOnScreen(terminal, form)
	if err != nil || fields[0].Value != "previous" {
		t.Fatalf("cancelled F4: %q, %v", fields[0].Value, err)
	}

	// With no grant, the form shows the reason and leaves the value alone.
	t.Setenv("OSD_DATASET_READ", "")
	t.Setenv("OSD_DATASET_WRITE", "")
	terminal.PostEvent(tcell.NewEventKey(tcell.KeyF4, 0, tcell.ModNone))
	terminal.PostEvent(tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone))
	form = graphicalForm(s, report, result)
	_, missing := form.OnF4(terminal, "P_IN", form.Fields)
	if missing == nil || !strings.Contains(missing.Error(), "no -allow-read root") {
		t.Fatalf("missing read grant: %v", missing)
	}
	fields, err = termgui.RunOnScreen(terminal, form)
	if err != nil {
		t.Fatal(err)
	}
	if fields[0].Value != "" {
		t.Fatalf("field changed without grant: %q", fields[0].Value)
	}
	// The browser's error is surfaced in the form footer; save requires its
	// separate write grant.
	_, err = (abap.SandboxFromEnv()).BrowseSaveName(filepath.Join(write, "x"))
	if err == nil || !strings.Contains(err.Error(), "root") {
		t.Fatalf("missing grant: %v", err)
	}
}

func TestF4FilenameFunctionModules(t *testing.T) {
	s := &abap.Session{}
	report := newReport(s)
	abap.FrontendPick = func(options abap.FrontendPickOptions) (string, error) {
		if options.Kind != "open" {
			t.Fatalf("kind %q", options.Kind)
		}
		return "/chosen/file.txt", nil
	}
	defer func() { abap.FrontendPick = nil }()
	for _, name := range []string{"P_FM1", "P_FM2"} {
		var result ZCL_GG_HOST__TY_RESULT
		abap.DialogStep(s, func() {
			result = hostRunRequest(s, report, selectionValues(map[string]selectionInput{name: {value: "old"}}), "", "X", name)
		})
		found := false
		for _, value := range result.values {
			if strings.TrimSpace(value.name) == name && len(value.ranges) > 0 {
				if value.ranges[0].low != "/chosen/file.txt" {
					t.Fatalf("%s: %+v", name, value.ranges)
				}
				found = true
			}
		}
		if !found {
			t.Fatalf("no value request result for %s", name)
		}
	}
}

func TestF4ReadsEditedOtherField(t *testing.T) {
	s := &abap.Session{}
	report := newReport(s)
	abap.FrontendPick = func(options abap.FrontendPickOptions) (string, error) {
		if options.Initial != "/edited/directory" {
			t.Fatalf("initial directory = %q", options.Initial)
		}
		return "/chosen/file.txt", nil
	}
	defer func() { abap.FrontendPick = nil }()
	values := selectionValues(map[string]selectionInput{
		"P_DIR": {value: "/edited/directory"},
		"P_IN":  {value: "old"},
	})
	abap.DialogStep(s, func() { hostRunRequest(s, report, values, "", "X", "P_IN") })
}

func TestCancelledSavePreservesField(t *testing.T) {
	s := &abap.Session{}
	report := newReport(s)
	abap.FrontendPick = func(options abap.FrontendPickOptions) (string, error) {
		if options.Kind != "save" {
			t.Fatalf("kind %q", options.Kind)
		}
		return "", abap.ErrFrontendPickCancel
	}
	defer func() { abap.FrontendPick = nil }()
	var result ZCL_GG_HOST__TY_RESULT
	abap.DialogStep(s, func() {
		result = hostRunRequest(s, report, selectionValues(map[string]selectionInput{"P_OUT": {value: "previous"}}), "", "X", "P_OUT")
	})
	for _, value := range result.values {
		if strings.TrimSpace(value.name) == "P_OUT" && len(value.ranges) > 0 {
			if value.ranges[0].low != "previous" {
				t.Fatalf("cancel changed value: %+v", value.ranges)
			}
			return
		}
	}
	t.Fatal("no save value request result")
}
