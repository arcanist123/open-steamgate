# src/rap_r6 -- the bill demo of RAP R6

A managed business object with the three kinds of action the flight
reference scenario declares beside the instance action, written the way
that scenario writes them ([docs/rap-runtime.md](../../docs/rap-runtime.md),
"R6"):

| construct | here | flight |
| --- | --- | --- |
| `internal action ReCalcTotal;` | the determination `calcTotal` executes it IN LOCAL MODE; no client can (not in the service, `ZCX_OSD_RAP` from EML outside the BO) | the travel's `ReCalcTotalPrice` |
| `factory action copyBill [1];` | a new bill from an existing one, answered in MAPPED under the import row's `%cid`; over OData the answer is the copy | the travel's `copyTravel` |
| `determine action check { validation checkAmount; determination ( always ) countCheck; }` | the validation where its triggers hold since the last save, the determination always | `Prepare` (there a draft determine action) |

- `zrap_bill` -- the table; `zi_rap_bill` -- the view; `zi_rap_bill.bdef` -- the behavior
- `zbp_rap_bill` -- the behavior pool (handlers in the system's form, EML inside them)
- `zc_rap_bill` -- a projection that uses the factory and the determine action (and cannot use the internal one)
- `zui_rap_bill.srvd` -- served at `/sap/opu/odata/sap/ZUI_RAP_BILL` and `/sap/opu/odata4/sap/ZUI_RAP_BILL`;
  `zui_rap_billc.srvd` the projection, at `.../ZUI_RAP_BILLC`

Tests: `npx mocha test/rap-r6.mjs` and `node tools/osd-unit.mjs CLAS ZCL_OSD_RAP_R6_TEST`
(after `npm run transpile`).
