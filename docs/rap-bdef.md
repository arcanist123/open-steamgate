# Behavior definitions as data (R0)

`tools/rap/bdef-parse.mjs` exposes `parseBdef(source)` and a file/corpus CLI.
This is an offline source model. No RAP behavior executes, no derived ABAP
is generated, and the existing CDS write path is unchanged.

```
node tools/rap/bdef-parse.mjs example.bdef.asbdef --json
node tools/rap/bdef-parse.mjs --corpus corpus-directory --json
```

Single-file output is JSON (compact by default, indented with `--json`). Corpus
mode walks sorted directories, skips symlinks and `.git`, reads only
`*.bdef.asbdef`, and prints `{files, entities, actions, unparsed}`. `actions`
counts ordinary and determine actions, including projection uses and draft
actions; it excludes functions and association link/unlink references. It counts
source declarations, without resolving uses or deduplicating names.

## Model schema, version 1

Names retain source spelling; keywords are normalized to lowercase. Missing
optional properties are absent unless a default is given below. Arrays preserve
source order. Lines and columns are one based.

| Model property | Shape / meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `implementationType` | `managed`, `unmanaged`, `projection`, `abstract`, `interface`, or `null` |
| `implementationClass`, `unique` | Class name (default `null`), optional uniqueness flag |
| `strict` | Integer level, `true` for unqualified strict, or `null` |
| `withDraft` | Boolean, default `false`; includes `use draft` |
| `collaborativeDraft` | Optional Boolean for collaborative draft |
| `options` | Save mode, privileged mode, side effects usage, extensibility descriptors |
| `authorizationContexts` | Known authorization context declarations retained as located raw source |
| `entities` | Entity records below |
| `unparsed` | `{line, endLine, raw, context, reason}[]`, default empty |

Every entity has `entity`, `alias` (default `null`), `line`,
`implementationClass` (default `null`), `options`, and these arrays:
`fields`, `operations`, `associations`, `actions`, `functions`, `determinations`,
`validations`, `determineActions`, `sideEffects`, `mappings`.

| Entity property | Shape / meaning |
| --- | --- |
| `implementationType`, `root` | Optional abstract/root qualifiers |
| `implementationClass`, `unique` | Per-entity implementation override |
| `persistentTable`, `draftTable`, `draftQuery` | Names |
| `lock`, `authorization`, `etag` | `{kind: 'master', options}` or `{kind: 'dependent', association}`; master etag adds `field`; inherited dependency without `by` has `association: null` |
| `totalEtag`, `numbering`, `useEtag`, `using` | Field; `early`/`late`; Boolean; interface name |
| `fields` | `{attributes: qualifier[], fields: string[], line}[]` |
| `operations` | `{kind: 'create'/'update'/'delete', use, options: qualifier[]}[]` |
| `associations` | `{name, use, operations, withDraft, abbreviation?}[]`; operations contain `create` with options or `link`/`unlink` with action name |
| `actions`, `functions` | Callable records below |
| `determinations`, `validations` | `{name, options, on: 'modify'/'save', triggers}[]` |
| `determineActions` | Callable records with `triggers` |
| `sideEffects` | `{line, endLine, raw}[]`, including block braces |
| `mappings` | `{table, corresponding, extensible, control?, fields: [{field, column}]}[]` |

A qualifier is `{name, value}` with `value: null` for an unqualified flag.
Examples include `readonly`, `mandatory:create`, `numbering:managed`,
`features:instance`, `authorization:update`, `precheck`, and authorization
master's `global`/`instance`/`none`. Qualifier names and values are preserved
as data; this parser does not validate their semantic combinations.

A callable has `name`, `use`, `modifiers` (`static`, `factory`, `internal`,
`draft`), `options`, `line`, and `cardinality` (default `null`). Optional members:
`parameter: {name, deep, table}`, `result: {options, cardinality, deep, type}`,
`defaultFunction`, `optimized`, `additionalImplementation`, `extensible`.
Parameter `deep` and `table` are explicit Booleans: `parameter X` gives
`{name: 'X', deep: false, table: false}`, `deep parameter X` gives
`{name: 'X', deep: true, table: false}`, and `deep table parameter X` gives
`{name: 'X', deep: true, table: true}`. Result `deep` is independently `true`
for `deep result` and otherwise `false`; no parameter is added by a result-only
declaration. Result `type` retains the referenced name, including `$self`.
Cardinalities are strings such as `1` and `0..*`.
Determine actions add `triggers: [{kind, name}]`, where kind is `validation` or
`determination`, and names can be qualified as `Item~Check`.
Ordinary triggers are `{kind: 'create'/'update'/'delete'}` or
`{kind: 'field', fields: string[]}`.

For example, the original fixture `field (readonly) Id; action Check result [1]
$self;` produces a field group with `attributes: [{name: 'readonly', value:
null}]` and `fields: ['Id']`, and an action whose result has `cardinality: '1'`
and `deep: false`, `type: '$self'`.

## Coverage and recovery

The recursive-descent parser handles implementation and entity headers, field
control, CRUD, associations, callables, modify/save triggers, determine actions,
projection uses, draft operations, and table mappings including unmanaged control
types. Comments, strings (including doubled quotes), namespaced names, and nested
blocks are tokenized before grammar parsing. Known authorization context and
extensibility blocks retain raw source; side effects deliberately retain a raw
block rather than claiming to understand their inner expressions.

Unknown statements and nested members become located `unparsed` entries.
Recovery stops at balanced statement/block boundaries; unknown entity header
clauses also stop at a line boundary because headers have no semicolons.
Malformed strings/comments and unrecoverable structural truncation throw;
the CLI exits 1 for those or file/argument errors. Recoverable unknown grammar
exits 0 **with nonempty `unparsed`**. Consumers must require an empty array
before generating types or behavior. A successful parse is not an ABAP syntax
or semantic validation, nor proof that a referenced entity/table/class exists.

The local measurement uses the public Apache-2.0
[SAP flight reference scenario](https://github.com/SAP-samples/abap-platform-refscen-flight),
branch `ABAP-platform-2025`. Sources remain gitignored and no oracle text is
copied into the original inline tests. Managed and draft samples have zero
unparsed constructs. Extension definitions/members, instance hierarchies and
compiler pragmas remain outside this slice and appear in `unparsed`.

## Reuse boundary and R1

The installed `@abaplint/core` 2.120.73 `BehaviorDefinition.parseSource` still
extracts only entity/alias pairs with a regular expression. Its CDS lexer has
useful comment/string handling but splits namespaced names, lacks exact source
offsets, and does not reject unterminated lexical input. The scanner reuses
abaplint's `Identifier` and `Position` classes while retaining its own exact
spans; the grammar is recursive descent over tokens, not source-wide regexes.

R1 combines BDEF with DDLS/DDIC and derives the RAP request/response types,
including `%cid`, `%key`, `%tky`, `%control`, `%msg`, `%fail`, and draft identity.
It must resolve projection uses, aliases, composition dependencies, mapping
chains, and result/parameter entities and reject incomplete models first.
Behavior pool skeleton generation/checking, transactional buffering, EML, draft
execution, and OData V4 remain later work; see [the R0-R4 plan](oracle-rap.md).
