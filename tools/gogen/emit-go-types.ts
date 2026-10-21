// SPDX-License-Identifier: MIT
// Erasable contracts for emit-go.mjs. IR tags stay discriminated so the
// emitter's existing switches narrow nodes without a runtime adapter.
import type * as IR from './ir.ts';
import type {OwnershipSafetyMap} from './frontend-types.ts';
import type {Layers as SymbolLayers} from './symbols.ts';

export type {Type, Field, Param, ResolvedKey, SqlColumn, WriteType, TemplateOptions} from './ir.ts';
export type SymbolCollector = (cls: Class, method: Method, go: string, receiver: string | null) => void;
// Reuse the IR tags while carrying the frontend's additional runtime shapes
// through nested operands, arguments, conditions and statement bodies too.
// Types have no runtime expression/statement payloads to adapt. Preserve their
// shared discriminated union instead of recursively rebuilding every type field.
type RuntimeValue<T> = T extends IR.Type ? T : T extends IR.Expr ? Expr : T extends IR.Stmt ? Stmt
  : T extends IR.Condition ? Condition : T extends IR.Catch ? Catch
    : T extends IR.SqlPredicate ? SqlPredicate : T extends readonly (infer V)[] ? readonly RuntimeValue<V>[]
    : T extends object ? RuntimeFields<T> : T;
type RuntimeFields<T> = T extends object ? {readonly [K in keyof T]: K extends 'assign'
  ? readonly (SqlAssignment | null)[] : RuntimeValue<T[K]>} : T;
type RawCall = Extract<IR.Expr, {e: 'call'}>;
export interface CallExpr extends RuntimeFields<Omit<RawCall, 'owner' | 'static' | 'callee'>> {
  readonly owner?: string | null;
  readonly static?: boolean;
  readonly callee?: string;
}
// Ownership probes also synthesize substrings without the renderer's base hint.
export interface SubstringExpr extends Omit<RuntimeFields<Extract<IR.Expr, {e: 'substr'}>>, 'base'> {
  readonly base?: IR.Type;
}
// Flags synthesized as str_fn arguments carry no type; every other flag does.
export interface UntypedFlagExpr { readonly e: 'flag'; readonly value: boolean; readonly conv?: boolean; readonly fromP?: Extract<IR.Type, {k: 'p'}> }
interface StrFnExpr extends Omit<RuntimeFields<Extract<IR.Expr, {e: 'str_fn'}>>, 'args'> {readonly args: readonly (Expr | UntypedFlagExpr)[]}
export type Expr = RuntimeFields<Exclude<IR.Expr, {e: 'call' | 'int' | 'flag' | 'strlist' | 'str_fn' | 'struct' | 'upcast' | 'substr'}>> | CallExpr | SubstringExpr | StrFnExpr
  | (RuntimeFields<Omit<Extract<IR.Expr, {e: 'struct'}>, 'type'>> & {readonly type: Extract<IR.Type, {k: 'struct'}>}) | (RuntimeFields<Omit<Extract<IR.Expr, {e: 'upcast'}>, 'type'>> & {readonly type: Extract<IR.Type, {k: 'ref'}>})
  | {readonly e: 'int' | 'float'; readonly value: number; readonly type: IR.Type; readonly conv?: boolean; readonly fromP?: Extract<IR.Type, {k: 'p'}>}
  | TypedFlagExpr;
export interface LockField extends Pick<IR.TableColumn, 'name' | 'kind'> { readonly length: number }
export interface NativeArgument { readonly value: Expr; readonly ref?: boolean }
export interface ArithmeticBranchProbe { readonly e?: string; readonly reason?: string }
// IR.TypedExpr retains raw IR children; use the emitter's recursive operands.
export interface TypedNumberExpr { readonly e: 'int' | 'float'; readonly value: number; readonly type: IR.Type }
export interface TypedFlagExpr { readonly e: 'flag'; readonly value: boolean; readonly type: IR.Type; readonly conv?: boolean; readonly fromP?: Extract<IR.Type, {k: 'p'}> }
// strlist carries no type and reaches only the dynamic-SQL string positions,
// so a typed expression is never a strlist.
export type TypedExpr = Exclude<Expr, {e: 'int' | 'float' | 'flag'}> | TypedNumberExpr | TypedFlagExpr;
export interface InitialCondition { readonly c: 'initial'; readonly x: TypedExpr }
export interface ConcatBytesTable { readonly s: 'concat_bytes'; readonly target: Expr; readonly table: TypedExpr; readonly row: Expr }
export interface AssignmentStmt { readonly s: 'assign' | 'set_data'; readonly target: Expr; readonly value: Expr }
type StatementFields<T> = T extends {s: 'assign' | 'set_data'} ? AssignmentStmt : T extends {s: 'native'} ? Omit<T, 'args'> & {readonly args?: readonly NativeArgument[]}
  : T extends {s: 'kernel_loop'} ? Omit<T, 'args' | 'pos'> & {readonly args: readonly NativeArgument[]; readonly pos?: IR.Position}
  : T extends {s: 'raise_event'} ? Omit<T, 'args'> & {readonly args: readonly EventArgument[]}
  : T extends {s: 'call_fm'} ? Omit<T, 'args'> & {readonly args: readonly EventArgument[]}
  : T extends {s: 'call_enq'} ? Omit<T, 'args' | 'fields'> & {readonly args: readonly EventArgument[]; readonly fields?: readonly LockField[]}
  : T extends {s: 'concat_bytes'; table: Expr} ? ConcatBytesTable
  : T extends {s: 'concat'} ? Omit<T, 'sep'> & {readonly sep: Expr | null}
  : T extends {s: 'select_dyn'} ? Omit<T, 'fields' | 'where' | 'groupBy' | 'orderBy'> & {readonly fields: DynamicSqlStrings | null; readonly where: Expr | null; readonly groupBy: DynamicSqlStrings | null; readonly orderBy: DynamicSqlStrings | null}
  : T extends {s: 'delete_index_data' | 'delete_index'} ? Omit<T, 'tokens'> & {readonly tokens: readonly LoopCursor[]}
  : T extends {s: 'delete_current'} ? Omit<T, 'token'> & {readonly token: LoopCursor}
  : T extends {s: 'stub'} ? Omit<T, 'pos'> & {readonly pos?: IR.Position}
  : T extends {s: 'call_dyn_static'} ? Omit<T, 'cls' | 'args'> & {readonly cls: string | Expr; readonly args: readonly EventArgument[]}
  : T extends {s: 'loop'} ? Omit<T, 'key' | 'dynamicKeys'> & {
    readonly key?: IR.ResolvedKey | null;
    readonly dynamicKeys?: {readonly value: Expr; readonly options: readonly IR.ResolvedKey[]} | null;
  } : T extends {s: 'insert_sorted'} ? Omit<T, 'keys' | 'refInto'> & {
    readonly keys: readonly SortKey[]; readonly refInto?: Expr | null; readonly unique?: boolean;
  } : T extends {s: 'select_loop' | 'select_single' | 'select_aggregate'} ? Omit<T, 'target'> & {readonly target: Expr | null}
    : T;
export type Stmt = StatementFields<RuntimeFields<IR.Stmt>> & {readonly pos?: IR.Position; readonly moveTable?: boolean};
export type Condition = RuntimeFields<Exclude<IR.Condition, {c: 'cmp' | 'initial'}>>
  | (RuntimeFields<Omit<Extract<IR.Condition, {c: 'cmp'}>, 'type'>> & {readonly type?: IR.Type})
  | InitialCondition;
export type Argument = RuntimeFields<IR.Argument>;
export interface ImportingArgument { readonly value: Expr; readonly type?: IR.Type; readonly byValue?: boolean }
export interface EventArgument {
  readonly name: string;
  readonly value: Expr;
  readonly dir?: IR.Argument['dir'];
  readonly byValue?: boolean;
  readonly type?: IR.Type;
  readonly place?: Expr | null;
  readonly wrap?: Expr;
  readonly supplied?: boolean;
  readonly fitc?: number;
}
export interface DynamicResultMove { readonly key: string; readonly type: IR.Type; readonly value: Expr }
// Every arm of Expr carries its type, so the string positions accept any of
// them beside the strlist, without an intersection view.
export type DynamicSqlStrings = RuntimeFields<Extract<IR.Expr, {e: 'strlist'}>> | Expr;
// whereOf emits INITIAL only with fx, and comparisons only with a value.
export type Where = {readonly op: 'initial' | 'notinitial'; readonly fx: TypedExpr}
  | {readonly op: '=' | '<>' | '<' | '<=' | '>' | '>='; readonly name?: string;
    readonly fx?: Expr; readonly ftype?: IR.Type; readonly value: Expr; readonly calc?: IR.Type};
export interface Catch extends RuntimeFields<Omit<IR.Catch, 'into' | 'intoKind' | 'intoType' | 'classes'>> {
  readonly classes?: readonly string[]; readonly into?: string | null;
  readonly intoKind?: 'exc' | 'ref' | null; readonly intoType?: IR.Type | null;
}
export interface SortKey extends Omit<IR.SortKey, 'type'> {readonly type?: IR.Type}
export interface SqlAssignment extends RuntimeFields<IR.SqlAssignment> {readonly place?: Expr}
export type SqlArgument = RuntimeFields<IR.SqlArgument>;
export type SqlPredicate = Omit<IR.SqlPredicate, 'range' | 'type' | 'kind' | 'lowLen'> & {
  readonly range: Expr; readonly type: IR.WriteType; readonly kind?: string; readonly lowLen?: number;
};
// Emitter metadata on the shared frontend identity token.
export interface LoopCursor { idxVar?: string }
export type TableType = Extract<IR.Type, {k: 'table'}>;
export type StructType = Extract<IR.Type, {k: 'struct'}>;
export type PackedType = Extract<IR.Type, {k: 'p'}>;
// from/to stay IR.Type as at base: abapiti lowers the plain union read, and
// conv()'s ungated len/dec reads carry @ts-expect-error there instead.
export interface ConvExpr extends RuntimeFields<Extract<IR.Expr, {e: 'conv'}>> {}
export interface Conversion extends ConvExpr {}
export type Builtin = Extract<Expr, {e: 'fn'}>;
export interface DynamicLoopBranch { readonly name: string; readonly key: IR.ResolvedKey | null }
export interface KeyLoop extends Extract<Stmt, {s: 'loop'}> {readonly key: IR.ResolvedKey}
export type KeyRead = Extract<Stmt, {s: 'read_seckey'}>;
export type Loop = Extract<Stmt, {s: 'loop' | 'loop_data'}>;
export type KeyValues = Extract<Stmt, {s: 'read_seckey' | 'delete_seckey'}>;

// These frontend fields are consumed by the emitter but are not yet all
// represented in ir.ts. Keep the extra shape here rather than widen IR tags.
export interface Local extends IR.Field {
  readonly static?: boolean;
  readonly statics?: string;
  readonly value?: LiteralValue;
  readonly init?: Expr;
  readonly fieldInits?: Readonly<Record<string, Expr | undefined>>;
}
export interface SupportedAttribute extends Omit<IR.Attribute, 'value'> {
  readonly value?: LiteralValue | Expr;
  readonly unsupported?: undefined;
  readonly fromIntf?: string | boolean;
  readonly intf?: string;
  readonly readOnly?: boolean;
}
export interface UnsupportedAttribute extends Omit<SupportedAttribute, 'type' | 'unsupported'> {
  readonly type?: IR.Type;
  readonly unsupported: string;
}
export type Attribute = SupportedAttribute | UnsupportedAttribute;
export interface Method extends Omit<IR.Method, 'locals' | 'body'> {
  readonly locals?: readonly Local[];
  readonly body?: readonly Stmt[];
  readonly reason?: string;
}
// Emitted method bodies always carry their declaration and statement arrays.
export interface LoweredMethod extends Method {
  readonly locals: readonly Local[];
  readonly body: readonly Stmt[];
}
// Omitted calls inspect only the result type, never a returning field name.
export interface FactorySignature {
  readonly name: string;
  readonly params: readonly IR.Param[];
  readonly returning?: {readonly type: IR.Type} | null;
}
export interface UnsupportedMethod {
  readonly name: string;
  readonly unsupported: string;
  readonly params?: readonly IR.Param[];
  readonly returning?: IR.Field | null;
  readonly static?: boolean;
  readonly private?: boolean;
  readonly abstract?: boolean;
}
export interface Class extends Omit<IR.Class, 'attributes' | 'methods' | 'constructor' | 'stubs' | 'signatures' | 'super'> {
  readonly attributes: readonly Attribute[];
  readonly methods: readonly Method[];
  readonly constructor: Method | null;
  readonly stubs?: readonly Method[];
  readonly signatures?: ReadonlyMap<string, Method | UnsupportedMethod>;
  readonly super?: string | null;
}
// A struct definition as the emitter consumes it: the DDIC fields resolved.
export interface StructDefinition extends StructType { readonly fields: readonly IR.Field[] }
export type StructDefinitions = Map<string, StructDefinition>;
export type LiteralValue = string | number | {readonly [name: string]: LiteralValue | undefined};
export interface Constant {
  readonly type: IR.Type;
  readonly value?: LiteralValue | Expr;
  readonly go?: string;
  readonly init?: Expr;
  readonly fieldInits?: Readonly<Record<string, Expr | undefined>>;
}
export interface DatabaseTable extends IR.DatabaseTable {
  readonly row?: IR.Type;
  readonly why?: string;
  readonly hidesClient?: string;
}
export interface Rtti {
  readonly classSupers: ReadonlyMap<string, string | null>;
  readonly structs: ReadonlyMap<string, readonly {readonly name: string; readonly kind: string}[]>;
  readonly known: ReadonlySet<string>;
}
export interface AmcChannel {
  readonly applicationId: string;
  readonly path: string;
  readonly scope: string | undefined;
  readonly type: string;
  readonly authorities?: readonly {readonly path?: string; readonly program?: string; readonly activity?: string}[];
}
export interface FunctionModule extends Omit<IR.FunctionModule, 'sig' | 'module'> {
  readonly module: Exclude<IR.FunctionModule['module'], IR.Method> | Method;
  readonly sig: Method | UnsupportedMethod;
}
export interface Program extends Omit<IR.Program, 'functionModules' | 'classes' | 'consts' | 'tables' | 'exceptionSupers' | 'reg' | 'structs' | 'interfaceAttrs' | 'intfOwnAttrs' | 'interfaceMethods' | 'sigs'> {
  readonly classes: readonly Class[];
  readonly ownershipSafety?: OwnershipSafetyMap;
  readonly functionModules?: Map<string, FunctionModule>;
  readonly reg?: IR.Program['reg'];
  readonly structs: StructDefinitions;
  readonly interfaceAttrs?: ReadonlyMap<string, readonly Attribute[]>;
  readonly intfOwnAttrs?: ReadonlyMap<string, readonly Attribute[]>;
  readonly interfaceMethods?: ReadonlyMap<string, readonly Method[]>;
  readonly sigs?: ReadonlyMap<string, Method | UnsupportedMethod>;
  readonly consts?: Map<string, Constant>;
  readonly tables?: readonly DatabaseTable[];
  readonly exceptionSupers?: Readonly<Record<string, string>>;
  readonly rtti?: Rtti;
  readonly amcChannels?: readonly AmcChannel[];
}
// Legacy callers can pass a class array with no program metadata.
export type ClassList = Class[] & Partial<Program>;
export type ProgramInput = Program | ClassList;
// superClassGo reads the RTTI the emitGo caller has already gated on.
export interface ProgramWithRtti extends Program { readonly rtti: Rtti }
export interface Layers extends Omit<SymbolLayers, 'classes' | 'consts' | 'structs' | 'tables'> {
  readonly classes?: readonly Class[];
  readonly consts?: Map<string, Constant>;
  readonly structs?: StructDefinitions;
  readonly tables?: readonly DatabaseTable[];
}
export interface Signature {
  readonly params: readonly {readonly type?: IR.Type}[];
  readonly returning?: {readonly type: IR.Type} | null;
}
export interface ClassName { readonly name: string }
// Interface signatures do not inspect their class argument (AMC passes {}).
export interface InterfaceClassName { readonly name?: string }

// Optional metadata probes intentionally read absent properties as undefined.
// Actual type switches use IR.Type, not this inspection view.
export type TypeProbe = IR.Type & {
  readonly len?: number;
  readonly dec?: number;
  readonly name?: string;
  readonly go?: string;
  readonly stable?: boolean;
  readonly row?: TypeProbe;
};
export interface Descriptor { readonly name: string; readonly type: TableType | StructType }
export interface NamedDescriptor { readonly name: string; readonly text: string }
export interface TryFrame { level: number; mode: 'body' | 'catch'; used: Set<number> }
export interface SinkSite { locals: readonly Local[]; depth: number }
export type SunkLocals<Body extends readonly object[] = readonly Stmt[]> = Map<Body, readonly Local[]>;
export interface Context {
  readonly cls: Partial<Omit<Class, 'constructor'>>;
  loop?: number;
  inCtor?: boolean;
  method?: Partial<Method>;
  staticStores?: Map<string, string>;
  sunkLocals?: SunkLocals;
  sinkSites?: SinkSite[];
  valueOutputs?: Set<string>;
  lrow?: string;
  builders?: Map<string, string>;
  loopLevel?: number;
  loopStack?: Loop[];
  tries?: TryFrame[];
  tryBuilderBlocked?: boolean;
}
export interface MethodContext extends Context { readonly cls: Class; readonly method: Method; loop: number; sinkSites: SinkSite[] }
// What frontend-owned stores in Ownership.declarations: locals and attributes.
export type OwnedDeclaration = IR.Field | SupportedAttribute;
export interface Ownership {
  readonly declarations: ReadonlySet<OwnedDeclaration>;
  unescaped(p: Expr | null | undefined, ctx: Context): boolean | undefined;
  width(p: Expr | null | undefined, ctx: Context): number | undefined;
  fixed(p: Expr | null | undefined, ctx: Context): number;
  has(p: Expr | import("./emit-ownership.ts").AttributeProbe | null | undefined, ctx: Context): boolean | undefined;
}
export type RenderExpr = (e: Expr, ctx: Context) => string;
export type RenderType = (t: IR.Type) => string;
export type RenderName = (name: string) => string;
export type MovePair = (st: Stmt, next: Stmt | undefined, ctx: Context, previous: Stmt | undefined) => boolean;
export type AnalyzeTableMoves = (program: ProgramInput, stable: (t: TypeProbe) => boolean | undefined, goType: RenderType) => MovePair;
export type ConstructorFactories = Map<string, {readonly canOmit: boolean; readonly args: readonly Argument[]}>;
export type AnalyzeOwnership = (program: ProgramInput) => Ownership;
export type SinkLocals = (method: Method) => SunkLocals;
export type GeneratedBindings = (source: string) => Set<string> | null;
export type OmittedFactoryCall = (program: ProgramInput, cls: Class, method: Method) => Expr;
export interface ExprHelpers {
  readonly ownership: Ownership;
  readonly expr: RenderExpr;
  readonly place: RenderExpr;
  readonly helper: RenderName;
}
export interface StatementHelpers extends ExprHelpers { readonly rowValue: (table: IR.Type, item: string) => string }
export type OwnedExpression = (e: Expr, ctx: Context, helpers: ExprHelpers) => string | null;
export type OwnedStatement = (st: Stmt, ctx: Context, indent: string, helpers: StatementHelpers) => string[] | null;
export type EmitByteConcat = (st: Extract<Stmt, {s: 'concat_bytes'}>, ctx: Context, indent: string, expr: StatementHelpers['expr'], place: StatementHelpers['place'], rowValue: StatementHelpers['rowValue']) => string[];
export type ByteStatement = Extract<Stmt, {s: 'replace_bytes' | 'replace_chars' | 'find_bytes_all' | 'find_bytes'}>;
export interface ByteContext extends Context { loop: number }
export type EmitByteStatement = (st: ByteStatement, ctx: ByteContext, indent: string, helpers: Pick<ExprHelpers, 'expr' | 'place'>) => string[];
export type EmitBuiltinGo = (e: Builtin, args: readonly string[], names: ReadonlyMap<string, string>, imports: Set<string>) => string;
export type EmitPackedInt8 = (e: Conversion, render: (e: Expr) => string, helper: RenderName) => string | null;
export type EmitPackedComparison = (c: Condition, render: (e: Expr) => string) => string | null;
export type ExceptionClass = (cls: Partial<Pick<Class, 'name' | 'super'>> | null | undefined, classes: ReadonlyMap<string, Class>) => boolean;
export interface RttiHelpers { readonly goType: RenderType; readonly ident: RenderName }
export type ObjectRttiGo = (program: ProgramInput, helpers: RttiHelpers) => string[];
export interface MessageHelpers extends RttiHelpers {
  readonly classes: ReadonlyMap<string, Class>;
  readonly poly: ReadonlySet<string>;
  readonly ancestorsOf: (cls: Class) => Class[];
}
export type NativeMessageText = (program: ProgramInput, helpers: MessageHelpers) => string[];
export interface ConstantHelpers {
  readonly fields: StructDefinitions;
  readonly expr: RenderExpr;
  readonly zero: RenderType;
  readonly ident: RenderName;
  readonly struct: (type: StructType, value: string) => string;
}
export type LocalConstant = (constant: Constant, helpers: ConstantHelpers) => string | undefined;
export interface ConstantDeclarationHelpers { readonly js?: false; readonly type: RenderType; readonly literal: (constant: Constant) => string }
export type LocalConstantDeclarations = (constants: ReadonlyMap<string, Constant>, helpers: ConstantDeclarationHelpers) => string[];

// Object walkers inspect a few fields and recurse over all remaining values.
// They do not turn a generic walk into an expression/statement emitter.
export interface WalkNode {
  readonly e?: string;
  readonly s?: string;
  readonly name?: string | Expr;
  readonly owner?: string | null;
  readonly target?: Expr | null;
  readonly table?: Expr | string | boolean;
  readonly [key: string]: unknown;
}
export type EmitGo = (program: ProgramInput, pkg?: string, layers?: Layers | null, unitBuild?: boolean, symbols?: SymbolCollector | null) => string;
