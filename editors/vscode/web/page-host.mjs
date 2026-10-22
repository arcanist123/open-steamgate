// The parts of the web extension's page host that need no VS Code, so the
// mocha suite (test/vscode-web-page-host.mjs) can drive them: the push
// channels of one webview panel, the sandbox rewrite of a gateway page's
// frames, the media cache's check for blob: URLs still in use, and the file
// name a W3MI object is stored under beside the bundle.

// The push channels (/sap/bc/apc/...) of one webview panel.
//
// A channel belongs to one document. The extension names each document it
// writes into the panel (newDocument(), called synchronously with the HTML
// assignment, before the page can run) and the page sends that name with every
// apc-open / apc-send / apc-close. A message from any other document is
// ignored. Replacing the HTML or disposing the panel ends the old document at
// once, before any await: from then on nothing of it can register a channel or
// reach the page.
//
// A channel is keyed by `${doc}:${socket}`, so two documents never share a key,
// and a key is opened at most once per document (a reused socket id is refused
// with 1008). Each open re-checks after every await that its document is still
// the current one and that its key still maps to itself, and it closes only
// what it opened, through the handle the backend gave it for that open: a
// stale cleanup cannot reach a live replacement.
//   backend(): the in-worker gateway (openChannel / channelMessage / closeChannel,
//     and channelHandle, the entry an openChannel registered)
//   services(): the generated channel list ({channels})
//   describe(error): the close reason of a failed handler
//   newId(): a fresh random document name
export function pageChannels({backend, services, describe, toPage, newId}) {
  let current;
  const channels = new Map();
  const opened = new Set();
  // closes one channel through its own handle, once; a channel whose open has
  // not reached the backend yet is only marked, and that open then stops
  const shut = (own) => {
    if (own.closed) return Promise.resolve();
    own.closed = true;
    if (!own.started) return Promise.resolve();
    return backend().then((gateway) => gateway.closeChannel(own.key, own.handle)).catch(() => undefined);
  };
  const endAll = () => {
    const owned = [...channels.values()];
    channels.clear();
    opened.clear();
    return Promise.all(owned.map(shut)).then(() => undefined);
  };
  // a new document: the old one is dead before this returns
  const newDocument = () => {
    current = newId();
    const ended = endAll();
    return {doc: current, ended};
  };
  // the panel is gone
  const closeAll = () => {
    current = undefined;
    return endAll();
  };
  const receive = async (doc, socket, message) => {
    if (doc === undefined || doc !== current || typeof socket !== "string") return;
    const key = `${doc}:${socket}`;
    const send = (payload) => {
      if (current === doc) void toPage({type: "apc", doc, id: socket, ...payload});
    };
    if (message.type === "apc-open") {
      if (opened.has(key)) {
        send({apc: "close", code: 1008, reason: `socket ${socket} was already opened in this document`});
        return;
      }
      opened.add(key);
      const own = {key, doc, closed: false, started: false, handle: undefined};
      channels.set(key, own);
      const live = () => current === doc && channels.get(key) === own && !own.closed;
      const gateway = await backend();
      if (!live()) return;
      const {channels: known} = await services();
      if (!live()) return;
      const channel = known.find((one) => one.path.toLowerCase() === String(message.path).toLowerCase());
      if (!channel) {
        channels.delete(key);
        own.closed = true;
        send({apc: "close", code: 1008, reason: `no channel on ${message.path}`});
        return;
      }
      // openChannel registers its entry before its first await, so the handle
      // is there right after the call (preview-backend.mjs)
      own.started = true;
      const opening = gateway.openChannel(key, channel, send);
      own.handle = gateway.channelHandle?.(key);
      try {
        await opening;
      } catch (error) {
        if (channels.get(key) === own) channels.delete(key);
        await shut(own);
        send({apc: "close", code: 1011, reason: await describe(error)});
        return;
      }
      // the document ended (or the socket closed) while the handler opened
      if (!live()) await shut(own);
    } else if (message.type === "apc-send") {
      const own = channels.get(key);
      if (!own || !own.started || own.closed) return;
      const gateway = await backend();
      try {
        await gateway.channelMessage(key, String(message.text), send);
      } catch (error) {
        if (channels.get(key) === own) channels.delete(key);
        await shut(own);
        send({apc: "close", code: 1011, reason: await describe(error)});
      }
    } else if (message.type === "apc-close") {
      const own = channels.get(key);
      if (!own) return;
      channels.delete(key);
      await shut(own);
      send({apc: "close", code: message.code ?? 1000, reason: message.reason ?? ""});
    }
  };
  return {receive, newDocument, closeAll, channels, current: () => current};
}

// A gateway page may draw a part of itself in a script-less sandboxed srcdoc
// frame (the WEBGUI's HTML viewer control). Such a frame is made same-origin
// with the page, so the page runtime can take over its links and forms;
// without allow-scripts nothing can run in it either way.
//
// Fail safe: a frame is rewritten only when its whole tag reads one way under
// a strict grammar (names [a-zA-Z-]+, values double-quoted, a name without a
// value, nothing else; no name twice), it has srcdoc and no src, and its
// sandbox value is ASCII letters, '-' and spaces only (so no entity can spell
// a token) and grants neither allow-scripts nor allow-same-origin. Any other
// frame, odd markup included, is left exactly as it was.
const TAG = /<iframe\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const STRICT = /^<iframe((?:[ \t\n\f\r]+[a-zA-Z-]+(?:="[^"]*")?)*)[ \t\n\f\r]*\/?>$/i;
const STRICT_ATTRIBUTE = /[ \t\n\f\r]+([a-zA-Z-]+)(?:="([^"]*)")?/g;
export function sandboxScriptlessFrames(html) {
  return html.replace(TAG, (tag) => {
    const strict = STRICT.exec(tag);
    if (!strict) return tag;
    const attributes = new Map();
    let sandbox;
    for (const match of strict[1].matchAll(STRICT_ATTRIBUTE)) {
      const name = match[1].toLowerCase();
      if (attributes.has(name)) return tag;
      attributes.set(name, match[2] ?? "");
      if (name === "sandbox") sandbox = match;
    }
    if (!sandbox || !attributes.has("srcdoc") || attributes.has("src")) return tag;
    const flags = attributes.get("sandbox");
    if (!/^[A-Za-z -]*$/.test(flags)) return tag;
    const tokens = flags.toLowerCase().split(" ");
    if (tokens.includes("allow-scripts") || tokens.includes("allow-same-origin")) return tag;
    const at = "<iframe".length + sandbox.index;
    const kept = flags.trim();
    return `${tag.slice(0, at)} sandbox="${kept ? `${kept} ` : ""}allow-same-origin"${tag.slice(at + sandbox[0].length)}`;
  });
}

// Whether a document still uses any of the given blob: URLs, for the page
// runtime's media cache (extension.mjs, fioriRuntime). Serialised into the
// page with toString(), so it stands alone. A URL counts as used when any
// element of the document or of a same-origin child frame names it in src,
// currentSrc, poster, srcset, a style attribute or its inline background, or
// any <style> text holds it; also while an element still waits for the path
// (osdSource / osdBackground name a path of byPath, path -> URL), and while a
// media element that is not in the document plays it. It answers the URLs in
// use; a document it cannot read counts as using all of them.
export function mediaUrlsInUse(root, urls, byPath, playing) {
  const used = new Set();
  const unread = () => { for (const url of urls) used.add(url); };
  const look = (text) => {
    if (!text) return;
    for (const url of urls) if (!used.has(url) && String(text).includes(url)) used.add(url);
  };
  // Every media element ever played counts, paused or not: play() may still
  // be waiting for its source, and a paused one may resume. The set holds
  // only elements a page played, so it stays small.
  for (const one of playing) { look(one.src); look(one.currentSrc); }
  // CSSOM rules (insertRule leaves no <style> text). A cross-origin sheet
  // (the CDN's) cannot be read, and cannot have been given this origin's blob.
  const sheets = (list) => {
    for (const sheet of list ?? []) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules ?? []) look(rule.cssText);
    }
  };
  const visit = (document, depth) => {
    let all;
    try { all = document.querySelectorAll("*"); } catch { unread(); return; }
    try { sheets(document.styleSheets); sheets(document.adoptedStyleSheets); } catch { unread(); return; }
    for (const element of all) {
      // an open shadow tree is a document of its own for this scan
      if (element.shadowRoot) visit(element.shadowRoot, depth);
      if (used.size === urls.length) return;
      if (element.osdSource !== undefined) look(byPath.get(element.osdSource));
      if (element.osdBackground !== undefined) look(byPath.get(element.osdBackground));
      for (const name of ["src", "poster", "srcset", "style"]) look(element.getAttribute(name));
      look(element.currentSrc);
      look(element.style?.backgroundImage);
      if (element.tagName === "STYLE") look(element.textContent);
      if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
        let inner;
        try { inner = element.contentDocument; } catch { inner = undefined; }
        // a frame whose document cannot be read is not same-origin and cannot
        // load this origin's blob: URLs
        // deeper than that is not looked into, so it counts as using everything
        if (inner) { if (depth < 8) visit(inner, depth + 1); else unread(); }
      }
    }
  };
  visit(root, 0);
  return used;
}

// The file a W3MI object's data is stored under in dist/web/media. A "%" in
// an abapGit media name (the escaped dot of zoisee-ear-02%2emp3) is a
// character of the name, and VS Code's file reads in the browser lose it on
// the way to the server, so "@" is the escape character instead: "@" is
// written "@40" and "%" "@25". Injective, so two names never share a file.
export const mediaFileName = (name) => name.replace(/[@%]/g, (one) => one === "@" ? "@40" : "@25");
