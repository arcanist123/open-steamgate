// Scripted session using the dependency's public RFC client.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/oisee/open-rfc-go/rfc"
)

func main() {
	if run() {
		os.Exit(1)
	}
}

func run() bool {
	port, err := strconv.Atoi(os.Args[1])
	if err != nil {
		panic(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, err := rfc.Open(ctx, rfc.Destination{Host: "127.0.0.1", Port: port, Service: fmt.Sprintf("sapdp%02d", port%100), Client: "001", User: "DEVELOPER", Password: "demo", Language: "E", OperationTimeout: 5 * time.Second})
	if err != nil {
		fmt.Printf("open: %v\n", err)
		return true
	}
	defer c.Close(context.Background())
	s, err := c.Pin(ctx)
	if err != nil {
		panic(err)
	}
	defer s.Close()
	failed := false
	for _, request := range []struct{ path, method, body string }{
		{"/sap/bc/adt/discovery", "GET", ""},
		{"/sap/bc/adt/checkruns?reporters=abapCheckRun", "POST", `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`},
	} {
		result, err := s.Call(ctx, "SADT_REST_RFC_ENDPOINT", rfc.Params{"REQUEST": map[string]any{
			"REQUEST_LINE":  map[string]any{"METHOD": request.method, "URI": request.path, "VERSION": "HTTP/1.1"},
			"HEADER_FIELDS": []map[string]any{{"NAME": "Content-Type", "VALUE": "application/xml"}},
			"MESSAGE_BODY":  []byte(request.body),
		}})
		if err != nil {
			fmt.Printf("%s: %v\n", request.path, err)
			failed = true
			continue
		}
		raw, _ := json.Marshal(result)
		fmt.Println(string(raw))
	}
	return failed
}
