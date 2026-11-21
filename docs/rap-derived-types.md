# RAP derived types (R1)

R1 chooses a local generator (option a). `tools/rap/bdef-gen.mjs` writes ordinary
ABAP interfaces to ignored `gen/rap/`. The transpile source loader replaces
explicit `TYPE TABLE/STRUCTURE/RESPONSE FOR ...` declarations with references to
those interfaces in memory. Source files retain their RAP declarations. There
is no upstream package patch and no RAP execution in this change.

```
node tools/rap/bdef-gen.mjs
npx mocha test/rap-derived-types.mjs test/rap-bdef-parse.mjs
```

## Inputs and output

The generator uses the same ordered content roots as CDS generation: `src/`,
configured content layers and packs, with later filenames winning. It never
collects behavior definitions from tests or dependency libraries. Library DDIC
is read from the existing locked core/OData paths to resolve field types.
Without BDEFs it reads no libraries and produces nothing; old `gen/rap/` output
is removed. Output names, declarations and bindings are deterministic. Failed
model validation happens before output is changed.

Each BDEF gets a `zif_rap_<stable-name-hash>` interface. Local entity prefixes
(`e0`, `e1`, ...) keep names within ABAP limits. `bindings.json` maps explicit
forms and qualified entity/action references to the interface's table or row
type. The transpiler excludes BDEFs and that JSON, and reads the generated
interfaces as ordinary ABAP. Lint includes `gen/rap/`.

The BDEF model must have no `unparsed` entries. Entity fields and key flags come
from the existing `cds2ddic.parseDDLS` model. Scalar ABAP declarations come from
the DDIC types behind those fields, preserving lengths, decimals and CDS aliases;
CDS casts use the pipeline's explicit ABAP type. Simple CDS projection chains
resolve recursively. Missing entities, unknown fields/types, cycles, unsupported
CDS elements, missing persistent tables and invalid explicit mappings fail.
Table mappings validate persistence names; they do not rename the CDS-facing
components in a derived signature.

## Component layout

Named ABAP includes preserve both direct access (`row-noteid`) and component
groups (`row-%key-noteid`). `%key` groups CDS keys, `%pky` adds `%pid` for late
numbering, and `%tky` adds `%is_draft` for draft-enabled definitions. `%data`
groups the entity payload. Flags and field-control markers use `x LENGTH 1`;
`%fail-cause` is an integer (the `if_abap_behv=>cause` values of R2);
content IDs use `c LENGTH 128`, and preliminary IDs use `x LENGTH 16`.

| Kind | Row contents beyond identity |
| --- | --- |
| CREATE | Entity fields / `%data`, `%cid`, `%control` for each CDS field |
| UPDATE | Entity fields / `%data`, `%cid_ref`, `%control` |
| DELETE | `%cid_ref` |
| READ IMPORT | `%control` |
| READ RESULT | Entity fields / `%data` |
| ACTION IMPORT | `%cid_ref`, `%param` when a parameter is declared |
| ACTION RESULT | `%param` from the declared result, including `$self` |
| MAPPED | `%cid` |
| FAILED | `%cid`, `%fail-cause`, operation markers in `%op` |
| REPORTED | `%cid`, `%msg`, `%element`, `%state_area`, `%global` |
| LOCK, KEY OF, DETERMINATION, VALIDATION | Identity |

CRUD families are emitted only when declared. Table forms are standard tables
with default key; structure forms use their row type. Default and EARLY response
forms group entity tables by BDEF alias. Aliases can also be addressed through
`bdef\Alias`; entity names work directly. Action references append `~Action`.
Multiple entities receive separate row types and response components.

The identity/content/control distinctions follow SAP's
[implementation contract](https://help.sap.com/docs/ABAP_PLATFORM_NEW/fc4c71aa50014fd1b43721701471913d/1040b81372d44ed38b07a409fa0e1769.html)
and [control mapping documentation](https://help.sap.com/docs/abap-cloud/abap-rap/using-type-and-control-mapping).
The response aggregation follows
[TYPE RESPONSE FOR](https://help.sap.com/docs/abap-cloud/abap-keywords-standard-abap/type-response-for).
These are a compiler representation of the supported components, not a claim of
SAP runtime or RTTI equivalence. In particular, `%msg` is currently a generic
object reference; message interfaces and message dispatch belong to runtime
work. Secondary table keys and the full set of response operation groups are
not reproduced.

## Integration and boundary

The cold build invokes this generator after CDS generation and before service
generators. The hosted `osd gen bdef-gen.mjs` dispatch knows the generator too.
The loader uses ABAP lexer tokens, so comments, quoted strings and templates
are preserved. It keeps the original line count for source maps. Warm priming
and registry refresh apply the same lowering. Frozen verification reads retained,
digest-checked bindings alongside the retained raw source, so a later generator
run cannot change a historical compilation. Unsupported
explicit derived forms fail with a filename and line. A source with derived
forms takes a cold build when edited; warm compilation cannot bypass lowering.

Supported BDEFs are managed/unmanaged definitions with scalar entity fields and
ordinary instance actions. Projection BDEF `use` resolution, create by
association/compositions, functions, determine actions, static/factory/internal
and draft actions, deep/table action parameters, abstract parameter entities,
LATE responses, feature/authorization request types and EML are rejected or
outside the explicit lowering surface. A BDEF can describe draft identity or
late numbering for compilation; this supplies no draft or numbering execution.

`src/rap_demo/` is original source: a managed root over `ZRAP_NOTE`, CRUD,
Approve, SetStatus, Normalize and CheckText. Its pool's `lhc_note` uses explicit
derived method parameter declarations; its twin `ZI_RAP_NOTE_SF` (same table,
same behavior) has a pool written in the system's form, below. R1 proves
compilation; the managed runtime (handler dispatch, buffer, save sequence,
persistence) is R2, [docs/rap-runtime.md](rap-runtime.md).

## Handler declarations (R3)

A handler on a system declares no parameter types: the form of the
declaration implies them.

| Declaration | Becomes |
| --- | --- |
| `METHODS m FOR DETERMINE ON MODIFY\|SAVE IMPORTING keys FOR ent~det.` | `IMPORTING keys TYPE <determination keys> CHANGING reported` |
| `METHODS m FOR VALIDATE ON SAVE IMPORTING keys FOR ent~val.` | `IMPORTING keys TYPE <validation keys> CHANGING failed reported` |
| `METHODS m FOR MODIFY IMPORTING keys FOR ACTION ent~act [RESULT result].` | `IMPORTING keys TYPE <action import> CHANGING [result TYPE <action result>] mapped failed reported` |
| `METHODS m FOR MODIFY IMPORTING c FOR CREATE ent u FOR UPDATE ent d FOR DELETE ent.` | one `IMPORTING` per clause, `CHANGING mapped failed reported` |
| `METHODS m FOR READ IMPORTING keys FOR READ ent RESULT result.` | `IMPORTING keys TYPE <read import> CHANGING result TYPE <read result> failed reported` |
| `METHODS m FOR LOCK IMPORTING keys FOR LOCK ent.` | `IMPORTING keys TYPE <lock keys> CHANGING failed reported` |
| `METHODS m FOR INSTANCE FEATURES IMPORTING keys REQUEST req FOR ent RESULT result.` (R4) | `IMPORTING keys TYPE <features key> req TYPE <features request> CHANGING result TYPE <features result> failed reported` |
| `METHODS m FOR NUMBERING IMPORTING entities FOR CREATE ent.` (R4) | `IMPORTING entities TYPE <create> CHANGING mapped failed reported` |

`failed`, `reported` and `mapped` are the BDEF's `RESPONSE FOR ... EARLY`
structures. Which form has which of them follows the public ABAP keyword
documentation as read here, not a measurement: determinations `reported`,
validations, reads and locks `failed` and `reported`, every `FOR MODIFY`
all three. Parameter names are the author's (`IMPORTING lt_keys FOR ...`
works); `ent` is the entity's alias or CDS name, resolved against the BDEF
whose `implementation in class` is the pool the file belongs to
(`zbp_x.clas.locals_imp.abap` is pool `ZBP_X`, `#dmo#bp_x...` is
`/DMO/BP_X`). For that, `bdef-gen.mjs` writes pool-scoped bindings
(`POOL ZBP_X FOR DETERMINATION NOTE`, `POOL ZBP_X FOR RESPONSE FAILED`, ...)
into the same `bindings.json`, and the lowering runs in the same source
loader step, before the derived-type lowering, keeping rows and comments.
abaplint parses these declarations but gives them no parameters at all
(ANORMALIES, `rap-implicit-handler-params`), which is why the lowering is
needed.

R4 adds the instance feature types of every entity: `TABLE FOR INSTANCE
FEATURES KEY` (the `%tky`), `STRUCTURE FOR INSTANCE FEATURES REQUEST` and
the `%features` group of `TABLE FOR INSTANCE FEATURES RESULT` (both
`%update`, `%delete` for the operations the entity declares, `%action-<a>`
per action and `%field-<f>` per element, each `x LENGTH 1`, an
`if_abap_behv=>fc-o` / `fc-f` value), the result row being `%tky` plus that
group. Early numbering needs no new type: its `entities` are the `TABLE FOR
CREATE`.

Refused with the file, the row and the form: `FOR GLOBAL FEATURES`,
`FOR INSTANCE|GLOBAL AUTHORIZATION` (no derived request/result types are
generated yet), `FOR NUMBERING ... FOR CREATE ent\_assoc`, `FOR PRECHECK`,
`FOR MODIFY ... FOR CREATE ent\_assoc` (create by association), and a
reference no BDEF of that pool declares (an unknown entity, action or a
`RESULT` on an action without one).

The runtime binds a determination, validation or action to the method whose
`FOR` clause names it (the explicit form is still bound by name) and passes
each parameter by its role; see [rap-runtime.md](rap-runtime.md).

Option b would require abaplint to resolve BDEF/CDS dependencies into concrete
`StructureType`/`TableType` objects for explicit forms and implicit method
parameters, including named component groups, action payloads, projection uses,
response phases and draft/numbering identity. The transpiler would then need
coverage of those concrete types and handler declarations; EML still requires
its own lowering/runtime. That is a separate upstream change with releases and
compatibility tests. This bridge can be removed when that support is available.

## Verification

`test/rap-derived-types.mjs` checks resolved ABAP types, required components,
draft/PID additions, actions, source preservation, invalid models, pack
precedence, fixture exclusion, stale output and the no-BDEF case. It lints the
original demo with open-abap syntax, then uses the real source loader and
production exclusions to lint and transpile the lowered pool and interfaces.
It also replays retained compiler inputs after changing the live bindings and
checks that the generated code is identical.
The targeted tests run under the job's machine-wide heavy lock. No SAP system
was accessed and no corpus source was copied.
