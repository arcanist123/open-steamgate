# Native CDS CHECK branch audit — PR #839, critic round 1

Reference: `bd29576752eb459dc56b8bf8cf845a8162d10405`, Node core 2.120.73.
Paths below are repository-relative; numbers refer to the final implementation.
`C` = tools/cds2ddic.mjs; `D` = tools/osd-store-ddls.mjs;
`G` = tools/gogen/go/cdscheck/issues.go; `I` = inspect.go;
`W` = whitespace.go in that same Go package.

This is a diagnostic projection, not another CDS parser or generator. Every
reachable Node helper and branch is accounted for below, including metadata
branches whose results are not read by ddlsIssues. “Metadata only” explicitly
means there is no Go implementation, rather than claiming a full generator port.
The copied input tree contains expression nodes; Identifier/token nodes are not
needed to compute diagnostic field names, bases, refusals or write eligibility.

| Node location and branch | Go location / disposition |
| --- | --- |
| C52 tokensOf: present node / absent node gives empty text | I45–49 `text`; copied Expression.Text |
| C53 nodeName: constructor name / empty | I5–8 Expression.Kind; copied by the public CDS API |
| C54 children: children / empty | I7 Children; nil slice is empty |
| C55 find: match current node, recurse in child order, no match | I20–31 `find` |
| C56 firstDirect: first matching direct child / undefined | I33–43 `direct`; child order precedes kind order |
| C57 normAnno: dot spacing, colon spacing, at-sign spacing, trim | G9–12,25–26; W10–14 preserves ECMAScript whitespace |
| C62–63 castType: regex fails | G17,54–57 false |
| C64–66 castType: lowercasing, absent length/scale → zero | G59 lowercases; numeric values metadata only |
| C68 char, explicit length / zero defaults to 1 | G60–61 accepts; ABAP/EDM length metadata only |
| C69 numc, explicit length / zero defaults to 1 | G60–61 accepts; length metadata only |
| C70 sstring and string, explicit length / zero | G60–61 accepts both; length metadata only |
| C71 int1, int2, int4 | G60–61 accepts all three; EDM metadata only |
| C72 int8 | G60–61 accepts; EDM metadata only |
| C73 dats | G60–61 accepts; EDM metadata only |
| C74 tims | G60–61 accepts; EDM metadata only |
| C75–76 dec, curr, quan, default precision / explicit precision and scale | G60–61 accepts all three; packed-length/precision/scale metadata only |
| C77 unknown cast type | G63 false |
| C82–83 edmOf: missing type → VoidType, missing length → zero | Metadata only; no result is read by D |
| C85 CharacterType | Metadata only; field name/base retained at G162–169 |
| C86 NumericType | Metadata only; same field bookkeeping |
| C87 StringType | Metadata only; same field bookkeeping |
| C88 IntegerType / Integer8Type | Metadata only; same field bookkeeping |
| C89 PackedType, decimals present / absent | Metadata only; same field bookkeeping |
| C90 FloatType / DecFloat16Type / DecFloat34Type | Metadata only; same field bookkeeping |
| C91 DateType | Metadata only; same field bookkeeping |
| C92 TimeType | Metadata only; same field bookkeeping |
| C93 default type | Metadata only; unknown type does not discard a field |
| C98–100 parsed data/tree absent | G81–82 returns nil |
| C101–102 name, SQL name present / absent | G84–88; nil SQLView falls back to the object name; a pointer to an empty name stays empty (`??`, not truthiness). The public CDS API retains both cases; the pinned parser only captures nonempty `[\w/]+` SQL names |
| C103 direct view annotations / none | G28–37,171 |
| C104–105 direct select absent | G89–92; return drops SQL/source/fields just as Node's skip object does |
| C106 strip trailing source alias, trim, uppercase | G13,103; W10–14 |
| C107 join present / source count zero or greater than one | G94–97 |
| C119–121 WHERE present | G99–101 |
| C123 compact source whitespace | G53,103 |
| C124 TABL found / VIEW fallback / neither | G104–108; Object.Found carries undefined distinction |
| C125–126 optional components / no components, uppercase names | G109–113; inspector supplies Components |
| C131–132 recursive elements, direct annotations | G114–115,28–37 |
| C133 key Identifier present / absent | Metadata only; selected-field key flags are not read by D or write.missing |
| C134–137 alias present / absent; first direct CDSName OR CDSPrefixedName | G116–119; I33–43 fixes first-child order |
| C141–142 cast absent / virtual annotation absent / virtual cast | G120–121 |
| C143–147 missing alias, absent/empty/blank class, nonblank class in any annotation | G122–125,41–50; MUST 1, per-annotation search and JS trim |
| C149–151 virtual cast unsupported | G127–129 |
| C153 virtual label present / empty / absent | Metadata only |
| C154–156 accepted virtual field | G131 omits from real fields/bases; exactly matches virtual filtering in C235 and C267 |
| C170 cast with no direct source / ordinary source | G133 |
| C176–178 cast text compacting; inner column regex match / failure | G134–138; G18–19; W10–14 |
| C179–184 no inner column / no ABAP type, alias / '?' | G139–148; same refusal priority |
| C186–190 alias / inner fallback, qualified base last segment | G150–157; cast metadata and labels only omitted |
| C192 missing/empty source name | G159–160 |
| C193 exposed association starts '_' | G159–160 omits real field; association metadata only |
| C194 expression punctuation / leading quote | G20,159–160 |
| C195–199 alias / last source segment, uppercase field/base | G162–169; labels and EDM only omitted |
| C203–205 association cardinality present / absent | Metadata only; no D dependency |
| C207–208 association target present / absent, alias / target fallback | Metadata only; no D dependency |
| C209–213 condition absent / present, AND parts, matching pair / ignored, projection on left / right | Metadata only; no D dependency |
| C219–222 association annotations absent / present, composition CHILD/PARENT/ROOT / absent, exposed / not | Metadata only; no D dependency |
| C224 view label found / name fallback | Metadata only; no D dependency |
| C231–232 flag match / no match, case-insensitive | G22,171–172 |
| C233 source is TABL / not TABL | G104–105 |
| C234 keys available / absent, uppercase | G180–181; inspector supplies Keys |
| C235 exclude virtual and empty bases, map duplicate bases | G131,173–178; map membership is all D needs |
| C236 client component present / absent | G113 |
| C237 ignore MANDT, mapped key / missing key | G180–184; preserves missing-key order |
| C238–242 write/create/update/delete flags OR, table, complete keys, no analytics | G22,172,186 |
| C243 why: no write flag | G188–189 |
| C244 why: source not table | G190–191 |
| C245 why: missing keys | G192–193 |
| C246 why: analytical | G194–195 |
| C247 why: writable, empty reason | G70 zero value,197 |
| C248–251 creatable/updatable/deletable and output key list | Metadata only; D reads asked/writable/why/mandt |
| C252–255 return diagnostic dependencies | G197 returns view; G66–70 carries precisely those dependencies |
| C267 fields absent / virtual excluded | G68 nil fields; G131 excludes virtual at construction |
| C268–269 client classification uses base, case-insensitive | G156,163,260; parsed bases already uppercase |
| C270 explicit client=false option | Generator-only; D72 calls the default client=true, no CHECK implementation needed |
| C271 first named client / none | G257–264 selects first field with MANDT base |
| C272 source not client dependent → all real fields | G260 condition false; G266 retains all |
| C273 client dependent, named client / synthetic MANDT, rest excludes all client bases | G257–269; MUST 2; preserves alias and discards later client aliases; key flag/order are not read by D72's Set |
| D15–20 parse throws | G75–79 recover inside parse,208–210; inspector/checker failures outside parse are not swallowed |
| D22–24 no parse tree | G212–213; precedes table-function exception |
| D26 file present / absent, fixed coordinates/rule | G203–207; tools/gogen/lint-engine.mjs:193 emits rule cds and line/column 1 |
| D36–38 raw files joined; table function found / not | G215–220; same ordering after parse |
| D44–50 nonempty source missing from TABL, VIEW and DDLS | G223–224; same short-circuit lookup order |
| D52–54 skip present / absent | G226–227; skip is always a nonempty fixed reason from parse |
| D55–58 unresolvedAssociations present / absent | Not produced by this parseDDLS at C97–256; always absent on this path; intentionally no fabricated Go diagnostic |
| D69–71 generated view absent / present, components absent / present | G229–234; inspector supplies optional components |
| D72–73 generated names absent from new name Set | G231,235–236; G255–271 implements client selection |
| D74–80 no gone fields / one / multiple | G239–244, same order and singular/plural wording |
| D83–86 asked and not writable / all other combinations | G247–248 |
| D87 return issues, extra diagnostic order | G250; missing source, skip, generated shape, write warning in Node order |

No functions after C274 are called by parseDDLS/viewFieldsOf/ddlsIssues.
In particular, resolveWriteChain/inheritAssociations run during generation, not
CHECK; porting their derived unresolvedAssociations would change the Node oracle.

Additional corrections found in the audit: first-child selection and ECMAScript
whitespace (BOM, NBSP, vertical tab; NEL is not JavaScript whitespace). These are
covered independently of the two critic cases. SQL view extraction was checked
against the installed core's getSQLViewName/getParsedData implementation; both
read the same parsed property.

Validation: table-driven fact JSON round trips; all 13 accepted cast kinds and
unknown/missing types; absent/valid/blank classes, later valid annotation, BOM/NEL;
implicit/explicit/aliased/duplicate client selections with an old generated view;
write flag variants, lookup fallbacks, skip branches, exception/no-tree ordering,
singular/plural stale fields. Go statement coverage: cdscheck 100.0%, adtoutline
82.6%. Outline fixtures assert program events, scoped global/local method links,
test class/method flags and include links, macro-only shells, and empty Any JSON.
Statement coverage is not a claim of exhaustive parser or runtime coverage.

Final linked-library differential: 364 objects, 1004 files, 436 CHECKs,
797 OUTLINEs, 45 mutations, zero mismatches, with no executable on PATH and
Other guarded by a panic sentinel. Node and Go SHA-256 both:
`ae71a41359db5f5103e879ec7518cee7a8444069a413a18805467b74d955835d`.

Both MUST tests fail against bd295767 using a temporary `go test -overlay`
that restores the base issues.go and inspect.go, without changing the checkout.
Both pass with the fixes. The critic's real-parser reproducer also returned
empty Go issue lists on the original checkout, against Node's expected E and W.

Checks passed: gofmt; go vet and go test -race for adtoutline, cdscheck,
storelint, lintinput; node --test test/native-check-outline.mjs (3 tests);
the same suite under the heavy-wrapper Mocha runner (3 tests); adapter and
CHECKRUN differential contract tests (11 tests); suite registry (351 ordinary,
19 grouped); scoped size budgets (160 budgets); git diff --check.

## Public CDS API follow-up

The adapter is removed in favor of abapiti `da13e34d` (PR #246, based on
selfhost `8df2b932`) on the same core `9f7f098c`. The bridge calls CDS, DDIC and
Files directly. SQL names retain nil versus an explicit empty string; only nil
falls back to the CDS object name. The fact oracle also injects an explicit empty
snapshot value because the pinned parser only captures nonempty annotation names.

The full linked differential passes 438 CHECKs, 799 OUTLINEs and 47 mutations
with identical Node/Go hashes and zero mismatches. This extends the previous
436/797/45 run with absent/empty annotation cases and a same-name generated
consumer. Focused native and bridge tests, vet/race tests for the policy and
lifecycle packages, all 160 size budgets, suite registration and leak checks pass.
No OSG adapter or generated-library SHA-256 pin remains.
