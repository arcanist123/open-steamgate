package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"

	"osg/gogen/diagnative"
	"osg/gogen/rfcnative"
)

type nativeProtocols struct{ rfc, diag *bool }

func protocolFlags() nativeProtocols {
	return nativeProtocols{
		rfc:  flag.Bool("rfc", false, "native RFC-to-ADT on 33nn (also OSD_OSGO_RFC=1; requires -adt)"),
		diag: flag.Bool("diag", false, "native DIAG tape on 32nn (also OSD_OSGO_DIAG=1)"),
	}
}

func (p nativeProtocols) start(sid string, adt bool, binds []string, handler http.Handler) (int, int) {
	rfc, err := rfcnative.FromEnv(*p.rfc, sid, os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	if rfc.Enabled && !adt {
		log.Fatal("-rfc requires -adt / OSD_OSGO_ADT=1")
	}
	diag, err := diagnative.Port(*p.diag, os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	if err := rfcnative.Start(context.Background(), rfc, binds, handler, log.Printf); err != nil {
		log.Fatal(err)
	}
	if err := diagnative.Start(context.Background(), diag, sid, binds, log.Printf); err != nil {
		log.Fatal(err)
	}
	if !rfc.Enabled {
		rfc.Port = -1
	}
	return rfc.Port, diag
}
