# go/abap package plan

Answer to "do we need ultracode for this?": mostly no. The file map is done. Waves 0 to 4 are mechanical moves of 20 to 1,300 lines each, and their seams are now checked against the emitter's calling convention. Ultracode would pay in one place, the go/osql design in wave 5. Those questions are about types and the emitter: `Type`/`Data` crossing the boundary, `abap.Table`/`abap.IRType` literals in generated code, `s.Sy.*` writes, and the host templates in three `.mjs` files. A single agent working file by file tends to miss something there. Use ultracode as a design review before that cut, not for the cut itself.

Facts checked in rel05 (origin/main 9e04d04c):
- `go/abap` is 16,926 lines, and go.mod is `go 1.26`.
- The emitter always calls a host function with the session first. emit-go.mjs:1355 (`call_fm`, params form `helperFn(fn)(s, map[string]abap.Data{...})`), :1369 (`native` with args), :1372 (`native` with method params) and :1377 (`kernel_loop`) all write `s` as the first argument. A function a frontend.mjs row names directly must therefore take `*abap.Session`, and so its package imports go/abap. go/tstmpsecs is the precedent: `SubtractSecs(s *abap.Session, ...)` at tstmpsecs.go:20.
- `helperFn` (emit-go.mjs:117-122) turns a `pkg.Fn` row into an `hPkg` alias import. That only spares an emitter change for packages that accept `*abap.Session`.
- The only `init()` in go/abap is events.go:99 (`session.Register`).

## 1. Clusters

| package | files | lines (src+test) | role |
|---|---|---|---|
| **abap** (core, stays) | abap, apc, appendbytes, conv, data, datesplit, find, regexclass, gencmp, gencmpnum, genarith, move, movecorr, packed, raise, random, registry, row_binding, seckey, shift, strings, sysinfo, unitdump, uuid, unit_session, icf, events (see 2), the statement half of dataset, the `NewData`/`CreateDataByName` half of tables, session-first wrappers for every carved pure package | ~7.1k | ABAP value semantics, exceptions, OO registry, ICF kernel, row-facing wrappers |
| **abaperr** (w0, leaf) | `HostError` (icf.go:86-95), `ArithmeticError` (abap.go:48-51), `NotCompiled` (conv.go:527) | ~40 | the error types the dispatcher and generated code recover by type |
| **nodehdr** (w0, leaf) | `nodeFirstWins` (icf.go:144) and the duplicate-header merge rule (icf.go:179, httpc.go:452-460) | ~30 | Node's header-joining table, shared by ICF and httpc |
| **osql** (w5) | db, db_sqlite/db_wasm/db_nodatabase, db_image_test, dbstore, dbraw (DBX*), dbwrite, icf_db(+test), irsql(+test), osqlwhere(+test), ranges(+test), select, selectdyn, luw(+test), the tables registry(+test), writes_test, knowngaps_test | ~5.0k | Open SQL, LUW, IR, SQLite driver (modernc) |
| **inflate** (w1) | inflate, inflate_test | 590 | resumable DEFLATE decoder |
| **crc32x** (w1) | crc32 | 21 | CRC register combine |
| **sxmlscan** (w1) | sxmlscan | 42 | XML pull byte scanners |
| **gzipx** (w1) | gzip, gzip_test | 113 | raw deflate/inflate |
| **sandbox** (w2) | dataset.go L452-914, dataset_nofollow_{unix,other}, sandbox part of dataset_test | ~800 | DATASET file confinement, browse |
| **objstore** (w2) | store, store_history, store_test, store_history_test | ~1,250 | ZOSD_STORE over abapGit files and git |
| **httpc** (w3) | the client part of httpc.go (not `GunzipWithHeader`/`EncodeBase64`), httpc_test | ~780 | Node-compatible HTTP/1.1 client |
| **jsonx** (w3) | jsonparse (parser half), jsonparse_test | ~440 | JSON.parse-compatible node list, JS number text |
| **media** (w3) | w3mi.go L1-96 | ~100 | SMW0 index and cache |
| **fdlibm** (w4) | trig, trig_libm, trig_test | 263 | V8-identical sin/cos |
| **codepage** (w4, optional) | codepage, codepage_test | 87 | utf8/utf16le/cp1252 |
| **frontend** (w4, after sandbox) | frontend, filedialog, both tests | ~470 | CL_GUI_FRONTEND_SERVICES subset (a row adapter that imports abap) |

events stays in core in this plan. Section 2 gives the generic variant that would let it move later.

## 2. New packages

There are two kinds of carve. The emitter always passes `s` first, so the kind decides whether the package may import go/abap.

1. **Pure package** (the default). It does not import go/abap. It takes no `*Session` and no `abap.Data`, and it panics only with `abaperr` types or returns its own error. A **session-first wrapper of the same name stays in go/abap** (`func X(s *Session, ...)`), so frontend.mjs rows and emit-go.mjs stay unchanged. Because `abap.HostError`, `abap.ArithmeticError` and `abap.NotCompiled` become aliases of the `abaperr` ones, a panic raised inside the pure package is recovered by type exactly as before. The panic sites are a move, not a rewrite.
2. **Row adapter** (the explicit exception to "new packages must not import go/abap"). A package that a row calls directly, or that must see `abap.Data`, imports go/abap and takes `*abap.Session`. go/abap never imports it, so there is no cycle. go/tstmpsecs, go/filepick and go/reportargs already work this way. frontend is the only new one in this plan.

The emitter could drop the session for flagged rows (a `noSession` flag at emit-go.mjs:1355/1369/1372/1377). That is out of scope here, and nothing below depends on it.

### abaperr (wave 0, prerequisite)
```go
package abaperr
type HostError struct{ Where, Text string }          // was icf.go:86-95
func (e HostError) Error() string
type ArithmeticError struct{ Class, Op string }      // was abap.go:48-51, field order kept
func NotCompiled(method, reason string) ArithmeticError
```
- go/abap: `type HostError = abaperr.HostError` and `type ArithmeticError = abaperr.ArithmeticError` are aliases, and `func NotCompiled(m, r string) ArithmeticError { return abaperr.NotCompiled(m, r) }`. These keep compiling:
  - the positional literals `HostError{where, text}` and `ArithmeticError{"NOT_COMPILED", ...}`
  - generated `abap.ArithmeticError{Class:..., Op:...}` (emit-go.mjs:1351)
  - `httpc.mjs:257 case abap.HostError` and `cmd/osgo/gitprobe_test.go`
- What it unblocks: httpc (10 NotCompiled, 2 HostError), codepage (4+), jsonx (jsonparse.go:222), media/w3mi (~11) and inflate/gzip.
- Session fields: none.
- README: "Leaf error types the dispatcher and generated code recover by type. No imports. Aliased in go/abap."

### nodehdr (wave 0, prerequisite)
`var FirstWins map[string]bool` (was `nodeFirstWins`, icf.go:144) and `func Merge(name, old, new string) string`. Merge is the first-wins / ", " / set-cookie rule that icf.go:179 and httpc.go:452-460 both apply. Core icf.go imports it. README: "Node's IncomingMessage duplicate-header rule. One table for server and client."

### inflate (wave 1)
```go
type Registry struct{ /* m map[int32]*inflater; seq int32 */ }
func (r *Registry) Open() int32
func (r *Registry) Feed(h int32, data string, maxOut int32) (raw string, state int32, unused string, reason string)
func (r *Registry) DropAll()
```
- Session fields: `Session.inflate` and `inflateSeq` (abap.go:42) become one `inflate *inflate.Registry` field, created lazily.
- `EndTestClass` (unit_session.go:10-16) gains `if s.inflate != nil { s.inflate.DropAll(); s.inflate = nil }`. That cleanup is missing today, so it is a behaviour fix and gets its own test.
- Generated code is unchanged. frontend.mjs:701-702 still names `abap.InflateHostOpen/Feed`, backed by ~15 lines of session-first wrapper in core.
- README: "What: streaming DEFLATE mirroring ZCL_OSD_INFLATE. API: Registry.Open/Feed/DropAll. Invariant: reason texts are the ABAP class's texts byte for byte; a failed feed drops the handle."

### crc32x (wave 1)
`func Combine(crc, data string) string`. The core wrapper at crc32.go:12, `abap.CRC32Combine(s, ...)` or whatever the row names, stays and forwards. frontend.mjs:698 is unchanged. README: "MSB-first, non-inverted CRC-32 register; pure."

### sxmlscan (wave 1)
`NameEnd(part string) int32`, `SpaceEnd(part string) int32`, `Utf8Text(part string) (string, bool)`. The three core wrappers (sxmlscan.go:11/23/37) stay session-first and forward. frontend.mjs:705-707 is unchanged. README: "Byte scanners for ZCL_OSD_SXML_PULL; pure, no allocation beyond the result."

### gzipx (wave 1)
- API: `DeflateRaw([]byte) ([]byte, error)` and `InflateRaw([]byte) ([]byte, error)`. Truncated input gives partial output and a nil error, and bad data gives an error.
- Core wrappers: the session-first `abap.DeflateRaw/InflateRaw` (gzip.go:19/41) stay and panic with `HostError{.., "zlib: "+err}`. `abap.GunzipWithHeader` (httpc.go:620-633) is also a row-facing wrapper. It moves to the core gzip wrapper file in wave 3 and calls `gzipx`; it does not move into gzipx.
- README: "Node-zlib-compatible raw DEFLATE."

### sandbox (wave 2, stoker)
The interface is kept exactly as dataset.go:27-50 has it:
```go
type Mode string                         // "INPUT" | "OUTPUT" | "APPENDING" | "UPDATE"
const (Input Mode = "INPUT"; Output = "OUTPUT"; Appending = "APPENDING"; Update = "UPDATE")
type Handle interface{ ReadAt(pos int64, n int) ([]byte, error); WriteAt(int64, []byte) error; Size() (int64, error); Close() error }
type Host interface{
    Open(name string, mode Mode) (Handle, string) // "" = ok; else the MESSAGE text, sy-subrc 8
    Delete(name string) bool                      // false = nothing to delete
}
type Sandbox struct{...}   // implements Host + Browse*
func FromEnv() *Sandbox  // with neither root set it refuses everything
```
- go/abap keeps the statement half (OpenDataset, ReadDataset and the rest) with these aliases:
  - `type DatasetMode = sandbox.Mode`, with `const DatasetInput = sandbox.Input` and the others
  - `DatasetHandle = sandbox.Handle`
  - `DatasetHost = sandbox.Host`
  - `SetDatasetHost` stays

  The MESSAGE/sy-subrc handling and the callers are therefore unchanged: cmd/osabap/main.go:186, go/filepick, frontend.go.
- Session fields: none. The per-session `datasetFiles` sync.Map and `CloseSessionDatasets` stay in core.
- Generated code is unchanged.
- Build tags: `dataset_nofollow_unix.go` (`unix`) and `dataset_nofollow_other.go` (`!unix`) travel together. The matrix includes `GOOS=js GOARCH=wasm` for sandbox, where `_other` is the one that compiles.
- README: "Deny-by-default file roots (OSD_DATASET_READ/WRITE) via os.Root; no symlinks; audit log."

### objstore (wave 2, dell)
- API, real signature kept: `SetStore(root string, cfg []byte, x string) error` (as at cmd/osgo/main.go:474 and cmd/storecmp/main.go:26), `Call(args map[string]*string) Answer`, `Revision`. There is no Session today and none after.
- Core forwarders stay:
  - `abap.SetStore(root, cfg, x)`, called by semantics.mjs:827 and the cmd hosts
  - the ~75-line `abap.ZOSD_STORE` adapter (Data to map, session-first, params form), so frontend.mjs:945 is unchanged

  With these forwarders, semantics.mjs and unit.mjs need no change in this wave. cmd/osgo and cmd/storecmp may call `objstore.SetStore` directly, or keep the forwarder.
- `fmArg` (w3mi.go:98, used by store.go:870-883) must already be in a core helper file from wave 0. A build without w3mi.go fails on `undefined: fmArg`, which confirms this.
- README: "ZOSD_STORE over abapGit-named files; history from git; CHECK/ACTIVATE refused."

### httpc (wave 3)
```go
type Registry struct{...}                 // replaces Session.httpc (abap.go:38)
func (r *Registry) Send(me any, url, method, body string) error
func (r *Registry) DropAll()             // replaces the client.drop() loop in EndTestClass
func SetRoots(*x509.CertPool)            // test hook, was httpcRoots
```
- The header and response accessors take `(r *Registry, me any, ...)`.
- Imports: `abaperr` (its 10 `NotCompiled` and 2 `HostError` panics stay as they are, now with the leaf's types) and `nodehdr` (httpc.go:460). It does not import go/abap.
- Core wrappers keep the `abap.HTTPC*` names, session-first, so frontend.mjs:800-826 is unchanged. Core owns `s.httpc *httpc.Registry`. unit_session.go:11-14 becomes `if s.httpc != nil { s.httpc.DropAll(); s.httpc = nil }`.
- What stays in core: `EncodeBase64` (httpc.go:637-643, a cl_http_utility wrapper over core `EncodeXBase64`) goes to a core helper file. The client never calls it. `GunzipWithHeader` goes to the core gzip wrapper file over gzipx.
- README: "Node-http-compatible client: keep-alive, chunked, JS key order, latin1 headers."

### jsonx (wave 3)
- API: `type Node struct{...}`, `Nodes(json string) ([]Node, bool)`, `NumberString(float64) string`.
- jsonparse.go:222's `NotCompiled` comes from `abaperr`. `abs` (jsonparse.go:340) is file-local and moves with it. jsonparse does not use `quote` (irsql.go:241).
- `FillJSONNodes` stays in core and takes `[]jsonx.Node`. Core keeps `abap.JSONNodes` as a one-line forwarder, so emit-go.mjs:720 is unchanged.
- README: "Strict JSON.parse grammar, key order and number text as V8."

### media (wave 3)
- API: `SetDir(dir string) error`, `Bytes(objid string) ([]byte, bool)`, `Objects() []Entry`, with the ~11 panic sites on `abaperr`.
- WWWDATA_IMPORT and SCMS_BINARY_TO_XSTRING stay in core and call `media.Bytes`.
- `abap.SetMediaDir` stays as a forwarder. Its callers are semantics.mjs:827, unit.mjs:374 and two cmd hosts, so no template changes.
- README: "SMW0 media dir + w3mi.json index, cached."

### fdlibm (wave 4)
`Sin, Cos(float64) float64`. It keeps the tag pairs trig.go (`!libm`) / trig_libm.go (`libm`, cgo) and trig_test.go (`!libm`). Core keeps `abap.Sin/Cos` forwarders, so FN_F at emit-go.mjs:1978 and the keeper at :319 are unchanged. Deleting both trig files leaves core compiling. README: "Bit-identical to V8 Math.sin/cos; test needs node."

### codepage (wave 4, optional)
`Encode(cp, s string) ([]byte, error)`, `Decode(cp string, b []byte, ignore bool) (string, error)`, with `ErrInvalid` and `ErrUnsupported`, or `abaperr.NotCompiled` at the 4+ sites in codepage.go:25-75, kept as they are. The core `abap.EncodeText/DecodeText` wrappers stay, so emit-go.mjs:427-490 is unchanged.

### events (stays in core; optional generic carve later)
It cannot move as planned before. Generated code writes `func(s *abap.Session, EvSender any, EvArgs any)` literals (emit-go.mjs:1339) where `HandlerFunc func(s *Session, ...)` (events.go:34) is expected, and a `func(any, ...)` type is not assignable from them. If a carve is wanted, the only form that needs no emitter change is a generic one:
```go
package events
type HandlerFunc[S any] func(s S, sender any, args any)
type Table[S any] struct{...}
func (t *Table[S]) SetHandler(s S, ...); func (t *Table[S]) Raise(s S, ...)
```
- Core: `type HandlerFunc = events.HandlerFunc[*Session]`, with `abap.SetHandler/RaiseEvent/BoundHandler` as forwarders. The emitted literal is then assignable, since it is the identical underlying type.
- The panics at events.go:126/130/158 use `abaperr`. The `init()` (`session.Register`) moves with it. It still runs, because core imports events through the forwarders.
- This is optional and only after waves 1-3. The gain is 264 lines, and the cost is generics in a hot path.

### frontend (wave 4, after sandbox merges): row adapter, imports go/abap
- This is the stated exception to the no-import rule, like go/tstmpsecs/filepick. abap never imports it.
- It keeps its real signatures:
  - the params-form rows F4_FILENAME / KD_GET_FILENAME_ON_F4 (frontend.mjs:928-929) stay `func(s *abap.Session, p map[string]abap.Data)` (filedialog.go:73/83)
  - the args-form Frontend* rows (frontend.mjs:751-761) keep `s *abap.Session` first, because the emitter passes it
  - frontend.go:56/125 keeps `table *abap.Data`
- Only the rows change, to `frontend.X` through `helperFn`. `currentDatasetHost` is passed in as `func() *sandbox.Sandbox`. `stringTable` moves to a shared `testhelp_test.go` in wave 0.

### osql (wave 5)
osql imports abap (for `Type`/`Data`/`MoveData`), and abap never imports osql.
- **Core-to-osql edges.** A symbol scan found exactly two, `unit_session.go:10` (`CloseUnitDB`, db.go:136) and `apc.go:37` (`DialogStep`, luw.go:191). They are injected, and apc.go and unit_session.go do not move. Core gets `var unitDBClose func()` and `var dialogStep func(func())` with setters. osql's `init()` sets them. Without osql linked, the defaults are a no-op close and a direct call.
- **sy fields.** select.go:22, luw.go:230-250 and dbwrite.go:199-260 write `s.Sy.Subrc` / `s.Sy.Dbcnt`. Core adds `func (s *Session) SetSubrc(int32)` and `SetDbcnt(int32)`, and osql takes `type Sy interface{ SetSubrc(int32); SetDbcnt(int32) }`. Generated code still passes `*abap.Session`, which satisfies it.
- **Emitter.** Emitted `abap.Select/CommitWork/InsertRows/DBC/IRType/Table/Column/...` switch to `osql.X` with a fixed `osg/gogen/osql` import plus a `var _` keeper. The keeper also guarantees osql's `init()` runs. Core forwarders are not an option, because they would reintroduce the import.
- **Host templates in the same PR.** These change:
  - `abap.OpenDB`, `Database.Image`, `CloseUnitDB`, `OpenDBImage`, `BeginUnitLUW`, `Session.UseUnitImage` / `Session.OpenUnitDB` in unit.mjs (since ADR 0010 slice 2 the test class's session owns its copy of the seed image)
  - `abap.OpenDB` and `abap.DialogStep` at semantics.mjs:827
  - gateway.mjs:242
  - cmd/osgo, cmd/osabap and httpc.mjs

  These do not change: `abap.SetStore` and `abap.SetMediaDir` (wave 2/3 forwarders).
- The scope of that list is what the ultracode design review settles.

## 3. Waves

| wave | content | owner | parallel? |
|---|---|---|---|
| 0 | `abaperr` (HostError, ArithmeticError, NotCompiled) and `nodehdr` leaves plus aliases; move `fmArg` to a core helper file; move `EncodeBase64` and `GunzipWithHeader` out of httpc.go into core helper files; move the `str`, `stringTable`, `unhex` test helpers to shared `testhelp_test.go`; move `DerefAs` from dbraw to move.go | one agent, first | must merge before the others; small. **The in-progress wave 1 rebases on it** |
| 1 | inflate (+ the EndTestClass DropAll fix), crc32x, sxmlscan, gzipx, all with session-first core wrappers | carve1 | yes, separate files. Shared touch points: abap.go and unit_session.go (inflate only), and no frontend.mjs rows |
| 2 | sandbox (stoker), objstore (dell) | two worktrees | yes, disjoint files: sandbox touches dataset/filepick, objstore touches store (fmArg moved in w0) |
| 3 | httpc, jsonx, media | one or three worktrees | yes; httpc touches abap.go and unit_session.go, the others do not |
| 4 | fdlibm, frontend (needs w2 sandbox), codepage; events only as the optional generic carve | parallel except frontend | none touches emit-go.mjs (forwarders); frontend edits only its rows |
| 5 | osql (design review first, then one agent, one PR) | single | no: touches all SQL files, emit-go.mjs and unit/semantics/gateway.mjs |

Order rationale: waves 1-3 are the least coupled. They cut the most "foreign" code out of core and serve OSGo and the ADT port now, since store, sandbox and httpc are the host-facing pieces. Wave 5 brings the biggest recompile gain, because modernc.org/sqlite stays out of core-only builds and tests. It also carries the most risk, so it goes last.

Note for the wave 1 work already in progress: the earlier version of this plan said "no shim, switch the row to the args form" for crc32 and sxmlscan. That does not compile, because the emitter passes `s`. Keep the core wrappers, and leave the rows as they are.

Avoiding conflicts on shared files:
- **frontend.mjs / emit-go.mjs**: waves 0-4 need no emitter change (wrappers and forwarders). Only frontend edits its own rows. Wave 5 is the only emitter edit.
- **unit_session.go / abap.go Session struct**: inflate (w1) and httpc (w3) both touch them, in different waves. Each edits its own field and its own `DropAll` line in `EndTestClass`.
- **go/README.md and abap/README.md**: each package carries its own README. go/README.md gets one line per package, appended in alphabetical order and rebased last.
- **ALLOWLIST** (location not found in rel05; it is the list of allowed packages/imports): one line per package, sorted, resolved at merge. Row-adapter packages (frontend) are marked as importing abap.

## 4. What stays in go/abap (~7k lines)

These files stay:
- conv, packed, move/movecorr, data, gencmp*, genarith, strings, find, regexclass, datesplit, shift, raise, registry, abap.go, row_binding, seckey, unitdump
- icf (ICFExchange), sysinfo/uuid/random/appendbytes
- events
- the dataset statement half, NewData/CreateDataByName
- unit_session, apc (with injected osql hooks from wave 5)
- ~350 lines of session-first wrappers and forwarders for the pure packages

Why they stay:
- They are the ABAP language core (value semantics, exceptions, the OO registry) and nearly every emitted `abap.X` name.
- Their pieces depend on each other (`Data` to `MoveData` to packed/conv to `ArithmeticError`), so any cut would need re-exports for dozens of emitter names with no gain.
- The wrappers are the price of the emitter's session-first convention. Each is one to five lines and holds no logic beyond error conversion.
- For token load, split within the package instead: conv.go becomes conv_num/conv_bytes/conv_str/conv_pattern/conv_host, and the generic-table half of data.go goes to its own file. That needs no package or emitter change.

## 5. Risks

- **Entangled files (decide before wave 5):**
  - tables.go:39: `Table` holds `*Type` (core) and `*IRType` (SQL). data.go `Type` does not reference `Table`/`IRType`, so osql importing abap is acyclic.
  - selectdyn.go writes into `Data` through `MoveData`.
  - `XFit`/`XToHex` (conv.go:777, :80) are core, so dbraw needs no cut.
  - ranges.go helpers (`jsLen`, `jsString`, ...) are used only by dbwrite.go and osqlwhere.go, so they move with osql.
- **Hidden globals:**
  - db/tx/stmtCache (luw)
  - datasetFiles (sync.Map keyed by *Session)
  - storeState
  - mediaIndex/cache
  - allHandlers/staticHandlers
  - the row_binding version cache
  - SysID/UName/HostFacts (written by hosts)

  Every per-session one needs a `DropAll/Forget(key)` that `EndTestClass` calls; that is the only fan-out point. Today inflate has none, and wave 1 adds it.
- **init() order**: events.go:99 is the only `init()`. It keeps running while core holds events, or, in the generic variant, while core forwarders import it. If generated code ever bypassed core and imported events directly, unit_session.go must keep a reference, or the reset silently stops. `events_reset_test` is the guard. osql's hook-installing `init()` (wave 5) needs the same guard: a test that a unit run with DB calls closes the DB through the injected hook.
- **Build tags**:
  - `db_sqlite` (`!wasm && !nodatabase`), `db_wasm` (`wasm`), `db_nodatabase` (`nodatabase`) and `db_image_test` (`!wasm && !nodatabase`) move together into osql. cmd/osabap relies on `nodatabase` to keep out the modernc libc.
  - `trig` (`!libm`) / `trig_libm` (`libm`, cgo) / `trig_test` (`!libm`) travel together.
  - `dataset_nofollow_unix` (`unix`) / `_other` (`!unix`) travel together.
  - The matrix runs for each wave: default, `-tags nodatabase`, `GOOS=js GOARCH=wasm` (including the sandbox package), and `-tags libm`.
- **Tests reaching internals**:
  - unit_session_test (`s.httpc`, `httpcOf`, fake DatasetHost)
  - dataset_test (`datasetFiles`, `datasetSwap`)
  - frontend_test/filedialog_test (store_history_test moved to go/objstore) (shared `str`/`stringTable`)
  - gzip/inflate/httpc tests (`unhex`)
  - httpc_test (`httpcRoots`, which becomes `httpc.SetRoots`)
  - row_binding_cache_test and foldeq_test (unexported, cannot move)
  - osqlwhere/writes/ranges tests, which share `newGaps`/`pairsFile`/`lowered`

  Wave 0 moves the shared helpers. Fixture paths `../../../../test/fixtures` still resolve because go/osql is at the same depth.
- **Error identity**: generated code and the dispatcher recover `ArithmeticError`/`HostError` by type, with `NotCompiled` as an `ArithmeticError`. With `abaperr` and type aliases, a panic from a pure package is the same type as one from core, with no conversion at the wrappers. Any package that defines its own error type instead must convert it in its core wrapper, or a CATCH stops matching and the result is a silent dump or pass. The JS-vs-Go parity corpus (100%) is the guard: run it for each wave, not only `go test`.
- **Calling convention**: a function named directly in a frontend.mjs row gets `s *abap.Session` first (emit-go.mjs:1355/1369/1372/1377). A pure package's function can never be the row target, only its core wrapper can. Reviewers check every row a carve touches against this rule.
- **Package name clashes**: the new packages are named crc32x and gzipx, not crc32 or gzip, to avoid the stdlib names. `helperAlias` already protects generated code from ABAP local names.

## Changes after review

- **Cycles, error types.** The leaf is `abaperr` and holds `ArithmeticError` and `NotCompiled`, not only `HostError`. go/abap keeps them as aliases or forwarders, so the panic sites in httpc, codepage, jsonparse, w3mi and events move unchanged.
- **Cycles, httpc.** `nodeFirstWins` (icf.go:144, used by icf.go:179 and httpc.go:460) moves to a new leaf, `nodehdr`, in wave 0. `EncodeBase64` (httpc.go:641, which calls `EncodeXBase64`) and `GunzipWithHeader` stay in core as row wrappers in helper files. The client never uses them.
- **Cycles, frontend.** Importing go/abap is now stated as the explicit row-adapter exception, like tstmpsecs/filepick. Its `*abap.Session` / `abap.Data` signatures are kept (filedialog.go:73/83, frontend.go:56/125).
- **Calling convention.** The emitter always passes `s` first (emit-go.mjs:1355/1369/1372/1377). "No shim, switch to the args form" is withdrawn: crc32, sxmlscan, gzip and all pure packages keep session-first core wrappers, and the frontend.mjs rows stay as they are. This is flagged to the wave 1 work in progress.
- **events.** It stays in core. A `func(any, ...)` HandlerFunc cannot accept the emitted `func(s *abap.Session, ...)` literals (emit-go.mjs:1339). The only carve without an emitter change is the generic `HandlerFunc[S]` with an instantiated alias in core, which is now optional. Its NotCompiled panics are covered by `abaperr`.
- **osql.** The `s.Sy.*` writes go through new `Session.SetSubrc/SetDbcnt` methods and an osql `Sy` interface. The only core-to-osql edges, `CloseUnitDB` (unit_session.go:10) and `DialogStep` (apc.go:37), are injected through hooks that osql's `init()` sets. apc.go and unit_session.go do not move. The emitter gets a fixed osql import. unit.mjs, semantics.mjs and gateway.mjs are updated in the same PR.
- **sandbox.** The interface now matches the code: string `Mode`, `Open(...) (Handle, string)`, `Delete(...) bool`. Callers and the sy-subrc 8 / MESSAGE handling are unchanged.
- **objstore.** It keeps the real `SetStore(root, cfg, "")` signature. `abap.SetStore` and `abap.SetMediaDir` stay as forwarders, so semantics.mjs:827 and unit.mjs:374 need no change. The `fmArg` move in wave 0 is confirmed necessary.
- **inflate.** The touch points are named: the Session field (abap.go:42) and unit_session.go. `EndTestClass` gains the missing inflate `DropAll`. Both inflate and httpc touch abap.go and unit_session.go, in different waves.
- **Risks.** The claim "db/tx used by httpc.go (`conn()`) and apc.go" is dropped. It does not exist in rel05, and apc reaches SQL only through `DialogStep`.
- **Verified clean** and recorded: trig, crc32, sxmlscan, gzip, inflate; `abs` is jsonparse-local and `quote` is unused by it; `Type` does not reference `Table`/`IRType`; `XFit`/`XToHex` are core; the ranges helpers are osql-only.
- **Build matrix.** It adds `GOOS=js GOARCH=wasm` for the sandbox package.