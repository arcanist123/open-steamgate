// A service that is not ours, answered as if it were.
//
// An SAP system reaches another system's OData through a **destination**;
// nothing in the application says which host. This is that, at the one place
// it is needed here: a page served by OSD asks
// `/sap/opu/odata/sap/<SERVICE>/…` on its own origin, and if the registry
// does not have that service, a destination does.
//
// Why it has to be OSD and not a proxy beside it (Alice, 2026-09-19): an app
// **inside** the system is the measurement. A second process on another port
// proves that our Fiori app can read a real Gateway; it does not prove that a
// page this system serves can, which is the thing a page on a real system
// does every day. And in a browser it cannot be done any other way -- another
// origin means CORS and a logon prompt per request.
//
// **Where the systems live is not this file's business any more.**
// `tools/osd-destinations.mjs` holds them: a *destination* is a system, a
// *binding* says which of this system's paths another one answers. This file
// had both jobs and keyed the systems by service name, which is what made a
// preflight -- keyed by system -- need a second file.
import {remoteServices} from "./osd-destinations.mjs";
import {dirname, resolve} from "node:path";
import {fixtureFolders, loadFixtures, MODES, ON_MISS, replayer, replayService} from "./osd-http-replay.mjs";

// What a transparent proxy has to carry, and why each one.
//
// A real Gateway refuses a modifying request without a CSRF token: the page
// does a GET with `X-CSRF-Token: Fetch`, gets a token **and a session
// cookie** back, and sends both with the `$batch`. A proxy that drops either
// breaks the pair -- and it breaks it at the only moment that matters, on a
// write, which is how this was found: a Create in the object page answered
// `/IWFND/CM_MGW/098, X-CSRF token is needed for Batch Processing with
// modifying operation` (Alice, 2026-09-19). The token and the session that
// issued it must travel together, so cookies go both ways too.
//
// Authorization is ours and not the page's: the destination holds the logon,
// exactly as an RFC destination does, so a client header never overrides it.
const TO_GATEWAY = ["x-csrf-token", "cookie", "if-match", "if-none-match", "accept", "accept-language", "content-type", "x-requested-with"];
const FROM_GATEWAY = ["x-csrf-token", "content-type", "dataserviceversion", "etag", "location", "sap-message"];

/** The system's answer to one request, written to `res`. Throws, having
 *  written nothing, when the system cannot be reached -- which is what lets
 *  a `fallback` destination answer from fixtures instead. */
export function forwarder(target) {
  const auth = "Basic " + Buffer.from(`${target.user}:${target.password}`).toString("base64");
  return async function (req, res) {
    const url = new URL(req.originalUrl, "http://localhost");
    url.searchParams.set("sap-client", target.client ?? "001");
    const to = new URL(target.url + url.pathname + "?" + url.searchParams);
    const headers = {authorization: auth};
    for (const h of TO_GATEWAY) {
      if (req.headers[h] !== undefined) {
        headers[h] = req.headers[h];
      }
    }
    const answer = await fetch(to, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // a fallback destination waits a bounded time on a READ before the
      // fixtures answer. A write waits as long as the system takes: cutting
      // it short cannot unsend it (tools/osd-http-replay.mjs replayService)
      signal: target.timeout === undefined || (req.method !== "GET" && req.method !== "HEAD") ? undefined : AbortSignal.timeout(target.timeout),
    });
    const bytes = Buffer.from(await answer.arrayBuffer());
    res.status(answer.status);
    for (const h of FROM_GATEWAY) {
      const v = answer.headers.get(h);
      if (v !== null) {
        res.set(h, v);
      }
    }
    const cookies = answer.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) {
      // the cookie comes back scoped to the Gateway's own path, which is
      // the same path here, and Secure would stop a plain-http page from
      // keeping it -- so the flag goes, and the reason is written down
      // rather than left as a silent rewrite
      res.set("set-cookie", cookies.map((c) => c.replace(/;\s*Secure/ig, "")));
    }
    if (res.get("content-type") === undefined) {
      res.set("content-type", "application/xml");
    }
    res.send(bytes);
  };
}

/** Express middleware for one service. `known` says whether this system
 *  already serves that name, because a local service must always win: a
 *  destination is a fallback and never a shadow. */
export function remoteService(name, target, known = () => false) {
  const prefix = `/sap/opu/odata/sap/${name}`;
  const forward = forwarder(target);
  return async function (req, res, next) {
    if (req.originalUrl.startsWith(prefix) === false || known(name)) {
      next();
      return;
    }
    try {
      await forward(req, res);
    } catch (error) {
      // a destination that cannot be reached is a 503 and says so: a page
      // asking for rows must not be told "no such service"
      res.status(503).json({error: {code: "STG/DESTINATION", message: {lang: "en", value: `${name}: ${error?.message ?? error}`}}});
    }
  };
}

/** every binding, mounted. Returns what it mounted, so a host can say so at
 *  start rather than leaving it to be discovered.
 *
 *  A destination's `mode` is RFC's vocabulary (tools/osd-http-replay.mjs):
 *  absent or `live` asks the system, `replay` answers from its fixtures,
 *  `fallback` asks and answers from the fixtures when the system cannot be
 *  reached. Fixtures are read once, here, and their count is said.
 *
 *  A relative `fixtures` is read against the working directory, as
 *  `.local/...` always is -- except in a file named by OSD_DESTINATIONS,
 *  where it is read against that file's folder, so a stand carries its
 *  file and its fixtures side by side and works from wherever it is. */
export function mountRemoteServices(app, known = () => false, options = {}) {
  const say = options.say ?? console.error;
  const mounted = [];
  const loaded = new Map();
  for (const {service, name, destination} of remoteServices(options)) {
    const mode = destination.mode ?? "live";
    if (mode === "live") {
      if (destination.url === undefined || destination.user === undefined) {
        say(`osd-destinations: ${name} has no url or user -- ${service} not mounted`);
        continue;
      }
      app.use(remoteService(service, destination, known));
      mounted.push(`${service} -> ${name}`);
      continue;
    }
    if (mode !== "replay" && mode !== "fallback") {
      say(`osd-destinations: ${name} has mode ${mode}, which an http destination does not do yet (${MODES.join(", ")}; record is stage 2) -- ${service} not mounted`);
      continue;
    }
    if (destination.fixtures === undefined) {
      say(`osd-destinations: ${name} is ${mode} and names no fixtures -- ${service} not mounted`);
      continue;
    }
    if (!loaded.has(name)) {
      const named = options.file ?? (process.env.OSD_DESTINATIONS || undefined);
      const root = options.root ?? (named === undefined ? process.cwd() : dirname(resolve(named)));
      const folders = fixtureFolders(destination, {root, tree: options.tree, say});
      loaded.set(name, replayer(loadFixtures(folders, {say}), {onMiss: destination.onMiss, say, name}));
    }
    const replay = loaded.get(name);
    if (destination.onMiss !== undefined && !ON_MISS.includes(destination.onMiss)) {
      say(`osd-destinations: ${name} has onMiss ${JSON.stringify(destination.onMiss)}, which is not one of ${ON_MISS.join(", ")} -- misses stay loud`);
    }
    const canAsk = mode === "fallback" && destination.url !== undefined && destination.user !== undefined;
    if (mode === "fallback" && !canAsk) {
      say(`osd-destinations: ${name} is fallback with no url or user -- ${service} answers from fixtures only`);
    }
    app.use(replayService(service, replay, known, {live: canAsk ? forwarder({timeout: 5000, ...destination}) : undefined}));
    mounted.push(`${service} -> ${name} (${canAsk ? "fallback" : "replay"}, ${replay.size} fixtures)`);
  }
  return mounted;
}
