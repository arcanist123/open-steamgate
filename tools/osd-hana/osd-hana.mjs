// The `osd hana <verb>` entry (bin/osd.mjs dispatches "hana" here). The
// product line's verbs: doctor (this module, tools/osd-hana/) and extract
// (the next job -- refused here with a clear message, not silently).
//
// Run from the CLI as `osd hana doctor ...`; this module is also imported
// directly by test/osd-hana-doctor.mjs, which injects the io/seams.
import {doctorMain} from "./doctor.mjs";

const VERBS = {
  doctor: doctorMain,
};

const HELP = `Usage: osd hana <verb> [flags]

Verbs:
  doctor    check a HANA database and say whether your ABAP code can be
            rescued out of it (osd hana doctor --help for the flags)
  extract   not in this build yet -- it is the next job of the product line
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
  if (verb === "extract") {
    process.stderr.write("osd hana: extract is not in this build yet -- it is the next job of the product line.\n");
    return 1;
  }
  return verbMain(rest, deps);
}

// A tool run directly (node tools/osd-hana/osd-hana.mjs ...) without the osd
// binary still works: the binary's dispatch (bin/osd.mjs, mode "hana") is
// only the hosted path.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
