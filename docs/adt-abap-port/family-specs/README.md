# Family specs (ADT on ABAP 100%)

One file per Node route family: behaviour to keep byte-equal, host dependencies, recommendation, ABAP design, test plan, risks, effort, owner. The plan is [port-plan.md](../port-plan.md). Line numbers are as of 2026-10-02 and drift: find a route by its pattern. The critic's findings are in [critic.md](critic.md).

- [discovery-compatibility](discovery-compatibility.md): port-to-abap, S, stoker (proposed: discovery is the logon handshake, HEAD core/discovery is the CSRF token fetch, and it sits next to sessions/logoff and the slice-3 front that stoker already owns; the graph, its twin, is also from the skeleton slices)
- [checkruns](checkruns.md): port-to-abap, M, dell
- [editor-helpers-transport](editor-helpers-transport.md): port-to-abap, M, stoker (proposed: OBJECT is his host command and the transport check belongs to his write/activate flow; one codex slice). Needs dell's confirmation, since port-map.md lists the feeds under SKELETON and occurencemarkers under C2.
- [sessions-logoff-reentrance](sessions-logoff-reentrance.md): port-to-abap, M, stoker
- [run-classrun-notebook](run-classrun-notebook.md): abap-protocol-plus-host-continuation, L, dell (group C per port-map: C5 classrun now, C6 notebook after stoker's 4b continuation)
- [source-read-objectstructure](source-read-objectstructure.md): port-to-abap, L, dell
- [object-create-delete](object-create-delete.md): port-to-abap, M, stoker
- [abap-unit](abap-unit.md): abap-protocol-plus-host-continuation, L, dell
- [data-preview](data-preview.md): port-to-abap, L, dell
- [ddic-reads-typestructure](ddic-reads-typestructure.md): port-to-abap, M, dell (group B, unit B8 in port-map; typestructure is SKELETON step 11, also dell). Could be split into two S slices: (1) typestructure + parser/info + ZCL_OSD_ADT_TYPES=>ALL; (2) DTEL/TABL documents + the shared entity/encode lift.
- [activation-inactive (slice 4b)](activation-inactive-slice-4b.md): abap-protocol-plus-host-continuation, L, stoker
- [osd-introspection (port-map group D, units D1-D4: core/http/build, changed, git/object, git/object/revision, services, transactions, segw/entitysets, xref/readers, xref/closure)](osd-introspection-port-map-group-d-units.md): port-to-abap, L, Proposed (group D is unassigned). The split is:
- dell leads the family. xref/readers, xref/closure and segw/entitysets are where-used and repository-read logic next to group B's where-used. build/changed/services/transactions ride the SYSTEM skeleton dell already owns.
- git/object and git/object/revision go to stoker. They sit on the git helpers next to versions (HISTORY/REVISION), and stoker knows the gitObjectRevision vs gitObjectRevisionAt difference.
- If one owner is required: dell.
- [write-includes (slice 4a): PUT source/main, PUT class include (both forms), POST class include create](write-includes-slice-4a-put-source-main.md): port-to-abap, M, stoker
- [information-system-search-tree](information-system-search-tree.md): port-to-abap, L, dell
- [functions-messages-xref](functions-messages-xref.md): abap-first (no Node route existed), M, dell: function groups and their parts, message classes, the main programs of an include, program/include preflight, where-used over WBCROSSGT, the core discovery form
