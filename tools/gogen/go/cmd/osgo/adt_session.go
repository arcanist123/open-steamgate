package main

import (
	"osg/gogen/abap"
	"osg/gogen/adtactivate"
	"osg/gogen/adtread"
	"osg/gogen/adtunit"
	"osg/gogen/adtwrite"
	"strings"
	"sync"
)

var adtWriteSessions sync.Map

// completeADTWrite runs before the request releases its dialog-step lock:
// the host's writes (adtwrite), activation (adtactivate), ABAP Unit
// (adtunit), then its read-only routes (adtread).
func completeADTWrite(s *abap.Session, x *abap.ICFExchange) {
	host := false
	for _, h := range x.RespHeaders {
		if strings.EqualFold(h[0], "x-osd-served-by") && h[1] == "HOST" {
			host = true
		}
	}
	if !host {
		return
	}
	var response adtwrite.Response
	handled := false
	if provider, ok := adtWriteSessions.Load(s); ok {
		_, query, _ := strings.Cut(x.URL, "?")
		response, handled = adtwrite.Serve(adtwrite.Request{Method: x.Method, Path: x.Path, Query: query, Headers: x.Headers, Body: x.Body}, provider.(adtwrite.Session))
	}
	if !handled {
		_, query, _ := strings.Cut(x.URL, "?")
		var activation adtactivate.Response
		if activation, handled = adtactivate.Default.Serve(adtactivate.Request{Method: x.Method, Path: x.Path, Query: query, Headers: x.Headers, Body: x.Body}); handled {
			response = adtwrite.Response(activation)
		}
	}
	if !handled {
		var unit adtunit.Response
		if unit, handled = adtUnitHost().Serve(adtunit.Request{Method: x.Method, Path: x.Path, Headers: x.Headers, Body: x.Body}); handled {
			response = adtwrite.Response(unit)
		}
	}
	if !handled {
		var read adtread.Response
		if read, handled = adtread.Serve(adtread.Request{Method: x.Method, Path: x.Path, Headers: x.Headers}); !handled {
			return
		}
		response = adtwrite.Response(read)
	}
	kept := x.RespHeaders[:0]
	for _, h := range x.RespHeaders {
		if strings.EqualFold(h[0], "set-cookie") || strings.EqualFold(h[0], "x-csrf-token") {
			kept = append(kept, h)
		}
	}
	x.RespHeaders = append(kept, response.Headers...)
	x.RespHeaders = append(x.RespHeaders, [2]string{"x-osd-served-by", "HOST"})
	x.Status, x.RespBody, x.Sent = response.Status, response.Body, true
}

// osgo.mjs installs the generated adapter only when both ADT classes exist.
// The fallback and host lifecycle require no generated ADT types.
var bindADTSession = func(s *abap.Session) func() { return func() {} }
var hasADTSession bool

func withADTSession(s *abap.Session, work func()) {
	started := adtHost.Begin(s)
	defer func() {
		if started {
			recovered := recover()
			dumped := recovered != nil
			adtHost.Finish(s, dumped)
			if dumped {
				panic(recovered)
			}
		}
	}()
	clear := bindADTSession(s)
	defer clear()
	work()
}
