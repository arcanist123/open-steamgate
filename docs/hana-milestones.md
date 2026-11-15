# The HANA track: milestones, and what is known not to work

The track runs real ABAP classes over a database that an SAP system already
holds, with no ABAP server in between: a closure of the classes is dumped,
transpiled and served read-only by `tools/hana-serve.mjs`, and every answer is
compared with the system's own. How the host is built is in
`docs/db-backends.md`, "A host over an existing schema" and "The closure, by
iteration"; the pieces of each milestone are in `docs/hana-milestone-2.md` and
`docs/hana-milestone-3.md`. This page is the ledger: what closed, what was
measured, and what does not work yet.

## Milestone 2 (closed 2026-11-14, PR #942)

One generated sample service: its `$metadata` structure-equal to the system's
and one business set equal, over a database with no ABAP server. Repeated on a
second edition of the database.

## Milestone 3 (closed 2026-11-15, last PR #959)

The same service's whole read side, and a Fiori Elements app on it. The oracle
is 115 requests captured from the system (the capture stays private). Each
pass sends them to the host and sorts every request: equal; equal after a
declared format normalisation; failing; different by design; silently wrong
(answers 200 with a different value, the class that matters most).

| | before (102 requests) | pass 1 | pass 2 | pass 3 | pass 4 |
|---|---|---|---|---|---|
| equal | 17 | 63 | 77 | 97 | 98 |
| format-only | -- | 11 | 18 | 0 | 0 |
| failing | 81 | 35 | 13 | 12 | 12 |
| by design | -- | 6 | 5 | 5 | 5 |
| silently wrong | 4 | 0 | 2 | 1 | 0 |

What the last pass proved, on a fresh clone and a fresh closure:

- The closure reaches its fixed point by itself: 12 iterations, 178 objects,
  37 stubbed methods, search helps 11 of 11 resolved, and the tables behind
  the conversion exits asked for by the iterator (iteration 2), not by hand.
- The app goes list, object page, and a 10-row sub-list through `$batch`.
- 0 writes reach the database, with a positive control (the trace check fails
  when the probe is cut).
- The client filter holds on tables that carry two clients.
- No request that was equal in the previous pass stopped being equal.

PRs: #943 #944 #945 #947 #952 #953 #955 #956 #957 #946 #954 #951 #958 #959.

## Known, not done

| what | how it shows | status |
|---|---|---|
| Value helps selected through an exit function | 12 oracle requests (four sets, each as top 5, count and single read) answer an error that names the reason | not served; the only failing class left |
| Data-element labels in other logon languages | `$metadata` in a second language lacks 33 labels when the dump carries only master-language texts | open; needs the translations in the dump |
| Speed of the largest list | the whole 205-row product list takes 249 ms warm, the system 58 ms; unit caches are per request, not per session | correct, slower; not worked on |
| `$inlinecount=allpages` with `$top` on a value-help set | answers the page size | not measured on a system; pinned by a test only |
| Atom format, `sap:supported-formats` | not produced | by design: JSON only |
| Association order in `$metadata` | differs from the system's | by design |
| Another `sap-client` | answers 400 where the system answers 401 | by design, not changed |
| A `$filter` value through a conversion exit on input | not converted | measured: the system does not either for an unpadded key; keys in the path are converted |
| Writes | none | by design: the host is read-only |
| The merged tree against the measurement | pass 4 ran one commit before the final merge; that commit added input validation of `$top` and `$skip` only, covered by unit tests | not re-measured on the database |

## Milestone 4 (open)

A funnel over every registered service, counted stage by stage: registered,
answering, code-based, island closes and loads, `$metadata` equal, set reads
equal with no stub on the read path. The first census, by count only: 64
registered, 37 answering, 19 code-based. Today one service reaches the last
stage (the milestone-3 sample).

What stands in the way, by class and without names: members of the gateway
framework contract that the transpiled model code calls and nobody has
implemented, so a model definition stubs out; the closure's frontier, where the
walk over definitions does not converge on a family of services; function
modules called on the read path and absent from the dump; and dependence on a
logon session. Each is a work item of its own, and the funnel reports by family
and by request, not as one percentage.

Host safety: the guard against outbound calls and the stub trace are in review
(PR #960). The host is read-only and is not to be exposed beyond loopback.
