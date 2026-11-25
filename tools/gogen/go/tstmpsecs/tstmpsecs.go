// Package tstmpsecs is the part of CL_ABAP_TSTMP that open-abap-core writes as
// kernel code and the Go runtime answers.
// (Not "tstmp": that is the parameter of SUBTRACTSECS itself, and a Go
// package named like a local of the calling method is shadowed there.)
package tstmpsecs

import (
	"fmt"
	"strings"
	"time"

	"osg/gogen/abap"
)

// SubtractSecs is CL_ABAP_TSTMP=>SUBTRACTSECS as open-abap-core computes it:
// ADD with the seconds negated, where ADD formats the time stamp as ISO, cuts
// its fraction, adds the seconds in UTC and writes YYYYMMDDhhmmss back. That
// copies open-abap-core and is not measured on a system. A value that is no
// time stamp (a RangeError from toISOString on Node) is refused.
func SubtractSecs(s *abap.Session, tstmp string, secs int32) string {
	return addSecs("CL_ABAP_TSTMP=>SUBTRACTSECS", tstmp, -int64(secs))
}

func addSecs(where, v string, secs int64) string {
	v = strings.TrimSpace(v)
	if i := strings.IndexByte(v, '.'); i >= 0 {
		v = v[:i]
	}
	t, err := time.Parse("20060102150405", fmt.Sprintf("%014s", v))
	if err != nil {
		panic(abap.NotCompiled(where, "a value that is not a time stamp: "+v))
	}
	return t.Add(time.Duration(secs) * time.Second).UTC().Format("20060102150405")
}

// Subtract is CL_ABAP_TSTMP=>SUBTRACT: the seconds from t2 to t1 as a
// p with seven decimals (TZNTSTMPL), fraction kept, as on a system and as
// open-abap-core computes it since #1311. A value that is not a time stamp
// is refused rather than guessed.
func Subtract(s *abap.Session, t1, t2 string) string {
	parse := func(v string) (time.Time, int64) {
		v = strings.TrimSpace(v)
		frac := int64(0)
		if i := strings.IndexByte(v, '.'); i >= 0 {
			f := (v[i+1:] + "0000000")[:7]
			for _, c := range f {
				if c < '0' || c > '9' {
					panic(abap.NotCompiled("CL_ABAP_TSTMP=>SUBTRACT", "a value that is not a time stamp: "+v))
				}
				frac = frac*10 + int64(c-'0')
			}
			v = v[:i]
		}
		t, err := time.Parse("20060102150405", fmt.Sprintf("%014s", v))
		if err != nil {
			panic(abap.NotCompiled("CL_ABAP_TSTMP=>SUBTRACT", "a value that is not a time stamp: "+v))
		}
		return t, frac
	}
	a, af := parse(t1)
	b, bf := parse(t2)
	d := int64(a.Sub(b)/time.Second)*10000000 + af - bf
	sign := ""
	if d < 0 {
		sign, d = "-", -d
	}
	return fmt.Sprintf("%s%d.%07d", sign, d/10000000, d%10000000)
}
