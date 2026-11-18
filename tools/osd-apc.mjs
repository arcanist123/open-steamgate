// ABAP Push Channels over a real websocket.
//
// A handler written for SAP APC — `cl_apc_wsp_ext_stateful_base`, the five
// callbacks — runs unchanged; what a system does with the ICF, this does
// with a socket. `zcl_apc_host` (open-abap-apc) is the runtime in between:
// it creates the handler, asks `on_accept`, calls `on_start`, hands each
// message to `on_message` and collects what the handler pushed back. So
// nothing here knows anything about the application, and the application
// knows nothing about Node.
//
// The framing is written out rather than taken from a package. RFC 6455 for
// what a push channel actually uses — text, close, ping — is a page of code,
// and this project keeps one runtime dependency on purpose.
import {createHash} from "node:crypto";
import {describe} from "./osd-describe.mjs";
// every APC event is a dialog step of its own: it waits for the work
// process, commits when it is done and rolls back when it dumps -- the rule
// the HTTP steps had and these did not (tools/osd-dialog-step.mjs)
import {apcTimerSession} from "./osd-apc-timers.mjs";
import {apcMailbox} from "./osd-apc-mailbox.mjs";
import {dialogStep} from "./osd-dialog-step.mjs";
import {installAmc} from "./osd-amc.mjs";
export {describe};

export async function deliverAmcPublication(publication, isClosed, sendFrame) {
  if (isClosed()) return;
  if (publication.type === "BINARY") {
    if (!isClosed()) sendFrame(Buffer.from(publication.message.get(), "hex"), OP.binary);
  } else if (publication.type === "PCP") {
    const encoded = await publication.message.if_ac_message_type_pcp$serialize();
    if (!isClosed()) sendFrame(encoded.get());
  } else if (!isClosed()) sendFrame(publication.message);
}

// the constant RFC 6455 §1.3 defines; it exists so a server cannot answer a
// handshake by accident
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP = {continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa};

export function acceptKey(key) {
  return createHash("sha1").update(String(key) + GUID).digest("base64");
}

// A frame out. Server frames are never masked, and the length is written in
// the shortest of the three forms the client is required to understand.
export function frame(payload, opcode = OP.text) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const head = [];
  head.push(0x80 | opcode);
  if (body.length < 126) {
    head.push(body.length);
  } else if (body.length < 65536) {
    head.push(126, body.length >> 8 & 0xff, body.length & 0xff);
  } else {
    head.push(127, 0, 0, 0, 0,
      body.length >>> 24 & 0xff, body.length >>> 16 & 0xff, body.length >>> 8 & 0xff, body.length & 0xff);
  }
  return Buffer.concat([Buffer.from(head), body]);
}

// One frame off the front of a buffer, or undefined when there is not a whole
// one yet. A client frame is always masked; an unmasked one is a protocol
// error rather than something to be lenient about, because being lenient here
// is how a proxy gets confused about where a frame ends.
export function unframe(buffer) {
  if (buffer.length < 2) {
    return undefined;
  }
  const first = buffer[0];
  const second = buffer[1];
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buffer.length < at + 2) {
      return undefined;
    }
    length = buffer.readUInt16BE(at);
    at = at + 2;
  } else if (length === 127) {
    if (buffer.length < at + 8) {
      return undefined;
    }
    const big = buffer.readBigUInt64BE(at);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProtocolError("frame longer than this host will carry");
    }
    length = Number(big);
    at = at + 8;
  }
  let mask;
  if (masked === true) {
    if (buffer.length < at + 4) {
      return undefined;
    }
    mask = buffer.subarray(at, at + 4);
    at = at + 4;
  }
  if (buffer.length < at + length) {
    return undefined;
  }
  const payload = Buffer.from(buffer.subarray(at, at + length));
  if (mask !== undefined) {
    for (let i = 0; i < payload.length; i = i + 1) {
      payload[i] = payload[i] ^ mask[i % 4];
    }
  }
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload,
    rest: buffer.subarray(at + length),
  };
}

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.code = "WS_PROTOCOL";
  }
}

// the query of the upgrade URL as the name/value table the handler reads.
// vsp measured this against SAP's own reference handler: what an APC handler
// legitimately takes off the initial request is a form field, meaning a query
// parameter of the ws:// URL, not a header.
export function fieldsOf(url, HostClass) {
  // the table's type comes from the constructor's own metadata rather than
  // being rebuilt here: TIHTTPNVP of IHTTPNVP is a DDIC type, and a
  // structurally similar table built by hand is a different type that only
  // looks the same until something checks
  const table = HostClass.METHODS.CONSTRUCTOR.parameters.IT_FIELDS.type();
  const query = new URL(url, "ws://osd").searchParams;
  for (const [name, value] of query) {
    const row = table.getRowType().clone();
    row.get().name.set(name);
    row.get().value.set(value);
    globalThis.abap.statements.append({source: row, target: table});
  }
  return table;
}

// What went wrong, in words.
//
// An ABAP exception carries its text in a method rather than a property, and
// plenty of them carry none at all — a raised CX_ with nothing set reads as
// the empty string. Logging that alone prints a line with a blank where the
// reason should be, which is worse than silence because it looks like the
// reason was "nothing". The class name is always there, so it goes first.


// The upgrade, and then the conversation.
//
// `open()` is allowed to refuse: a handler that says no gets a clean close
// rather than a socket that is up and answers nothing, because "connected
// and silent" is indistinguishable from "connected and broken" at the far
// end. Everything the handler pushes is drained after every callback, since
// a stateful handler may push from on_start as well as from on_message.
export async function serveChannel(options) {
  const {req, socket, head, channel, log} = options;
  // the transpiled runtime installs itself globally, so there is one source
  // of it rather than a parameter that can be forgotten — which it was, and
  // the channel answered 101 and then died on the first callback
  const abap = globalThis.abap;
  const key = req.headers["sec-websocket-key"];
  if (key === undefined) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return undefined;
  }

  let host;
  try {
    if (options.host === undefined) {
      throw new Error("no ZCL_APC_HOST class was given to the channel mount");
    }
    host = new options.host();
  } catch (e) {
    socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    log?.(`APC ${channel.path}: ${e?.message ?? e}`);
    return undefined;
  }

  // what the handler pushes before the socket is a socket. on_start is
  // allowed to speak, and it runs before the upgrade is answered, so its
  // messages wait here and go out the moment the connection is real.
  let pending = [];
  let live = false;
  const mailbox = apcMailbox();
  const sendFrame = (payload, opcode = OP.text) => {
    if (mailbox.closed) return;
    if (live === false) {
      pending.push([payload, opcode]);
      return;
    }
    socket.write(frame(payload, opcode));
  };
  const send = (text) => sendFrame(text);
  const drain = async () => {
    const pushed = await host.drain();
    for (const row of pushed.array()) {
      send(row.get());
    }
  };
  let shut = () => {};
  const queue = (work) => {
    return mailbox.enqueue(work).catch((e) => {
      log?.(`APC ${channel.path} (${channel.handler}): ${describe(e)}`);
      shut(1011, "handler failed");
    });
  };
  const timers = channel.stateful === true
    ? apcTimerSession(abap, queue, undefined, drain)
    : {step: dialogStep, close() {}};
  let closed = false;
  const subscriptions = [];
  shut = (code, reason) => {
    if (closed) return;
    closed = true;
    mailbox.close();
    pending = [];
    for (const subscription of subscriptions) subscription.close();
    timers.close();
    if (live === false) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason ?? ""));
    body.writeUInt16BE(code, 0);
    body.write(reason ?? "", 2);
    socket.end(frame(body, OP.close));
  };
  socket.on("error", () => shut(1011, "socket error"));
  socket.on("close", () => shut(1000, "socket closed"));
  // A client FIN half-closes an upgraded socket: "end" comes without "close"
  // (half-open connections are allowed), and queued messages must not run
  // for a peer that has left. An already committed event still publishes.
  socket.on("end", () => shut(1000, "socket ended"));

  // The handler runs before the upgrade, not after.
  //
  // Answering 101 and then closing is the shape we keep removing elsewhere:
  // a connection that exists and cannot work. A client reads the upgrade as
  // "this channel is here", and if the class is not in this runtime, or the
  // handler refuses the connection, that is knowable now and should be said
  // in the language the client is still speaking — HTTP.
  const start = () => mailbox.enqueue(async () => {
    const accepted = await timers.step(async () => {
      await host.constructor_({
        iv_handler: new abap.types.String().set(channel.handler),
        it_fields: fieldsOf(req.url, options.host),
      });
      const accepted = await host.open();
      await drain();
      if (accepted.get() === "X" && typeof host.bindings === "function") {
        const broker = installAmc(abap, options.root);
        const bindings = await host.bindings();
        for (const row of bindings.array()) {
          const binding = row.get();
          let last = Promise.resolve();
          subscriptions.push(broker.subscribe({
            app: binding.application_id.get(), path: binding.channel_id.get(),
            extension: binding.extension_id.get(), activity: "C",
            program: channel.handler.toUpperCase().padEnd(30, "=") + "CP",
            session: timers.session,
            client: abap.builtin.sy.get().mandt.get(), username: abap.builtin.sy.get().uname.get(),
            receive: (publication) => {
              last = last.then(() => deliverAmcPublication(publication, () => closed, sendFrame))
                .catch((e) => log?.(`APC AMC delivery: ${describe(e)}`));
            },
          }));
        }
      }
      return accepted.get() === "X";
    });
    if (closed || !accepted) return accepted;
    // Startup, publication and the open notification are the first mailbox
    // turn. An immediately due timer must wait for all three.
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      `X-OSD-Channel: ${channel.name}`,
      "", "",
    ].join("\r\n"));
    live = true;
    for (const [payload, opcode] of pending) socket.write(frame(payload, opcode));
    pending = [];
    return accepted;
  });

  let accepted;
  try {
    accepted = await start();
  } catch (e) {
    timers.close();
    const why = String(e?.message?.get?.() ?? e?.message ?? e);
    if (!closed) socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\n${channel.handler}: ${why}`);
    log?.(`APC ${channel.path} (${channel.handler}): ${why}`);
    return undefined;
  }
  if (closed) return undefined;
  if (accepted === false) {
    mailbox.close();
    timers.close();
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nthe handler refused the connection");
    return undefined;
  }

  let buffer = Buffer.isBuffer(head) && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

  // one conversation at a time: a stateful handler is a single object, and
  // two messages in flight would interleave inside it
  socket.on("data", (chunk) => {
    if (mailbox.closed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      let parsed;
      try {
        parsed = unframe(buffer);
      } catch (e) {
        shut(1009, e.message);
        return;
      }
      if (parsed === undefined) {
        return;
      }
      buffer = parsed.rest;
      if (parsed.opcode === OP.text) {
        const text = parsed.payload.toString("utf8");
        queue(() => timers.step(async () => {
          if (mailbox.closed) return;
          await host.message({iv_text: new abap.types.String().set(text)});
          await drain();
        }));
      } else if (parsed.opcode === OP.ping) {
        socket.write(frame(parsed.payload, OP.pong));
      } else if (parsed.opcode === OP.close) {
        timers.close();
        mailbox.closeTurn(() => timers.step(async () => {
          await host.close({iv_reason: new abap.types.String().set("closed by the client"), iv_code: new abap.types.Integer().set(1000)});
        })).catch(e => log?.(`APC ${channel.path}: ${describe(e)}`))
          .finally(() => shut(1000, "bye"));
        return;
      }
    }
  });

  return {send, close: shut};
}

// Mount the push channels a repository declared on an http server's upgrade
// event. A path nothing declared is refused rather than left hanging, because
// a socket that neither opens nor closes is the worst answer available.
export function mountChannels(server, channels, options = {}) {
  installAmc(globalThis.abap, options.root);
  if (channels.length === 0) {
    return [];
  }
  const byPath = new Map(channels.map((c) => [c.path, c]));
  server.on("upgrade", (req, socket, head) => {
    // a host may refuse an upgrade before any ABAP runs (hana-serve: another
    // client, a guard that is not intact): {status, text} or undefined
    const refused = options.admit?.(req);
    if (refused !== undefined) {
      socket.end(`HTTP/1.1 ${refused.status} ${refused.reason ?? "Refused"}\r\nContent-Type: text/plain\r\n\r\n${refused.text ?? ""}`);
      return;
    }
    const path = req.url.split("?")[0].replace(/\/+$/, "");
    const channel = byPath.get(path);
    if (channel === undefined) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    // an upgrade that throws must not take the listener with it
    serveChannel({req, socket, head, channel, log: options.log, host: options.host, root: options.root})
      .catch((e) => {
        options.log?.(`APC ${channel.path}: ${e?.message ?? e}`);
        socket.destroy();
      });
  });
  return channels;
}
