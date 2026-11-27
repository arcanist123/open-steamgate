# src/rap_r5 -- the order demo of RAP R5

A managed business object with a composition, served through a projection
BDEF, written the way the flight reference scenario writes its travel and
bookings ([docs/rap-runtime.md](../../docs/rap-runtime.md), "R5"):

| construct | here |
| --- | --- |
| `composition [0..*] of ZI_RAP_ORDITEM as _Items` / `association to parent ZI_RAP_ORDER as _Order` | the tree: an order and its items, the item key extends the order's |
| `association _Items { create; }` + `FOR NUMBERING IMPORTING entities FOR CREATE order\_items` | create by association; the pool numbers the items 10, 20, ... below their order |
| `association _Order;` | read by association, up to the parent |
| `lock master` / `lock dependent by _Order` | a write of an item locks its order |
| `@Semantics.systemDateTime.lastChangedAt` + `etag master` on the order | the order's ETag moves with every item write |
| `etag master item_changed_at` on the item | the item's own ETag |
| `validation CheckQuantity on save` on the item | a child's validation in the save |
| `projection;` with `use create / update / delete / association` over `as projection on` views | the service runs on the projection, renamed fields (`order_id` -> `OrderId`) |

The pool reads the items of an order by association while it numbers
them; the pinned transpiler does not lower `READ ENTITIES ... BY \_items`
yet, so the call is written as the `ZCL_OSD_RAP_EML=>READ_BY` it lowers to,
with the statement in a comment above it.

- `zrap_order`, `zrap_orditem` -- the tables; `zi_rap_order`, `zi_rap_orditem` -- the views; `zi_rap_order.bdef` -- the behavior
- `zc_rap_order`, `zc_rap_orditem` -- the projection views; `zc_rap_order.bdef` -- the projection behavior
- `zbp_rap_order` -- the behavior pool (handlers in the system's form)
- `zui_rap_order.srvd` -- served at `/sap/opu/odata/sap/ZUI_RAP_ORDER` and `/sap/opu/odata4/sap/ZUI_RAP_ORDER`

Tests: `npx mocha test/rap-r5.mjs` and `node tools/osd-unit.mjs CLAS ZCL_OSD_RAP_R5_TEST` (after `npm run transpile`).
