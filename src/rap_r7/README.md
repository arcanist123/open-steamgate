# src/rap_r7 -- the tour demo of RAP R7

A managed business object shaped like the flight travel BO where R6 left
it: a saver in the root's pool, the child's handlers in a pool of their
own, the root written by the managed save and then by the saver, the child
written by the saver alone ([docs/rap-runtime.md](../../docs/rap-runtime.md),
"R7"):

| construct | here |
| --- | --- |
| `with additional save` on the tour | the managed save writes `zrap_tour`, then `lsc_tour->save_modified` logs the change into `zrap_tourlog` (CREATE, UPDATE of `description` / `status` by `%control`, DELETE) |
| `with unmanaged save` on the stop | no persistent table: `save_modified` writes `zrap_tourstop`; saved stops are read from the `mapping for` table |
| `implementation in class zbp_rap_stop` | the stop's validation `CheckNights` is in a second pool |
| `mapping for zrap_tourstop corresponding { place = place_name; }` + `CORRESPONDING #( create-stop MAPPING FROM ENTITY )` | the saver turns the request into table rows through the BDEF's mapping |

- `zrap_tour`, `zrap_tourstop`, `zrap_tourlog` -- the tables; `zi_rap_tour`, `zi_rap_tourstop`, `zi_rap_tourlog` -- the views
- `zi_rap_tour.bdef` -- the behavior; `zbp_rap_tour` (tour handlers, the saver), `zbp_rap_stop` (stop handlers) -- the pools
- `zui_rap_tour.srvd` -- served at `/sap/opu/odata/sap/ZUI_RAP_TOUR` and `/sap/opu/odata4/sap/ZUI_RAP_TOUR`, with the log as a read-only set `Log`

The cba numbering reads the stops by association; the pinned transpiler
does not lower `READ ENTITIES ... BY \_stops` yet, so the call is written as
the `ZCL_OSD_RAP_EML=>READ_BY` it lowers to, with the statement in a comment
above it.

Tests: `npx mocha test/rap-r7.mjs` and `node tools/osd-unit.mjs CLAS ZCL_OSD_RAP_R7_TEST` (after `npm run transpile`).
