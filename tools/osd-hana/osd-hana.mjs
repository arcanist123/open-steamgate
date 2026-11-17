// The `osd hana <verb>` entry (bin/osd.mjs dispatches "hana" here). The
// product line's verbs: doctor and extract, both in tools/osd-hana/.
//
// Run from the CLI as `osd hana doctor ...`; this module is also imported
// directly by the tests (test/osd-hana-doctor.mjs, test/osd-hana-extract.mjs),
// which inject the io/seams.
import {doctorMain} from "./doctor.mjs";
import {extractMain} from "./extract.mjs";
import {compiled} from "../osd-host.mjs";

const VERBS = {
  doctor: doctorMain,
  extract: extractMain,
};

const HELP = `Usage: osd hana <verb> [flags]

Verbs:
  doctor    check a HANA database and say whether your ABAP code can be
            rescued out of it (osd hana doctor --help for the flags)
  extract   write your own code out of it into an abapGit-layout repository
            (osd hana extract --help for the flags)
`;

export async function main(argv, deps = {}) {
  const [verb = "", ...rest] = argv;
  if (verb === "" || verb === "--help" || verb === "help") {
    (deps.io?.out ?? ((line) => process.stdout.write(`${line}\n`)))(HELP);
    return 0;
  }
  const verbMain = VERBS[verb];
  if (verbMain === undefined) {
    process.stderr.write(`osd hana: unknown verb "${verb}" -- one of doctor, extract\n${HELP}`);
    return 1;
  }
  return verbMain(rest, deps);
}

// A tool run directly (node tools/osd-hana/osd-hana.mjs ...) without the osd
// binary still works: the binary's dispatch (bin/osd.mjs, mode "hana") is
// only the hosted path.
// In the compiled osd binary every bundled module shares the entry's
// import.meta.url, so this guard would fire on import there (CLAUDE.md, the
// binary's traps): compiled, bin/osd.mjs is the only way in.
if (!compiled && process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}

