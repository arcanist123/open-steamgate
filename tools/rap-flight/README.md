# tools/rap-flight

The host side of `packs/rap-flight` (the RAP flight reference scenario as a
fetched pack, [docs/rap-flight-pack.md](../../docs/rap-flight-pack.md)).

`classify.mjs` is the measurement behind the document's tables: it fetches
the pinned commit with no exclude list into
`.local/rap-flight-classify/`, counts the four other scenarios, classifies
every object of the kept folders with abaplint (the build's libraries and
the pack's `src/` layered over the tree as the build layers it), runs
`bdef-gen`'s checks per BDEF and `cds2ddic`'s reading per view, and prints
the tables. A run takes a couple of minutes. The one column it does not
produce is the BDEF table's "also in it".

`constructs.mjs` is RAP R4's measurement: per behavior definition of the
managed scenario and the reuse layer, the behavior constructs and handler
forms it uses and what the generators and runtime do with each (runs,
ignored, refused), and its first refusal. Seconds, from the same clone.

`seed-capture.mjs` boots the transpiled runtime, runs the pack's seed class
(`ZCL_OSD_RAPFLIGHT_SEED`, which runs the scenario's own data generator)
inside one dialog step and writes every table the generator fills into
`packs/rap-flight/data/*.tabu.json`, abapGit's TABU form with ISO dates, the
same format the other packs' seed rows have.

The rows are generator output and are **not tracked** (the licence decision
of 2026-11-09: derived content of the fetched upstream stays out of the
repository). A build makes them: `tools/osd-build.mjs` (its `build()`, so
every path that ends in a generation -- the CLI, a first start, a store's
activation -- and a cache hit included) asks `seedsDue()` and, when the
answer is yes, starts this script as a child (`--ensure --output
<generation>/output`), but only when the pack is one of that build's
selected inputs: `OSD_WEB_PACKS` builds a smaller system on purpose, and a
pack the selection left out neither needs nor could make its rows. The
child runs against the generation the build just made -- under `--no-switch`
that is not the live one -- and on a database of its own: it clears the
inherited `STG_DB`/`STG_DB_PATH` before it boots, so a capture is always the
runtime's in-memory SQLite and never the host's database (a process serving
a persistent DuckDB file locks it against every other process). A capture
happens whenever the inputs the generator reads changed: the upstream
commit, the overlay's generator copies, the seed class and this script,
their digest in `data/.osd-seed.json`, beside the rows it explains. The
generator is random where the scenario is: the master data comes out the
same every run and the transactional counts do not, so a capture's counts
are one run's.

```
npm run transpile                           # captures when the inputs changed
node tools/rap-flight/seed-capture.mjs      # refresh on purpose, same output
node tools/rap-flight/seed-capture.mjs --out <dir>
```

Depends on `tools/osd-dialog-step.mjs` and `tools/osd-packs.mjs` only; the
tables it writes are listed in `TABLES` at the top of the file.
`test/rap-flight-pack.mjs` checks the manifest; `test/rap-flight-wire.mjs`
reads the rows over the wire.
