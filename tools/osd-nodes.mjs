// Every node this system answers on, from whichever registry declares it.
//
//   node tools/osd-nodes.mjs            the inventory
//   node tools/osd-nodes.mjs --json     the same, for a caller
//
// **The type of a node is where it is declared, not a field somebody set.**
// That is the conclusion of the whole ICF track and it took three of Alice's
// corrections to reach (`docs/icf-registry-plan.md`):
//
//   1. ICF is the only *registry*, not the only *router*.
//   2. Imitate the interface, not the storage.
//   3. What the host serves can stay served by the host -- it only has to be
//      *declared*.
//
// A `*.sicf.xml` is a SAP object: it exists on a system, it transports, and
// the class it names runs anywhere the ABAP runs. A path answered by a
// JavaScript function is none of those, and writing a SICF object for it
// would be a lie in somebody else's format -- an object claiming to travel
// to a system where it does not exist. So those are declared in
// `<layer>/icf/nodes.json` instead, and "does it travel" follows from the
// file rather than from a flag that has to be kept true.
//
// The types, each saying **where the node works** rather than whether it is
// allowed:
//
//   ABAP     a class implementing if_http_extension. Server, binary, preview.
//   HOST     a function of the JavaScript host. Server and binary; not the
//            preview.
//   PROXY    a destination: another system answers. Server and binary only.
//   CONTENT  bytes out of the object store. Everywhere. (Not yet used: the
//            BSP pages are ABAP today and become CONTENT in step A.)
import {cockpitAppsOf} from "./osd-cockpit-apps.mjs";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {channels, services} from "./osd-icf.mjs";
import {destinationsFile, remoteServices} from "./osd-destinations.mjs";
import {generatorFoldersOf, packsOf, winningByLayer} from "./osd-packs.mjs";
import {runsAs} from "./osd-main.mjs";

// Where a node works. A promise, so that "not yet" and "never" stay
// different words -- the browser preview has no file system, no process to
// hold state and no second system to ask.
export const WORKS_IN = {
  ABAP: ["server", "binary", "preview"],
  // A node with no handler at all is a real object on a real system -- an
  // alias, or a node that only carries authentication for its children, and
  // a UI5 application's node inherits its handler from the branch above it
  // (measured on A4H, 2026-09-19). It belongs in the inventory because it
  // EXISTS; nothing answers on it here, and an empty list says that without
  // a second word for it.
  NODE: [],
  CONTENT: ["server", "binary", "preview"],
  HOST: ["server", "binary"],
  PROXY: ["server", "binary"],
};

const DECLARED = join("icf", "nodes.json");

/** Paths a real system already answers on, and what answers there.
 *
 *  **An object of ours on one of these must not travel, and the reason is
 *  that nobody knows what an import would do with it.** The first version of
 *  this said "ICFSERVICE is keyed by the node and abapGit writes the row, so
 *  importing would replace SAP's handler". That mechanism is wrong, and an
 *  adversarial review caught it. Read off `zcl_abapgit_object_sicf` in
 *  .local/lars/abapgit: deserialize calls
 *  `cl_icf_tree=>if_icf_tree~insert_node( icf_name = orig_name, icfparguid =
 *  find_parent( url ) )`, and it decides insert-versus-update by looking for
 *  `icf_name = ms_item-obj_name(15)` -- the **file's** name, not the URL.
 *
 *  Which means three things are true and one is not:
 *
 *    - the URLs below are a real system's (the UI5 one measured on A4H on
 *      2026-09-19, where /sap/bc/ui5_ui5/sap/arsrvc_upb_admn/ answers 200);
 *    - our objects claim them, and `src/bsp/zosd_bsp.sicf.xml` claims
 *      `/sap/bc/ui5_ui5/sap/` while calling itself `zosd_bsp` -- a URL and a
 *      name that disagree, which on a system is not the node it looks like;
 *    - none of our `*.sicf.xml` use abapGit's own SICF file-name format
 *      (a name padded to 15 plus 25 hex, which `osd-bsp-app.mjs` knows), so
 *      the existence check looks for a node that is not there;
 *    - and "it would replace SAP's handler" is **not** established. It might
 *      nest, it might collide, it might fail. Measuring that needs a system,
 *      and this tree touches A4H only when Alice asks.
 *
 *  An object whose effect on a system is unknown is exactly one that should
 *  not be in a zip, so the gate stands and the claim under it is now the one
 *  that was checked. `tools/osd-abapgit-zip.mjs` refuses these outright --
 *  until that commit `travels: false` was an annotation two tools read and
 *  no packaging path did.
 *
 *  Adding a child under one of these is not the same thing and is not
 *  flagged: `/sap/bc/ui5_ui5/sap/zosd_008_app/` is exactly how a Fiori
 *  application reaches a system, measured, and `/sap/bc/apc/sap/zstg_apc_demo`
 *  is how a push channel does. Only a node that claims the delivered node
 *  ITSELF is here. */
export const SAP_DELIVERED = {
  "/sap/bc/ui5_ui5/sap": "the UI5 repository's namespace node, served by /UI5/CL_UI5_HTTP_HANDLER; measured on "
    + "A4H 2026-09-19, where /sap/bc/ui5_ui5/sap/arsrvc_upb_admn/ answers 200 under it. Our object claims this "
    + "URL and calls itself zosd_bsp, so on a system it is not the node it looks like",
  "/sap/bc/gui/sap/its/webgui": "the ITS WebGUI, which src/webgui/ imitates on the real path on purpose "
    + "(docs/webgui.md); what an import of our node would do to a system's own is not established",
  "/sap/bc/gui/sap/its/webgui/sapevent": "the WebGUI's own event round trip, a child of the node above "
    + "and delivered with it",
};

export const deliveredAt = (path) => SAP_DELIVERED[path];

function layers(root) {
  return generatorFoldersOf(root);
}

/** The nodes a layer declares for itself: the ones that are not SAP objects.
 *
 *  Keys beginning with `_` are the file's own prose. A format that cannot
 *  carry a comment gets one anyway, and a reader that chokes on it would
 *  make the explanation cost a second file. */
export function declaredNodes(root = ".") {
  return winningByLayer(layers(root), (dir) => {
    const file = join(root, dir, DECLARED);
    if (existsSync(file) === false) return [];
    const decl = JSON.parse(readFileSync(file, "utf8"));
    return Object.entries(decl).filter(([path]) => !path.startsWith("_")).map(([path, d]) => ({
        path: path.replace(/\/+$/, "") || "/",
        type: d.type ?? "HOST",
        handler: d.handler,
        // **Declared, but attached by code of its own.** The OData front is
        // mounted beside the runtime it proxies to, because the same lines
        // start the child, install the dev loop and refresh the status
        // service before a read of it. Saying so costs a written reason, the
        // way `.leak-allow.json` makes an exception cost a sentence -- an
        // entry without one is refused by the test, so this is a note and
        // not a way out.
        mountedElsewhere: d.mount === "elsewhere" ? (d.why ?? "") : undefined,
        implementedIn: d.host,
        needs: d.needs,
        internal: d.internal === true,
        text: d.text,
        travels: false,
        source: file,
      }));
  }, (node) => node.path);
}

/** A pack's page under its own name: a HOST node nobody wrote down.
 *
 *  Derived rather than declared for the reason `packApps` in
 *  osd-bsp-registry.mjs is: a pack already says its name and already carries
 *  a webapp/, and asking it to repeat that in a second file is the extra
 *  registry this whole track is removing. */
export function packNodes(root = ".", env = process.env) {
  return [...packsOf(root, env).filter((pack) => pack.webapp !== undefined).map((pack) => ({
    path: `/app/${pack.name}`,
    type: "HOST",
    handler: "pack-static",
    implementedIn: "test/start.mjs",
    needs: "fs",
    text: `express.static over the pack ${pack.name}'s webapp/`,
    travels: false,
    source: join(pack.dir, "osd-pack.json"),
  })), ...cockpitAppsOf(root, generatorFoldersOf(root, env)).map((c) => ({path: `/app/${c.app}`, type: "HOST", handler: "pack-static",
    implementedIn: "test/start.mjs", needs: "fs", text: c.title, travels: false, source: join(c.dir, "cockpit.json")}))];
}

/** A binding: a service this registry lacks, answered by another system.
 *
 *  Never written in nodes.json -- it is derived from
 *  `.local/destinations.json`, which is gitignored, because a list of the
 *  systems we can reach is not something a public repository carries. */
export function proxyNodes(options = {}) {
  return remoteServices({say: () => {}, ...options}).map((r) => ({
    path: `/sap/opu/odata/sap/${r.service}`,
    type: "PROXY",
    handler: r.name,
    implementedIn: (r.destination.mode ?? "live") === "live" ? "tools/osd-remote-service.mjs" : "tools/osd-http-replay.mjs",
    needs: "state",
    text: `answered by the destination ${r.name}${(r.destination.mode ?? "live") === "live" ? "" : ` (${r.destination.mode}, from fixtures)`}`,
    travels: false,
    source: destinationsFile(),
  }));
}

/** Everything, from every registry that declares a node. */
export function nodes(root = ".", options = {}) {
  const sap = [
    ...services(root, options).map((s) => ({...s, implementedIn: s.source, text: s.description})),
    ...channels(root, options).map((c) => ({...c, type: "ABAP", travels: true, implementedIn: c.source, text: c.description})),
  ];
  const all = [...sap, ...declaredNodes(root), ...packNodes(root), ...(options.proxies === false ? [] : proxyNodes(options))];
  return all.map((n) => {
    // a node that would replace a delivered one does not travel, whatever
    // file it was declared in
    const shadows = deliveredAt(n.path);
    return {...n, type: n.type ?? "NODE", shadows, travels: shadows === undefined && n.travels,
      worksIn: WORKS_IN[n.type ?? "NODE"] ?? []};
  })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Mount the HOST nodes this host implements, **in the registry's order**.
 *
 *  The registry says what exists and in what order; the host says how each
 *  one attaches. That seam is deliberate and it is where the earlier
 *  attempt at this went wrong: those are genuinely different express
 *  shapes -- an exact `app.get("/")`, a prefix `app.use("/app",
 *  express.static(...))`, a POST with a parameter, a router with no path
 *  at all -- and flattening them into one "handler" would have needed a
 *  field per shape inside the declaration, which is the format-invention
 *  this whole track is removing. So a value here is a *register* function:
 *  it takes the app and its node and attaches itself however it likes.
 *
 *  What the host stops carrying is the **list**: which paths exist, in what
 *  order, and whether this build has them at all. `tools/osd-routes.mjs`
 *  then checks both directions, so the declaration and the code cannot
 *  drift apart in silence.
 *
 *  Longest path first, for the same reason `services()` sorts that way:
 *  `/app/packs.json` must not be swallowed by `/app`. That ordering used to
 *  be an accident of the order somebody wrote the lines in.
 *
 *  A node whose declaration names THIS file and whose handler this file
 *  does not have is an error and not a skip -- the inventory would be
 *  naming something nothing answers, and the whole point is that it cannot. */
export function mountHost(app, all, handlers, options = {}) {
  const mounted = [];
  const used = new Set();
  for (const node of all.filter((n) => n.type === "HOST" && n.mountedElsewhere === undefined)
    .sort((a, b) => b.path.length - a.path.length)) {
    const register = handlers[node.handler];
    if (register === undefined) {
      if (node.implementedIn === options.host) {
        throw new Error(`${node.source} declares ${node.path} as served by ${options.host} with the handler `
          + `"${node.handler}", and ${options.host} has no such handler. Add it, or change the declaration.`);
      }
      continue;
    }
    register(app, node);
    used.add(node.handler);
    mounted.push(node);
  }
  const orphan = Object.keys(handlers).filter((name) => used.has(name) === false);
  if (orphan.length > 0) {
    throw new Error(`${options.host ?? "this host"} implements ${orphan.join(", ")} and no node declares `
      + `${orphan.length === 1 ? "it" : "them"}. A path that answers and is in no inventory is the defect this registry exists to remove.`);
  }
  return mounted;
}

if (runsAs("osd-nodes.mjs")) {
  // the root is the first argument that is not a flag -- `--json` used to
  // land here as a folder name and the inventory came back with one node
  const all = nodes(process.argv.slice(2).find((a) => a.startsWith("--") === false) ?? ".");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(all, undefined, 2));
  } else {
    const by = {};
    for (const n of all) {
      by[n.type] = (by[n.type] ?? 0) + 1;
      const where = n.worksIn.length === 3 ? ""
        : n.worksIn.length === 0 ? "  [no handler: nothing answers here]"
        : `  [not in the ${["server", "binary", "preview"].filter((w) => n.worksIn.includes(w) === false).join("/")}]`;
      console.log(`${(n.type ?? "NODE").padEnd(8)} ${n.path.padEnd(42)} ${(n.handler ?? "-").padEnd(24)}${where}`);
      if (n.text) console.log(`         ${n.text}`);
      if (n.shadows) console.log(`         MUST NOT TRAVEL: ${n.shadows}`);
    }
    console.log(`\n${all.length} nodes: ${Object.entries(by).map(([t, n]) => `${n} ${t}`).join(", ")}.`);
    console.log(`${all.filter((n) => n.travels).length} travel to a system; the rest are this host's own and say so by where they are declared.`);
  const shadowing = all.filter((n) => n.shadows !== undefined);
  if (shadowing.length > 0) {
    console.log(`\n${shadowing.length} answer on a path a real system delivers, so they must not travel:`);
    for (const n of shadowing) console.log(`  ${n.path}  (${n.source})`);
    // The comment on SAP_DELIVERED was corrected when this claim was
    // withdrawn; this line, which is the one a person actually reads, was
    // not. Saying it here for the third time would have outlived the
    // retraction by however long nobody ran the tool.
    console.log("What an abapGit import would do with one of these is NOT known: it might nest, collide or fail.");
    console.log("Measuring it needs a system. Until then they do not travel, and the packaging refuses them.");
  }
  }
}
