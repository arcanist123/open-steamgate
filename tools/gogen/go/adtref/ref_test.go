package adtref

import "testing"

func TestURIRoundTrip(t *testing.T) {
	if got := URIOf("CLAS", "ZCL_X/Y"); got != "/sap/bc/adt/oo/classes/zcl_x%2Fy" {
		t.Fatal(got)
	}
	o, ok := FromURI("/sap/bc/adt/oo/classes/zcl_x%2Fy/source/main?context=a#start=1,0")
	if !ok || o != (Object{"CLAS", "ZCL_X/Y"}) {
		t.Fatal(o, ok)
	}
	if _, ok := FromURI("/sap/bc/adt/ddic/tables/zt"); ok {
		t.Fatal("table is not a source collection")
	}
	if URIOf("TABL", "X") != "" || ADTType("PROG") != "PROG/P" || ADTType("TABL") != "TABL" {
		t.Fatal("types")
	}
}

func TestReferencesAndElements(t *testing.T) {
	body := []byte(`<?xml version="1.0"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
		`<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zp" adtcore:name="ZP"/>` +
		`<adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a" adtcore:name="ZCL_A"/>` +
		`<other uri="/sap/bc/adt/oo/classes/zcl_b"/></adtcore:objectReferences>`)
	refs := References(body)
	if len(refs) != 2 || refs[0] != (Object{"PROG", "ZP"}) || refs[1] != (Object{"CLAS", "ZCL_A"}) {
		t.Fatal(refs)
	}
	els := Elements(body)
	if len(els) != 4 || els[1].Parent != 0 || els[0].Parent != -1 || els[0].Local != "objectReferences" {
		t.Fatal(els)
	}
	if v, _ := Header([][2]string{{"Accept", "x"}}, "accept"); v != "x" {
		t.Fatal(v)
	}
	if q := Query("method=activate&forced=", "forced"); len(q) != 1 || q[0] != "" {
		t.Fatal(q)
	}
}
