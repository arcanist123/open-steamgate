// The parts of the web extension's page host that need no VS Code, so the
// mocha suite (test/vscode-web-page-host.mjs) can drive them: the push
// channels of one webview panel, the sandbox rewrite of a gateway page's
// frames, and the file name a W3MI object is stored under beside the bundle.

// The push channels (/sap/bc/apc/...) of one webview panel, keyed per socket.
// A channel belongs to the document that opened it: closeAll() is called when
// that document ends (the panel is disposed, navigates, or gets new HTML), and
// an open still waiting for the backend or the channel list then never
// registers, while a send from the old document's channels is dropped, since
// the next document numbers its sockets from apc-1 again. An apc-close while
// the open is still pending cancels it the same way.
//   backend(): the in-worker gateway (openChannel / channelMessage / closeChannel)
//   services(): the generated channel list ({channels})
//   describe(error): the close reason of a failed handler
export function pageChannels({backend, services, describe, toPage}) {
  const channels = new Map();
  let generation = 0;
  const closeAll = async () => {
    generation++;
    const keys = [...channels.keys()];
    channels.clear();
    if (keys.length === 0) return;
    const gateway = await backend();
    for (const key of keys) await gateway.closeChannel(key).catch(() => undefined);
  };
  const receive = async (key, message) => {
    const born = generation;
    const send = (payload) => {
      if (generation === born) void toPage({type: "apc", id: message.id, ...payload});
    };
    if (message.type === "apc-open") {
      const ticket = {};
      channels.set(key, ticket);
      const live = () => channels.get(key) === ticket;
      const gateway = await backend();
      const {channels: known} = await services();
      if (!live()) return;
      const channel = known.find((one) => one.path.toLowerCase() === String(message.path).toLowerCase());
      if (!channel) {
        channels.delete(key);
        send({apc: "close", code: 1008, reason: `no channel on ${message.path}`});
        return;
      }
      // openChannel registers the channel before its first await, so a
      // closeChannel from here on finds it (preview-backend.mjs)
      await guarded(key, gateway, send, () => gateway.openChannel(key, channel, send), live);
    } else if (message.type === "apc-send" && channels.has(key)) {
      const gateway = await backend();
      const ticket = channels.get(key);
      await guarded(key, gateway, send, () => gateway.channelMessage(key, String(message.text), send), () => channels.get(key) === ticket);
    } else if (message.type === "apc-close" && channels.has(key)) {
      channels.delete(key);
      const gateway = await backend();
      await gateway.closeChannel(key);
      send({apc: "close", code: message.code ?? 1000, reason: message.reason ?? ""});
    }
  };
  const guarded = async (key, gateway, send, work, live) => {
    try { await work(); } catch (error) {
      if (live()) channels.delete(key);
      await gateway.closeChannel(key).catch(() => undefined);
      send({apc: "close", code: 1011, reason: await describe(error)});
    }
  };
  return {receive, closeAll, channels};
}

// A gateway page may draw a part of itself in a script-less sandboxed srcdoc
// frame (the WEBGUI's HTML viewer control). Such a frame is made same-origin
// with the page, so the page runtime can take over its links and forms;
// without allow-scripts nothing can run in it either way. Only that class of
// frame: one with srcdoc and no src, whose sandbox tokens (case-insensitive,
// as the browser reads them) grant neither scripts nor the same origin.
// Every other frame keeps its isolation.
const TAG = /<iframe\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTRIBUTE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
export function sandboxScriptlessFrames(html) {
  return html.replace(TAG, (tag) => {
    const attributes = new Map();
    let sandbox;
    for (const match of tag.slice("<iframe".length, tag.endsWith("/>") ? -2 : -1).matchAll(ATTRIBUTE)) {
      const name = match[1].toLowerCase();
      if (attributes.has(name)) continue;
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
      if (name === "sandbox") sandbox = match;
    }
    if (!sandbox || !attributes.has("srcdoc") || attributes.has("src")) return tag;
    const tokens = attributes.get("sandbox").toLowerCase().split(/[\t\n\f\r ]+/);
    if (tokens.includes("allow-scripts") || tokens.includes("allow-same-origin")) return tag;
    const at = "<iframe".length + sandbox.index;
    const flags = attributes.get("sandbox").trim();
    return `${tag.slice(0, at)}sandbox="${flags ? `${flags} ` : ""}allow-same-origin"${tag.slice(at + sandbox[0].length)}`;
  });
}

// The file a W3MI object's data is stored under in dist/web/media. A "%" in
// an abapGit media name (the escaped dot of zoisee-ear-02%2emp3) is a
// character of the name, and VS Code's file reads in the browser lose it on
// the way to the server, so "@" is the escape character instead: "@" is
// written "@40" and "%" "@25". Injective, so two names never share a file.
export const mediaFileName = (name) => name.replace(/[@%]/g, (one) => one === "@" ? "@40" : "@25");
