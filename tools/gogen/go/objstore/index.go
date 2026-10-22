package objstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// The index of the tree: object types and their files, the package chain of
// a file, the walk, the version of an object by its digest, and the order
// JavaScript's localeCompare gives names.

// the object types, in the order the Node store tries them (osd-store.mjs TYPES)
var storeTypes = []struct {
	Type, Ext  string
	SameFileAs string
	Source     bool
}{
	{"CLAS", ".clas.abap", "", true}, {"INTF", ".intf.abap", "", true}, {"PROG", ".prog.abap", "", true},
	{"FUGR", ".fugr.xml", "", false}, {"TABL", ".tabl.xml", "", false}, {"DTEL", ".dtel.xml", "", false},
	{"DOMA", ".doma.xml", "", false}, {"TTYP", ".ttyp.xml", "", false}, {"DDLS", ".ddls.asddls", "", true},
	{"SRVD", ".srvd.srvdsrv", "", true}, {"VIEW", ".view.xml", "", false}, {"SHLP", ".shlp.xml", "", false},
	{"MSAG", ".msag.xml", "", false}, {"SICF", ".sicf.xml", "", false}, {"SAPC", ".sapc.xml", "", false},
	{"SAMC", ".samc.xml", "", false}, {"DEVC", ".devc.xml", "", false}, {"INCL", ".prog.abap", "PROG", true},
}

func storeTypeExt(t string) (string, bool) {
	for _, x := range storeTypes {
		if x.Type == t {
			return x.Ext, true
		}
	}
	return "", false
}

func storeTypeSource(t string) (bool, bool) {
	if t == "STRU" {
		return false, true
	}
	for _, x := range storeTypes {
		if x.Type == t {
			return x.Source, true
		}
	}
	return false, false
}

// a class's parts, by the suffix abapGit gives them (osd-store.mjs INCLUDES)
var storeIncludes = []struct{ Name, Suffix string }{
	{"main", ".clas.abap"}, {"definitions", ".clas.locals_def.abap"}, {"implementations", ".clas.locals_imp.abap"},
	{"macros", ".clas.macros.abap"}, {"testclasses", ".clas.testclasses.abap"},
}

func storeIncludeSuffix(include string) (string, bool) {
	for _, x := range storeIncludes {
		if x.Name == include {
			return x.Suffix, true
		}
	}
	return "", false
}

// the packages of the tree's own layout (osd-store.mjs ROOT_PACKAGES,
// FOLDER_PACKAGES); a pack names its own and a library's comes from its path
var storeRootPackages = map[string]string{"src": "$STG", "local": "$OSD", "test": "$STG_TEST", "gen": "$STG_GEN"}
var storeFolderPackages = []struct{ Folder, Package string }{{"src/zosd_test", "$ZOSD_TEST"}}

var storeNotWord = regexp.MustCompile(`[^A-Z0-9]+`)

func storePackageWord(s string) string { return storeNotWord.ReplaceAllString(strings.ToUpper(s), "_") }

func storeFileOf(name string) string {
	return strings.ReplaceAll(strings.ToLower(name), "/", "#")
}

func storeNameOf(file string) string {
	return strings.ReplaceAll(strings.ToUpper(file), "#", "/")
}

// the chain of packages a file sits in (osd-store.mjs #packagesOf)
func storePackagesOf(file string, root Root) []string {
	if root.Tmp {
		chain := []string{root.Package}
		inside := strings.Split(strings.TrimPrefix(file, root.Path+"/"), "/")
		if len(inside) > 0 {
			inside = inside[:len(inside)-1]
		}
		for _, folder := range inside {
			upper := strings.ToUpper(folder)
			if strings.HasPrefix(upper, "$") && storeTmpChildName.MatchString(upper) {
				chain = append(chain, upper)
			} else {
				chain = append(chain, chain[len(chain)-1]+"_"+storeNotWord.ReplaceAllString(upper, "_"))
			}
		}
		return chain
	}
	if root.Abapgit != nil {
		inside := strings.Split(strings.TrimPrefix(file, root.Path+"/"), "/")
		if len(inside) > 0 {
			inside = inside[:len(inside)-1]
		}
		chain := []string{root.Package}
		at := root.Path
		for _, folder := range inside {
			if folder == "" || folder == "." {
				continue
			}
			at += "/" + folder
			declared := storeDeclaredPackage(at)
			if declared != "" {
				chain = append(chain, declared)
			} else if root.Abapgit.FolderLogic == "FULL" {
				chain = append(chain, strings.ToUpper(folder))
			} else {
				chain = append(chain, chain[len(chain)-1]+"_"+strings.ToUpper(folder))
			}
		}
		return chain
	}
	own := ""
	for _, f := range storeFolderPackages {
		if strings.HasPrefix(file, f.Folder+"/") {
			own = f.Folder
			break
		}
	}
	var bases []string
	switch {
	case own != "":
		for _, f := range storeFolderPackages {
			if f.Folder == own {
				bases = []string{f.Package}
			}
		}
	case root.Package != "":
		bases = []string{root.Package}
	case storeRootPackages[root.Path] != "":
		bases = []string{storeRootPackages[root.Path]}
	case strings.HasPrefix(root.Path, "local/"):
		bases = []string{storeRootPackages["local"], storeRootPackages["local"] + "_" + storePackageWord(root.Path[len("local/"):])}
	default:
		last := root.Path
		for _, p := range strings.Split(root.Path, "/") {
			if p != "src" && p != "." && p != ".local" && p != "lars" {
				last = p
			}
		}
		bases = []string{"$" + storePackageWord(last)}
	}
	from := root.Path
	if own != "" {
		from = own
	}
	var inside []string
	for _, p := range strings.Split(file[min(len(from), len(file)):], "/") {
		if p != "" {
			inside = append(inside, p)
		}
	}
	if len(inside) > 0 {
		inside = inside[:len(inside)-1]
	}
	chain := append([]string{}, bases...)
	for _, folder := range inside {
		chain = append(chain, chain[len(chain)-1]+"_"+storeNotWord.ReplaceAllString(strings.ToUpper(folder), "_"))
	}
	return chain
}

var storeTmpChildName = regexp.MustCompile(`^\$[A-Z0-9_]+$`)
var storePackageTag = regexp.MustCompile(`(?i)<(?:DEVCLASS|PACKAGE)>([^<]*)</(?:DEVCLASS|PACKAGE)>`)

func storeDeclaredPackage(dir string) string {
	b, err := os.ReadFile(filepath.Join(storeState.root, dir, "package.devc.xml"))
	if err != nil {
		return ""
	}
	match := storePackageTag.FindStringSubmatch(string(b))
	if match == nil {
		return ""
	}
	return strings.ToUpper(match[1])
}

// the files under one root, sorted, the build's exclusions left out
// (osd-store.mjs #walk)
func storeWalk(base, dir string, out []string) []string {
	entries, err := os.ReadDir(filepath.Join(base, dir))
	if err != nil {
		return out
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		if name == "node_modules" || name == ".git" {
			continue
		}
		rel := filepath.ToSlash(filepath.Join(dir, name))
		st, err := os.Stat(filepath.Join(base, rel))
		if err != nil {
			continue
		}
		if st.IsDir() {
			out = storeWalk(base, rel, out)
			continue
		}
		skip := false
		for _, re := range storeState.excluded {
			if re.MatchString("/" + rel) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, rel)
		}
	}
	return out
}

type storeIndex struct {
	keys []string
	by   map[string]*storeEntry
}

func (ix *storeIndex) set(key string, e *storeEntry) {
	if _, ok := ix.by[key]; !ok {
		ix.keys = append(ix.keys, key)
	}
	ix.by[key] = e
}

// every object of every root, by type and name (osd-store.mjs build). Built
// again for every call: the walk is milliseconds, and a file an editor or a
// git pull changed is then never answered from a stale index.
func storeBuild() *storeIndex { return storeBuildFor("") }

// A nonempty target filters enumeration before per-object stat/package work.
func storeBuildFor(target string) *storeIndex {
	ix := &storeIndex{by: map[string]*storeEntry{}}
	cfg := storeState.cfg
	roots := append(append([]Root{}, cfg.Roots...), cfg.Libs...)
	for _, root := range roots {
		files := root.Files
		if !root.Library {
			if target == "" {
				files = storeWalk(storeState.root, root.Path, nil)
			} else {
				files = storeTargetWalk(storeState.root, root.Path, target, nil)
			}
		}
		for _, file := range files {
			if target != "" && !storeTargetMatches(filepath.Base(file), target) {
				continue
			}
			name := file[strings.LastIndex(file, "/")+1:]
			for _, t := range storeTypes {
				if !strings.HasSuffix(name, t.Ext) || t.SameFileAs != "" {
					continue
				}
				if root.Library {
					// a library file the build listed and this tree does not
					// have (a copied tree without the clones) is no object
					if _, err := os.Stat(filepath.Join(storeState.root, file)); err != nil {
						break
					}
				}
				chain := storePackagesOf(file, root)
				objectName := storeNameOf(name[:len(name)-len(t.Ext)])
				if t.Type == "DEVC" && name == "package.devc.xml" {
					objectName = chain[len(chain)-1]
				}
				key := t.Type + " " + objectName
				if _, has := ix.by[key]; !root.Library || !has {
					own := t.Type == "DEVC" && objectName == chain[len(chain)-1]
					home := chain
					if own && len(chain) > 1 {
						home = chain[:len(chain)-1]
					}
					ix.set(key, &storeEntry{Type: t.Type, Name: objectName, File: file, Root: root.Path,
						Writable: root.Writable, Library: root.Library, Imported: root.Imported, Overlay: root.Overlay,
						Package: home[len(home)-1], Packages: home})
				}
				break
			}
		}
	}
	storeIndexTmp(ix)
	return ix
}

func storeIndexTmp(ix *storeIndex) {
	if ix.by["DEVC $TMP"] == nil {
		ix.set("DEVC $TMP", &storeEntry{Type: "DEVC", Name: "$TMP", File: "local/tmp/package.devc.xml",
			Root: "local/tmp", Writable: true, Package: "$TMP", Packages: []string{"$TMP"}, Synthetic: true})
	}
	var authors map[string]struct {
		Author string `json:"author"`
	}
	if b, err := os.ReadFile(filepath.Join(storeState.root, "local", "tmp", "tadir.json")); err == nil {
		_ = json.Unmarshal(b, &authors)
	}
	for _, key := range ix.keys {
		e := ix.by[key]
		if e.Root == "local/tmp" {
			if a := authors[e.Type+" "+e.Name]; a.Author != "" {
				e.ChangedBy = strings.ToUpper(a.Author)
			}
		}
	}
}

func (ix *storeIndex) find(typ, name string) *storeEntry {
	key := strings.ToUpper(name)
	if e, ok := ix.by[typ+" "+key]; ok {
		return e
	}
	if typ == "INCL" {
		if p, ok := ix.by["PROG "+key]; ok {
			c := *p
			c.Type = "INCL"
			return &c
		}
		return nil
	}
	if typ == "STRU" {
		t, ok := ix.by["TABL "+key]
		if !ok {
			return nil
		}
		b, err := os.ReadFile(filepath.Join(storeState.root, t.File))
		if err != nil || !strings.Contains(string(b), "<TABCLASS>INTTAB</TABCLASS>") {
			return nil
		}
		c := *t
		c.Type = "STRU"
		return &c
	}
	return nil
}

// the name after `define ... view|entity|table function`, comments skipped
// (tools/ddls-entity.mjs)
var storeDefines = regexp.MustCompile(`(?i)\bdefine\s+(?:root\s+)?(?:table\s+function|table\s+entity|hierarchy|transient\s+view\s+entity|view\s+entity|view|abstract\s+entity|custom\s+entity)\s+([\w/]+)`)

func storeStripComments(text string) string {
	var out strings.Builder
	for i := 0; i < len(text); {
		ch := text[i]
		switch {
		case ch == '\'':
			end := strings.IndexByte(text[i+1:], '\'')
			stop := len(text)
			if end >= 0 {
				stop = i + 1 + end + 1
			}
			out.WriteString(text[i:stop])
			i = stop
		case ch == '/' && i+1 < len(text) && text[i+1] == '*':
			end := strings.Index(text[i+2:], "*/")
			if end < 0 {
				i = len(text)
			} else {
				i = i + 2 + end + 2
			}
			out.WriteByte(' ')
		case (ch == '/' && i+1 < len(text) && text[i+1] == '/') || (ch == '-' && i+1 < len(text) && text[i+1] == '-'):
			end := strings.IndexByte(text[i:], '\n')
			if end < 0 {
				i = len(text)
			} else {
				i += end
			}
			out.WriteByte(' ')
		default:
			out.WriteByte(ch)
			i++
		}
	}
	return out.String()
}

// a DDLS by the entity it defines, when that is not its object name; two
// sources defining one entity are neither taken (osd-store.mjs #ddlsEntities)
func (ix *storeIndex) ddlsEntity(name string) *storeEntry {
	by := map[string]*storeEntry{}
	twice := map[string]bool{}
	for _, k := range ix.keys {
		e := ix.by[k]
		if e.Type != "DDLS" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(storeState.root, e.File))
		if err != nil {
			continue
		}
		m := storeDefines.FindStringSubmatch(storeStripComments(string(b)))
		if m == nil || strings.ToUpper(m[1]) == strings.ToUpper(e.Name) {
			continue
		}
		entity := strings.ToUpper(m[1])
		if _, ok := by[entity]; ok {
			twice[entity] = true
		}
		by[entity] = e
	}
	if twice[strings.ToUpper(name)] {
		return nil
	}
	return by[strings.ToUpper(name)]
}

// the files of an object whose digest decides its version
func storeFilesOf(e *storeEntry) []string {
	if e.Type != "CLAS" {
		return []string{e.File}
	}
	var out []string
	for _, inc := range storeIncludes {
		out = append(out, strings.TrimSuffix(e.File, ".clas.abap")+inc.Suffix)
	}
	return out
}

func storeDigest(file string) string {
	b, err := os.ReadFile(filepath.Join(storeState.root, file))
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func storeActiveBytes(file string) ([]byte, bool) {
	if storeState.cfg == nil || storeState.cfg.Active == nil {
		return nil, false
	}
	path, ok := storeState.cfg.Active[file]
	if !ok {
		return nil, false
	}
	b, err := os.ReadFile(filepath.Join(storeState.root, filepath.FromSlash(path)))
	if err != nil {
		return nil, false
	}
	if digest, ok := storeState.cfg.Built[file]; ok && len(digest) == 64 && storeDigestBytes(b) == digest {
		return b, true
	}
	return nil, false
}

func storeDigestBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func storeWritable(e *storeEntry) bool {
	return e.Writable || e.Overlay != ""
}

var storeSourceTypes = map[string]bool{
	"CLAS": true, "INTF": true, "PROG": true, "DDLS": true, "SRVD": true, "INCL": true,
}

// active or inactive, and the file's time (osd-store.mjs stateOf)
func storeStateOf(e *storeEntry, file string) (version, changedAt string) {
	if st, err := os.Stat(filepath.Join(storeState.root, file)); err == nil {
		changedAt = st.ModTime().UTC().Format("2006-01-02T15:04:05Z")
	}
	version = "active"
	if storeState.written[e.Type+" "+e.Name] {
		version = "inactive"
	} else if storeSourceTypes[e.Type] {
		if len(storeState.cfg.Active) == 0 {
			version = "inactive"
		} else {
			version = "active"
		}
	}
	if storeSourceTypes[e.Type] && version == "active" {
		for _, f := range storeFilesOf(e) {
			working := storeDigest(f)
			bytes, proven := storeActiveBytes(f)
			if working != "" && (!proven || working != storeDigestBytes(bytes)) || working == "" && proven && len(bytes) != 0 {
				version = "inactive"
				break
			}
		}
	}
	return
}

// collateLess is JavaScript's a.localeCompare(b) < 0 for object names: ICU's
// root collation, where punctuation sorts before symbols, symbols before
// digits, digits before letters, and case only breaks a tie (a before A)
func collateLess(a, b string) bool { return collate(a, b) < 0 }

const collatePunct = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~"

func collateWeight(r rune) (int, int) {
	switch {
	case r == ' ':
		return 1, 0
	case strings.ContainsRune(collatePunct, r):
		return 10 + strings.IndexRune(collatePunct, r), 0
	case r == '$':
		return 100, 0
	case r >= '0' && r <= '9':
		return 200 + int(r-'0'), 0
	case r >= 'a' && r <= 'z':
		return 300 + int(r-'a'), 0
	case r >= 'A' && r <= 'Z':
		return 300 + int(r-'A'), 1
	}
	return 1000 + int(r), 0
}

func collate(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	tie := 0
	for i := 0; i < len(ra) && i < len(rb); i++ {
		pa, ta := collateWeight(ra[i])
		pb, tb := collateWeight(rb[i])
		if pa != pb {
			if pa < pb {
				return -1
			}
			return 1
		}
		if tie == 0 && ta != tb {
			if ta < tb {
				tie = -1
			} else {
				tie = 1
			}
		}
	}
	if len(ra) != len(rb) {
		if len(ra) < len(rb) {
			return -1
		}
		return 1
	}
	return tie
}
