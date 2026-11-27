// load the bundled page in chromium, click START, watch the canvas
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const {need} = require("./paths.cjs");
const {chromium} = require(need("playwright"));
import {createServer} from "node:http";
import {listenBound} from "../../tools/osd-bind.mjs";
import {readFileSync, existsSync} from "node:fs";
import {join, extname} from "node:path";

const root = new URL("./build/", import.meta.url).pathname;
const TYPES = {".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".mp3": "audio/mpeg"};
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "index.html";
  const file = join(root, name);
  if (existsSync(file) === false) {
    res.writeHead(404).end("no");
    return;
  }
  res.writeHead(200, {"content-type": TYPES[extname(file)] ?? "application/octet-stream"});
  res.end(readFileSync(file));
});
await new Promise(r => listenBound(server, 0, process.env, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const log = [];
page.on("console", m => log.push(`${m.type()}: ${m.text().slice(0, 200)}`));
page.on("pageerror", e => log.push(`pageerror: ${String(e.message).slice(0, 300)}`));

await page.goto(`http://localhost:${port}/index.html`, {waitUntil: "load", timeout: 60000});
await page.waitForTimeout(15000);

const before = await page.evaluate(() => document.getElementById("info").textContent);
const parts = await page.evaluate(() => document.getElementById("part-info").textContent);
console.log("info      :", before);
console.log("part-info :", parts);

await page.click("#btn-start").catch(() => log.push("click failed"));
await page.waitForTimeout(15000);

console.log("after start, info      :", await page.evaluate(() => document.getElementById("info").textContent));
console.log("after start, part-info :", await page.evaluate(() => document.getElementById("part-info").textContent));
// is the WebGL canvas painting anything at all?
const painted = await page.evaluate(() => {
  const c = document.getElementById("glc");
  const gl = c.getContext("webgl", {preserveDrawingBuffer: true});
  if (gl === null) { return "no webgl"; }
  const px = new Uint8Array(c.width * c.height * 4);
  gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) { if (px[i] + px[i + 1] + px[i + 2] > 24) { lit++; } }
  return `${lit} lit pixels of ${c.width * c.height}`;
});
console.log("canvas    :", painted);
await page.screenshot({path: new URL("./bundle.png", import.meta.url).pathname});
console.log("--- console ---");
for (const l of log.slice(0, 25)) { console.log(" ", l); }
await browser.close();
server.close();
