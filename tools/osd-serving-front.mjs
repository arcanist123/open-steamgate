import {startingAnswer, odataProxy} from "./osd-proxy.mjs";

// The front owns identity and warm state; runtime workers can be replaced
// between fetch and its fallback. Enrich every response at that boundary.
export function servingFront(runtime, {launcherPid = process.pid, launcherIdentity, warmStatus, bind, fetchAnswer = fetch, startingWaitMs}) {
  const enrich = body => ({...body, launcherPid, launcherIdentity, warm: warmStatus(), bind: bind()});
  const proxy = odataProxy(runtime, {mapJSONAnswer: enrich, startingWaitMs});
  return async (req, res, next) => {
    if (req.method !== "GET") {
      return proxy(req, res, next);
    }
    // still booting: say so now, with the step, rather than hold the
    // question for the boot (the VS Code launcher waits on this answer)
    if (runtime.booting !== undefined && runtime.running !== true) {
      res.status(200).json(enrich(startingAnswer(runtime)));
      return;
    }
    try {
      const answer = await fetchAnswer(`${runtime.url}${req.originalUrl}`, {signal: AbortSignal.timeout(5000)});
      const body = await answer.json();
      // the child puts its generation on every answer (tools/osd-serve.mjs);
      // the one door this front re-serialises keeps it, so a client reads the
      // same header from the facade and from the osgo binary
      // (tools/osd-host-contract.mjs)
      const generation = answer.headers?.get?.("x-osd-generation");
      if (generation) res.set("X-OSD-Generation", generation);
      res.status(answer.status).json(enrich(body));
    } catch {
      return proxy(req, res, next);
    }
  };
}
