//go:build osabap_pickrange

package main

import (
	"testing"

	"github.com/gdamore/tcell/v2"
	"osg/gogen/abap"
	"osg/gogen/termgui"
)

func TestSelectOptionComponentF4(t *testing.T) {
	s := &abap.Session{}
	report := newReport(s)
	var initial ZCL_GG_HOST__TY_RESULT
	abap.DialogStep(s, func() { initial = hostRun(s, report, nil, "", "X") })
	form := graphicalForm(s, report, initial)
	if !appF4["S_FILE-LOW"] || !appF4["S_FILE-HIGH"] || len(form.Fields) != 2 {
		t.Fatalf("component F4 fields: %#v, %#v", appF4, form.Fields)
	}
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	defer screen.Fini()
	low, err := form.OnF4(screen, "S_FILE", form.Fields)
	if err != nil || low != "low.txt" {
		t.Fatalf("LOW: %q, %v", low, err)
	}
	form.Fields[0].Value = low
	high, err := form.OnF4(screen, "S_FILE-HIGH", form.Fields)
	if err != nil || high != "high.txt" {
		t.Fatalf("HIGH: %q, %v", high, err)
	}
	form.Fields[1].Value = high
	values := selectionValuesFromFields(form.Fields, initial)
	if len(values) != 1 || len(values[0].ranges) != 1 || values[0].ranges[0].low != low ||
		values[0].ranges[0].high != high || values[0].ranges[0].option != "BT" {
		t.Fatalf("range after F4: %#v", values)
	}
	// The actual terminal form selects the two handlers by focused row.
	screen.PostEvent(tcell.NewEventKey(tcell.KeyF4, 0, tcell.ModNone))
	screen.PostEvent(tcell.NewEventKey(tcell.KeyTab, 0, tcell.ModNone))
	screen.PostEvent(tcell.NewEventKey(tcell.KeyF4, 0, tcell.ModNone))
	screen.PostEvent(tcell.NewEventKey(tcell.KeyEnter, 0, tcell.ModNone))
	fields, err := termgui.RunOnScreen(screen, graphicalForm(s, report, initial))
	if err != nil || fields[0].Value != low || fields[1].Value != high {
		t.Fatalf("terminal component F4: %#v, %v", fields, err)
	}
}

func TestSelectOptionLowF4KeepsOtherRanges(t *testing.T) {
	s := &abap.Session{}
	report := newReport(s)
	var initial ZCL_GG_HOST__TY_RESULT
	abap.DialogStep(s, func() { initial = hostRun(s, report, nil, "", "X") })
	form := graphicalForm(s, report, initial)
	form.Fields[0].Value = "a,b"
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	defer screen.Fini()
	got, err := form.OnF4(screen, "S_FILE", form.Fields)
	if err != nil || got != "low.txt,b" {
		t.Fatalf("LOW ranges after F4: %q, %v", got, err)
	}
	form.Fields[0].Value = got
	values := selectionValuesFromFields(form.Fields, initial)
	if len(values) != 1 || len(values[0].ranges) != 2 || values[0].ranges[0].low != "low.txt" || values[0].ranges[1].low != "b" {
		t.Fatalf("submitted ranges: %#v", values)
	}
}

func TestEmptyHighKeepsNonBetweenOption(t *testing.T) {
	screen := ZCL_GG_HOST__TY_RESULT{values: []*ZIF_GG_SELECTION_SCREEN_TYPES__TY_VALUE{{name: "S_FILE", ranges: []ZIF_GG_SELECTION_SCREEN_TYPES__TY_RANGE{{sign: "I", option: "CP", low: "*.txt"}}}}}
	fields := []termgui.Field{{Name: "S_FILE", Kind: termgui.Ranges, Value: "*.txt"}, {Name: "S_FILE-HIGH", Value: ""}}
	values := selectionValuesFromFields(fields, screen)
	if len(values) != 1 || len(values[0].ranges) != 1 || values[0].ranges[0].option != "CP" {
		t.Fatalf("empty HIGH reset option: %#v", values)
	}
}
