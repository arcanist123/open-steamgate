// The harness of the Go backend spike: cases in on stdin as JSON, one
// result per case out as JSON. Each case runs once to warm up and then
// `repeat` times, each timed on its own, in a fresh Session.
package main

import (
	"encoding/json"
	"os"
	"sync"
	"time"

	"osg/gogen/abap"
)

type testCase struct {
	Name   string    `json:"name"`
	Method string    `json:"method"`
	Args   []float64 `json:"args"`
	Repeat int       `json:"repeat"`
	// Parallel > 0: run Repeat calls spread over Parallel goroutines, one
	// Session each, and report the wall time of the whole batch -- the
	// dispatcher-and-work-processes question, not the single-call one
	Parallel int `json:"parallel"`
}

type result struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Error string  `json:"error,omitempty"`
	Ns    []int64 `json:"ns"`
	Wall  int64   `json:"wallNs,omitempty"`
}

func run(c testCase) (v float64, err string) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(abap.ArithmeticError); ok {
				err = e.Class
				if e.Detail != "" {
					err += " [" + e.Detail + "]"
				}
				return
			}
			err = abap.DumpText(r)
		}
	}()
	return Call(c.Method, &abap.Session{}, c.Args), ""
}

func main() {
	var cases []testCase
	if err := json.NewDecoder(os.Stdin).Decode(&cases); err != nil {
		panic(err)
	}
	out := make([]result, 0, len(cases))
	for _, c := range cases {
		v, e := run(c)
		r := result{Name: c.Name, Value: v, Error: e}
		if c.Parallel > 0 {
			var wg sync.WaitGroup
			per := c.Repeat / c.Parallel
			t := time.Now()
			for g := 0; g < c.Parallel; g++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for i := 0; i < per; i++ {
						run(c)
					}
				}()
			}
			wg.Wait()
			r.Wall = time.Since(t).Nanoseconds()
			out = append(out, r)
			continue
		}
		for i := 0; i < c.Repeat; i++ {
			t := time.Now()
			run(c)
			r.Ns = append(r.Ns, time.Since(t).Nanoseconds())
		}
		out = append(out, r)
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
