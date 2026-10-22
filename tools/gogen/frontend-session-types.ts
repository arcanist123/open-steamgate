// SPDX-License-Identifier: MIT
// Erasable contracts for session reuse and observational provenance. Opaque
// values below are identity/fingerprint payloads, never interpreted as IR here.
import type * as Core from '@abaplint/core';
import type {Class} from './emit-go-types.ts';
import type {FunctionModule as IRFunctionModule} from './ir.ts';
import type {MethodSignature} from './frontend-types.ts';

// Future narrowing of getObject results must be nominal and runtime-safe (no 'as'/JSDoc casts: abapiti lowers them to ?=; prefer a form both tsc and abapiti accept, reviewed with a one-copy npm ls @abaplint/core check, emitGo byte cmp and the cache/provenance tests).
export type Registry = Core.Registry;
export type SourceFile = Core.IFile;
export type ArtifactIdentity = unknown[];
export type RegistryObjects = (this: Registry) => Iterable<ArtifactObject>;
// The frontend's enqueue seam retains DDIC lock field descriptors.
export interface LockField {readonly name: string; readonly kind: string; readonly length?: number}
type CacheValue<T> = T extends {s: 'call_enq'} ? Omit<T, 'fields'> & {readonly fields?: readonly LockField[]}
  : T extends readonly (infer V)[] ? readonly CacheValue<V>[]
    : T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<K, CacheValue<V>>
      : T extends object ? {[K in keyof T]: CacheValue<T[K]>} : T;
export type ClassIR = import("./frontend-types.ts").FrontendClass;
export type Signature = MethodSignature;
export type Signatures = Map<string, Signature>;
export type SignatureChanges = [string, Signature][];
export interface ProgramSnapshot extends Map<string, unknown> {
  get(key: 'sigs'): Signatures;
  get(key: string): unknown;
}
export interface ArtifactObject {
  getType(): string;
  getName(): string;
  getFiles(): readonly SourceFile[];
  isDirty?(): boolean;
  syntaxResult?: unknown;
  parsedType?: unknown;
  definition?: unknown;
}
// The core Class keeps def private, so it is not part of ArtifactObject (a Class
// must stay assignable to it); the cache domain still reads it through this view.
export type ArtifactObjectWithDef = ArtifactObject & {def?: unknown};
// Local class adapters retain the owning core object beside their own getters.
export interface ClassObject {
  getName(): string;
  getMainABAPFile(): Core.ABAPFile | undefined;
  obj?: ArtifactObject;
}
export type ArtifactInput = ArtifactObject | {obj: ArtifactObject};
export interface RegistryContext {reg: Registry}
export type LoweringContext = import("./frontend-types.ts").CompilationContext;
export type ClassLowering = (ctx: LoweringContext, obj: ClassObject) => ClassIR;
export interface FunctionModule {
  owner: string;
  group: Core.Objects.FunctionGroup;
  module: IRFunctionModule['module'];
  // The frontend retains both refused signatures and the public IR descriptor.
  sig: Signature | IRFunctionModule['sig'];
  updateTask: boolean;
  spaghetti?: IRFunctionModule['spaghetti'];
  top?: IRFunctionModule['top'];
}
// Explicit lowering subset; retain the frontend's exact container value types.
export interface SessionProgram extends Pick<import("./frontend-types.ts").FrontendProgram, "reg" | "sigs" | "wanted" | "supplied" | "skipped" | "partial" | "currentClass" | "currentOwner" | "currentTypes" | "functionModules" | "frontendCounts"> {}
// A replay is an ordered transcript of heterogeneous program observations and
// effects. Payloads remain opaque until frontend-replay validates/applies them.
export type ReplayOperation =
  | {kind: 'measure'; key: string; method: string; value: number}
  | {kind: 'read'; key: string; method?: string; args: unknown[]; value: string | undefined}
  | {kind: 'assign'; key: string; value: unknown}
  | {kind: 'effect'; key: string; method: string; args: unknown[]};
export interface Replay {ops: ReplayOperation[]; written: Set<string>}
export interface RecordedLowering {ir: ClassIR; replay?: Replay}
export interface SessionEntry {
  file: Core.ABAPFile;
  structure: ReturnType<Core.ABAPFile['getStructure']>;
  ir: ClassIR;
  supplied: string;
  current: Pick<SessionProgram, 'currentClass' | 'currentOwner' | 'currentTypes'>;
  sigs?: SignatureChanges;
  skipped?: string[];
  partial?: string[];
  replay?: Replay;
  provenance?: StoredProvenance;
}
// A SessionEntry as stored on disk: no parsed file or structure, plus its name.
export interface CacheDiskEntry {
  name: string;
  ir: ClassIR;
  supplied: string;
  current: Pick<SessionProgram, 'currentClass' | 'currentOwner' | 'currentTypes'>;
  sigs?: SignatureChanges;
  skipped?: string[];
  partial?: string[];
  replay?: Replay;
  provenance?: StoredProvenance;
}
export interface CachePrediction {
  row: {
    name: string; wouldReuseV3: boolean; actuallyLowered: boolean; reason: string;
    complete?: boolean; currentComplete?: boolean; completenessReason?: string; key?: string;
  };
  value?: CacheDiskEntry;
  trial?: SessionProgram;
}
export interface CacheShadow {
  probe(owner: string, key: string, program: SessionProgram): CachePrediction;
  validate(prediction: CachePrediction, ctx: LoweringContext, obj: ClassObject, lower: ClassLowering): void;
}
export interface CacheDisk {
  begin(): void;
  finish(program: SessionProgram): void;
  promote(owner: string, value: CacheDiskEntry, program: SessionProgram): void;
  read(owner: string, key: string, program: SessionProgram): CacheDiskEntry | undefined;
  record(run: () => ClassIR): {value: ClassIR; reads: string[]};
  write(owner: string, value: CacheDiskEntry, reads: string[], program: SessionProgram): boolean | undefined;
  shadow?: CacheShadow;
}
export interface CacheSession {
  dependencyCache?: boolean;
  // Preparation clears all own fields, including disk-cache extensions.
  [key: string]: unknown;
  registry: Registry;
  config: ReturnType<Registry['getConfig']> | undefined;
  files: SourceFile[];
  classes: Map<string, SessionEntry>;
  ownershipSafety?: import("./frontend-types.ts").OwnershipSafetyMap;
  disk?: CacheDisk;
}
export type SessionInput = Partial<CacheSession> | null | undefined;
// The three disk-cache entry points compileProgram holds when cacheDir is set.
export interface DiskFrontend {
  cacheSession(session: SessionInput, registry: Registry, cacheDir: string | undefined, dependencyCache?: boolean): SessionInput;
  prepareDiskSession(session: SessionInput, registry: Registry): void;
  compileDiskClass(ctx: LoweringContext, obj: ClassObject, lower: ClassLowering, session: CacheSession | null | undefined): ClassIR;
}
export interface PreparedSelection {wanted: string[]; diagnostics: readonly import("./ir.ts").Diagnostic[]; broken: Set<string>}
export interface CompileOptions {
  // Internal seam for the cache host's discovery-equivalence checker: returns
  // a deliberately partial program. Not a supported compilation mode.
  discoveryProbe?: {owners: Set<string>; selection?: PreparedSelection; cds?: import("./frontend-cache-types.ts").CdsSource[]; compile: CompileClass};
  closureContext?: {round: number};
  strictRoots?: Set<string>;
  selectionCache?: {
    read(options: CompileOptions): {selection: string[]; closed?: string[]; evidence: string; rounds: unknown[]} | undefined;
    check?(reg: Registry, seeded: boolean): boolean | string;
    write(options: CompileOptions, selection: string[], rounds: unknown[]): void;
  };
  folders: string[];
  objects: string[];
  tolerant?: boolean;
  skip?: (path: string) => boolean;
  includeTests?: boolean | Set<string>;
  [key: string]: unknown;
  provenance?: boolean;
  cacheDir?: string;
  dependencyCache?: boolean;
  registry?: Registry;
  session?: Partial<CacheSession> | null;
}
export type Role = 'artifact' | 'scheduling' | 'final-output';
// Hooks normalize strings and undefined, retaining other scalar answers.
export type QueryScalar = string | number | boolean | null | undefined;
export interface QueryBase {
  args: readonly QueryScalar[];
  result: readonly QueryScalar[];
  role?: Role;
  phase?: string;
  artifact?: string;
  providers?: readonly string[];
  scan?: string;
  complete?: boolean;
  policy?: string;
  target?: string;
  queryArgs?: QueryScalar[];
  site?: string[];
}
// Named semantic answers carry different payloads; keep their discriminants
// through Recorder.query, stored rows and semanticQuery's partial details.
export interface LockDescriptor {
  name: string;
  table: string;
  key: string[];
  fields: LockField[];
}
export interface RttiComponent {name: string; kind: string}
export type ObservationKind =
  | 'getObject' | 'getFileByName' | 'findObjectForFile' | 'getFirstObject'
  | 'unknown-scan' | 'function-module-owner' | 'function-group-include'
  | 'function-module-index' | 'badi-definition' | 'implicit-type-pool'
  | 'implicit-type-pool-constant' | 'behavior-definition' | 'cds-alias'
  | 'include-parent' | 'include-macro-context' | 'global-definitions'
  | 'registry-inventory' | 'registry-parse' | 'registry-findIssues'
  | 'registry-findIssuesObject' | 'registry-isDirty' | 'registry-getFiles'
  | 'registry-getObjectCount' | 'registry-setConfig' | 'include-graph'
  | 'supplied-index' | 'locals' | 'local-dispatch' | 'selected-groups'
  | 'selected-classes' | 'ownership-dispatch' | 'table-inventory'
  | 'lock-inventory' | 'rtti-inventory' | 'rtti' | 'exception-supers'
  | 'tables' | 'locks' | 'caught';
export type Query = QueryBase & (
  | {kind: ObservationKind}
  | {kind: 'supplied'; parameters: string[]}
  | {kind: 'lock'; descriptor: LockDescriptor | 'MISSING'}
  | {kind: 'ownershipSafety'; names: string[]; dynamic: boolean}
  | {kind: 'rtti-owner'; known: string[]; structs: [string, RttiComponent[]][]}
);
export type QueryRow = Query & {role: Role; phase: string; artifact: string};
export interface QueryEntry {queries: Map<string, QueryRow>; edges: Set<string>}
// Leaves contain true; intermediate nodes are Maps indexed by scalar tuples.
export interface QueryTrie extends Map<QueryScalar, QueryTrie | true> {}
export interface RegistryState {
  unknownVersion: number;
  reg: Registry;
  config: ReturnType<Registry['getConfig']> | undefined;
  entries: Map<string, QueryEntry>;
  lowerings: Map<string, QueryEntry>;
  scheduling: QueryEntry;
  finalOutput: QueryEntry;
  global: QueryEntry;
  files: Map<string, [string, string][]>;
  artifacts: Map<ArtifactObject, ArtifactIdentity>;
  exposed?: boolean;
  auditBuilt?: boolean;
}
export interface ArtifactFrame {
  state: RegistryState;
  key: string | undefined;
  phase: string;
  obj?: ArtifactObject;
  lowering?: boolean;
  named?: QueryTrie;
}
export interface QueryContext {kind: string; args: unknown[]}
export interface InputSource {file: SourceFile; name: string; raw: string; _rawHash: string | undefined; _artifactHash: string | undefined}
export interface InputObject {obj: ArtifactObject; dependency: boolean; sources: InputSource[]}
export interface InputSnapshot {
  objects: Map<string, InputObject>;
  fileOwners: Map<string, string>;
  files: SourceFile[];
  config: string;
  configObject?: ReturnType<Registry['getConfig']>;
  signature: string;
}
export interface ResultState {states: Set<RegistryState>; exposed: boolean}
export interface StoredProvenance {rows: QueryRow[]; edges: string[]}
export interface Manifest {hits: QueryRow[]; misses: QueryRow[]; scans: QueryRow[]; unknownScans: QueryRow[]}
export type ProvenanceInput = Registry | {reg?: Registry; registry?: Registry};
export interface ProvenanceGraph {
  // Observer-only safety memo revision; never serialized or hashed as input.
  unknownVersion: number;
  artifacts: Map<string, QueryEntry>;
  lowerings: Map<string, QueryEntry>;
  global: QueryEntry;
}
// Selection needs only these public core members; tests also pass this seam.
export interface SelectionCore {
  VirtualPosition: typeof Core.VirtualPosition;
  MacroContent: typeof Core.MacroContent;
  Objects: {FunctionGroup: typeof Core.Objects.FunctionGroup};
  Visibility: {Public: Core.Visibility};
  Statements: {CallFunction: typeof Core.Statements.CallFunction};
  Expressions: {FunctionName: typeof Core.Expressions.FunctionName};
  Tokens: {StringToken: typeof Core.Tokens.StringToken; Identifier: typeof Core.Tokens.Identifier};
}
// One signature for every class compiler compileProgram picks (probe, disk frontend, compileClass).
export type CompileClass = (ctx: LoweringContext, obj: ClassObject, lower: ClassLowering, session: CacheSession | null | undefined) => ClassIR;
