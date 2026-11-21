# Activation and ABAP Unit on osgo

osgo is a built generation. The binary carries the compiled classes and no
transpiler and no Go toolchain, so it cannot turn saved ABAP into running
code. The Node host can: its activation rebuilds the JS generation and swaps
it in (`tools/adt-facade.mjs`, `docs/warm-compile.md`). This page records what
osgo does instead and what a client sees.

## The decision: check, publish, and say that a rebuild is needed

Three options were on the table:

- **(a) Activation is a syntax check plus a change of state in the store.**
  The check is the one osgo already answers for `checkruns` (the configured
  compiler provider, the Go lint engine by default). A clean object becomes
  active in the object store. The running code stays the generation the
  binary was built from, and the answer says so.
- **(b) Delegate the compile to a sidecar** `osd`/Node when one is present.
  A sidecar can transpile, but it produces JavaScript, and osgo cannot load
  JavaScript. A sidecar-produced generation would have to be compiled with
  gogen and Go and the server restarted. That is a rebuild of the binary
  under another name, and it needs Node, Go and the whole tree. It belongs
  to the self-hosting track.
- **(c) gogen in process.** This is the self-hosting goal. It is not
  available yet.

**Chosen: (a).** Nothing in the code offered a better route. `objstore`
already keeps an in-memory active version for created classes, and the
inactive set is already the store's. Activation now uses both.

## What a client sees

`POST /sap/bc/adt/activation?method=activate` (`go/adtactivate`):

1. The objects named in the body are checked one by one with CHECKRUN over
   the saved source. `forced=true` skips the check, as on Node, and
   `checkExecuted="false"` says so.
2. If any check reports an error, the answer is the activation failure
   document that the Node host sends: `activationExecuted="false"`, the
   "Activation was cancelled" warning, and one `msg type="E"` per issue,
   each with its `#start=line,column` link. The objects stay inactive.
3. If the check cannot run (no compiler provider, `notProcessed`), the
   activation is refused with that reason as an error message. An
   unchecked activation would be a guess. `forced` is the way past it.
4. If every check is clean, each object becomes **published**. The working
   source becomes the object's active version in the store
   (`objstore.Activate`), it leaves the inactive list, and
   `?version=active` reads it.
5. The success document has `activationExecuted="true"`. Two cases:
   - All the objects are still the bytes this binary was built from (the
     usual Eclipse "activate" of an unchanged object). The answer is the
     Node success document byte for byte, `generationExecuted="true"`.
   - The source changed since the build. The answer has
     `generationExecuted="false"` and one `msg type="W"` per such object,
     which says that the object is active in the store and that this osgo
     binary keeps running the code it was built with until it is rebuilt
     from this tree. Clients (abap-adt-api, Eclipse) count a warning as a
     successful activation. The `X-OSD-Build` header says `published;
     rebuild osgo to run it`, so the VS Code extension shows the same thing.

The **published** state outlives the process (ADR 0010 slice 4): activation
writes `build/osgo-published/index.json` (file -> snapshot, digest) beside the
snapshots, and every osgo process restores it at start
(`objstore.RestorePublished`), so a restart or a replacement of the same
build still reads the published source as active. A snapshot the starting
build was built from is active there and is not restored. The write merges
with the index on disk rather than replacing it from the writing process's
own view: a session pinned to a draining generation can activate while
another has published, and an entry the other generation wrote is kept. A
drop (the working file is the build's own bytes) removes only the entry the
process itself published, or one naming the bytes the starting build was
built from. The files on disk
are untouched by activation. A rebuild of osgo from the tree (`node
tools/gogen/osgo.mjs`) makes the code live.

**Behind the gateway with a builder** (`osgw -build ...`, `go/osgw` "The
generation swap"), the sidecar runs with `-gateway-builds`: a publishing
activation answers `X-OSD-Build: published; building b<n>` (the gateway puts
the build's id in) and the warning says the gateway is building a new
generation; once it serves, `/osd/serving` says `X-OSD-Build: live <it>`, the
next answer carries the new `X-OSD-Generation`, and the unit run's 409 is gone
because the serving binary was built from the published source. While any
object of the tree is inactive nothing is built (`published; not building: n
inactive object(s) would enter the build`): the build reads the tree, and an
inactive object's working source would go live unactivated. The gate is
sampled twice: once when the activation answer is composed (the header
above), and again by the gateway right before the builder runs -- it asks
every generation that still takes requests (`GET /osd/inactive`), because a
save that is not activated can land in the debounce window between the
answer and the build; such a build fails with the count as its reason, and
the next activation that leaves nothing inactive builds. A save made while
a build runs is the remaining window.

A batch is all or nothing (`objstore.ActivateAll`): every object is resolved
and every file read and snapshotted before any active version changes, so a
missing object or an unreadable file cancels the whole activation with
nothing published. The published bytes are also copied to an immutable,
content-named snapshot under `build/osgo-published/`, which is what the
compiler reads for the active version (the active outline), so active READ
and active PARSE agree, and a later save does not change either.

Preaudit and the inactive objects: `preauditRequested` is accepted and
ignored, as on Node. A successful activation removes its objects from
`GET /activation/inactiveobjects`. A failed one leaves them there.
Dependents are not checked against the new source (Node checks them before
it builds). On osgo nothing is built, so a dependent cannot break the
running generation.

## ABAP Unit on osgo

`POST /sap/bc/adt/abapunit/testruns` and `.../testruns/evaluation`
(`go/adtunit`) run tests **in process**, against the test classes compiled
into the binary:

- `tools/gogen/osgo.mjs` compiles the test include of the owners listed in
  `OSGO_UNIT_OWNERS` (comma-separated). The default is `ZCL_ZOSD_TEST_DEMO`,
  the ADT and ABAP-FS fixture with one pass and one deliberate failure.
  `--unit-owners A,B` sets the list. `--unit-owners none` compiles none. It
  writes `zz_unit.go`, which holds the test classes, their methods, their
  risk and duration, their source lines, and closures that call setup,
  teardown and each method.
- Each test class runs with a fresh `abap.Session` (its own class statics)
  on a private in-memory copy of the seed database
  (`Session.OpenUnitDB`). The image is built once per process from the
  binary's own seed script. The copy is the test session's own database
  (ADR 0010 slice 2), so the server's database and its open transaction
  are never touched by the run. A test's
  COMMIT WORK commits into the copy, which is then thrown away, which is
  what the Node host gets from its detached child.
- The answer is the `aunit:runResult` document that the Node host sends
  for a class (`tools/adt-unit-result.mjs`, class protocol): semantic URIs,
  navigation URIs, `Critical Assertion Error` titles, the
  "Different values" detail with Expected/Actual, and stack entries
  in the class pool include form. `#testclass=...;testmethod=...`
  selects a class or a method. An unknown class or method is a 404.
- **A class that changed since the build** (any of its files differs from
  the digest this binary was built from: saved, created, or activated
  after the build) is refused with **409** `ExceptionTestRunFailed`:
  "... changed since this osgo binary was built: its tests would run the
  old code. Rebuild osgo from this tree to run them." Running the old code
  and presenting it as the new code's result would be a false green.
- A class with a test include that is not compiled into the binary gets
  **409** too. The message names the build option that adds it. A class
  without a test include gets an empty run result, as on Node.

What it does not do: there is no per-test timeout. A Go goroutine cannot be
cancelled, and a test that loops holds the work process (and keeps the serving
database set aside) until the process is killed. A timer that answered
"aborted" while the test goroutine ran on would be unsafe: the test would go
on using the shared database globals after they were restored. The safe forms
are a supervised test worker (the same executable in a child process, killed
at a deadline) or a watchdog that ends the whole wedged host for its
supervisor to restart; neither is built yet. Only test classes compiled into
the binary run, so the exposure is the build's own code. The `HARMLESS`
write guard of the Node runner is not there. Coverage and the
`abapunit/testruns` options beyond `withNavigationUri` are not there. These
are the same omissions the Node runner has, except for the first two.
