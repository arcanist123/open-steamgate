// The TEST entry of the VS Code command's forked helper
// (editors/vscode/hana-extract-host.mjs): the same runHost, with the
// module's own test seams filled -- the FAKE hdb client (scripted with the
// success rules), the generated test pin through the trusted pinFile seam,
// and the fake sidecar's scenario knobs. Its configuration comes from one
// environment variable the test sets; the client log (every connection and
// statement the fake saw) is appended to a file when each job finishes, because
// the fake lives in this process, not in the test's. Fakes only.
import {appendFileSync} from "node:fs";
import {runHost} from "../../editors/vscode/hana-extract-host.mjs";
import {fakeClientFactory, SUCCESS_RULES} from "./fake-client.mjs";

const config = JSON.parse(process.env.OSD_HANA_VSCODE_TEST ?? "{}");
const {log, factory} = fakeClientFactory(SUCCESS_RULES);
runHost({
  clientFactory: factory,
  pinFile: config.pinFile,
  sidecarExtraEnv: config.sidecarExtraEnv,
  onFinish: async () => {
    if (config.clientLog) appendFileSync(config.clientLog, `${JSON.stringify(log)}\n`); // one line per job
  },
});
