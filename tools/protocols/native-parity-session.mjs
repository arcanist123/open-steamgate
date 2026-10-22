// Run under tools/osd-heavy.sh after building osgo and native-rfc-client.
// JS and native RFC take turns on the same 33nn, backed by the same osgo build.
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {connect} from "node:net";
import {mkdirSync, openSync, closeSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {setTimeout as pause} from "node:timers/promises";
import {createRfcAdtServer} from "./rfc-server.mjs";
import {encodeNIFrame, NIFrameDecoder} from "./ni.mjs";
import {cutRequest, requestXml, appc, dataRecord, logonPacket, responseXml} from "./test-rfc-wire.mjs";

const base = `http://127.0.0.1:${process.env.STG_PORT}`;
const port = Number(process.env.STG_RFC_PORT);
if (!port || !process.env.STG_PORT) throw new Error("run under osd-heavy.sh");
mkdirSync(".local/native-protocols", {recursive: true});
const children = new Set();
process.on("exit", () => { for (const child of children) child.kill(); });
async function stop(child) {
  if (child.exitCode !== null) return;
  const ended = once(child, "exit"); child.kill(); await ended; children.delete(child);
}
async function host(native) {
  const fd = openSync(`.local/native-protocols/osgo-${native ? "native" : "js"}.log`, "w");
  const child = spawn(resolve("tools/gogen/.out/osgo"), ["-adt", "-diag", "-lint-engine", "go", "-port", process.env.STG_PORT, "-root", process.cwd(), ...(native ? ["-rfc"] : [])], {stdio: ["ignore", fd, fd]});
  children.add(child); closeSync(fd);
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`osgo exited ${child.exitCode}`);
    try { if ((await fetch(base + "/health")).ok) return child; } catch {}
    await pause(100);
  }
  throw new Error("osgo readiness timed out");
}
async function publicClient() {
  const child = spawn(resolve("tools/gogen/.out/native-rfc-client"), [String(port)]);
  children.add(child);
  let output = "";
  child.stdout.on("data", b => output += b); child.stderr.on("data", b => output += b);
  const [code] = await once(child, "exit"); children.delete(child);
  return {code, output};
}
async function wireSession() {
  const socket = connect(port, "127.0.0.1");
  const received = [], decoder = new NIFrameDecoder();
  let error;
  socket.on("data", b => received.push(...decoder.push(b)));
  socket.on("error", e => error = e);
  const wait = async n => {
    for (let i = 0; received.length < n; i++) {
      if (error) throw error;
      if (i > 900) throw new Error(`waiting for RFC frame ${n}`);
      await pause(20);
    }
  };
  try {
    await once(socket, "connect");
    const init = appc(1,453); init.writeUInt16BE(3,76);
    for (const frame of [Buffer.alloc(64),init,appc(0x0f,224),appc(5),dataRecord(logonPacket())]) socket.write(encodeNIFrame(frame));
    await wait(4);
    const body = '<?xml version="1.0" encoding="UTF-8"?><chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core"><chkrun:checkObject adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_http_handler" chkrun:version="active"><chkrun:artifacts><chkrun:artifact chkrun:contentType="text/plain" chkrun:uri="/sap/bc/adt/oo/classes/zcl_stg_http_handler/source/main"><chkrun:content>CLASS zcl_stg_http_handler DEFINITION PUBLIC. PUBLIC SECTION. METHODS broken. ENDCLASS. CLASS zcl_stg_http_handler IMPLEMENTATION. ENDCLASS.</chkrun:content></chkrun:artifact></chkrun:artifacts></chkrun:checkObject></chkrun:checkObjectList>';
    const results = [];
    for (const [path, method, content] of [["/sap/bc/adt/discovery","GET",""],["/sap/bc/adt/checkruns?reporters=abapCheckRun","POST",body]]) {
      const xml = requestXml(path.replaceAll("&","&amp;"),method).replace("<HEADER_FIELDS>","<HEADER_FIELDS><item><NAME>Content-Type</NAME><VALUE>application/xml</VALUE></item>").replace('<MESSAGE_BODY></MESSAGE_BODY>',`<MESSAGE_BODY>${Buffer.from(content).toString("base64")}</MESSAGE_BODY>`);
      socket.write(encodeNIFrame(dataRecord(cutRequest(xml))));
      await wait(5 + results.length);
      const response = responseXml(received[4 + results.length]);
      const raw = /<MESSAGE_BODY>([^<]*)<\/MESSAGE_BODY>/.exec(response)?.[1] ?? "";
      const text = Buffer.from(raw,"base64").toString();
      results.push({path, status: /<STATUS_CODE>(\d+)<\/STATUS_CODE>/.exec(response)?.[1], bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), body: text});
    }
    return results;
  } finally { socket.destroy(); }
}
const result = {};
for (const mode of ["js","native"]) {
  const child = await host(mode === "native");
  let bridge;
  try {
    if (mode === "js") { bridge = createRfcAdtServer({backend: base, port, host: "127.0.0.1", rfcAuthMode: "demo"}); await bridge.listen(); }
    result[mode] = {publicClient: await publicClient(), wire: await wireSession()};
  } finally {
    if (bridge) await new Promise(r => bridge.server.close(r));
    await stop(child);
  }
}
result.equal = result.js.wire.map((r,i) => r.status === result.native.wire[i].status && r.body === result.native.wire[i].body);
writeFileSync(".local/native-protocols/session.json", JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({...result,js:{...result.js,wire:result.js.wire.map(({body,...r})=>r)},native:{...result.native,wire:result.native.wire.map(({body,...r})=>r)}},null,2));
if (!result.equal.every(Boolean)) process.exitCode = 1;
