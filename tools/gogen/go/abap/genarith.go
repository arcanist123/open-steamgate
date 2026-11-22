package abap

// Arithmetic with a generic operand or into a generic target (ultra/itab,
// frontend.mjs genericArith). A4H 2026-09-24, ZCL_GOGEN_T_GENAR: the
// calculation type is what the static rule gives for the types the operands
// and the target have at run time. The front end compiles one branch per
// calculation type; CalcKind picks it.

// CalcKind is the calculation type of an arithmetic expression: static holds
// the kinds of its typed operands and of a typed numeric target
// (cl_abap_typedescr=>typekind_*: I 8 F P C g N ...), charTarget says the
// typed target is c or string, target is a generic target (P nil for none),
// leaves the generic operands. 'I', '8', 'P' or 'F'; 0 for a combination the
// static rule refuses (an operand of another kind), which the caller raises
// as NOT_COMPILED. A c or string target of an integer result (all operands
// i / int8) is refused as well: by the static rule a character target makes
// the calculation type p, but that was not measured on A4H, so it stays a
// deliberate refusal until it is.
func CalcKind(static string, charTarget bool, target Data, leaves ...Data) byte {
	ks := []byte(static)
	for _, d := range leaves {
		if d.P == nil || d.T == nil {
			panic(notAssigned("arithmetic"))
		}
		ks = append(ks, d.T.Kind)
	}
	if target.T != nil {
		switch target.T.Kind {
		case 'I', '8', 'F', 'P':
			ks = append(ks, target.T.Kind)
		case 'C', 'g':
			charTarget = true
		case 'X':
			ks = append(ks, 'I')
		default:
			return 0
		}
	}
	has := func(set string) bool {
		for _, k := range ks {
			for i := 0; i < len(set); i++ {
				if k == set[i] {
					return true
				}
			}
		}
		return false
	}
	for _, k := range ks {
		switch k {
		case 'I', '8', 'F', 'P', 'C', 'g', 'N':
		default:
			// refused with or without an f operand, so the refusal is
			// uniform (critic fix; DataF would refuse it later anyway)
			return 0
		}
	}
	switch {
	case has("F"):
		return 'F'
	case has("PCgN"):
		return 'P'
	case charTarget:
		return 0
	case has("8"):
		return '8'
	}
	return 'I'
}

// DataI8 is a generic i, int8 or p read as an int8 (a p rounded half away
// from zero, with the overflow check of an int8 target).
func DataI8(d Data) int64 {
	switch d.T.Kind {
	case 'I':
		return int64(*d.P.(*int32))
	case '8':
		return *d.P.(*int64)
	case 'P':
		return PToI8(*d.P.(*string), false)
	}
	panic(NotCompiled("move", "a generic value of type kind "+string(d.T.Kind)+" into an int8"))
}

// DataF is a generic elementary value read as an f.
func DataF(d Data) float64 {
	switch d.T.Kind {
	case 'I':
		return float64(*d.P.(*int32))
	case '8':
		return float64(*d.P.(*int64))
	case 'F':
		return *d.P.(*float64)
	case 'P':
		return PToF(*d.P.(*string))
	case 'C', 'g', 'N':
		return ParseF(*d.P.(*string))
	}
	panic(NotCompiled("move", "a generic value of type kind "+string(d.T.Kind)+" into an f"))
}
