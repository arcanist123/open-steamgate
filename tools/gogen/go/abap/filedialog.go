package abap

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"unsafe"
)

type FrontendPickOptions struct {
	Kind, Initial, Name, Title string
	Filter, Extension, Prompt  string
}

var ErrFrontendPickCancel = errors.New("file dialog cancelled")

// FrontendPick is installed only while a terminal selection form is active.
// Outside that form (including batch and SAP GUI) dialogs refuse explicitly.
var FrontendPick func(FrontendPickOptions) (string, error)

func frontendPick(method string, options FrontendPickOptions) (string, error) {
	if FrontendPick == nil {
		panic(ClassicException{Name: "ERROR_NO_GUI", Method: method})
	}
	return FrontendPick(options)
}

func FrontendFileOpenDialog(_ *Session, title, name, filter, extension, initial, multi string, table any, rc, action *int32) {
	*rc, *action = 0, 9
	rows := reflect.ValueOf(table).Elem()
	rows.Set(reflect.MakeSlice(rows.Type(), 0, 1))
	kind := "open"
	if strings.EqualFold(strings.TrimSpace(multi), "X") {
		kind = "open-multiple"
	}
	path, err := frontendPick("FILE_OPEN_DIALOG", FrontendPickOptions{Kind: kind, Initial: initial, Name: name, Title: title, Filter: filter, Extension: extension})
	if err != nil {
		if !errors.Is(err, ErrFrontendPickCancel) {
			*rc = -1
		}
		return
	}
	if path == "" {
		return
	}
	for _, selected := range strings.Split(path, "\x00") {
		row := reflect.New(rows.Type().Elem()).Elem()
		field := row.FieldByNameFunc(func(n string) bool { return strings.EqualFold(n, "filename") })
		// The generated FILE_TABLE field: filename, Filename in a layered build (tools/gogen/go-layers.mjs).
		reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem().SetString(selected)
		rows.Set(reflect.Append(rows, row))
	}
	*rc, *action = int32(rows.Len()), 0
}

func FrontendFileSaveDialog(_ *Session, title, name, filter, extension, initial, prompt string, filename, dir, fullpath *string, action *int32) {
	*action = 9
	path, err := frontendPick("FILE_SAVE_DIALOG", FrontendPickOptions{Kind: "save", Initial: initial, Name: name, Title: title, Filter: filter, Extension: extension, Prompt: prompt})
	if err != nil || path == "" {
		return
	}
	*filename, *dir, *fullpath, *action = filepath.Base(path), filepath.Dir(path), path, 0
}

func FrontendDirectoryBrowse(_ *Session, title, initial string, selected *string) {
	path, err := frontendPick("DIRECTORY_BROWSE", FrontendPickOptions{Kind: "directory", Initial: initial, Title: title})
	if err == nil && path != "" {
		*selected = path
	}
}

func F4_FILENAME(_ *Session, args map[string]Data) {
	path, err := frontendPick("F4_FILENAME", FrontendPickOptions{Kind: "open"})
	if err != nil || path == "" {
		return
	}
	if target, exists := args["FILE_NAME"]; exists {
		MoveData(target, Data{P: &path, T: TString})
	}
}

func KD_GET_FILENAME_ON_F4(_ *Session, args map[string]Data) {
	target, exists := args["FILE_NAME"]
	if !exists {
		return
	}
	// MASK is accepted by the classic signature but this terminal browser
	// does not implement SAP GUI's mask syntax.
	path, err := frontendPick("KD_GET_FILENAME_ON_F4", FrontendPickOptions{Kind: "open", Name: strings.TrimSpace(DataString(target))})
	if err == nil && path != "" {
		MoveData(target, Data{P: &path, T: TString})
	}
}
