package objstore

import (
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// MutationError carries a stable refusal code to the host protocol adapter.
type MutationError struct{ Code, Message string }

func (e *MutationError) Error() string         { return e.Message }
func mutationError(code, message string) error { return &MutationError{code, message} }

// safeMutationPath rejects links in every existing path component, including
// the source file. Lexical confinement alone cannot protect a writable root.
func safeMutationPath(file string) error {
	if !storeConfined(file) {
		return mutationError("READ_ONLY", "path is outside writable roots")
	}
	current := storeState.root
	for _, part := range strings.Split(filepath.ToSlash(filepath.Clean(file)), "/") {
		current = filepath.Join(current, part)
		st, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return mutationError("READ_ONLY", "source mutation through a symbolic link is refused")
		}
	}
	return nil
}

var mutationName = regexp.MustCompile(`^(/[A-Z0-9_]{1,10}/)?[A-Z0-9_]{1,30}$`)
var mutationProgramName = regexp.MustCompile(`^(/[A-Z0-9_]{1,10}/)?[A-Z0-9_]{1,40}$`)

// CreateSource creates a source skeleton and its abapGit metadata in an
// existing writable package. Only classes have an initially active skeleton,
// matching the JS ADT create contract; this is not executable activation.
func CreateSource(typ, name, home, description string) error {
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	if storeState.cfg == nil {
		return mutationError("NOT_SUPPORTED", "no object store here")
	}
	name, home = strings.ToUpper(name), strings.ToUpper(home)
	if typ != "CLAS" && typ != "INTF" && typ != "PROG" {
		return mutationError("NOT_SUPPORTED", "unsupported create type")
	}
	pattern := mutationName
	if typ == "PROG" {
		pattern = mutationProgramName
	}
	if !pattern.MatchString(name) {
		return mutationError("INVALID_NAME", "invalid repository name")
	}
	ix := storeBuild()
	if ix.find(typ, name) != nil {
		return mutationError("CONFLICT", typ+" "+name+" already exists")
	}
	parent := ix.find("DEVC", home)
	if parent == nil {
		return mutationError("NOT_FOUND", "package does not exist")
	}
	if !parent.Writable {
		return mutationError("READ_ONLY", "package cannot be changed here")
	}
	ext, _ := storeTypeExt(typ)
	file := filepath.ToSlash(filepath.Join(filepath.Dir(parent.File), storeFileOf(name)+ext))
	header := strings.TrimSuffix(file, ".abap") + ".xml"
	for _, f := range []string{file, header} {
		if err := safeMutationPath(f); err != nil {
			return err
		}
		if _, err := os.Lstat(filepath.Join(storeState.root, f)); err == nil {
			return mutationError("CONFLICT", "object file already exists")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	lower := strings.ToLower(name)
	source, inner := "", ""
	var escaped strings.Builder
	_ = xml.EscapeText(&escaped, []byte(description))
	switch typ {
	case "CLAS":
		source = fmt.Sprintf("CLASS %s DEFINITION PUBLIC CREATE PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\n\nCLASS %s IMPLEMENTATION.\nENDCLASS.\n", lower, lower)
		inner = fmt.Sprintf("<VSEOCLASS><CLSNAME>%s</CLSNAME><LANGU>E</LANGU><DESCRIPT>%s</DESCRIPT><STATE>1</STATE><CLSCCINCL>X</CLSCCINCL><FIXPT>X</FIXPT><UNICODE>X</UNICODE></VSEOCLASS>", name, escaped.String())
	case "INTF":
		source = fmt.Sprintf("INTERFACE %s PUBLIC.\nENDINTERFACE.\n", lower)
		inner = fmt.Sprintf("<VSEOINTERF><CLSNAME>%s</CLSNAME><LANGU>E</LANGU><DESCRIPT>%s</DESCRIPT><EXPOSURE>2</EXPOSURE><STATE>1</STATE><UNICODE>X</UNICODE></VSEOINTERF>", name, escaped.String())
	case "PROG":
		source = fmt.Sprintf("REPORT %s.\n", lower)
		inner = fmt.Sprintf("<PROGDIR><NAME>%s</NAME><DBAPL>S</DBAPL><SUBC>1</SUBC><FIXPT>X</FIXPT><LDBNAME>D$S</LDBNAME><UCCHECK>X</UCCHECK></PROGDIR>", name)
	}
	metadata := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<abapGit version=\"v1.0.0\" serializer=\"LCL_OBJECT_%s\" serializer_version=\"v1.0.0\"><asx:abap xmlns:asx=\"http://www.sap.com/abapxml\" version=\"1.0\"><asx:values>%s</asx:values></asx:abap></abapGit>\n", typ, inner)
	if err := os.MkdirAll(filepath.Dir(filepath.Join(storeState.root, file)), 0755); err != nil {
		return err
	}
	writeNew := func(f, content string) error {
		out, err := os.OpenFile(filepath.Join(storeState.root, f), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return err
		}
		_, err = out.WriteString(content)
		closeErr := out.Close()
		if err != nil {
			return err
		}
		return closeErr
	}
	if err := writeNew(header, metadata); err != nil {
		return err
	}
	if err := writeNew(file, source); err != nil {
		_ = os.Remove(filepath.Join(storeState.root, header))
		return err
	}
	if typ == "CLAS" {
		if storeState.createdActive == nil {
			storeState.createdActive = map[string][]byte{}
		}
		storeState.createdActive[file] = []byte(source)
	}
	storeState.written[typ+" "+name] = true
	storeState.revision++
	return nil
}

// DeleteSource removes only the object's source, known includes and metadata.
// The host must validate ownership under its dialog-step lock before calling.
func DeleteSource(typ, name string) error {
	if typ != "CLAS" && typ != "INTF" && typ != "PROG" {
		return mutationError("NOT_SUPPORTED", "unsupported delete type")
	}
	storeState.mu.Lock()
	defer storeState.mu.Unlock()
	if storeState.cfg == nil {
		return mutationError("NOT_SUPPORTED", "no object store here")
	}
	e := storeBuild().find(typ, strings.ToUpper(name))
	if e == nil {
		return mutationError("NOT_FOUND", "object does not exist")
	}
	if !e.Writable {
		return mutationError("READ_ONLY", "object cannot be changed here")
	}
	files := storeFilesOf(e)
	files = append(files, strings.TrimSuffix(e.File, ".abap")+".xml")
	for _, f := range files {
		if err := safeMutationPath(f); err != nil {
			return err
		}
	}
	for _, f := range files {
		if err := os.Remove(filepath.Join(storeState.root, f)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		delete(storeState.createdActive, f)
		delete(storeState.publishedSnapshot, f)
		// Detach this identity from the old generation; keep its immutable files.
		delete(storeState.cfg.Active, f)
		delete(storeState.cfg.Built, f)
	}
	delete(storeState.written, typ+" "+strings.ToUpper(name))
	storeState.revision++
	return nil
}
