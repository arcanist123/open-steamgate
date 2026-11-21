package objstore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// indexTree is a tree for the cache tests: a writable src with a folder, a
// library, an abapGit root with a declared package and local/tmp with its
// tadir.json. The racy window is 0 and every filesystem counts as coherent,
// so the tests decide staleness by the stamps alone; settle sleeps past one
// timestamp tick so a change is never in the tick of the walk before it.
func indexTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"abap_transpile.json":                         "{}",
		"src/zcl_a.clas.abap":                         "CLASS zcl_a DEFINITION.\nENDCLASS.\n",
		"src/sub/zprog_b.prog.abap":                   "REPORT zprog_b.\n",
		"lib/src/zcl_lib.clas.abap":                   "CLASS zcl_lib DEFINITION.\nENDCLASS.\n",
		"agit/src/package.devc.xml":                   "<DEVCLASS>ZAGIT_ONE</DEVCLASS>",
		"agit/src/inner/package.devc.xml":             "<DEVCLASS>ZAGIT_INNER</DEVCLASS>",
		"agit/src/inner/zcl_agit.clas.abap":           "CLASS zcl_agit DEFINITION.\nENDCLASS.\n",
		"local/tmp/ztmp_obj.prog.abap":                "REPORT ztmp_obj.\n",
		"local/tmp/tadir.json":                        `{"PROG ZTMP_OBJ":{"author":"alpha"}}`,
		"elsewhere/target/zlinked_c.prog.abap":        "REPORT zlinked_c.\n",
		"elsewhere/target/deeper/zlinked_d.prog.abap": "REPORT zlinked_d.\n",
	}
	for f, c := range files {
		full := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "elsewhere", "target"), filepath.Join(root, "src", "linked")); err != nil {
		t.Fatal(err)
	}
	cfg := `{"roots":[{"path":"src","writable":true},{"path":"agit","writable":true,"package":"ZAGIT","abapgit":{"folderLogic":"PREFIX"}},{"path":"local/tmp","writable":true,"tmp":true,"package":"$TMP"}],
	 "libs":[{"path":"lib/src","library":true,"files":["lib/src/zcl_lib.clas.abap","lib/src/zcl_gone.clas.abap"]}]}`
	window, probe := storeIndexWindow, storeIndexFSType
	storeIndexWindow = 0
	storeIndexFSType = func(string) (int64, error) { return 0xef53, nil }
	t.Cleanup(func() {
		storeIndexWindow, storeIndexFSType = window, probe
		SetStore("", nil, "")
	})
	if err := SetStore(root, []byte(cfg), ""); err != nil {
		t.Fatal(err)
	}
	settle()
	return root
}

func settle() { time.Sleep(30 * time.Millisecond) }

func storeCall(args ...string) Answer {
	in := map[string]*string{}
	for i := 0; i+1 < len(args); i += 2 {
		v := args[i+1]
		in[args[i]] = &v
	}
	return Call(in)
}

func listed(t *testing.T) map[string]Row {
	t.Helper()
	a := storeCall("IV_COMMAND", "LIST", "IV_LIMIT", "1000")
	if a.Scalars["EV_ERROR"] != "" {
		t.Fatal(a.Scalars["EV_ERROR"])
	}
	out := map[string]Row{}
	for _, r := range a.Objects {
		out[r.TYPE+" "+r.NAME] = r
	}
	return out
}

// the walks a function caused
func walks(f func()) int64 {
	before := storeIndexWalks.Load()
	f()
	return storeIndexWalks.Load() - before
}

func TestIndexCacheReusedWhileNothingChanged(t *testing.T) {
	indexTree(t)
	if n := walks(func() { listed(t) }); n != 1 {
		t.Fatalf("first call walked %d times, want 1", n)
	}
	if n := walks(func() {
		for i := 0; i < 20; i++ {
			listed(t)
			storeCall("IV_COMMAND", "READ", "IV_TYPE", "CLAS", "IV_NAME", "ZCL_A")
		}
	}); n != 0 {
		t.Fatalf("an unchanged tree walked %d times", n)
	}
	rows := listed(t)
	for _, key := range []string{"CLAS ZCL_A", "PROG ZPROG_B", "CLAS ZCL_LIB", "CLAS ZCL_AGIT", "PROG ZTMP_OBJ", "PROG ZLINKED_C", "PROG ZLINKED_D"} {
		if _, ok := rows[key]; !ok {
			t.Fatalf("%s missing from %v", key, rows)
		}
	}
	if _, ok := rows["CLAS ZCL_GONE"]; ok {
		t.Fatal("a library file the tree lacks is listed")
	}
	if rows["CLAS ZCL_AGIT"].PACKAGE != "ZAGIT_INNER" {
		t.Fatalf("declared package: %q", rows["CLAS ZCL_AGIT"].PACKAGE)
	}
}

// every change the index depends on, made behind the store's back, is seen
// on the next call; a content edit needs no walk and is still read fresh
func TestIndexCacheSeesOutsideChanges(t *testing.T) {
	root := indexTree(t)
	listed(t)
	write := func(f, c string) {
		t.Helper()
		full := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	steps := []struct {
		name   string
		change func()
		check  func(map[string]Row) bool
	}{
		{"file added in a subfolder", func() { write("src/sub/znew.prog.abap", "REPORT znew.\n") },
			func(r map[string]Row) bool { _, ok := r["PROG ZNEW"]; return ok }},
		{"folder added", func() { write("src/sub/deep/er/zdeep.prog.abap", "REPORT zdeep.\n") },
			func(r map[string]Row) bool { return r["PROG ZDEEP"].PACKAGE == "$STG_SUB_DEEP_ER" }},
		{"file removed", func() { os.Remove(filepath.Join(root, "src/sub/zprog_b.prog.abap")) },
			func(r map[string]Row) bool { _, ok := r["PROG ZPROG_B"]; return !ok }},
		{"file renamed", func() {
			os.Rename(filepath.Join(root, "src/sub/znew.prog.abap"), filepath.Join(root, "src/sub/zrenamed.prog.abap"))
		}, func(r map[string]Row) bool {
			_, old := r["PROG ZNEW"]
			_, now := r["PROG ZRENAMED"]
			return !old && now
		}},
		{"file added behind a symlink", func() { write("elsewhere/target/deeper/zbehind.prog.abap", "REPORT zbehind.\n") },
			func(r map[string]Row) bool { _, ok := r["PROG ZBEHIND"]; return ok }},
		{"symlink re-pointed", func() {
			write("elsewhere/other/zother.prog.abap", "REPORT zother.\n")
			os.Remove(filepath.Join(root, "src/linked"))
			os.Symlink(filepath.Join(root, "elsewhere", "other"), filepath.Join(root, "src", "linked"))
		}, func(r map[string]Row) bool {
			_, old := r["PROG ZLINKED_C"]
			_, now := r["PROG ZOTHER"]
			return !old && now
		}},
		{"library file appears", func() { write("lib/src/zcl_gone.clas.abap", "CLASS zcl_gone DEFINITION.\nENDCLASS.\n") },
			func(r map[string]Row) bool { _, ok := r["CLAS ZCL_GONE"]; return ok }},
		{"library file disappears", func() { os.Remove(filepath.Join(root, "lib/src/zcl_lib.clas.abap")) },
			func(r map[string]Row) bool { _, ok := r["CLAS ZCL_LIB"]; return !ok }},
		{"declared package edited", func() { write("agit/src/inner/package.devc.xml", "<DEVCLASS>ZAGIT_RENAMED</DEVCLASS>") },
			func(r map[string]Row) bool { return r["CLAS ZCL_AGIT"].PACKAGE == "ZAGIT_RENAMED" }},
		{"declared package removed", func() { os.Remove(filepath.Join(root, "agit/src/inner/package.devc.xml")) },
			func(r map[string]Row) bool { return r["CLAS ZCL_AGIT"].PACKAGE == "ZAGIT_ONE_INNER" }},
	}
	for _, s := range steps {
		s.change()
		settle()
		var rows map[string]Row
		if n := walks(func() { rows = listed(t) }); n != 1 {
			t.Fatalf("%s: %d walks, want 1", s.name, n)
		}
		if !s.check(rows) {
			t.Fatalf("%s: not seen: %v", s.name, rows)
		}
		if n := walks(func() { listed(t) }); n != 0 {
			t.Fatalf("%s: the next call walked again (%d)", s.name, n)
		}
	}
	// tadir.json: the author is part of the index (READ's changedBy)
	write("local/tmp/tadir.json", `{"PROG ZTMP_OBJ":{"author":"beta"}}`)
	settle()
	a := storeCall("IV_COMMAND", "READ", "IV_TYPE", "PROG", "IV_NAME", "ZTMP_OBJ")
	if !strings.Contains(a.Scalars["EV_JSON"], `"changedBy":"BETA"`) {
		t.Fatalf("tadir author not seen: %s", a.Scalars["EV_JSON"])
	}
	// a content edit changes no stamp: no walk, and READ reads the file
	var src string
	write("src/zcl_a.clas.abap", "CLASS zcl_a DEFINITION. \"edited\nENDCLASS.\n")
	if n := walks(func() {
		src = storeCall("IV_COMMAND", "READ", "IV_TYPE", "CLAS", "IV_NAME", "ZCL_A").Scalars["EV_SOURCE"]
	}); n != 0 || !strings.Contains(src, "edited") {
		t.Fatalf("content edit: %d walks, source %q", n, src)
	}
}

// writes through the store bump the revision and drop the index
func TestIndexCacheInvalidatedByStoreWrites(t *testing.T) {
	root := indexTree(t)
	listed(t)
	ops := []struct {
		name string
		op   func() error
	}{
		{"WRITE of a new object", func() error {
			a := storeCall("IV_COMMAND", "WRITE", "IV_TYPE", "PROG", "IV_NAME", "ZWRITTEN", "IV_SOURCE", "REPORT zwritten.\n")
			if a.Scalars["EV_ERROR"] != "" {
				return fmt.Errorf("%s", a.Scalars["EV_ERROR"])
			}
			return nil
		}},
		{"WRITE of an existing one", func() error {
			a := storeCall("IV_COMMAND", "WRITE", "IV_TYPE", "CLAS", "IV_NAME", "ZCL_A", "IV_SOURCE", "CLASS zcl_a DEFINITION.\nENDCLASS.\n*\n")
			if a.Scalars["EV_ERROR"] != "" {
				return fmt.Errorf("%s", a.Scalars["EV_ERROR"])
			}
			return nil
		}},
		{"activation", func() error { return Activate("CLAS", "ZCL_A") }},
		{"CreateSource", func() error { return CreateSource("PROG", "ZCREATED", "$TMP", "x") }},
		{"DeleteSource", func() error { return DeleteSource("PROG", "ZCREATED") }},
	}
	for _, o := range ops {
		if err := o.op(); err != nil {
			t.Fatalf("%s: %v", o.name, err)
		}
		if n := walks(func() { listed(t) }); n != 1 {
			t.Fatalf("%s: %d walks after it, want 1", o.name, n)
		}
	}
	rows := listed(t)
	if _, ok := rows["PROG ZWRITTEN"]; !ok {
		t.Fatal("written object not listed")
	}
	if _, ok := rows["PROG ZCREATED"]; ok {
		t.Fatal("deleted object still listed")
	}
	_ = root
}

// racy stamps and filesystems that are not trusted keep the old behaviour:
// a walk per call
func TestIndexCacheNotTrusted(t *testing.T) {
	indexTree(t)
	storeIndexWindow = time.Hour // every stamp is "recent"
	if n := walks(func() { listed(t); listed(t) }); n != 2 {
		t.Fatalf("racy stamps: %d walks, want 2", n)
	}
	storeIndexWindow = 0
	storeIndexFSType = func(string) (int64, error) { return 0x6969, nil } // NFS
	if n := walks(func() { listed(t); listed(t) }); n != 2 {
		t.Fatalf("NFS: %d walks, want 2", n)
	}
	storeIndexFSType = func(string) (int64, error) { return 0xef53, nil }
	storeIndexWindow = -1 // off
	if n := walks(func() { listed(t); listed(t) }); n != 2 {
		t.Fatalf("off: %d walks, want 2", n)
	}
}

// readers share the store: two READs are inside the store at the same time
func TestReadersRunConcurrently(t *testing.T) {
	indexTree(t)
	listed(t)
	inside := make(chan struct{}, 2)
	release := make(chan struct{})
	storeState.mu.Lock()
	var once sync.Mutex
	entered := 0
	storeIndexBuilt = func(string) {
		once.Lock()
		entered++
		n := entered
		once.Unlock()
		if n <= 2 {
			inside <- struct{}{}
			<-release
		}
	}
	storeState.mu.Unlock()
	defer func() {
		storeState.mu.Lock()
		storeIndexBuilt = nil
		storeState.mu.Unlock()
	}()
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			storeCall("IV_COMMAND", "READ", "IV_TYPE", "CLAS", "IV_NAME", "ZCL_A")
		}()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-inside:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("the second reader could not enter beside the first: reads are serialised")
		}
	}
	close(release)
	wg.Wait()
}

// concurrent readers beside a writer (go test -race): every answer is whole,
// and once the writer is done every object it wrote is listed
func TestIndexCacheConcurrentReadersAndWriter(t *testing.T) {
	root := indexTree(t)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for r := 0; r < 8; r++ {
		wg.Add(1)
		go func(r int) {
			defer wg.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				var a Answer
				switch i % 3 {
				case 0:
					a = storeCall("IV_COMMAND", "READ", "IV_TYPE", "CLAS", "IV_NAME", "ZCL_A")
					if a.Scalars["EV_ERROR"] != "" || !strings.Contains(a.Scalars["EV_SOURCE"], "zcl_a") {
						errs <- fmt.Errorf("reader %d READ: %v", r, a.Scalars)
						return
					}
				case 1:
					a = storeCall("IV_COMMAND", "LIST", "IV_LIMIT", "1000")
					if a.Scalars["EV_ERROR"] != "" || len(a.Objects) < 5 {
						errs <- fmt.Errorf("reader %d LIST: %v", r, a.Scalars)
						return
					}
				default:
					a = storeCall("IV_COMMAND", "OBJECT", "IV_TYPE", "PROG", "IV_NAME", "ZTMP_OBJ")
					if a.Scalars["EV_ERROR"] != "" {
						errs <- fmt.Errorf("reader %d OBJECT: %v", r, a.Scalars)
						return
					}
				}
			}
		}(r)
	}
	var names []string
	for i := 0; i < 15; i++ {
		name := fmt.Sprintf("ZW%02d", i)
		names = append(names, name)
		a := storeCall("IV_COMMAND", "WRITE", "IV_TYPE", "PROG", "IV_NAME", name, "IV_SOURCE", "REPORT "+strings.ToLower(name)+".\n")
		if a.Scalars["EV_ERROR"] != "" {
			t.Fatalf("WRITE %s: %s", name, a.Scalars["EV_ERROR"])
		}
		// and one behind the store's back
		ext := fmt.Sprintf("ZX%02d", i)
		names = append(names, ext)
		if err := os.WriteFile(filepath.Join(root, "src", "sub", strings.ToLower(ext)+".prog.abap"), []byte("REPORT x.\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if i%5 == 0 {
			if err := Activate("PROG", name); err != nil {
				t.Fatal(err)
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	settle()
	close(stop)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	rows := listed(t)
	for _, n := range names {
		if _, ok := rows["PROG "+n]; !ok {
			t.Fatalf("%s not listed after the writer finished", n)
		}
	}
}
