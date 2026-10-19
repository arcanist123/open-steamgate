// Observational tracing facade. Ordinary compilation never loads the recorder.
import {staticDiscoveryReferences, functionDiscoveryReferences} from "./frontend-discovery-references.mjs";
import {freshRegistry, finishInputs} from "./frontend-inventory.mjs";
import {createRequire} from "node:module";
import {beginFrontendRound, finishFrontendRound} from "./frontend-timing.mjs";
import {cacheDiagnostic} from "./frontend-cache-diagnostics.mjs";
const require = createRequire(import.meta.url);
/** @type {typeof import("@abaplint/core")} */ const core = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
/** @type {typeof import('./frontend-provenance-recorder.mjs') | undefined} */ let recorder;
function loadRecorder() {
  return recorder ??= require("./frontend-provenance-recorder.mjs");
}

/** @template T @param {() => T} run @param {{expose?: boolean, cacheDir?: string}} options @returns {T} */ export function recordProvenance(run, {expose = true, cacheDir} = {}) {
  return loadRecorder().recordProvenance(run, {expose, cacheDir});
}

/** Disk builds record internally; expanded public reporting stays opt-in. */
/** @param {(options: import('./frontend-session-types.ts').CompileOptions) => import('./frontend-types.ts').FrontendProgram} compile @returns {(options: import('./frontend-session-types.ts').CompileOptions) => import('./frontend-types.ts').FrontendProgram} */ export function withProvenance(compile) {
  return (options) => {
    beginFrontendRound(options.closureContext?.round);
    /** @type {boolean} */ const expose = options.provenance ?? (process.env.GOGEN_PROVENANCE === "1");
    const run = () => {
      if (options.registry) options = {...options, registry: freshRegistry(options.registry, options.session, (reg) => recorder?.prepareProvenanceInputs(reg))};
      if (options.registry) recorder?.inventoryProvenance(options.registry);
      const program = compile(options);
      finishInputs(program.reg);
      return program;
    };
    /** @type {boolean | string | undefined} */ const record = expose || (options.cacheDir && (options.provenance !== false || options.dependencyCache === true));
    try { return record ? recordProvenance(run, {expose, cacheDir: !expose && options.dependencyCache ? options.cacheDir : undefined}) : run(); }
    finally {
      const rows = finishFrontendRound();
      if (process.env.GOGEN_CACHE_DIAGNOSTICS && options.cacheDir) {
        for (const row of rows) cacheDiagnostic({event: "phase", ...row});
      }
    }
  };
}

/** @param {import('./frontend-session-types.ts').Registry} reg @returns {void} */ export function beginProvenanceCompile(reg) {
  recorder?.beginProvenanceCompile(reg);
}

/** @template T @param {import('./frontend-session-types.ts').RegistryContext} ctx @param {import('./frontend-session-types.ts').ArtifactInput} obj @param {() => T} run @param {string} phase @returns {T} */ export function withArtifact(ctx, obj, run, phase = "lowering") {
  return recorder ? recorder.withArtifact(ctx, obj, run, phase) : run();
}

/** @template {import('./frontend-session-types.ts').RegistryContext} C @template {import('./frontend-session-types.ts').ArtifactInput} O @template {unknown[]} A @template T @param {(ctx: C, obj: O, ...args: A) => T} lower @returns {(ctx: C, obj: O, ...args: A) => T} */ export function artifactLowering(lower) {
  return (ctx, obj, ...args) => withArtifact(ctx, obj, () => lower(ctx, obj, ...args));
}

/** @returns {boolean} */ export function recordingProvenance() {
  return recorder?.recordingProvenance() ?? false;
}
/** Reuse needs no observation merge when provider provenance is already seeded. */
export function scopedProvenance() { return recorder?.scopedProvenance() ?? false; }

/** Public reporting projections are unnecessary for internal cache observation. */
/** @returns {boolean} */ export function exposingProvenance() {
  return recorder?.exposingProvenance() ?? false;
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').ArtifactInput} obj @returns {import('./frontend-session-types.ts').StoredProvenance | undefined} */ export function storedProvenance(reg, obj) {
  return recorder?.storedProvenance(reg, obj);
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').ArtifactInput} obj @param {import('./frontend-session-types.ts').StoredProvenance | undefined} stored @returns {void} */ export function inheritStoredProvenance(reg, obj, stored) {
  recorder?.inheritStoredProvenance(reg, obj, stored);
}

/** @param {import('./frontend-session-types.ts').LoweringContext} ctx @param {string} name @returns {import('./frontend-session-types.ts').FunctionModule | undefined} */ export function resolvedFunctionModule(ctx, name) {
  return recorder ? recorder.resolvedFunctionModule(ctx, name) : ctx.program.functionModules.get(name);
}

// Same selection order and lookup precedence as the frontend. Keep the named
// FM ownership query beside the gogen scan (normal ABAP syntax only checks FM
// ownership in Cloud language mode).
/** @param {import('./frontend-session-types.ts').Registry} reg @param {string[]} wanted @param {import('./frontend-session-types.ts').SelectionCore} abaplint @returns {void} */ export function expandProgramSelection(reg, wanted, abaplint) {
  /** @param {unknown} s @returns {string} */ const upper = (s) => String(s).toUpperCase();
  /** @type {Map<string, string>} */ const fmGroups = new Map();
  const index = () => {
    for (const g of enumerateObjects(reg, "function-module-index", [], "scheduling", (o) => o instanceof abaplint.Objects.FunctionGroup)) {
      for (const m of g.getModules()) fmGroups.set(upper(m.getName()), g.getName().toLowerCase());
    }
  };
  withRole("scheduling", index);
  for (let i = 0; i < wanted.length; i++) {
    const obj = withRole("scheduling", () => reg.getObject("CLAS", wanted[i]) ?? reg.getObject("FUGR", wanted[i]));
    const run = () => {
      for (const file of obj?.getABAPFiles() ?? []) {
        // Expansion tokens have virtual call-site positions. Select from the
        // original definition instead, including macros that are never invoked.
        const statements = file.getStatements().filter((statement) =>
          !statement.getTokens().some((token) => token.getStart() instanceof abaplint.VirtualPosition));
        // Preserve the per-file order: all FM ownership queries precede static
        // attribute lookups, even when those accesses occur earlier in the file.
        for (const statement of statements) {
          for (const functionName of functionDiscoveryReferences(statement, abaplint)) {
            const group = fmGroups.get(functionName);
            semanticQuery(reg, "function-module-owner", [functionName],
              group ? [`FUGR ${upper(group)}`] : [], {policy: "gogen-last-wins"});
            if (group && !wanted.includes(group)) wanted.push(group);
          }
        }
        // A PUBLIC CLASS-DATA read is a dependency too. Only identifier tokens
        // surrounding a static arrow count; comments and literal text do not.
        for (const statement of statements) {
          for (const {owner, member: attr} of staticDiscoveryReferences(statement, abaplint)) {
            const def = reg.getObject("CLAS", owner)?.getDefinition();
            if (def?.getAttributes().getStatic().some((a) => upper(a.getName()) === attr && a.getVisibility?.() === abaplint.Visibility.Public)
                && !wanted.includes(owner)) wanted.push(owner);
          }
        }
      }
    };
    if (recorder) recorder.withSelection(reg, obj, run); else run();
  }
}

/** @param {import('./frontend-session-types.ts').ProvenanceInput} value @param {{internal?: boolean}} options @returns {Map<string, import('./frontend-session-types.ts').Manifest>} */ export function provenanceOf(value, {internal = false} = {}) {
  if (recorder) return recorder.provenanceOf(value, {internal});
  // Preserve normalization reads and getter exceptions even without recorded state.
  void (value?.reg ?? value?.registry ?? value);
  return new Map();
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').Query['kind']} kind @param {readonly import('./frontend-session-types.ts').QueryScalar[]} args @param {import('./frontend-session-types.ts').Role} role @param {(obj: import('./frontend-session-types.ts').ArtifactObject) => boolean} predicate @returns {import('./frontend-session-types.ts').ArtifactObject[]} */ export function enumerateObjects(reg, kind, args = [], role = "scheduling", predicate = () => true) {
  return recorder ? recorder.enumerateObjects(reg, kind, args, role, predicate) : [...core.Registry.prototype.getObjects.call(reg)].filter(predicate);
}

/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('./frontend-session-types.ts').Query['kind']} kind @param {readonly import('./frontend-session-types.ts').QueryScalar[]} args @param {readonly import('./frontend-session-types.ts').QueryScalar[]} result @param {Partial<import('./frontend-session-types.ts').Query>} details @returns {void} */ export function semanticQuery(reg, kind, args, result, details = {}) {
  recorder?.semanticQuery(reg, kind, args, result, details);
}

/** @template T @param {import('./frontend-session-types.ts').Role} role @param {() => T} run @returns {T} */ export function withRole(role, run) {
  return recorder ? recorder.withRole(role, run) : run();
}

/** @template T @param {string} purpose @param {() => T} run @returns {T} */ export function auditedBookkeeping(purpose, run) {
  return recorder ? recorder.auditedBookkeeping(purpose, run) : run();
}

/** @template T @param {() => T} run @returns {T} */ export function recordedArtifactBuild(run) {
  return recorder ? recorder.recordedArtifactBuild(run) : run();
}

/** @param {import('./frontend-session-types.ts').Registry} reg @returns {boolean} */ export function auditBuiltArtifacts(reg) {
  return recorder?.auditBuiltArtifacts(reg) ?? false;
}

/** @returns {boolean} */ export function provenanceAuditActive() {
  return recorder?.provenanceAuditActive() ?? false;
}

/** @param {import('./frontend-session-types.ts').ProvenanceInput} value @returns {{scheduling: import('./frontend-session-types.ts').QueryRow[], finalOutput: import('./frontend-session-types.ts').QueryRow[]}} */ export function compilationProvenanceOf(value) {
  if (recorder) return recorder.compilationProvenanceOf(value);
  void (value?.reg ?? value?.registry ?? value);
  return {scheduling: [], finalOutput: []};
}

/** @param {import('./frontend-session-types.ts').Registry} reg @returns {import('./frontend-session-types.ts').ProvenanceGraph | undefined} */ export function provenanceGraph(reg) {
  return recorder?.provenanceGraph(reg);
}
