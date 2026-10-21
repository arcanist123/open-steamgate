// A replay miss made a fixture, from the nearest recording.
//
//   node tools/osd-replay-promote.mjs --destination REF --url '<as missed>' \
//     --out .local/replay/promoted [--from <fixture.json>]
//
// The URL is the one `/sap/bc/osd/replay/misses` prints with each miss. The
// new fixture has the miss's key and the response of `--from`, or of the
// recording at the same path whose query differs least. It is written only
// where git would not publish it (tools/osd-replay-misses.mjs promote), so add
// that folder to the destination's `fixtures` -- first, to win over the rest.
import {dirname, resolve} from "node:path";
import {destinationOf} from "./osd-destinations.mjs";
import {fixtureFolders, loadFixtures} from "./osd-http-replay.mjs";
import {promote} from "./osd-replay-misses.mjs";
import {runsAs} from "./osd-main.mjs";

/** `--name value` pairs; a flag without a value is an error, not true */
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--") || i + 1 >= argv.length) {
      throw new Error(`expected --name value, got ${flag}`);
    }
    out[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

export function main(argv) {
  let options;
  try {
    options = flags(argv);
  } catch (error) {
    console.error(`osd-replay-promote: ${error.message}`);
    return 2;
  }
  if (options.destination === undefined || options.url === undefined || options.out === undefined) {
    console.error("usage: node tools/osd-replay-promote.mjs --destination NAME --url URL --out DIR [--from FIXTURE]");
    return 2;
  }
  try {
    const destination = destinationOf(options.destination);
    const named = process.env.OSD_DESTINATIONS || undefined;
    const root = named === undefined ? process.cwd() : dirname(resolve(named));
    const fixtures = loadFixtures(fixtureFolders(destination, {root}), {});
    const {file} = promote({fixtures, url: options.url, from: options.from, out: options.out});
    console.log(file);
    return 0;
  } catch (error) {
    console.error(`osd-replay-promote: ${error.message}`);
    return 1;
  }
}

if (runsAs("osd-replay-promote.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
