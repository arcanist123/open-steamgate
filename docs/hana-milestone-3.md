# HANA milestone 3: the read-only host serves an app, and a read diff instrument

Milestone 2 (`docs/hana-milestone-2.md`) served one business set of the SEGW
sample over an existing HANA schema and compared it with the system's own
answers by hand. Milestone 3 ("rehearsal") puts a Fiori Elements app on the
same host and compares many reads at once. This page holds the pieces that
are in the tree: the comparison instrument, what the host serves now, the
app over a synthetic twin service, and the one Playwright spec that runs in
CI over the twin and by hand on a bed over a real service. The real
service's app configuration and its expected values stay outside the
repository, as the oracle captures do.

## The read diff: `tools/odata-read-diff.mjs`

Two OData v2 JSON answers, or two capture folders under a manifest,
compared the way a reader of the wire compares them: status; for an error,
`error.code` and `error.message.value` (and nothing else of the error body,
which is per call -- said in the output each time); the keys of the entries
and their order; every property value; the set of properties an entry
carries (a `$select` that was not applied is a difference); `__count`;
`__metadata`.

    node tools/odata-read-diff.mjs <ours.body> <oracle.body> [--status 200,200] [--expect-empty]
    node tools/odata-read-diff.mjs --manifest <m.json> --ours <dir> --oracle <dir> [--normalise uri-host,etag-form]
    node tools/odata-read-diff.mjs --capture <base-url> --manifest <m.json> --out <dir>
    node tools/odata-read-diff.mjs --manifest-from-index <index.tsv> > m.json

A capture folder holds `<id>.body` and `<id>.meta.json` per request (or an
`index.tsv` with the id and the status, the form the milestone-2 captures
have). `--capture` sends GET and HEAD only, with the URL as written.

Nothing is normalised unless declared, and every declared normalisation is
counted in the output: `normalised: uri-host 105, etag-form 22,
member-order 1`. The rules: `uri-host` (scheme, host and port of
`__metadata.uri`/`id`, `__deferred.uri`, `__next`), `uri-prefix` (path
prefixes declared as `--prefix <ours>=<oracle>`), `etag-form` (two non-empty
`__metadata.etag` compare equal), `member-order`. Two answers without a
single entry are **not** a match unless the request declares `"empty": true`
(or `--expect-empty`): an empty result equal to an empty result is the
cheapest false green there is, and a `$count` of 0 counts as empty.

On the milestone-2 captures (outside the tree) it gives milestone 2's
verdicts: the business-set reads equal once `uri-host`, `etag-form` and
`member-order` are declared, the product read different in its two
language fields.

## The host: `tools/hana-serve.mjs`

What it answers now, besides the GETs of milestone 2:

| request | answer |
|---|---|
| `/app/...` | the static files of `webapp/`; `--app <name>=<dir>` mounts a folder outside the tree at `/app/<name>/` (SAPUI5 itself comes from the CDN, as for every app here). A file is served only when its real path is inside the mount's real path -- a symlink out of the mount is not followed -- and never a dotfile or a directory |
| `HEAD` | the GET without its body; `x-csrf-token: Fetch` gets the token the ordinary server hands out |
| `POST .../$batch` | admitted only when **every** part is a GET; a changeset, any other method or an `X-HTTP-Method(-Override)` header refuses the whole batch with 405 before a line of ABAP runs; an absolute part URL outside the batched service, 400 |
| `X-HTTP-Method(-Override)` | 405 on any request: it would make the request another method than it says |
| function imports | a GET import is a read like any GET; a POST import is refused by the method rule (405), in a batch or not |
| another `sap-client` | 400 (`OSD/CLIENT`), named by URL option, header or cookie, on the request or inside a batch part: the host serves the one client `OSD_CLIENT` names, and before this a request naming another client was answered out of this client's rows |
| `--register <SRV>=<MPC>,<DPC>` | registers a service the SEGW registry does not hold (the twin) |

Tests: `test/hana-serve.mjs` (fake DatabaseClient; a batch with a POST part
leaves no read in the fake's log -- it did not reach the ABAP).

## The app and its twin service

`webapp/h5x` is a Fiori Elements V2 list report -> object page -> sub-list
over `ZOSD_H5X_APP_SRV`: the twin of `test/hana-m2` (its partners, orders,
singles and navigations, read by the twin's own DPC `ZCL_OSD_H5X_DPC`) with
one model class added beside it, `ZCL_OSD_H5X_APP_MPC`: a `sap:label` on
each property shown and sort/filter on the two the list report uses.
`useBatch` is on.

Two things the app showed. A V2 list report leaves a complex property
(`Address/City`) out of its table and out of `$select`, so the address is
on the object page only. And the gateway passed `iv_source_name` empty to
`GET_ENTITYSET` on a navigation, where a system names the source type: an
orders read that asked it put every partner's orders on the sub-list (four
rows where the spec expects three). The gateway names the source now
(PR #947).

The app's annotation file carries **no property label**: every column
header is the service's `sap:label`, so a label the service lacks is a
header the spec does not find. It sets the sets read-only
(`Capabilities.*Restrictions`), so there is no Create button that would
answer 405. There is no launchpad tile: the launchpad lists services the
ordinary server registers, and this one exists only on hana-serve.

## The spec: `test/e2e/h5x-app.spec.mjs`

In CI (and by default) the spec starts hana-serve itself over the twin and a
fake DatabaseClient that answers SQL (`test/fixtures/hana-serve/
twin-client.mjs`: the tree's SQLite client over the twin's seeded tables,
every write refused -- the host says "DATABASE IS NOT HANA"), and expects
`test/e2e/fixtures/h5x-app.expect.json`. It asserts: each header label is in
`$metadata` and in none of the app's files; exactly the expected headers (an
extra column fails) and every row with exactly that many cells, cell by
cell and in order; a sort the user makes in the column header's menu (the first row, and
`$orderby` in a batch part); a filter the user makes (the rows, and
`$filter` in a batch part); the object page and the sub-list's rows through
the navigation; at least one `$batch`, every part a GET, no changeset, no
read outside a batch but `$metadata` and a token fetch; no answer >= 400,
batch parts included; no Create, Edit or Delete button.

### By hand on a bed, over a real service

The same spec, three variables, no file of the real service in the tree:

- `OSD_E2E_BASE_URL` -- the running hana-serve on the bed (it then starts none);
- `OSD_E2E_APP_PATH` -- the page of the app configuration for the real
  service, a copy of `webapp/h5x` with its own `manifest.json` and
  `annotations/annotations.xml`, kept in a private folder and mounted with
  `--app <name>=<private folder>`;
- `OSD_E2E_EXPECT` -- a file of the shape of `h5x-app.expect.json` with the
  real service's paths, labels, rows and sub-rows (and the private app's
  files under `appFiles`, which the spec checks carry none of the labels).

Then:

    # the host, as in milestone 2's recipe, plus the private app folder
    ( set -a; . <env file>; set +a; STG_DB=hana HANA_EXISTING_SCHEMA=1 OSD_CLIENT=<client> \
      node tools/hana-serve.mjs --port <port> --app <name>=<private app folder> )
    # the spec against it
    OSD_E2E_BASE_URL=http://127.0.0.1:<port> OSD_E2E_APP_PATH=/app/<name>/index.html \
      OSD_E2E_EXPECT=<private expect.json> npx playwright test test/e2e/h5x-app.spec.mjs

Playwright's own web server (`playwright.config.mjs`) still starts the
ordinary gateway beside it; the spec does not use it.
