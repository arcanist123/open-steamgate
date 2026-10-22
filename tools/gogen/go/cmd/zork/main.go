// Zork through the compiled ZCL_ORK_00_SPEEDRUN: the story and the commands
// in, the result and the log as JSON out (tools/gogen/zork.mjs runs it).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"osg/gogen/abap"
	"osg/gogen/castdiag"
)

func main() {
	story, _ := os.ReadFile(os.Args[1])
	var commands []string
	raw, _ := os.ReadFile(os.Args[2])
	json.Unmarshal(raw, &commands)
	out := map[string]any{}
	func() {
		defer func() {
			if r := recover(); r != nil {
				out["error"] = castdiag.DumpText(r)
			}
		}()
		if seed := os.Getenv("ZORK_SEED"); seed != "" {
			var n uint32
			fmt.Sscan(seed, &n)
			abap.SeedRandom(n)
		}
		s := &abap.Session{}
		t := time.Now()
		sr := New_ZCL_ORK_00_SPEEDRUN(s, string(story), &commands)
		res := sr.RUN(s)
		out["ms"] = float64(time.Since(t).Microseconds()) / 1000
		out["result"] = map[string]any{"success": res.success, "commands_run": res.commands_run, "commands_total": res.commands_total,
			"assertions_total": res.assertions_total, "assertions_pass": res.assertions_pass, "assertions_fail": res.assertions_fail,
			"game_ended": res.game_ended, "error_message": res.error_message}
		out["log"] = sr.GET_LOG_AS_TEXT(s)
	}()
	json.NewEncoder(os.Stdout).Encode(out)
}
