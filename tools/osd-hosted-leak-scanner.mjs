import {spawnSync} from "node:child_process";
import {setHostedLeakScanner, toolCommand} from "./osd-host.mjs";

export function installHostedLeakScanner() {
  setHostedLeakScanner((cwd, paths, privateLayer) => {
    const [command, ...args] = toolCommand("tools/osd-leak-scan.mjs", [...(privateLayer ? ["--private-layer"] : []), "--redact", "--publication-allow", "--paths", ...paths]);
    return spawnSync(command, args, {cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024});
  });
}
