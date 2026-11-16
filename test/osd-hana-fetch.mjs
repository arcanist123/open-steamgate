// The build-time fetcher (tools/osd-hana/fetch-sidecar.mjs) against a local
// HTTP server on 127.0.0.1 only -- no real network, no real release. The
// fixture bytes are served by the test itself and the pin's release base URL
// is injected through the pin seam (a plain object handed to main()/fetchSidecar()),
// never through a CLI flag: the fetcher reads its release URL from the pin
// and nowhere else, which is exactly the property the tests pin down.
//
// Covered: the happy path (atomic write, 0755), the SHA-256 mismatch (file
// gone, exit 1, both hashes named), the cached hit (no request), --offline,
// a redirect to a host outside the allowlist, a truncated download, an
// unknown target -- and the guard that keeps this a BUILD tool: no `osd hana`
// verb module imports it.
//
// Every guard has a named mutation behind it; the mutations are listed in
// REPORT.md next to each test.
import {expect} from "chai";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {randomBytes} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fetchSidecar, main, outputName, releaseUrl} from "../tools/osd-hana/fetch-sidecar.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Fixture assets: one right payload, one wrong payload (a bit flipped), the
// truncated route serves half of the right one.
const FIXTURE = randomBytes(256 * 1024);
const OTHER = Buffer.from(FIXTURE);
OTHER[0] ^= 0xff;

const BASE = "/dl/v9.9.9-test";

const server = createServer((request, response) => {
  server.requests += 1;
  if (request.url.startsWith("/truncated/")) {
    // promise the full length, deliver half, cut the socket: fetch must not
    // hand us a quietly-short body without this being catchable
    response.setHeader("content-length", String(FIXTURE.length));
    response.write(FIXTURE.subarray(0, FIXTURE.length / 2));
    setTimeout(() => response.socket.destroy(), 10);
    return;
  }
  if (request.url.startsWith("/short-quiet/")) {
    // half the bytes, NO content-length, clean close: no transport error at
    // all -- only the byte count (here) and the hash (always) can refuse it
    response.writeHead(200);
    response.end(FIXTURE.subarray(0, FIXTURE.length / 2));
    return;
  }
  if (request.url.startsWith("/redirect/")) {
    // a host that is on no allowlist: the fetcher must refuse BEFORE fetching
    response.writeHead(302, {location: "http://nasty.example/pickpocket"});
    response.end();
    return;
  }
  if (request.url.startsWith(BASE)) {
    const body = request.url === `${BASE}/osd-hana-dump-linux-arm64` ? OTHER : FIXTURE;
    response.writeHead(200, {"content-type": "application/octet-stream"});
    response.end(body);
    return;
  }
  response.writeHead(404).end("no such asset");
});

// A pin whose release lives on the local server -- the non-CLI seam. The
// targets carry the fixture hashes; linux-arm64 deliberately carries the
// WRONG payload's hash so one target can test the mismatch path.
function makeLocalPin({baseUrl = server.base + BASE} = {}) {
  return {
    name: "osd-hana-dump",
    version: "v9.9.9-test",
    commit: "a".repeat(40),
    schema: 1,
    read_only: true,
    capabilities: ["probe"],
    targets: {
      "linux-x64": sha256(FIXTURE),
      "linux-arm64": sha256(OTHER),
      "darwin-x64": sha256(FIXTURE),
      "darwin-arm64": sha256(FIXTURE),
      "win32-x64": sha256(FIXTURE),
    },
    release: {
      base_url: baseUrl,
      assets: {
        "linux-x64": "osd-hana-dump-linux-amd64",
        "linux-arm64": "osd-hana-dump-linux-arm64",
        "darwin-x64": "osd-hana-dump-darwin-amd64",
        "darwin-arm64": "osd-hana-dump-darwin-arm64",
        "win32-x64": "osd-hana-dump-windows-amd64.exe",
      },
    },
  };
}

function freshOut() {
  const dir = join(tmpdir(), `osd-hana-fetch-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, {recursive: true});
  return dir;
}

const received = [];
const out = (line) => received.push(line);
const err = (line) => received.push(line);

before(async function () {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  server.base = `http://127.0.0.1:${server.address().port}`;
  server.requests = 0;
});

after(async function () {
  await new Promise((resolveClose) => server.close(resolveClose));
});

describe("tools/osd-hana: the build-time sidecar fetcher", function () {
  this.timeout(20_000);

  beforeEach(function () {
    server.requests = 0;
    received.length = 0;
  });

  it("names the output file and the release URL after the pin (asset per target)", function () {
    const pin = makeLocalPin();
    expect(outputName("win32-x64")).to.equal("osd-hana-dump.exe");
    expect(outputName("linux-x64")).to.equal("osd-hana-dump");
    expect(releaseUrl(pin, "linux-x64")).to.equal(`${server.base}${BASE}/osd-hana-dump-linux-amd64`);
    // a target the pin does not cover is refused under its own name
    let refused = "";
    try {
      releaseUrl(pin, "win32-arm64");
      expect.fail("should refuse");
    } catch (error) {
      refused = error.message;
    }
    expect(refused).to.include("win32-arm64");
    expect(refused).to.include("linux-x64"); // the covered list
    expect(() => releaseUrl(pin, "linux-x64")).to.not.throw();
  });

  it("downloads, verifies against the pin and writes <out>/<target>/osd-hana-dump with mode 0755 (mutation: skip the hash check -> red; chmod dropped -> red)", async function () {
    const dir = freshOut();
    try {
      const result = await fetchSidecar({target: "linux-x64", outDir: dir, pin: makeLocalPin(), log: out});
      const expectedPath = join(dir, "linux-x64", "osd-hana-dump");
      expect(result.path).to.equal(expectedPath);
      expect(result.cached).to.equal(false);
      expect(existsSync(expectedPath)).to.equal(true);
      expect(readFileSync(expectedPath).equals(FIXTURE)).to.equal(true);
      expect(statSync(expectedPath).mode & 0o777).to.equal(0o755);
      // nothing was left in the temp file's wake
      expect(readdirSync(join(dir, "linux-x64"))).to.deep.equal(["osd-hana-dump"]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("refuses a hash mismatch: exit 1, the file is gone, BOTH hashes are named (mutation: keep the downloaded bytes anyway -> red; drop one hash from the message -> red)", async function () {
    const dir = freshOut();
    try {
      const pin = makeLocalPin();
      // the pin says OTHER for linux-arm64; the server serves OTHER there, so
      // flip the pin's expectation to FIXTURE: a genuine mismatch
      pin.targets["linux-arm64"] = sha256(FIXTURE);
      const code = await main(["--target", "linux-arm64", "--out", dir], {pin, log: out, err});
      expect(code).to.equal(1);
      expect(received.join("\n")).to.include(sha256(FIXTURE)); // the pinned hash
      expect(received.join("\n")).to.include(sha256(OTHER)); // the downloaded hash
      expect(existsSync(join(dir, "linux-arm64", "osd-hana-dump"))).to.equal(false);
      expect(readdirSync(join(dir, "linux-arm64"))).to.deep.equal([]); // no temp file either
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("keeps a cached file with the right hash and makes NO request (mutation: always re-download -> red)", async function () {
    const dir = freshOut();
    try {
      const pin = makeLocalPin();
      const targetDir = join(dir, "linux-x64");
      mkdirSync(targetDir, {recursive: true});
      writeFileSync(join(targetDir, "osd-hana-dump"), FIXTURE);
      const before = server.requests;
      const result = await fetchSidecar({target: "linux-x64", outDir: dir, pin, log: out});
      expect(result.cached).to.equal(true);
      expect(server.requests).to.equal(before); // zero requests
      expect(received.join("\n")).to.include("no request made");
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("re-fetches when the cached file's hash is wrong (mutation: trust any existing file -> red)", async function () {
    const dir = freshOut();
    try {
      const targetDir = join(dir, "linux-x64");
      mkdirSync(targetDir, {recursive: true});
      writeFileSync(join(targetDir, "osd-hana-dump"), OTHER);
      const result = await fetchSidecar({target: "linux-x64", outDir: dir, pin: makeLocalPin(), log: out});
      expect(result.cached).to.equal(false);
      expect(readFileSync(join(targetDir, "osd-hana-dump")).equals(FIXTURE)).to.equal(true);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("--offline fails instead of downloading, without a request (mutation: offline still fetches -> red)", async function () {
    const dir = freshOut();
    try {
      const pin = makeLocalPin();
      const before = server.requests;
      const code = await main(["--target", "linux-x64", "--out", dir, "--offline"], {pin, log: out, err});
      expect(code).to.equal(1);
      expect(server.requests).to.equal(before);
      expect(existsSync(join(dir, "linux-x64"))).to.equal(false);
      expect(received.join("\n")).to.include("--offline");
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("--offline succeeds when the pinned file is already cached (cached beats offline)", async function () {
    const dir = freshOut();
    try {
      const targetDir = join(dir, "win32-x64");
      mkdirSync(targetDir, {recursive: true});
      writeFileSync(join(targetDir, "osd-hana-dump.exe"), FIXTURE);
      const before = server.requests;
      const code = await main(["--target", "win32-x64", "--out", dir, "--offline"], {pin: makeLocalPin(), log: out, err});
      expect(code).to.equal(0);
      expect(server.requests).to.equal(before);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("refuses a redirect to a host outside the allowlist BEFORE following it (mutation: follow any redirect -> red)", async function () {
    const dir = freshOut();
    try {
      const pin = makeLocalPin({baseUrl: `${server.base}/redirect${BASE}`});
      const code = await main(["--target", "darwin-arm64", "--out", dir], {pin, log: out, err});
      expect(code).to.equal(1);
      expect(received.join("\n")).to.include("nasty.example");
      expect(existsSync(join(dir, "darwin-arm64", "osd-hana-dump"))).to.equal(false);
      // exactly one request was made: the refused hop was never fetched
      expect(server.requests).to.equal(1);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("refuses a truncated download: exit 1, no file, no temp file (mutation: accept a short body -> red)", async function () {
    const dir = freshOut();
    try {
      const pin = makeLocalPin({baseUrl: `${server.base}/truncated${BASE}`});
      const code = await main(["--target", "darwin-x64", "--out", dir], {pin, log: out, err});
      expect(code).to.equal(1);
      const message = received.join("\n");
      expect(message).to.include("truncat");
      expect(existsSync(join(dir, "darwin-x64", "osd-hana-dump"))).to.equal(false);
      expect(readdirSync(join(dir, "darwin-x64"))).to.deep.equal([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("refuses a quietly-short body (no content-length, clean close): exit 1, file gone, no temp file (mutation: accept a short body -> red)", async function () {
    const dir = freshOut();
    try {
      const pin = makeLocalPin({baseUrl: `${server.base}/short-quiet${BASE}`});
      const code = await main(["--target", "darwin-x64", "--out", dir], {pin, log: out, err});
      expect(code).to.equal(1);
      const message = received.join("\n");
      expect(message).to.include("SHA-256 mismatch");
      expect(message).to.include(sha256(FIXTURE)); // what the pin wants
      expect(message).to.include(sha256(FIXTURE.subarray(0, FIXTURE.length / 2))); // what arrived
      expect(existsSync(join(dir, "darwin-x64", "osd-hana-dump"))).to.equal(false);
      expect(readdirSync(join(dir, "darwin-x64"))).to.deep.equal([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("refuses an unknown target under its own name, naming what the pin covers, with no request (mutation: map an unknown target to a pinned one -> red)", async function () {
    const dir = freshOut();
    try {
      const before = server.requests;
      const code = await main(["--target", "mips64", "--out", dir], {pin: makeLocalPin(), log: out, err});
      expect(code).to.equal(1);
      expect(received.join("\n")).to.include("mips64");
      expect(received.join("\n")).to.include("linux-x64"); // the covered list
      expect(server.requests).to.equal(before);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("--all fetches every target the pin covers, and the CLI run directly exits with its code", async function () {
    const dir = freshOut();
    try {
      const code = await main(["--all", "--out", dir], {pin: makeLocalPin(), log: out, err});
      expect(code).to.equal(0);
      for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
        expect(existsSync(join(dir, target, outputName(target))), target).to.equal(true);
      }
      expect(existsSync(join(dir, "win32-x64", "osd-hana-dump.exe"))).to.equal(true);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("as a script it answers --help with exit 0 and nothing else runs at import time (mutation: the main block passes other args -> red)", async function () {
    const {execFile} = await import("node:child_process");
    const script = join(import.meta.dirname, "..", "tools", "osd-hana", "fetch-sidecar.mjs");
    const result = await new Promise((resolveDone) => {
      execFile(process.execPath, [script, "--help"], {timeout: 30_000}, (error, stdout, stderr) => {
        resolveDone({code: error?.code ?? 0, stdout, stderr});
      });
    });
    expect(result.code).to.equal(0);
    expect(result.stdout).to.include("Usage:");
    expect(result.stderr).to.equal("");
  });

  it("stays a BUILD tool: no `osd hana` verb module imports the fetcher (mutation: wire it into the verb entry -> red)", async function () {
    const toolsDir = join(import.meta.dirname, "..", "tools", "osd-hana");
    for (const name of readdirSync(toolsDir)) {
      if (name === "fetch-sidecar.mjs" || !name.endsWith(".mjs")) continue;
      const source = readFileSync(join(toolsDir, name), "utf8");
      expect(source.includes("fetch-sidecar"), `${name} must not reference the build-time fetcher`).to.equal(false);
    }
    // and importing the fetcher runs nothing: the import at the top of this
    // test file is itself the proof (no server, no download, no write).
  });
});
