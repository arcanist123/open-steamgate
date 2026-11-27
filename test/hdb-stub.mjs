import {createRequire} from "node:module";

// The give-back for a fake hdb driver stood into require.cache.
//
// tools/hana-client.mjs loads "hdb" inside connect() through createRequire,
// so a test can drive it without a HANA by pointing the same CJS cache a
// real require would use at a stand-in first. The stand-ins carry no
// prepare -- query() then takes the plain exec path, which is the point.
//
// The give-back is part of installing, not a courtesy: the suites runner
// runs a shard's files in ONE process, and a stand-in left behind follows
// the file into the next hdb consumer in that shard. The measured shape of
// the damage (the RED this helper was added for): connect() still answers,
// because exec is on the fake, and the first native() call dies with
// "this.client.prepare is not a function" -- test/sqlscript-vs-hana.mjs,
// which alone skips without a HANA instead.
//
// A DELETE, not a restore of a saved previous entry: at the first install
// the real driver has never been required, so the saved original would be
// undefined and a restore keyed on it would return early -- the stand-in
// survives the suite after all. The next require after the delete loads the
// real driver fresh, which is what a later file in the shard wants.

const require = createRequire(import.meta.url);

/** delete the require.cache entry "hdb" resolves to; call from afterEach */
export function giveBackHdb() {
  delete require.cache[require.resolve("hdb")];
}
