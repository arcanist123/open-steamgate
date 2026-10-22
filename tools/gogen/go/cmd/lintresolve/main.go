// lintresolve is a build/test oracle driver; the runtime calls the package.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"osg/gogen/lintresolve"
)

func main() {
	var rules lintresolve.Rules
	if err := json.NewDecoder(os.Stdin).Decode(&rules); err != nil {
		fail(err)
	}
	if len(os.Args) > 1 && os.Args[1] == "--validate" {
		for _, s := range rules.Excluded {
			if _, err := lintresolve.Compile(s, false); err != nil {
				fail(err)
			}
		}
		for _, l := range rules.Libraries {
			for _, s := range l.Excluded {
				if _, err := lintresolve.Compile(s, true); err != nil {
					fail(err)
				}
			}
		}
		return
	}
	if len(os.Args) != 2 {
		fail(fmt.Errorf("usage: lintresolve ROOT < rules.json"))
	}
	facts, err := lintresolve.Resolve(os.Args[1], &rules)
	if err != nil {
		fail(err)
	}
	facts.Rules = nil
	if err := json.NewEncoder(os.Stdout).Encode(facts); err != nil {
		fail(err)
	}
}
func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
