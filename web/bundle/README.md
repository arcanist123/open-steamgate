# The browser bundle, handed over

Her demo already runs on OSD through the server route. This is the other one:
the same demo as a single page with **no server at all** — her transpiled ABAP,
her APC handler, and a WebSocket that reaches the handler instead of a network.

Handed from the transpiler session to open-steamgate on 2026-09-14. It builds
and it does not yet run. What is here, what is missing, and the two traps.

**Status, 2026-09-14: parked.** Alice put the one-page-no-server goal in the far
backlog (1a.2), and open-steamgate was right not to start it on my say-so — a
peer relaying "Alice split the work" is not Alice saying it. This file is a
record so the work is not done twice, not a task.

## What works

- `webpack.config.cjs` bundles the transpiled output into one file. Measured:
  **12.6 MiB**, compiled in 8.8 s.
- `entry.mjs` boots the runtime and installs the WebSocket shim from
  `open-abap-apc/web/apc-socket.mjs`, synchronously, before the page's own
  script can call `new WebSocket`, and hands it a `ready` promise so it waits
  for the boot rather than racing it.
- `bundle.mjs` runs webpack through its Node API, because the tree has
  `webpack` and no `webpack-cli`, and installing one would change a checkout
  that is not ours.
- `shot.mjs` serves `build/` and drives it in Chromium: reads `#info` and
  `#part-info`, clicks START, and counts lit pixels on the WebGL canvas with
  `readPixels`. A screenshot alone cannot tell a black canvas from a canvas
  that is not there — the earlier `getContext("2d")` probe answered "no 2d
  context" for a WebGL canvas, which is true and useless.

## What is missing

1. **The page does not load the bundle.** `build/index.html` is her original
   and has no `<script src="vivid.js">`, so `install()` never runs, her code
   opens a real socket and gets a 404, and the canvas stays black. That is the
   whole of the first failure, and it is one line. It is also why "it builds"
   meant nothing: the 12.6 MiB sat beside the page, unloaded.

2. **Media are fetched over HTTP**, and two things I wrote here were wrong.
   Corrected by open-steamgate, who measured instead of assuming:

   - The image URL is **`?img=`**, not `?image=`. `?image=` has never worked:
     the handler has no such route, the request falls through to the default
     branch and gets the page back as `text/html`, and nothing errors. Her
     megademo player has been asking for `?image=` all along. So a shim written
     against `?image=` would answer requests the page should stop making. The
     objid carries the extension: `?img=ZO4D_05_COPPER.PNG`.
   - **The hex cost is not the wall.** On the service-worker route, with
     `abap.W3MI_LOADER(objid, filename)` answering out of `WWWDATA_IMPORT` and
     the media copied beside the bundle rather than into it, the 4.6 MB mp3
     arrives in 782 ms cold and 337 ms warm in Chromium, hex path included. So
     `ANOMALY-2026-09-13-xstring-as-hex` is a real cost and not an argument for
     changing the xstring representation at this size.

3. **Nobody has measured the start-up cost** of a 12.6 MiB bundle. It may be
   fine and it may be ten seconds; it is unknown, and unknown is not fine.

4. **`local/vivid-vibes` is not an input** to `abap_transpile.json`, although it
   looks like source and holds 121 objects, 85 of which the build also has.
   open-steamgate lost an edit into it and reported a fix as shipped while both
   copies still carried the bug. `tools/osd-inputs.mjs` now names that shape.

## The two traps

- The percent. abapGit writes `ZO4D_06_PLASMA.PNG` as `zo4d_06_plasma%2epng`,
  the transpiler escapes the percent in the specifier, and the file on disk
  carries it raw. The `NormalModuleReplacementPlugin(/%25/)` in the config
  puts it back. Remove it and the build fails on a file that is right there.
- Paths. The scratch build had absolute paths into one machine's sibling
  checkout. They now come from `paths.cjs`: webpack, the polyfills and
  playwright from this repository's `node_modules` (or
  `OSD_BUNDLE_NODE_MODULES`), `apc-socket.mjs` from `../open-abap-apc` beside
  this checkout (or `OPEN_ABAP_APC`), through the webpack alias
  `open-abap-apc`.

## Source maps

`write_source_map` in `abap_transpile.json` is **off by default** and worth
turning on for anything you intend to debug. With it, the transpiler emits one
map per CLAS, PROG and FUGR — 341 of them on her tree — and they resolve to the
statement, not just the object:

    zcl_o4d_sales_dance.clas.mjs:1346   abap.statements.append({source: lv_val, ...})
 -> zcl_o4d_sales_dance.clas.abap:119   APPEND lv_val TO rt_values.

which is exactly the line the demo died on. The bundle has no maps at all
unless the transpile that fed it had them.

## Running it

    node bundle.mjs        # writes build/vivid.js
    node shot.mjs          # serves build/ and drives Chromium
