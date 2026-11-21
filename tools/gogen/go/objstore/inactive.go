package objstore

import (
	"sort"
	"strings"
)

// Inactive lists what was saved or created and not activated since, sorted
// by "TYPE NAME" (osd-store-versions.mjs inactiveObjects). A key whose object
// is no longer indexed keeps its type and name with an empty package.
func Inactive() []Row {
	storeState.mu.RLock()
	defer storeState.mu.RUnlock()
	keys := make([]string, 0, len(storeState.written))
	for key := range storeState.written {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rows := make([]Row, 0, len(keys))
	if storeState.cfg == nil {
		return rows
	}
	ix := storeBuild()
	for _, key := range keys {
		typ, name, _ := strings.Cut(key, " ")
		row := Row{TYPE: typ, NAME: name}
		if e := ix.find(typ, name); e != nil {
			row.PACKAGE, row.FILE = e.Package, e.File
		}
		rows = append(rows, row)
	}
	return rows
}
