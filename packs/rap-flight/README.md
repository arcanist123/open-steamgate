# rap-flight: SAP's RAP flight reference scenario as a pack

`osd-pack.json` fetches the public, Apache-2.0
[SAP-samples/abap-platform-refscen-flight](https://github.com/SAP-samples/abap-platform-refscen-flight)
at a pinned commit of its `ABAP-platform-2025` branch into `upstream/`
(`node tools/osd-fetch.mjs rap-flight`), minus what the manifest excludes --
each pattern with its reason in `_exclude_why`. `src/` layers over it. What
compiles, what is refused and what each wall blocks is measured in
[docs/rap-flight-pack.md](../../docs/rap-flight-pack.md).

What the fetch keeps: the managed scenario (`managed/`), the reuse layer it
reads (`reuse/`, `reuse/agency`, `reuse/carrier`, `reuse/supplement`), the
read-only views (`readonly/`) and the legacy base (`legacy/`): the tables the
managed data generator copies from and the data generator itself.

## The overlay (`src/`)

Stand-ins for released SAP DDIC the libraries do not carry yet (`src/ddic/`;
the DDIC rule of CLAUDE.md says released objects go to open-abap-core, so
these are to send upstream and then drop):

- `ABP_LOCINST_LASTCHANGE_USER` (CHAR 12), used by eight tables
- `SDRAFT_UUID` (RAW 16), the draft tables' key; they compile, no draft runs
- `I_CURRENCY`, `I_COUNTRYTEXT` and (R10) `I_COUNTRY` as plain tables with
  the columns the scenario reads (`SELECT DISTINCT currency`, `country,
  countryname`, `country`)

Copies of the two data generators, changed where this runtime differs from a
system and nowhere else (every change is marked `OSD overlay` in the source):

- `/dmo/cl_flight_data_generator`: `GET BADI` / `CALL BADI` are not
  transpiled and the BAdI definition is an ENHS, so the one implementation
  is called directly; `cl_numberrange_intervals` has no intervals here, so
  the reset is a no-op and the three blocks of numbers are drawn from the
  interval's lower bound (what a fresh system gives); `cl_abap_random_int8`
  is absent, so phone numbers get nine digits; `CORRESPONDING ... DISCARDING
  DUPLICATES`, the lookup form `CORRESPONDING #( a FROM b USING ... )` and a
  `SWITCH` over two `REDUCE`s with `LET` are not parsed, so they are spelled
  out as loops; an inline `CORRESPONDING` in an `INSERT ... FROM TABLE @()`
  host expression and `KEY primary_key` in a table expression are spelled
  out too; and four more statements a green build accepted but the first run
  refused -- `SELECT ... FROM @itab` (the `@` reaches the SQL), a functional
  call inside a table expression's key (called per row here, once on a
  system), `cl_abap_random_int` with `min = max` (this library asserts
  `high > low`), and a string function given an integer. The non-ASCII city
  names in its literals are upstream's.
- `/dmo/cl_data_generator_managed`: the two lookup-form `CORRESPONDING`s.

`zcl_osd_rapflight_seed` runs the generator with a console and reports the
row counts; `tools/rap-flight/seed-capture.mjs` calls it and writes the rows
into `data/*.tabu.json` -- 22 files, about 11 MB, one run's counts in
[docs/rap-flight-pack.md](../../docs/rap-flight-pack.md)'s seed section. The
rows are generator output and are **not tracked**: the build makes them
(whenever the upstream commit, the overlay's generator copies or the seed
class changed, `data/.osd-seed.json` names the digest they are a function
of), so a fresh checkout seeds itself and a diff of this repository carries
no derived upstream content.

`zosd_rapflight.stg.yaml` serves the CDS interface views the generator takes
as read-only entity sets (`/sap/opu/odata/sap/ZOSD_RAPFLIGHT_SRV`), so the
seeded data can be read over the wire.

Since RAP R7 the managed travel business object runs (docs/rap-flight-pack.md,
"R7"): its BDEFs are fetched, and the overlay carries

- the three behavior pools `/dmo/bp_travel_m`, `/dmo/bp_booking_m` and
  `/dmo/bp_bookingsupplement_m`, whole, their `locals_imp` changed where this
  runtime differs (every change marked `OSD overlay`, listed in the document);
- the two service definitions `/DMO/UI_TRAVEL_PROCESSOR_M` and
  `/DMO/UI_TRAVEL_APPROVER_M` without their value helps;
- in the seed class, the currencies the generated data uses, written into
  the `I_CURRENCY` stand-in the travel's validations read;
- `zcl_osd_rapflight_r7_test`, ABAP Unit over the travel's saver.

Since RAP R10 the draft supplement and agency BOs run too (docs/rap-flight-pack.md,
"R10"): their BDEFs, service definitions and consumption views are fetched,
and the overlay carries the three pools `/dmo/bp_i_supplement`,
`/dmo/bp_c_supplement` (the projection's augment) and `/dmo/bp_r_agencytp`
(late numbering), each change marked `OSD overlay`; an `I_COUNTRY` stand-in
filled by the seed class; and `zcl_osd_rapflight_r10_test`.

Since RAP R11 the agency's interface BDEF `/DMO/I_AGENCYTP` and the carrier
singleton run as well (docs/rap-flight-pack.md, "R11"): their BDEFs, views
and `/DMO/UI_CARRIERS_S` are fetched, the overlay carries the singleton's
pool `/dmo/bp_i_carrierslocksingle_s` (changes marked `OSD overlay`), the
`I_CURRENCY` stand-in gets the carriers' currencies, and
`zcl_osd_rapflight_r11_test` covers both. All ten BDEFs of the scenario run.

Licence: upstream's files are Apache-2.0 (the repository's `LICENSES/` and
`REUSE.toml`), and so are the copies in `src/` -- [LICENSE](LICENSE) says
what is whose, [NOTICE](NOTICE) carries upstream's copyright line, each
copied file names its origin and commit in a header, and
`scripts/third-party-notices.mjs` lists the material beside zork's. The
overlay's own files (the seed class, the YAML, the stand-ins, the manifest)
are this repository's, under its MIT licence.
