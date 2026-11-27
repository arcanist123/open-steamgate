# osgo-incr.mjs — the per-object front-end cache of the osgo fast path

Files: `osgo-incr.mjs` (the recorder and the assembly), `osgo-incr-anon.mjs`
(which declaration owns an anonymous structure, and whether its first
reacher moved), `osgo-incr-deps.mjs` (the semantic dependencies of an
object, off abaplint's syntax pass), `osgo-incr-meta.mjs` (the completion
stamp and the whole-metadata check), `osgo-incr-db.mjs` (the database
statements per object), `osgo-incr.test.mjs`, `osgo-incr-fallback.test.mjs`
(the production entry points, compileOsg / osgDatabase).

Measured and designed in `docs/osgo-fast-rebuild.md`, "The incremental front
end". This is the README of the module the house rule asks a self-contained
module for; the code comments here repeat only what a reader of the module
needs in order.

## What it is for

`osgo.mjs --fast` already proved (osgo-fast.mjs) that a save changed nothing
but the content of existing classes and interfaces since the live
generation. That proof made the Node build skippable; the front end still
parsed, syntax-checked and lowered all ~2 900 files / ~1 080 classes on
every save (22 s of the 47 s cycle). This cache takes the rest: a fast save
re-lowers the edited objects and their transitive dependents, and takes
every other object's lowered IR from the cache.

## Shape

```
build/osgo-incr/<generation>/        one directory per live generation,
  index.json                          small, read first: schema, tool identity,
                                      folders, objects, ABAP Unit owners, the
                                      segment sequence (below), where the
                                      global passes wrote, the class push
                                      order, the superclass map, wanted,
                                      diagnostics, the broken set, rtti,
                                      ownership, aliases, the name of every
                                      declared anonymous structure, the
                                      classes whose constructor DEFAULTs the
                                      emission resolves, and per entry: file
                                      digests, deps, reads, pushed classes,
                                      anonymous-struct refs, portability, the
                                      entry digest
  e/<sha(key)>.bin                    per object: the lowered class IRs, the
                                      writes its lowering made to the shared
                                      program state, per segment, the supplied
                                      contributions, the rtti typedefs (v8
                                      serialized, deflated, digest-checked)
  db.json                             the database statements per registry
                                      object, in the order DatabaseSetup makes
                                      them (proved equal to the real run before
                                      being written)
  complete.json                       written LAST (after db.json): the
                                      digests of index.json and db.json.
                                      Removed first when a generation is
                                      recorded again
```

A generation is usable only with its stamp, both digests matching and both
files of the shape the reader walks (`readSealedCache`): a build interrupted
between the recorder's finish and the database record, a database record
that did not attribute (never written then), a damaged or truncated file --
each is a miss of the whole cache, and the full front end runs. compileOsg
also turns any exception out of the assembly into that miss.

The newest three generations are kept. The cache is refused whole when the
front end itself changed (`toolIdentity()`, frontend-object-cache.mjs) or the
layer folders / object list / Unit owners differ.

## How a fast build assembles the program

1. **What to re-lower**: the edited objects (from the proof's changed files)
   plus, transitively, every object whose recorded `deps` include one -- deps
   are the registry objects the lowering read, the classes and interfaces its
   IR names, the owner of every generated type name it spells (a
   structure a class first used is named after it), every object abaplint's
   syntax pass resolved a reference in (`osgo-incr-deps.mjs`: a `TYPES`
   alias of a primitive lowers to the primitive, and neither the IR nor the
   lowering's reads keep the declaring class), and every class or interface
   the object's text spells. An object whose syntax pass cannot run has no
   certified deps and always re-lowers. Entries whose IR did not
   serialize are always re-lowered.
2. **The registry**: every non-class file `compileProgram` loads (all of
   them: abaplint enumerates objects in the order a *name* first appeared,
   and a behaviour definition in `src/` put `ZI_RAP_NOTE` ahead of its view
   in `gen/`, which the table pass's row types follow), the classes whose
   constructor DEFAULTs the emission resolves for CREATE OBJECT by name
   (`emit-constructors.ts`, every class of the program), plus the reference
   closure of
   the classes re-lowered -- their recorded reads **and deps** (the syntax
   pass resolves a type the lowering never asks the registry for: the model
   class behind a redefined method's signature) and every class whose name
   any member's text spells (a reference the lowering stubs out is in
   neither recorded set). Every member's references resolve against the
   registry, because abaplint's syntax pass checks them all. The parse, the
   syntax pass and the fresh lowering all shrink with that set.
3. **The shared state**: every re-used entry's recorded writes are replayed
   in the full build's segment order into the collections the lowering reads
   (structures, constants, signatures, events, ...), `supplied` is merged
   from the per-class contributions, and the caught index (which CATCH takes
   the raised objects of which classes) answers from the recorded superclass
   map over the recorded `wanted`: the partial registry holds neither the
   chains nor the start set (its own selection drops what it does not
   know), and a CATCH lowered against a truncated chain would be emitted
   dead (`catchCond`'s `abap.IsA` against `false` -- the regression test
   builds exactly that).
4. **The lowering** runs through `compileProgram` itself (`incr` hooks,
   frontend.mjs), with the closure registry and the pre-seeded state, so the
   fresh IRs come out of the same code path a full build uses. Its writes to
   the shared collections are recorded per object (the same op proxy the
   write side uses).
5. **The merge**: classes in the recorded push order, every shared
   collection **in the order the full build wrote it**. compileProgram
   enters an object more than once -- the local discovery, the class pass,
   the local classes after *every* class, the function groups -- and each
   `enter` is a segment of one global sequence (`index.segments`); the
   merge replays segments in that sequence, each the fresh writes of an
   object that lowered again or the recorded writes of one from the cache,
   and the global passes in the slot they ran in (before or after the
   discovery, before or after the lowering; a pass that wrote anywhere else
   refuses). Grouping an object's writes at its first slot moved a local
   class's types (`LCL_STACK__TY_DATA`) ahead of every later class's. The
   program digest (program-digest.mjs) and the emitted Go read several of
   these collections in insertion order; any other order names another
   generation. Before the final analyses (`incr.lowered`, frontend.mjs)
   the fresh program gets the merged class list and every recorded
   collection rebuilt in that order, so the interface walk, the dynamic
   statics and the table pass append what they derive in the full build's
   order (the interface declarations of `app.go`); the merge after them is
   checked against what they left. The rtti table is rebuilt over the recorded registry
   enumeration order (the dictionary interleaves with the class typedefs,
   and every registry class gets a superclass entry, null included); the
   ownership table over the recorded collection order. The final analyses
   are recomputed where the registry answers (interface methods, tables,
   locks, CDS views) and merged from the cache where it cannot (exception
   supers, ownership of absent classes, dynamic dispatch).

## What refuses (the full front end runs)

Anything the cache cannot prove, each with a reason printed as
`osgo incr: the full front end runs (...`:

- no cache of the live generation, no completion stamp, a digest or a shape
  that does not match (index.json, db.json), wrong schema, another front end
  (tool identity), other folders, objects or Unit owners;
- a changed file that is not a class or interface, or a class the cache has
  no entry for;
- an entry that is unreadable or whose IR did not serialize;
- a syntax error in a re-lowered object (the full front end drops such an
  object from the program; that answer is not this edit's);
- an object outside the re-lowered set turning broken (the edit broke it);
- a fresh IR newly naming a shared anonymous structure under a shape-only
  seed (global passes only), or a declared anonymous structure whose name
  here is not the one the live generation gave its declaration, or whose
  first reacher in the segment sequence moved (an earlier object reaches it
  now, or the first one stopped: the full build renames it);
- a re-lowered object entered in other passes than the live generation's
  (an edit that adds the first local class, say), a fresh lowering that
  first writes a key another object first wrote, a global pass writing
  between two objects;
- a class with interface aliases outside the fresh registry (its dynamic
  dispatch would resolve differently);
- the database statements not attributing per object (recorded at write time
  by comparing the reconstruction with the real `DatabaseSetup` run).

## The anonymous-structure substitute (osgo-incr-anon.mjs)

abaplint keys anonymous structures (the row of a `RANGE OF`, an inline
`BEGIN OF` constant) by *type instance*: the first lowering to reach one
names it after its own class, later users keep that name. A fast build
reaches instances in another order (the first reacher may be cached), and
the shape alone does not say which instance it is: every exception class has
its own `MSGID/MSGNO/ATTR1..4` textid constant, and `ZCL_STG_SADL_DPC`
reaches its own and `ZCL_OSD_RAP_SADL`'s under two names. The declaration
does. `anonOrigins` maps every anonymous instance a global class or
interface member owns (attribute, constant, type, method parameter, and the
components and rows below them) to its paths; both registries parse the same
declarations, and the write side records the name each path's instance got.
A fresh lowering then:

- takes the recorded name for a declared instance -- valid only while its
  first reacher stays first: the write side records per path the first
  segment each object reached it at (a global pass between two segments),
  the read side where the fresh lowerings reach it, and `anonFirstMoved`
  refuses when the earliest of the cached reachers and the fresh ones is
  not the recorded first; with none recorded no
  object of the full build reached it, a cached object reaches what it
  reached then, so the first re-lowered reacher names it here as there;
- mints the name for an instance no global member owns, which comes from
  the lowering object's own syntax run (its own definition, a method's local
  type): only it reaches that instance, and it names it after itself both
  ways;
- outside every object's mark (a global pass) answers by the shape when the
  write-time build gave that shape exactly one name.

## Cost

Write (a full build): ~3 s over the front end on this tree -- the write
transcript, the deps walk, v8-serializing the entries (~19 MB over 1 076
objects), the database attribution (which a mismatch turns off until the
next full build). Read (a fast save): see the phase table in the doc; the
re-lowered set shrinks with the edit, the registry closure and the entry
deserialization do not.

## Tests

`tools/gogen/osgo-incr.test.mjs` over a small tree with an interface used as
a reference type and a `RANGE OF` row shared through its signature: for a
method body edit, a new method, an interface constant and an interface
method gained with its implementation, the assembled program equals the full
one (classes, structures, constants, interface signatures, events, exception
supers, rtti, the table registry and the emitted Go); the doubtful cases
(wrong generation, unreadable entry, a syntax error in the edited object, a
changed front end) refuse. One test per ordering and naming case the real
tree hit, each failing on the merge before it: the local classes' pass
(owner cached, owner re-lowered), the interface declaration order, a later
reacher of a declared anonymous structure, an object that reaches its own
and another class's structure of one shape, an edit that newly reaches a
declared structure, a cached class's skipped methods, a cached class with
constructor DEFAULTs, and a non-class file that orders the table pass.
The critic's three counterexamples on #898, each failing on the code before
the fix: a primitive `TYPES` alias of a class and of an interface edited
(the user re-lowers, the Go is the full build's), an earlier object made
the first reacher of a shared anonymous structure (refuses), and incomplete
or damaged metadata (no stamp, db.json gone or not parsing, index.json
`null`, an entry or the database record of another shape under a matching
stamp, a generation recorded again without its database record) -- refused
by `incrAssemble`, and through compileOsg / osgDatabase a full build that
completes (`osgo-incr-fallback.test.mjs`).
The real-tree proof (same generation, byte
identical files, fast against full) is recorded in the doc.
