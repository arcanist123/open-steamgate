//go:build libm

package abap

// #cgo LDFLAGS: -lm
// #include <math.h>
import "C"

// Sin and Cos from the C library the build links (glibc on Linux): the
// experiment of whether A4H's kernel computes sin with glibc.
func Sin(x float64) float64 { return float64(C.sin(C.double(x))) }
func Cos(x float64) float64 { return float64(C.cos(C.double(x))) }
