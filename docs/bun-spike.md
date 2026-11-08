# Does any of this run on Bun? Measured, 2026-09-13

The Bun packaging idea rested on an assumption nobody had tested: that the
transpiled runtime and this gateway run on Bun at all. Thirty minutes, and
the answer is yes, with one defect found and worked around.

Bun 1.4.2, installed for the user (`~/.bun`), against the same tree Node
runs. Nothing in the repository was changed for it.

## The one defect: `%23` in a module specifier

The transpiler names a `/IWBEP/`-namespaced object's file with hashes,
`#iwbep#cl_mgw_data_util.clas.mjs`, and imports it with the hash
percent-encoded, because a bare `#` in an ESM specifier would start a
fragment:

```js
const {x} = await import("./%23iwbep%23cl_mgw_data_util.clas.mjs");
```

Node decodes that and finds the file. **Bun does not**, and the run dies at
the first such import. It is symmetric, which is what makes it a divergence
rather than a missing feature:

| specifier | Node 26 | Bun 1.4.2 |
| --- | --- | --- |
| `"./%23hash%23mod.mjs"` | resolves | `Cannot find module` |
| `"./#hash#mod.mjs"` | `Cannot find module` | resolves |

Ninety-nine files in `output/` carry a hash today.

**The workaround is twenty lines** and was enough for this spike: copy the
transpiled output, rename `#` to something plain in the file names, and
rewrite the same substitution inside relative `./…mjs` specifiers only.
Twenty-two files needed a rewrite. After that everything below worked.

**The real fix is filed**: `abaplint/transpiler#1841`, opened by the
transpiler session on the day of this spike, with these measurements as its
evidence. It traces to two lines that write `/` as `%23`, in
`escapeNamespaceFilename` and in the source-map line of the CLI. It is an
issue and not a patch on purpose: changing the character changes everything
that maps a file back to an object name, so the choice belongs to the
maintainer, and `$`, `-` and `_` all avoid encoding everywhere. The other
half, a Bun issue for the specifier decoding, is not filed. Logged in
`ANORMALIES.md`.

## What ran

With the rename applied to a copy:

- **ABAP Unit: 107 tests, the same list Node runs, exit 0.** Not a subset,
  not a skip: the same names in the same order.
- **The gateway over HTTP**, started under Bun on the express shim:
  `$metadata` with its twelve entity types, entity-set reads, a media
  resource (`PhotoSet('T0001')/$value` answered 930 bytes of `image/png`),
  virtual elements computed by the ABAP exit class, a published CDS service
  (`ZC_STG_TRAVEL_CDS`), and a write (`POST` answered 201).

So the runtime, the database layer, the OData gateway, SADL, the CDS
machinery and the media path all work on JavaScriptCore without a single
shim. That is more than the goja path managed even after lowering.

## Speed, such as it is

| | Bun 1.4.2 | Node 26 |
| --- | --- | --- |
| twenty entity-set reads | 220 ms | 264 ms |
| the whole ABAP Unit suite | 3.06 s | 1.91 s |

Per request Bun is a little quicker, about eleven milliseconds against
thirteen. The unit suite is the other way round, and the likely reason is
startup plus the wasm build of sql.js doing the heavy database work; a
native `bun:sqlite` backend is exactly what would move that number, and it
is the first item of the packaging work.

Neither figure is a benchmark. They are two runs on one laptop, quoted so
nobody plans around a guess.

## What this does and does not settle

It settles feasibility: no lowering, no shims, no missing engine features,
which is the thing that killed the goja path until Babel was added. It does
not settle `bun build --compile`, which is the next question and a separate
one: a compiled binary has to carry the same files, and the `%23` defect
lands there too.

---

# Part two: the bundler and the binary. Measured 2026-09-14

Part one settled that Bun *runs* the thing. Two questions were left open:
whether Bun could also replace webpack, and whether `bun build --compile`
inherits the `%23` defect. Both are now measured, and one of the answers
reverses what part one predicted.

## Three corrections to what was believed

**There are no native dependencies.** `@abaplint/database-sqlite` depends on
`sql.js`, which is wasm. The only native module in the tree is the optional
DuckDB driver. The "will native modules block a binary" question, carried
since the idea was raised, does not exist.

**The percent defects are a bundler footnote, not a blocker.** Both
`%23` (namespaces) and `%25` (W3MI names, 172 files today) close with one
`Bun.build` plugin whose `onResolve` decodes the specifier — the same shape
as webpack's `NormalModuleReplacementPlugin`, ten lines for both. What
`ANOMALY-2026-09-13-bun-percent-encoded-specifier` blocks is the
*interpreted* path, `bun entry.mjs`.

**`bun build --compile` does not inherit it.** Measured directly rather than
reasoned about, with one file importing `./%23iwbep%23mod.mjs`:

| | result |
| --- | --- |
| `bun entry.mjs` | `Cannot find module "./%23iwbep%23mod.mjs"` |
| `bun build --compile entry.mjs` | `Could not resolve` — the CLI takes no plugin |
| `Bun.build({compile, plugins})` | binary built, **runs, prints the value** |

So transpiler #1841 is no longer a gate for packaging. It stays worth having
— it would remove the plugin and fix the interpreted path — but backlog 1.3
should not wait on Lars for it.

## Bun as the bundler: 166 times faster, and it does not work

`bun build web/preview-worker.mjs --target=browser` against the same graph
webpack bundles:

| | Bun 1.4.2 | webpack 5.110.3 |
| --- | --- | --- |
| time | **337 ms** | 56 000 ms |
| size | 33.3 MB unminified | 22.8 MB minified |

The walls, in the order they appeared, because the order is the useful part:

1. `/* webpackIgnore: true */` in `tools/rfc-live.mjs:102`. A hint only
   webpack understands, telling it not to follow the live-RFC import into
   Node-only code. Bun followed it and drowned in `node:net`, `node:os`.
   Bun's equivalent is `external: ["open-rfc"]`. Worth knowing that our
   source carries instructions addressed to one particular bundler.
2. DuckDB, `%23` and `%25` — plugins, about ten lines, one-to-one with what
   `webpack.config.cjs` already does.
3. The wall: **`Cannot use 'import.meta' outside a module`**, plus 8893
   top-level awaits. Logged as
   `ANOMALY-2026-09-14-bun-bundler-module-output`. It built; it would not
   evaluate; all four preview e2e tests went red.

Ten of webpack's jobs are load-bearing here and worth listing, because
"swap the bundler" reads cheap until they are counted: sixteen node-builtin
browser polyfills, `symlinks: false` for the linked clones, the sql.js
asm alias, the three specifier rewrites, the DuckDB ignore, the
`Buffer`/`process` provides, one-chunk output, and Terser with
`keep_classnames`/`keep_fnames` — that last one not cosmetic, because the
runtime looks classes up by name.

**Conclusion: webpack stays for the preview.** The 166× is real and tempting
and does not matter while the output cannot be evaluated. Nothing about this
touches the binary, where a module target makes both constructs legal.

## The single-file HTML question, answered by the same fact

Asked while this was measured: can the whole thing be bundled into one local
HTML file, opened from disk with no server?

A service worker **cannot be registered from `file://`**. Not "works badly" —
cannot. So the current architecture, where interception is the worker's job,
has no single-file form.

But the worker is only the interception seam; the runtime is ordinary
JavaScript. Moving it into the page and shimming `fetch` and
`XMLHttpRequest` instead is the route, and the pattern already exists here:
`web/preview-socket.mjs` shims `WebSocket` and the worker injects it into
the page as a classic script. `handleRequest({method, path, search, headers,
body})` knows nothing about transport, so the shim is tens of lines rather
than a rewrite.

The costs are real: ~33 MB of JavaScript plus 11 MB of media as data URIs
(+33% for base64) is a 45–50 MB file, re-parsed on every open because there
is no worker cache; UI5 still comes from the CDN, and cannot be embedded
because Fiori Elements (`sap.fe`, `sap.ui.generic.app`) is SAPUI5 and not
OpenUI5. And `file://` refuses `<script type="module">`, so the build needs
a classic script with lowered top-level await — which is precisely the thing
webpack does and Bun does not. The two questions of the day meet at one
property.

Worth doing only for "send someone a file they double-click". Where an
executable may be run, the binary is better: it is the server, so the https
that a worker demands off localhost stops being a problem.

# Part three: the binary as the workbench. Measured 2026-09-16

Parts one and two settled that Bun runs the thing and that `Bun.build`
compiles it. SP4 asked the question the plan wrote down: does a compiled
binary load a namespaced module generated **after** it was built, on a
machine without Node, and run the whole workbench around it? Measured on
Linux x64, Bun 1.4.2, with the checkout as the workspace (gate 4, a clean
directory, waits for E.2: `src/`, `webapp/`, `data/` and `test/setup.mjs`
are OSD's content and a binary has to bring them as a pack).

## The answer

**Yes.** `build/osd up` (`bin/osd.mjs` through `scripts/build-binary.mjs`,
`npm run binary`) is the workbench: the ADT façade, the supervisor, the
serving child (`osd serve`), the builder with the transpiler in-process
(N3) and its generators (`osd gen <tool>`), detached ABAP Unit runs
(`osd unit`). Measured end to end:

The default build is checkout mode: it needs `npm ci` but no `.local/lars`
and runs from an open-steamgate checkout. `npm run binary -- --seed` (or
`OSD_BINARY_SEED=1 npm run binary`) embeds the system seed after
`npm run bootstrap`; release binaries use this mode and can run away from
the checkout. `osd doctor` reports the mode.

| | |
| --- | --- |
| binary | 89.4 MB, built in 250–450 ms |
| cold start, ADT answering / child serving | 2.9 s / 3.0 s |
| ADT discovery, class source, `$metadata`, entity sets, the demo app, `/app/` | all answer, `X-OSD-Generation` on every OData answer |
| edit a class → dev loop → built → recycled | 8.7–9.4 s build, 0.6–1.1 s recycle, three names agree |
| the behaviour changes | `DEFAULT 'Hello'` → `'Hullo'`: `GREETING_PASSES` fails with `got 'Hullo Ada'` on the new generation, passes again after the revert, and the revert comes back under the **same** generation name (content-addressed, cached) |
| a detached unit run (`osd unit … --detached`, the façade's F9 path) | 3.4 s, spawned as `<binary> unit … --plan-stdin` |
| a runtime error | the dump names the ABAP statement with its frames (`rs_paging-top = mv_top.` ← `get_paging( )`): source maps work, JavaScriptCore keeps async frames |
| memory | parent 500 MB RSS (the store's parse of 1,027 objects and the bundle), child 169 MB |

## What had to be true, and was not for free

Six walls, in the order they came, each measured before it was closed.

1. **A compiled binary resolves nothing from a `node_modules` beside an
   external module** — not even one right next to it — and `Bun.plugin`'s
   `onResolve` is never invoked for a bare specifier (it is for relative and
   absolute ones). Interpreted `bun x.mjs` looks as if it worked only because
   Bun **auto-installs from `~/.bun/install/cache`**; measure with
   `--no-install`. What works is a runtime plugin's
   **`build.module("@abaplint/runtime", …)`** returning the binary's own
   module with `loader: "object"`: the generated code and the host then
   share one runtime object (`mod.runtimeRef === runtime.ABAP`). The only
   other bare import generated code makes, `../test/setup.mjs` by path, is
   intercepted by `onResolve` and answered from the bundle the same way.
   The same wall came back on 2026-11-08 for the one other module a
   checkout-mode binary loads from disk: the gui converter
   (`.local/lars/open-abap-gui/converter/src/api.mjs`, not bundled because
   a checkout build must succeed without `.local/lars`) imports
   `@abaplint/core` and two of its files by name, and `build/osd up` died
   in `osd-gui-convert` with "Cannot find module '@abaplint/core'". Every
   package such a module imports is now a `build.module` of `HOST_PACKAGES`
   in `bin/osd.mjs`, `test/osd-binary.mjs` compares that list with the
   converter's imports, and `osd doctor` loads the converter and says so.
2. **`%23` in a relative specifier**, the part-one anomaly, is alive in the
   binary's resolver for external files. Closed by the same plugin:
   `onResolve({filter: /%(23|25)/})` decodes against the importer.
3. **Every bundled module shares one `import.meta.url`**
   (`file:///$bunfs/root/<binary>`), `process.execPath` is the binary and
   `process.argv[1]` its bunfs path. So the five `import.meta.url.endsWith(
   argv[1])` guards would all fire on import, and every `spawn(process.
   execPath, <script>)` would start another workbench. `tools/osd-host.mjs`
   answers "how do I start that tool" (`<binary> gen|serve|unit …` when
   compiled), and `bin/osd.mjs` sets `argv[1]` to a name no module ends
   with before importing anything, then dispatches the modes.
4. **The bundle renamed two runtime classes**: `types.Date` became `Date2`
   and `types.String` `String2`, colliding with the globals when the graph
   was hoisted into one chunk — and the runtime tells types apart by
   `constructor.name` in some four hundred places, so RTTI took every
   string for "todo" and every request died in `CONVT_NO_NUMBER` at
   `ASSERT 1 = 'todo_cl_abap_typedescr'`. webpack keeps class names on
   request (the preview's `keep_classnames`, noted in CLAUDE.md for exactly
   this reason); Bun has no such switch. A function's name is a
   configurable property, so `bin/osd.mjs` puts every `runtime.types` name
   back before anything runs, and **`osd doctor`** lists what a bundle
   renamed (0 after, 2 before).
5. **`@duckdb/node-api` as `external`** still fails the binary at start: a
   compiled bundle evaluates every import, dynamic ones included. It is
   replaced by a stub module at bundle time; DuckDB is not part of the
   binary.
6. **Paths derived from a module's own location**: the CLI's config loader
   (reached from inside the binary through the tree's node_modules and
   dragging its requires along — `loadConfig` reads the JSON itself now,
   the last use of the CLI in the build path), `stg-compile`'s table spec
   (a static JSON import now, so it travels with the code), `test/start.mjs`'s
   `webapp` (tree-relative now).

Two things that needed nothing: `node:sqlite` (`DatabaseSync`, the B4
client) behaves as under Node — types, `changes`, WAL, `VACUUM INTO` — and
sql.js loads its wasm from inside the bundle (the in-memory unit run).
Node and the binary name the same generation for the same inputs — after
one more fix: they did not at first, because the CDS registry listed its
entities in `readdirSync` order, which is the host's order and differs
between Bun and Node, and `gen/` is an input to the hash. Every directory
read in the generators is sorted now (seven of them, six tools), checked
by forcing a build under each host and diffing `gen/`.

## What this settles, and what it does not

Decision 0.1, Bun packaging: **yes** for Linux x64 with the checkout as
workspace. Not measured: other platforms (each needs a native run, a
cross-compile is not a runtime test), APC over the binary, TLS, the
preview build. Not reachable yet: gate 4, a directory with no checkout —
that is E.2's content pack, and the boundary is recorded rather than
tested around. The plugin, the name restore and the mode dispatch are
about 60 lines in `bin/osd.mjs` and `tools/osd-host.mjs`; nothing in the
tools knows it is in a binary except through `osd-host`.


# Part four: is Bun the right container? The control groups. Measured 2026-09-16

Part three settled that a Bun binary is the workbench. Alice asked the
question that deserved an answer rather than an opinion: **was Bun needed at
all, or would something closer to Node have cost less?** So the same entry
(`bin/osd.mjs`) was packaged three more ways and put through the same tests.
`tools/osd-host.mjs` already knew how a tool starts a tool, so a host is now
just a command, and `scripts/check-hosts.mjs` asks all of them the same
questions.

## The four hosts, side by side

| host | Zork | OData | `doctor` | generation | start | glue beyond the shared host module |
| --- | --- | --- | --- | --- | --- | --- |
| `node bin/osd.mjs` (the source) | 33/33 | ok | 0 | `71670ec4…` | 2.4 s | none |
| `node build/osd-node/osd.mjs` (a bundle) | 33/33 | ok | 0 | `71670ec4…` | 2.3 s | none |
| `build/osd` (Bun binary, 89 MB) | 33/33 | ok | 0 | `71670ec4…` | 2.9 s | a resolver plugin, ~15 lines |
| `build/osd-sea` (Node 26.9 SEA, 158 MB) | 33/33 | ok | 0 | `71670ec4…` | 2.1 s | none |

All four name the **same generation** for the same inputs, and all four play
Zork: one socket to the push channel, thirty-six commands, thirty-three
expectations (`tools/zork-speedrun.mjs`). That test is the useful one,
because it exercises the APC upgrade through the façade to the child, a
stateful ABAP handler holding a session, the Z-machine interpreter
transpiled from ABAP, and a story file loaded out of SMW0 — all at once, in
67 s.

Reads under load, measured separately (`scripts/bench-hosts.mjs`, 100 OData
reads): the Node bundle is quickest at 3.9 ms median, the Bun binary 5.0 ms,
and memory favours the Node hosts (389 MB parent against 462 MB).

## Node SEA: refused, then not

The single executable was the interesting one, and it moved twice in one
evening.

On **Node 26.3** a SEA cannot load a generation at all. Its injected main
reaches a builtin-only embedder loader, so `import()` of any file outside the
executable fails with `ERR_UNKNOWN_BUILTIN_MODULE`, the stack naming
`loadBuiltinModuleForEmbedder`. Measured in every entry shape: CommonJS main,
ESM main, with and without `useVfs`. A worker thread escapes it (the normal
loader runs there), and so does one `vm.Script` compiled with
`vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, which hands the import to the
default ESM loader — that was measured working, with top-level await and a
`%23` name, and it is the bridge to use if an older Node must be supported.

On **Node 26.9**, released the same day, none of that is needed.
`mainFormat: "module"` with `useVfs: true` runs the main through the ordinary
loader: `import.meta.filename` is a VFS path rather than `process.execPath`,
and a plain `import()` of a module created after the build works, with
top-level await, a relative dependency and a percent-encoded name.
`scripts/sea-speedrun.sh` is that measurement in six printed phases, so the
answer takes one command on the next machine.

So the SEA carries **no glue at all**: the bundle is its main script, and the
things the Bun binary needed — a plugin to hand the generated code a runtime,
another to decode `%23`, the class names put back — are all unnecessary,
because Node resolves `node_modules` beside an external module and does not
rename a class it bundles. What remains shared by every host is
`tools/osd-host.mjs` (how this program starts itself) and the sorted
directory reads, and neither is a packaging cost: the sorts fixed a real
non-determinism of ours.

## What this changes

Nothing about the work was wasted, and the answer to "was Bun a mistake" is
no: of the six walls in part three, one was Bun's (the `%23` resolver bug),
one was the bundler's (renamed classes), three were single-executable
properties that Node SEA shares, and one — the directory order — was our own
defect that Bun exposed. The measured cost of Bun over Node is now precisely
**one resolver plugin**.

But the shortlist has changed. `build/osd-sea` is a single file with Node
semantics and no adaptation, and the plain Node bundle is 7.9 MB, the
quickest, and the simplest thing to reason about. Since **gate 4 shows that
one file still travels with a directory of content** (E.2: `src/`, `webapp/`,
`data/` and the setup hook are OSD's content, not the workspace's), "one
file" buys less than it appeared to. The recommendation is therefore to keep
all four hosts under `scripts/check-hosts.mjs` and let the release decide
late: the bundle for development, the SEA or the Bun binary for delivery,
whichever a platform supports — the tests say they are the same system.


# Part five: a second machine, and what "self-contained" turned out to mean

Measured 2026-09-16 by deploying to another Linux x64 machine over ssh —
Node 18 on it, no Bun, no checkout, nothing of this repository.
`scripts/make-release.mjs` assembles what goes over; `run.sh` picks a host.

| host | on a machine with nothing installed |
| --- | --- |
| `./run.sh` (the Bun binary) | works, and needs no `node_modules` at all |
| `./run.sh sea` (Node single executable) | works **with** the runtime closure beside it |
| `./run.sh node` (bundle on a private Node) | works with the same closure |
| `./run.sh system` (bundle on the machine's Node 18) | refuses, as it should |

All of them serve the launchpad, both demos and OData from the same
generation, `db11b3a9bb69dea8`. The ZO4D frame stream recorded on the
second machine is **byte-identical** to this one's, sixty frames
(`tools/o4d-record.mjs --against`), which is the property that makes an
oracle comparison mean anything.

## The thing that passed locally and was not true

`scripts/check-hosts.mjs` had all four hosts green here. That proved they
agree with each other; it did not prove any of them self-contained,
because this tree has a `node_modules` and Node resolves through it. On a
machine without one, the Node hosts die the moment a request needs ABAP:
the launchpad still serves, every app answers 503, and the child says

```
Cannot find package '@abaplint/runtime' imported from …/output/init.mjs
```

Generated code imports the runtime **by name**, and `test/setup.mjs`
imports the database adapter, and neither is bundled outside Bun — the
Bun hosts get both from a plugin (`bin/osd.mjs`), the Node hosts must find
them on disk. So a Node release carries a closure of four packages
(`@abaplint/runtime`, `@abaplint/database-sqlite`, `sql.js`,
`temporal-polyfill`), which `make-release.mjs` puts there and says so.

That is the honest scoreboard for the packaging question: **only the seeded Bun
binary is a single file in the strict sense.** The Node single executable
is one file plus a package directory, which is exactly the
"executable plus a versioned support directory" that Astra's vendoring
note called the intermediate product. Neither is a reason to prefer one:
the release ships a directory either way, because OSD's own `src/`,
`webapp/` and `data/` travel with it until B.11.
