package adtread

import (
	"strings"
	"testing"

	"osg/gogen/objstore"
)

func TestInactiveObjects(t *testing.T) {
	Inactive = func() []objstore.Row {
		return []objstore.Row{{TYPE: "CLAS", NAME: "ZCL_A&B", PACKAGE: "$ZOSD_TEST"}, {TYPE: "PROG", NAME: "ZGONE"},
			{TYPE: "TABL", NAME: "ZT", PACKAGE: "$P"}, {TYPE: "STRU", NAME: "ZS"}, {TYPE: "MSAG", NAME: "ZM"}}
	}
	defer func() { Inactive = objstore.Inactive }()
	r, ok := Serve(Request{Method: "GET", Path: "/sap/bc/adt/activation/inactiveobjects",
		Headers: [][2]string{{"Authorization", "Basic ZGV2ZWxvcGVyOng="}}})
	if !ok || r.Status != 200 || r.Headers[0][1] != "application/vnd.sap.adt.inactivectsobjects.v1+xml; charset=utf-8" {
		t.Fatalf("answer %v %v", ok, r)
	}
	body := string(r.Body)
	for _, want := range []string{
		`<ioc:object ioc:user="DEVELOPER" ioc:linked="" ioc:deleted="false">`,
		`<ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zcl_a%26b" adtcore:type="CLAS/OC" adtcore:name="ZCL_A&amp;B" adtcore:parentUri="/sap/bc/adt/packages/%24zosd_test"/>`,
		`<ioc:ref adtcore:uri="/sap/bc/adt/programs/programs/zgone" adtcore:type="PROG/P" adtcore:name="ZGONE"/>`,
		"</ioc:entry>\n    <ioc:entry>",
		`<ioc:ref adtcore:uri="/sap/bc/adt/ddic/tables/zt" adtcore:type="TABL/DT" adtcore:name="ZT" adtcore:parentUri="/sap/bc/adt/packages/%24p"/>`,
		`<ioc:ref adtcore:uri="" adtcore:type="TABL/DS" adtcore:name="ZS"/>`,
		`<ioc:ref adtcore:uri="/sap/bc/adt/messageclass/zm" adtcore:type="MSAG/N" adtcore:name="ZM"/>`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in\n%s", want, body)
		}
	}
	if !strings.HasSuffix(body, "</ioc:entry>\n</ioc:inactiveObjects>\n") {
		t.Errorf("tail of\n%s", body)
	}
	if empty := InactiveObjectsDocument(nil, "U"); !strings.HasSuffix(empty, "core\">\n\n</ioc:inactiveObjects>\n") {
		t.Errorf("empty document %q", empty)
	}
	if user(nil) != "DEVELOPER" {
		t.Error("default user")
	}
	if _, ok := Serve(Request{Method: "POST", Path: "/sap/bc/adt/activation/inactiveobjects"}); ok {
		t.Error("only GET is served")
	}
}
