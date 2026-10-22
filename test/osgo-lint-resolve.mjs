// The differential oracle uses node:test so it can also run directly offline.
import {execFileSync} from "node:child_process";
import {it} from "mocha";
it("native fixed-generation lint Facts match the Node build oracle", function () {
  this.timeout(180000);
  execFileSync(process.execPath, ["--test", "tools/gogen/lint-resolve.test.mjs"], {stdio: "inherit"});
});
