# src/rap_r4 -- the trip demo of RAP R4

A managed business object that uses the behavior constructs of the flight
reference scenario's travel (`/DMO/I_TRAVEL_M`) that do not need a
composition, written the way that scenario writes them
([docs/rap-runtime.md](../../docs/rap-runtime.md), "R4"):

| construct | here |
| --- | --- |
| `etag master last_changed_at` | the entity type's ETag over V2 and V4; 428 without `If-Match`, 412 on a stale one |
| `@Semantics.systemDateTime.localInstanceLastChangedAt`, `@Semantics.user.createdBy` | stamped by the runtime on create and on change |
| `early numbering` + `FOR NUMBERING IMPORTING entities FOR CREATE trip` | the pool draws the next `trip_id` |
| `update / delete ( features : instance )`, `action ( features : instance )` + `FOR INSTANCE FEATURES` | an accepted trip cannot be accepted again or deleted, a rejected one not rejected again or changed |
| `determination SetStatus on modify { create; }` | a new trip is open (`O`) |

The handlers use EML (`READ ENTITIES` / `MODIFY ENTITIES ... IN LOCAL
MODE`), which reaches the calling transaction while they run.

- `zrap_trip` -- the table; `zi_rap_trip` -- the view; `zi_rap_trip.bdef` -- the behavior
- `zbp_rap_trip` -- the behavior pool (handlers in the system's form)
- `zui_rap_trip.srvd` -- served at `/sap/opu/odata/sap/ZUI_RAP_TRIP` and `/sap/opu/odata4/sap/ZUI_RAP_TRIP`

Test: `npx mocha test/rap-r4.mjs` (after `npm run transpile`).
