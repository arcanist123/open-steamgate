import {compileProgram} from "./frontend.mjs";
import {withRole} from "./frontend-provenance.mjs";

// Close lowering-time and superclass dependencies without host-specific class
// lists. Explicit inputs keep their requested syntax policy. Dependencies may
// contain unsupported library definitions; retain their diagnostics/refusals
// without rejecting an otherwise valid report or repeatedly selecting them.
/** @param {import("./frontend-session-types.ts").CompileOptions} options @returns {import("./frontend-types.ts").FrontendProgram} */
export function compileClosedProgram(options) {
  const original = options;
  let cache = options.selectionCache;
  let seed = cache?.read(options);
  const rounds = seed ? [...seed.rounds] : [];
  const closureContext = {round: 1};
  if (seed) options = {...options, objects: seed.selection, tolerant: true,
    strictRoots: options.tolerant ? undefined : new Set(original.objects.map(n => n.toUpperCase().replaceAll("#", "/")))};
  options = {...options, closureContext};
  let program = compileProgram(options);
  /** @type {Set<string> | undefined} */ let selected;
  for (;;) {
    const certified = withRole("scheduling", () => cache?.check?.(program.reg, !!seed));
    if (certified === false) {
      // The preflight raced the loader (including edit/revert races). The
      // loaded registry is the authority; discard the seed before emitting.
      cache = undefined; seed = undefined; rounds.length = 0;
      closureContext.round++;
      options = {...original, selectionCache: undefined, closureContext};
      program = compileProgram(options);
      selected = new Set(program.wanted);
      continue;
    }
    selected ??= new Set(seed?.closed ?? program.wanted);
    if (seed && typeof certified === "string") seed.evidence = certified;
    const more = withRole("scheduling", () => {
      const superEdges = [...selected].map(n => [n, program.reg.getObject("CLAS", n)?.getDefinition()?.getSuperClass()?.toUpperCase()]).filter(row => row[1]);
      const supers = superEdges.map(row => row[1]);
      const missing = [...program.missing];
      const added = [...missing, ...supers].filter(n => !selected.has(n) && program.reg.getObject("CLAS", n));
      if (!seed || added.length || closureContext.round > 1) rounds.push({inputs: options.objects, wanted: [...program.wanted], missing, supers, superEdges, added});
      return added;
    });
    if (!more.length) {
      cache?.write(original, options.objects, rounds);
      Object.assign(program, {closureRounds: closureContext.round, selectionEvidence: seed?.evidence ?? "discovery-from-roots"});
      return program;
    }
    more.forEach(n => selected.add(n));
    closureContext.round++;
    options = {...options, registry: program.reg, objects: [...selected], tolerant: true};
    program = compileProgram(options);
  }
}
