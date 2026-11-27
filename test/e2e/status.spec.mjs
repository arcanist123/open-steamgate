import {test, expect} from "@playwright/test";
import {identity} from "../../tools/osd-identity.mjs";

// the system id the server (and the preview, at build) took from the one
// identity: OSD_SID, its alias STG_ADT_SID, else OSD
const SID = identity().sid;
// the port of the gateway under test: STG_PORT, as test/start.mjs reads it, so sessions do not collide on 3030
const PORT = Number(process.env.STG_PORT ?? 3030);

// The system status app: a Fiori Elements V2 list report over SystemSet (one
// row) and an object page whose facets are the processes, the ports, the
// services, packs and database facts of the tree that is answering. Every annotation --
// HeaderInfo, LineItem, Facets -- comes out of ZOSD_STATUS_SRV's own
// $metadata, so what this proves is that the service annotates itself well
// enough for a stock template to render it, with no annotation file in the
// app. Needs network access for the UI5 runtime.
test("system status: the object page over the running tree", async ({page}) => {
  const failed = [];
  page.on("response", (res) => {
    if (res.url().includes("/sap/opu/odata/sap/ZOSD_STATUS_SRV") && res.status() >= 400) {
      failed.push(res.status() + " " + res.url());
    }
  });

  await page.goto("/app/status/index.html");

  // the list report: one row, the SID of the running tree
  const row = page.locator(".sapMListTblRow", {hasText: SID}).first();
  await expect(row).toBeVisible();
  await row.click();

  // the object page header: HeaderInfo's Title is Sid, its Description GenLive
  const header = page.locator(".sapUxAPObjectPageHeaderTitle").first();
  await expect(header).toBeVisible();
  await expect(header).toContainText(SID);

  // the five table facets, each scoped by the ID the service's ReferenceFacet
  // gave it (the section id ends in "--<ID>::Section")
  const section = (id) => page.locator(`[id$="--${id}::Section"]`).first();
  // a number is rendered with the locale's group separator ("3,055"), so a
  // row is read with the separators taken out before a port is looked for
  const digits = async (loc) => (await loc.innerText()).replace(/[,  \s]/g, "");

  // Work processes: the facade, and a work process when one is forked
  const proc = section("Processes").locator(".sapMListTblRow").filter({hasText: /facade|work/}).first();
  await expect(proc).toBeVisible();

  // Ports: the HTTP port this page itself came in on, listening
  const http = section("Ports").locator(".sapMListTblRow", {hasText: "HTTP"}).first();
  await expect(http).toBeVisible();
  await expect(http).toContainText("listening");
  expect(await digits(http)).toContain(String(PORT));

  // Services: the ICF paths the runtime answers
  // (each launchpad app is a row too, and the apps' /app/flp.html# paths sort
  // first: when they fill the first page, grow the table until one shows)
  const service = section("Services").locator(".sapMListTblRow").filter({hasText: /\/sap\//}).first();
  await expect(async () => {
    if (!(await service.isVisible())) await section("Services").getByRole("button", {name: /^More/}).click();
    await expect(service).toBeVisible({timeout: 2000});
  }).toPass({timeout: 30_000});
  expect(await service.innerText()).toMatch(/(^|[\t\n])\/sap\//);

  // Packs: the content packs layered into the build
  const pack = section("Packs").locator(".sapMListTblRow").filter({hasText: /\S/}).first();
  await expect(pack).toBeVisible();

  const database = section("Database");
  await database.scrollIntoViewIfNeeded();
  const engine = database.locator(".sapMListTblRow", {hasText: "Engine"}).first();
  await expect(engine).toBeVisible();
  await expect(engine).toContainText(/sqlite|duckdb|HDB/);
  const storage = database.locator(".sapMListTblRow", {hasText: "Storage"}).first();
  await expect(storage).toBeVisible();
  await expect(storage).toContainText(/memory|file|server/);
  const architecture = database.locator(".sapMListTblRow", {hasText: "Architecture"}).first();
  await expect(architecture).toBeVisible();
  await expect(architecture).toContainText(/linux|darwin|win32/);

  // AMDP methods: the demo's SQUARES with the engine a call would use now,
  // which is one of the five labels ZCL_OSD_STATUS=>ENGINE gives and never
  // the system database's name on its own
  const amdp = section("Amdp");
  await amdp.scrollIntoViewIfNeeded();
  const squares = amdp.locator(".sapMListTblRow", {hasText: "SQUARES"}).first();
  await expect(squares).toBeVisible();
  await expect(squares).toContainText(/portable-duckdb|hdb-stale|hdb-idle|hdb|unavailable/);

  expect(failed).toEqual([]);
});
