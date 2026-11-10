# genbuild -- the builder seam of the generation swap

ADR 0010 slice 4 ("The hot swap of a generation", step 2). What turns the
tree into a new osgo executable sits behind one interface, so the gateway
(`go/osgw`) does not care whether it is `node tools/gogen/osgo.mjs --fast`
today or gogen-in-Go later.

- `Builder` -- `Build(ctx, Request{Root, Published, Objects}) (Result{Binary,
  Duration, Output}, error)`. `Command{Argv, Output, Env, Log}` is the one
  implementation: the command runs in the tree, and `Output` is the
  executable it writes once it exits 0 (`Output` keeps the last 4 KiB of what
  it printed). It builds the tree as it is on disk: the sidecar asks for a
  build only when no object is inactive, so the working file of every
  published object holds the published bytes.
- `Queue` -- one build at a time. A request waits for a quiet period
  (`debounce`, 500 ms: a build is seconds, so a burst of activations is one
  build); a request while a build waits joins it (same id, `b<n>`), a request
  while one runs queues the next and later requests join that one. `done`
  runs after each build, and the next build starts only after it returned,
  so the swap it runs is over before another build begins. `Busy`, `Wait`,
  `Close` (a pending build dropped, a running one cancelled).
- `Stash(binary, dir)` -- the executable copied to `dir/<digest>/<name>`,
  written beside and renamed into place: no half-written file is ever
  started, and the next build overwriting the builder's own output cannot
  change the code a running generation restarts with. Same content, same
  path, no second copy. `Digest` is the 16 hex of the file's SHA-256.

No import of `go/abap`, of generated code or of `tools/osd-*`.

```sh
go test -race ./genbuild/
```
