// Serve the VS Code web extension on https://localhost so vscode.dev can
// install it. vscode.dev's Content-Security-Policy lets "Developer: Install
// Extension From Location..." fetch only from https://localhost:* and the
// Marketplace CDN, so a GitHub Pages URL is refused even though Pages answers
// CORS. This is the local door; docs/vscode-web.md "Try in vscode.dev".
//
//   node scripts/serve-vscode-web.mjs                 # build/preview/vscode-web (npm run web:vscode && npm run web:vscode:stage)
//   node scripts/serve-vscode-web.mjs <dir>
//   node scripts/serve-vscode-web.mjs https://oisee.github.io/open-steamgate/main/vscode-web
//                                                     # relay a published preview; nothing to build
//
// Port: OSD_WEB_PORT (default 5000). Certificate: OSD_WEB_CERT/OSD_WEB_KEY
// (e.g. from `mkcert localhost`, which the browser then trusts); without them
// a self-signed one is made with openssl under the system temp dir, and the
// browser must be told once to accept it: open https://localhost:<port>/ and
// proceed past the warning, then install from that URL in vscode.dev.
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync} from "node:fs";
import {readFile, stat} from "node:fs/promises";
import {createServer} from "node:https";
import {tmpdir} from "node:os";
import {extname, join, normalize, resolve, sep} from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = process.argv[2] ?? join(root, "build/preview/vscode-web");
const remote = /^https:\/\//.test(source) ? source.replace(/\/+$/, "") : undefined;
const dir = remote ? undefined : resolve(source);
if (dir && !existsSync(join(dir, "package.json"))) {
  throw new Error(`${dir} has no package.json; run npm run web:vscode && npm run web:vscode:stage, or pass a published .../vscode-web URL`);
}
const port = Number(process.env.OSD_WEB_PORT ?? 5000);

function certificate() {
  if (process.env.OSD_WEB_CERT && process.env.OSD_WEB_KEY) {
    return {cert: readFileSync(process.env.OSD_WEB_CERT), key: readFileSync(process.env.OSD_WEB_KEY)};
  }
  const temp = mkdtempSync(join(tmpdir(), "osd-web-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", join(temp, "key.pem"), "-out", join(temp, "cert.pem")], {stdio: "ignore"});
  return {cert: readFileSync(join(temp, "cert.pem")), key: readFileSync(join(temp, "key.pem"))};
}

const TYPES = {".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown", ".properties": "text/plain",
  ".xml": "application/xml", ".wasm": "application/wasm"};

async function answer(path) {
  if (remote) {
    const upstream = await fetch(remote + path);
    return {status: upstream.status, type: upstream.headers.get("content-type") ?? "application/octet-stream",
      body: Buffer.from(await upstream.arrayBuffer())};
  }
  const file = normalize(join(dir, decodeURIComponent(path)));
  if (file !== dir && !file.startsWith(dir + sep)) return {status: 403, type: "text/plain", body: Buffer.from("forbidden")};
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return {status: 404, type: "text/plain", body: Buffer.from("not found")};
  return {status: 200, type: TYPES[extname(file)] ?? "application/octet-stream", body: await readFile(file)};
}

// vscode.dev is a public origin and this is the loopback address: Chrome's
// Private/Local Network Access sends a preflight that must be answered with
// Allow-Private-Network, and asks the person once for permission. vscode.dev
// is cross-origin isolated (COEP), so every file also needs CORP cross-origin.
const CORS = {"access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin", "access-control-allow-private-network": "true",
  "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "*"};

createServer(certificate(), async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }
  const path = new URL(request.url, "https://localhost").pathname;
  const reply = await answer(path === "/" ? "/package.json" : path).catch((error) =>
    ({status: 502, type: "text/plain", body: Buffer.from(String(error.message ?? error))}));
  response.writeHead(reply.status, {...CORS, "content-type": reply.type, "cache-control": "no-cache"});
  response.end(request.method === "HEAD" ? undefined : reply.body);
}).listen(port, "127.0.0.1", () => {
  console.log(`serve-vscode-web: https://localhost:${port}/ <- ${remote ?? dir}`);
  console.log("In vscode.dev: F1 > Developer: Install Extension From Location... > the URL above");
});
