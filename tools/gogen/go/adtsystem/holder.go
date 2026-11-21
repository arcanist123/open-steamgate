package adtsystem

import (
	"osg/gogen/adtenq"
	"osg/gogen/enq"
	"strings"
)

// ENQHolders reads the same dictionary argument as ENQUEUE_EZOSD_ADT_OBJ.
type ENQHolders struct {
	Server enq.Locks
	Kernel *adtenq.Kernel
	Client string
}

func (h ENQHolders) Holder(typ, name string) (string, bool) {
	row, found := h.Server.Holder(enq.Request{Client: h.Client, Table: "ZOSD_ADT_LOCK", Fields: []enq.Field{{Value: strings.ToUpper(typ), Length: 4}, {Value: strings.ToUpper(name), Length: 40}}})
	if !found {
		return "", false
	}
	if key, mine := h.Kernel.KeyForHandle(row.Session); mine {
		return key, true
	}
	return "foreign-holder", true
}
