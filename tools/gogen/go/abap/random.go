package abap

import "math/rand/v2"

// RandomInt is cl_abap_random_int=>create( min max )->get_next( ) with no
// seed: a system seeds such a generator at random, so any number in the
// range is right and none is reproducible. For comparing two runtimes a
// harness may call SeedRandom: then both draw from the same xorshift32.
func RandomInt(min, max int32) int32 {
	if max < min {
		panic(ArithmeticError{Class: "CX_ABAP_RANDOM", Op: "min > max"})
	}
	if seeded {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		return min + int32(state%uint32(max-min+1))
	}
	return min + rand.Int32N(max-min+1)
}

var seeded bool
var state uint32

// SeedRandom makes RandomInt a fixed sequence (harnesses only).
func SeedRandom(seed uint32) { seeded, state = true, seed }
