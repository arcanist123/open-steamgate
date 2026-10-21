# Applications and tiles in the launchpad

An OSD content pack registers its applications and launchpad entries in one
`osd-pack.json`. No central launchpad file has to learn the pack's name.

```text
packs/example/
  osd-pack.json
  webapp/
    index.html
    manifest.json
```

The smallest registration is:

```json
{
  "name": "example",
  "webapp": "webapp",
  "tiles": [{
    "id": "example-workbench",
    "title": "Example workbench",
    "subtitle": "Inspect and run examples",
    "icon": "sap-icon://wrench",
    "url": "/app/example/"
  }]
}
```

At startup OSD serves the directory at `/app/example/`, exposes the declared
tiles through `/app/packs.json`, and the sandbox FLP adds them to **Content
packs**. A direct `url` works for UI5 and non-UI5 pages.

A tile may also open the pack's app by intent, the way a Fiori launchpad
does: tile -> `#Object-action` -> the app's `Component.js` from its BSP
application. The intent comes from the app's own `webapp/manifest.json`,
`sap.app.crossNavigation.inbounds`; `/app/packs.json` carries each as an
entry of the sandbox's `applications` (`SAPUI5.Component=<sap.app.id>`, the
pack's BSP application `../sap/bc/ui5_ui5/sap/<name>/`), and `flp.html`
reads them before the sandbox boots, since an intent added afterwards
cannot be opened. Write the tile's `url` as `#Object-action` or as this
page with the intent (`/app/flp.html#Object-action`, `flp.html#...`,
`./flp.html#...`, a query allowed before the hash); the launchpad turns the
latter into the former, because a URL that is not a hash opens as an
outside link, in a new window. Every inbound of a pack app is registered,
except one whose semantic object or action is not a plain word (a dash, a
`*`), one whose intent a built-in application already has, and one whose
component id a built-in application already uses or another pack serves
from another URL.

## Applications under their own names

`webapp` becomes one BSP application with a derived name (`Z<PACK>`). An
application that already has a name -- one downloaded from a system, whose
URLs and whose system's data say `/sap/bc/ui5_ui5/sap/<APP>/` -- is named
by the pack:

```json
{
  "name": "example",
  "bsp": {"ZEXAMPLE_LIB": "apps/lib", "ZEXAMPLE_APP": "apps/app"}
}
```

Each folder, inside the pack, is served by the same ABAP path as every other
BSP application, under that name, with its bytes as they are (its manifest
is not re-based: it was written for that path). The name is checked like any
BSP application name (at most 15 characters). Two packs naming one
application, a pack naming its derived name, or a name `src/bsp/apps.json`
already declares are refused, with both files named. A page path too long
for the Web Repository's 40-character name gets a digest name; the
registry maps the path to it.
## Intents and libraries no manifest declares

A manifest's inbounds are the pack's intents, as above. Two things a
manifest cannot say are said in `osd-pack.json`:

```json
{
  "intents": {
    "Order-manage": {"app": "ZORDER_EXT", "component": "my.orders.ext", "title": "Orders"}
  },
  "resourceRoots": {
    "my.lib": {"app": "ZMY_LIB", "path": "my/lib"}
  }
}
```

- **`intents`** -- a target mapping: the intent launches `component` from
  the BSP application `app` (`../sap/bc/ui5_ui5/sap/<app>/`). This is
  for a base app that declares the inbound while its extension is what
  runs. An explicit intent replaces a manifest's of the same name, and the
  host says so at start (`launchpad: pack ... maps ... ; the manifest
  declared ...`). Without one, nothing changes.
- **`resourceRoots`** -- where the loader finds a library that has no app
  index here; given to the loader right after the core script, before any
  application loads. A built-in namespace is never replaced.

Two packs declaring one intent or one resource root fail the build, with
both files named. An intent is `<SemanticObject>-<action>` in plain words
(letters, digits, `_`).

## Availability

A capability may remain visible without pretending it can run:

```json
{
  "id": "hana-tool",
  "title": "HANA tool",
  "url": "/app/example/hana/",
  "requires": "HDB",
  "disabledReason": "needs HANA"
}
```

`requires: "HDB"` is checked against the same live SQLScript probe as the
AMDP sandbox. On ANYDB the target is removed, the native UI5 `Disabled` state
greys the tile, the footer is marked as an error, and `aria-disabled=true` is
set. `enabled: false` provides the same visible disabled form for a static
decision. A disabled tile is not hidden: it advertises the capability and
explains why it is unavailable.

## Tile kinds and live values

`type` accepts `static` (the default), `dynamic`, or `image`:

```json
{
  "tiles": [
    {
      "id": "live-count",
      "type": "dynamic",
      "title": "Open findings",
      "url": "/app/example/",
      "serviceUrl": "/sap/opu/odata/sap/ZEXAMPLE_SRV/TileSet('OPEN')",
      "serviceRefreshInterval": 60,
      "numberUnit": "items"
    },
    {
      "id": "poster",
      "type": "image",
      "imageSource": "/app/example/poster.png",
      "url": "/app/example/"
    }
  ]
}
```

OSD binds the response to UI5's native `NumericContent`. The service may
return a plain number (an OData `$count` is therefore enough), or JSON:

```json
{"number": 42, "numberUnit": "items", "numberState": "Good", "info": "live"}
```

Optional `numberState` and `infoState` use UI5 value colors; `stateArrow` may
be `Up`, `Down` or `None`, and `subtitle`/`info` may be refreshed too. Failed
requests show an error value without disabling navigation. Keep refresh
intervals conservative (OSD enforces at least ten seconds) and use live
numbers for small status aggregates, not for starting a benchmark or another
costly job. Application-internal KPI tiles, such as ZVDB Vector Quality,
remain `sap.m.GenericTile` controls owned by that application.

The built-in shell entries in `webapp/flp.html` use the same UI5 tile types.
Pack applications should prefer `osd-pack.json`; editing the shell is reserved
for applications that are part of OSD itself and need intent navigation.
