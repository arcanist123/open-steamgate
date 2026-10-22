# objstore -- ZOSD_STORE over abapGit-named files

What: the object store of the Go host, `CALL FUNCTION 'ZOSD_STORE' DESTINATION 'STORE'` answered over the
files the Node host answers it over (tools/osd-store.mjs, tools/osd-store-destination.mjs); filesystem reads
(LIST, READ, OBJECT, PACKAGE, PACKAGES, SEARCH), history from git, and writes. An injected `Compiler`
supplies CHECK and PARSE kind OUTLINE snapshots; ACTIVATE and TOKENS are still refused. go/abap keeps
`SetStore`, `StoreCall`, the `Store*` type aliases and the
session-first `ZOSD_STORE` adapter (Data in, tables filled).

The compiler boundary uses neutral contracts in `storecheck`; objstore keeps API
aliases, resolution and answer assignment. It captures provider, generation,
file hashes and a store revision under the mutex, then runs CHECK, CHECKRUN and
OUTLINE outside it. A concurrent WRITE, SetStore or SetCompiler rejects the
answer as STALE_RESULT; saved target bytes are rechecked after the call too.
`storecompiler.Adapter` supplies snapshots to the lifecycle-owning client.
CHECKRUN uses Node's shared report builder, including AMDP portability warnings,
and ignores optional includes for saved-source syntax checks. Standalone CHECK
and PARSE refusals remain unchanged. IV_SOURCE still requires a saved draft on
the default Go snapshot path; `tools/gogen/storecmp.mjs` ratchets that contract-v1 gap.
The opt-in ABAP lint provider accepts CHECKRUN SOURCE, including an absent object
or class include. Capture retains the saved main filename, or the first writable
root's `osd/<name>` target for a new object, without creating it. Generation
changes between ABAP CHECKRUN requests are accepted; changes during a request
still reject the result. Ordinary CHECK/OUTLINE keep their snapshot guards.

SYSTEM is tree-independent. `CallWithSystem(in, provider)` uses the explicitly
passed request's `SystemProvider`, whose `System(kind, name, input)` method
returns the value Node's withSystem callback would return, or an error. Nil
preserves `Call` byte for byte: only the installed IDENTITY answers; other
known kinds keep their existing refusals. The callback runs outside the store
mutex, so it can call back into ABAP or yield without holding the store.
The provider is never cached on the store or installed as a current request.

API: `SetStore(root string, cfg []byte, reason string) error`;
`SetSystemIdentity(Identity)`; `Call(in map[string]*string) Answer`;
`CallWithSystem(in map[string]*string, SystemProvider) Answer`;
`Config`/`Root`, `Answer` with `Row`, `Issue`, `Tally`, `Revision`;
`Identity`; `Capabilities`.

Invariants: the files are the truth and git the history, no second copy; the index is rebuilt per call; a
WRITE touches only a file inside a writable root; answers and their order match the Node destination field
for field (localeCompare order, JSON property order, and the scalar/table envelopes). The frozen proof is
`test/fixtures/osgo-store/destination-golden.json`: `tools/osgo-store-goldens.mjs` records the Node
destination, `tools/gogen/go/objstore/golden_test.go` compares Go, and `test/osgo-store-goldens.mjs` fails on
drift. A refusal is `EV_ERROR`, never a panic. No import of go/abap, no Session.

`LintCache.Capture` shares the uncached `CaptureLintView` traversal and ordered
content digest. A compiler owns one cache under its mutex; no process-global
cache or store active-version proof changes. On Linux, allowlisted regular files reuse raw
bytes and SHA-256 only when device, inode, size, mode, mtime and ctime all match
and both timestamps predate the cached read's start by more than two seconds.
The walk supplies project stats; explicit library entries are statted separately.
Changed/racy files are read and hashed, with another stat to reject a read-time
identity change. Each capture replaces cache membership, evicting absent files.

The timestamp window is racy-git style: eligibility uses the *previous read's*
start, so waiting alone never makes a potentially racy cached read eligible.
The default covers timestamp granularity up to two seconds; callers using
coarser filesystems must increase `LintCache.Granularity`, or set it negative to
force full reads. A nil cache also forces full reads. Other operating systems
and unsupported file identities always read until their change-time identity
has a tested implementation. Linux `statfs` must identify ext2/3/4, XFS,
Btrfs, tmpfs, ZFS or F2FS. Every capture memoizes probes by containing directory
and followed-file device; it probes the file to follow symlinks into other
mounts. Nested/bind mounts thus get their own filesystem decision. NFS,
CIFS/SMB, 9p, FUSE, unknown types and probe failures always read. Overlayfs is
excluded because its type cannot establish coherence of the backing layers.

`lintinput.New` reads `OSD_LINT_STAT_CACHE=auto|off` (default auto) and
`OSD_LINT_STAT_CACHE_WINDOW` (Go duration >=2s, default 2s) once at construction.
Off or invalid settings select full reads; the window never overrides the
allowlist. A filesystem clock consistent with the host is still required for
reuse. Full reads preserve open/read semantics, not stronger coherence than the
filesystem provides. This remains a two-pass freshness check, not an atomic
filesystem transaction.
