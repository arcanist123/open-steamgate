"use strict";
// "OSD: Extract my code from HANA" (osd.hanaExtract): the R1 "Rescue" verbs
// of tools/osd-hana/ (doctor, extract) behind one guided command.
//
//   1. connection   host, port, tenant database, user (a remembered one can
//                   be picked; remembering stores NO password); the password
//                   in a password box -- or the stored read-only reader
//   2. doctor       the module's verdict, said plainly; a login that can
//                   write gets the module's read-only sentence and the offer
//                   of a dedicated read-only user (consent modal = the
//                   module's exact SQL; nothing is sent without Yes)
//   3. plan         extract --dry-run: counts by type, per author, size;
//                   narrowing to one author / no local packages
//   4. extract      folder, "extract N objects (S MB) into <folder>?",
//                   cancellable progress, then the report
//
// Secrets: the login's password, a second login's password and the reader's
// generated password go to VS Code SecretStorage (the reader's, through the
// module's injected secret store) or nowhere -- never to settings, the output
// channel, a message or a terminal. The module runs in a forked helper
// (hana-extract-host.mjs) so the extension host never blocks on it.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {runHostJob, makeRedactor} = require("./hana-extract-job.js");

const COMMAND = "osd.hanaExtract";
const SETTING = "hanaExtract.connections"; // under "osd."
const SECRET_PREFIX = "osd.hanaExtract.reader/";
const READER_NAME = "OSD_READER";

/** The sidecar this install carries for this machine:
 *  bin/<platform>-<arch>/osd-hana-dump[.exe] beside the extension, or
 *  undefined (the module then takes OSD_HANA_DUMP, or explains). */
function bundledSidecarPath(context, {platform = process.platform, arch = process.arch, exists = fs.existsSync} = {}) {
  const base = context?.extensionUri?.fsPath ?? context?.extensionPath;
  if (typeof base !== "string") return undefined;
  const file = path.join(base, "bin", `${platform}-${arch}`, platform === "win32" ? "osd-hana-dump.exe" : "osd-hana-dump");
  return exists(file) ? file : undefined;
}

function noSidecarText(platform = process.platform, arch = process.arch) {
  return `osd: The HANA reader (osd-hana-dump) is not bundled with this install for ${platform}-${arch}. ` +
    "Set the environment variable OSD_HANA_DUMP to the path of the pinned osd-hana-dump binary " +
    "(from the osd-hana-dump release) and restart VS Code. There is no download; the binary is checksum-verified before every use.";
}

const MODULE_NEEDED = "osd: Extracting from HANA needs the osd-hana tools: an open-steamgate checkout (osd.home or the workspace folder), or the bundled system after its first Start.";

/** The first home whose tools/osd-hana carries both verbs. */
function findModuleRoot(homes, exists = fs.existsSync) {
  for (const home of homes ?? []) {
    if (typeof home !== "string" || home === "") continue;
    const dir = path.join(home, "tools", "osd-hana");
    if (exists(path.join(dir, "doctor.mjs")) && exists(path.join(dir, "extract.mjs"))) return dir;
  }
  return undefined;
}

const mb = (bytes) => `${(Number(bytes ?? 0) / 1_000_000).toFixed(1)} MB`;
const label = (c) => `${c.user}@${c.host}:${c.port}${c.database ? `/${c.database}` : ""}`;
const sameConnection = (a, b) => a.host === b.host && String(a.port) === String(b.port) && (a.database ?? "") === (b.database ?? "") && a.user === b.user;

/** The quick-pick rows of a plan: the actions first, then the plan itself as
 *  read-only rows under separators (counts by type, per author, the biggest
 *  packages). Names come from the database: control characters are escaped. */
function planItems(plan, {separator = -1, noLocal = false, author} = {}) {
  const clean = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  const items = [{label: `$(cloud-download) Extract ${plan.inScope} objects (${mb(plan.bytes)})`, action: {kind: "extract"}}];
  if (author === undefined && Number(plan.localAuthors ?? 0) > 1) {
    for (const a of plan.perAuthor ?? []) {
      items.push({label: `$(person) Only the local objects of ${clean(a.author)}`, description: `${a.objects} objects, ${mb(a.bytes)}`, action: {kind: "narrow", author: a.author}});
    }
  }
  if (!noLocal && author === undefined && (plan.perAuthor ?? []).length > 0) {
    items.push({label: "$(filter) Leave local packages ($...) out", action: {kind: "narrow", noLocal: true}});
  }
  items.push({label: "Per type", kind: separator});
  for (const t of plan.perType ?? []) {
    items.push({label: clean(t.type), description: `${t.inScope} objects, ${mb(t.bytes)}`,
      detail: t.unsupported > 0 ? `${t.unsupported} of them cannot be written yet: listed in the report, not extracted` : undefined});
  }
  if ((plan.perAuthor ?? []).length > 0) {
    items.push({label: "Per author (local objects)", kind: separator});
    for (const a of plan.perAuthor) items.push({label: clean(a.author) || "(no author)", description: `${a.objects} objects, ${mb(a.bytes)}`});
  }
  if ((plan.biggest ?? []).length > 0) {
    items.push({label: "Biggest packages", kind: separator});
    for (const p of plan.biggest) items.push({label: clean(p.package), description: `${p.objects} objects, ${mb(p.bytes)}`});
  }
  return items;
}

/** The plain message of an exit code that is not a success. */
function extractExitText(code, lastError) {
  const tail = lastError ? ` (${lastError})` : "";
  switch (code) {
    case 2: return `osd: Cannot connect or log on to the database${tail}.`;
    case 4: return `osd: That output folder was refused: it holds files this command did not write, or the dump in it cannot be reused. Choose an empty folder; nothing was touched${tail}.`;
    case 5: return "osd: No ABAP schema was found on this database -- there is no ABAP code to rescue here.";
    case 6: return `osd: The extraction failed inside the converter; a best-effort report was written${tail}.`;
    default: return `osd: The extraction stopped${tail || ` (exit ${code})`}.`;
  }
}

function doctorExitText(code, lastError) {
  const tail = lastError ? `: ${lastError}` : "";
  switch (code) {
    case 2: return `osd: Cannot connect or log on to the database${tail}`;
    case 5: return "osd: No ABAP schema was found on this database -- there is no ABAP code to rescue here.";
    default: return `osd: The database check stopped${tail || ` (exit ${code})`}`;
  }
}

/** The report's summary: the first sentence under the title of
 *  extract-report.md (the module writes it there, and nowhere else first). */
async function reportSentence(out) {
  try {
    const lines = (await fsp.readFile(path.join(out, "extract-report.md"), "utf8")).split(/\r?\n/);
    return lines.find((line, i) => i > 0 && line.trim() !== "" && !line.startsWith("#") && !line.startsWith("- ")) ?? "";
  } catch {
    return "";
  }
}

const importModule = (root, file) => import(pathToFileURL(path.join(root, file)).href);

async function extractFromHana(vscode, context, output, {moduleRoot, callerPath, hostScript, env = process.env, tmpdir = os.tmpdir()}) {
  const redact = makeRedactor();
  const log = (line) => output.appendLine(redact(line));
  const errors = [];
  const config = () => vscode.workspace.getConfiguration("osd");
  const {readerStoreKey} = await importModule(moduleRoot, "reader-shared.mjs");
  const {isLargePlan, largePlanNumbers} = await importModule(moduleRoot, "extract-plan.mjs");

  // ---- 1. the connection ---------------------------------------------------
  const remembered = (config().get(SETTING, []) ?? []).filter((c) => c && c.host && c.port && c.user);
  let connection;
  if (remembered.length > 0) {
    const pick = await vscode.window.showQuickPick([
      ...remembered.map((c) => ({label: `$(database) ${label(c)}`, connection: c})),
      {label: "$(add) New connection…"},
    ], {title: "Extract my code from HANA: connection", placeHolder: "A remembered connection, or a new one", ignoreFocusOut: true});
    if (pick === undefined) return;
    connection = pick.connection;
  }
  if (connection === undefined) {
    const ask = (title, prompt, options = {}) => vscode.window.showInputBox({title: `Extract my code from HANA: ${title}`, prompt, ignoreFocusOut: true, ...options});
    const host = await ask("host (1/4)", "Host name or address of the HANA database server.",
      {validateInput: (v) => (v.trim() === "" ? "A host is required." : undefined)});
    if (host === undefined) return;
    const port = await ask("port (2/4)", "SQL port of the database, for example 30015 (instance 00).",
      {validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) > 0 && Number(v) <= 65535 ? undefined : "A port number (1-65535).")});
    if (port === undefined) return;
    const database = await ask("tenant database (3/4)", "Tenant database name; leave empty when the port already selects the database.");
    if (database === undefined) return;
    const user = await ask("user (4/4)", "Database login (any login that can read the ABAP schema; nothing is ever written).",
      {validateInput: (v) => (v.trim() === "" ? "A user is required." : undefined)});
    if (user === undefined) return;
    connection = {host: host.trim(), port: Number(port.trim()), database: database.trim() || undefined, user: user.trim()};
  }
  const secretKey = (name) => SECRET_PREFIX + readerStoreKey(connection, name);
  let login = {user: connection.user, password: undefined, reader: false};
  const readStoredReader = async () => {
    try {
      const raw = await context.secrets.get(secretKey(READER_NAME));
      const entry = raw === undefined ? undefined : JSON.parse(raw);
      return typeof entry?.password === "string" && typeof entry?.user === "string" ? entry : undefined;
    } catch {
      return undefined;
    }
  };
  const stored = await readStoredReader();
  if (stored !== undefined) {
    const pick = await vscode.window.showQuickPick([
      {label: `$(lock) Log on as the read-only reader ${stored.user}`, description: "password in VS Code SecretStorage", reader: true},
      {label: `$(account) Log on as ${connection.user}`, description: "asks for the password"},
    ], {title: "Extract my code from HANA: login", ignoreFocusOut: true});
    if (pick === undefined) return;
    if (pick.reader) login = {user: stored.user, password: stored.password, reader: true};
  }
  if (!login.reader) {
    const password = await vscode.window.showInputBox({title: `Extract my code from HANA: password for ${connection.user}`,
      prompt: "Used for this run only and never stored.", password: true, ignoreFocusOut: true});
    if (password === undefined || password === "") return;
    login.password = password;
  }
  redact.add(login.password);

  const job = (verb, argv, title, extra = {}) => vscode.window.withProgress(
    {location: vscode.ProgressLocation.Notification, title, cancellable: true},
    (progress, token) => runHostJob({t: "run", verb, argv, moduleRoot, password: login.password, callerPath, secrets: {}}, {
      hostScript, env, token, redact,
      onLine: (stream, line) => {
        log(line);
        if (stream === "err" && line.trim() !== "") {
          errors.push(line.trim());
          progress.report({message: line.trim().slice(0, 120)});
        }
        extra.onLine?.(stream, line);
      },
      onAsk: extra.onAsk,
      onChild: extra.onChild,
      onSecretSet: (key, value) => context.secrets.store(SECRET_PREFIX + key, JSON.stringify(value)),
      onSecretDelete: (key) => context.secrets.delete(SECRET_PREFIX + key),
    }));
  const lastError = () => errors.at(-1)?.replace(/^osd hana( extract)?: /, "");
  const base = () => ["--host", connection.host, "--port", String(connection.port), "--user", login.user,
    ...(connection.database ? ["--database", connection.database] : []),
    ...(connection.schema ? ["--schema", connection.schema] : [])];

  // ---- 2. the doctor -------------------------------------------------------
  const doctor = async () => {
    errors.length = 0;
    const result = await job("doctor", [...base(), "--json"], `Checking ${label(connection)}`);
    if (result.cancelled) { void vscode.window.showInformationMessage("osd: Cancelled; the reader was stopped."); return undefined; }
    if (result.code !== 0 || result.verdict === undefined) {
      const action = await vscode.window.showErrorMessage(redact(doctorExitText(result.code, lastError())), "Show output");
      if (action === "Show output") output.show();
      return undefined;
    }
    return result.verdict;
  };
  let verdict = await doctor();
  if (verdict === undefined) return;
  const schemas = verdict.doc.verdict?.abapSchemas ?? [];
  if (schemas.length > 1 && connection.schema === undefined) {
    const pick = await vscode.window.showQuickPick(schemas.map((s) => ({label: String(s)})),
      {title: "Extract my code from HANA: this database holds several ABAP schemas", ignoreFocusOut: true});
    if (pick === undefined) return;
    connection = {...connection, schema: pick.label};
  }
  for (const line of verdict.plain ?? []) log(line);
  if (!remembered.some((c) => sameConnection(c, connection))) {
    const keep = await vscode.window.showInformationMessage(
      `osd: Remember ${label(connection)} in your settings? The password is never stored there.`, "Remember", "Not now");
    if (keep === "Remember") {
      const {host, port, database, user} = connection;
      await config().update(SETTING, [...remembered, {host, port, ...(database ? {database} : {}), user}], vscode.ConfigurationTarget.Global);
    }
  }
  const canWrite = verdict.doc.verdict?.canWrite === true;
  const CREATE = "Create a read-only user first…";
  const go = await vscode.window.showInformationMessage(`osd: ${label({...connection, user: login.user})} is ready to extract.`,
    {modal: true, detail: (verdict.plain ?? []).join("\n")}, canWrite && !login.reader ? "Extract with this login" : "Continue", ...(canWrite && !login.reader ? [CREATE] : []));
  if (go === undefined) return;

  if (go === CREATE) {
    const created = await createReader(vscode, {job, base, connection, redact, errors, lastError});
    if (created === "stop") return;
    if (created === "created") {
      const entry = await readStoredReader();
      if (entry === undefined) {
        void vscode.window.showErrorMessage("osd: The reader was created, but its credentials did not reach SecretStorage; run the command again and log on as the administrator.");
        return;
      }
      login = {user: entry.user, password: entry.password, reader: true};
      redact.add(login.password);
      void vscode.window.showInformationMessage(`osd: Created the read-only user ${entry.user}; its password is in VS Code SecretStorage. The extraction logs on as ${entry.user}.`);
    }
  }

  // ---- 3. the plan ---------------------------------------------------------
  const narrowing = {author: undefined, noLocal: false};
  const narrowArgs = () => [...(narrowing.author !== undefined ? ["--author", narrowing.author] : []), ...(narrowing.noLocal ? ["--no-local"] : [])];
  let plan;
  for (;;) {
    errors.length = 0;
    const scratch = await fsp.mkdtemp(path.join(tmpdir, "osd-hana-plan-"));
    let result;
    try {
      result = await job("extract", [...base(), "--out", scratch, "--dry-run", "--json", ...narrowArgs()], "Listing your objects");
    } finally {
      await fsp.rm(scratch, {recursive: true, force: true});
    }
    if (result.cancelled) { void vscode.window.showInformationMessage("osd: Cancelled; the reader was stopped."); return; }
    if (result.code !== 0 || result.plan?.plan === undefined) {
      const action = await vscode.window.showErrorMessage(redact(extractExitText(result.code, lastError())), "Show output");
      if (action === "Show output") output.show();
      return;
    }
    plan = result.plan.plan;
    let choice;
    do {
      choice = await vscode.window.showQuickPick(planItems(plan, {separator: vscode.QuickPickItemKind?.Separator ?? -1, ...narrowing}), {
        title: `Plan: ${plan.inScope} objects (${mb(plan.bytes)}) -- the system holds ${plan.onSystem}: ${plan.customer} customer, ${plan.sap} SAP`,
        placeHolder: "Pick an action; the rows below the actions are the plan", ignoreFocusOut: true, matchOnDescription: true});
      if (choice === undefined) return;
    } while (choice.action === undefined);
    if (choice.action.kind === "extract") break;
    if (choice.action.author !== undefined) narrowing.author = choice.action.author;
    if (choice.action.noLocal) narrowing.noLocal = true;
  }

  // ---- 4. the extraction ---------------------------------------------------
  const picked = await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    openLabel: "Extract here", title: "An empty folder for the repository (or one this command wrote before)"});
  const folder = picked?.[0];
  if (folder === undefined) return;
  if (folder.scheme !== "file") { void vscode.window.showErrorMessage("osd: The repository folder must be a local folder."); return; }
  const out = folder.fsPath;
  const large = isLargePlan(plan);
  const sure = await vscode.window.showWarningMessage(`Extract ${plan.inScope} objects (${mb(plan.bytes)}) into ${out}?`, {modal: true,
    detail: `Read only: the database refuses any write from this session. The folder must be empty or one this command wrote before.${large ? ` This plan is LARGE (above ${largePlanNumbers()}).` : ""}`}, "Extract");
  if (sure !== "Extract") return;

  errors.length = 0;
  let consent = "none"; // none | given | declined
  let child;
  let livePlan;
  const result = await job("extract", [...base(), "--out", out, "--json", ...narrowArgs()], `Extracting into ${path.basename(out)}`, {
    onChild: (c) => { child = c; },
    onLine: (stream, line) => {
      if (stream !== "out") return;
      if (line.trimStart().startsWith("{") && livePlan === undefined) {
        try { livePlan = JSON.parse(line).plan; } catch { /* not the plan */ }
      } else if (/^extract \d+ objects .*\? \[y\/N\]/.test(line)) {
        // the module's own consent, on the LIVE listing: the same numbers the
        // user just confirmed are answered; a listing that changed is asked again
        void (async () => {
          let yes = livePlan !== undefined && livePlan.inScope === plan.inScope && livePlan.bytes === plan.bytes;
          if (!yes && livePlan !== undefined) {
            yes = (await vscode.window.showWarningMessage(`The listing changed since the plan: now ${livePlan.inScope} objects (${mb(livePlan.bytes)}). Extract them into ${out}?`, {modal: true}, "Extract")) === "Extract";
          }
          consent = yes ? "given" : "declined";
          child?.answerConsent(yes ? "yes\n" : "no\n");
        })();
      }
    },
  });
  if (result.cancelled) {
    void vscode.window.showWarningMessage(`osd: Cancelled; the reader was stopped. ${out} holds this command's unfinished work area (.osd-hana/); choose an empty folder next time, or delete that folder first.`);
    return;
  }
  if (consent === "declined") { void vscode.window.showInformationMessage("osd: Declined -- nothing was dumped."); return; }
  const reportMd = path.join(out, "extract-report.md");
  const showReport = async () => {
    if (fs.existsSync(reportMd)) await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(reportMd));
  };
  if (result.code === 0 || result.code === 3) {
    await showReport();
    const sentence = redact(await reportSentence(out));
    const text = result.code === 0
      ? `osd: Extracted into ${out}. ${sentence}`
      : `osd: Extracted only in part into ${out}: ${sentence} The report lists every object.`;
    const show = result.code === 0 ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    const action = await show(text, "Open folder in new window", "Reveal in file manager");
    if (action === "Open folder in new window") await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(out), {forceNewWindow: true});
    if (action === "Reveal in file manager") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(out));
    return;
  }
  if (result.code === 6) await showReport();
  const action = await vscode.window.showErrorMessage(redact(extractExitText(result.code, lastError())), "Show output");
  if (action === "Show output") output.show();
}

/** The doctor's guided create of a dedicated read-only user, with every
 *  question of the module answered by VS Code UI: the second login (name,
 *  then a password box) and the consent -- a modal that shows the module's
 *  exact consent text, all statements of both logins. Returns "created",
 *  "skipped" (go on with the present login) or "stop". */
async function createReader(vscode, {job, base, connection, redact, errors, lastError}) {
  let consentText;
  let declinedLogin = false;
  let declinedConsent = false;
  errors.length = 0;
  const result = await job("doctor", [...base(), "--create-reader", "--json"], "Creating the read-only user", {
    onLine: (stream, line) => {
      if (stream === "out" && line.startsWith("osd hana: about to create")) consentText = line;
    },
    onAsk: async ({kind, question}) => {
      if (/Type 'yes'/.test(question)) {
        const yes = await vscode.window.showWarningMessage("Run these statements to create the read-only user?",
          {modal: true, detail: consentText ?? "(the statements were not shown -- declining)"}, "Yes", "No");
        if (yes !== "Yes" || consentText === undefined) { declinedConsent = true; return "no"; }
        return "yes";
      }
      if (kind === "hidden") {
        if (declinedLogin) return ""; // the module refuses an empty password: nothing is sent
        const value = await vscode.window.showInputBox({title: question.replace(/[:\s]+$/, ""), password: true, ignoreFocusOut: true,
          prompt: "Used for its statements only and never stored."});
        redact.add(value);
        return value ?? "";
      }
      const suggestion = /\[([^\]]+)\]/.exec(question)?.[1];
      const value = await vscode.window.showInputBox({title: question.replace(/\s*\[[^\]]*\]/, "").replace(/[:\s]+$/, ""),
        value: suggestion, ignoreFocusOut: true,
        prompt: "This flow needs a second login: the one that holds the role the present login lacks."});
      if (value === undefined) declinedLogin = true;
      return value ?? "";
    },
  });
  if (result.cancelled) return "stop";
  if (result.code === 0) return "created";
  const message = declinedConsent || declinedLogin
    ? "osd: Declined -- nothing was sent to the database."
    : redact(`osd: The read-only user was not created: ${lastError() ?? `exit ${result.code}`}`);
  const go = await vscode.window.showWarningMessage(message, `Continue with ${connection.user}`);
  return go === undefined ? "stop" : "skipped";
}

function registerHanaExtractCommand(vscode, context, output, homesOf, deps = {}) {
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND, async () => {
    try {
      const moduleRoot = findModuleRoot(homesOf());
      if (moduleRoot === undefined) return vscode.window.showErrorMessage(MODULE_NEEDED);
      const env = deps.env ?? process.env;
      const callerPath = bundledSidecarPath(context);
      if (callerPath === undefined && !env.OSD_HANA_DUMP) return vscode.window.showErrorMessage(noSidecarText());
      return await extractFromHana(vscode, context, output, {moduleRoot, callerPath, env, hostScript: deps.hostScript, tmpdir: deps.tmpdir});
    } catch (error) {
      const message = `osd: ${String(error?.message ?? error)}`;
      output.appendLine(message);
      return vscode.window.showErrorMessage(message);
    }
  }));
}

module.exports = {registerHanaExtractCommand, extractFromHana, bundledSidecarPath, findModuleRoot, planItems,
  extractExitText, doctorExitText, reportSentence, noSidecarText, MODULE_NEEDED, COMMAND, SECRET_PREFIX};
