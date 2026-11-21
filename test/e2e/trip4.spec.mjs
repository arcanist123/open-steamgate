import {test, expect} from "@playwright/test";
import {launchpadTile} from "./launchpad-navigation.shared.mjs";
// the port of the gateway under test: STG_PORT, as test/start.mjs reads it, so sessions do not collide on 3030
const PORT = process.env.STG_PORT ?? 3030;
const V4 = "/sap/opu/odata4/sap/ZUI_RAP_DTRIP";

// RAP R9 (docs/rap-runtime.md): a Fiori Elements V4 list report and object
// page with draft (webapp/trip4, SAPUI5 from the CDN) over the R8 trip demo,
// ZUI_RAP_DTRIP. Nothing in the app is draft-specific: sap.fe runs its own
// draft flow because the set is a Common.DraftRoot. The browser is the
// system's default user; "another user" is a request with a Basic credential
// (src/logon), made beside the page. Needs network access for the UI5 runtime.

// every V4 request of the page (batch parts unpacked) and every failure
function recorder(page) {
  const sent = [];
  const failed = [];
  page.on("request", (req) => {
    if (!req.url().includes("/sap/opu/odata4/")) return;
    const body = req.postData() || "";
    const parts = [...body.matchAll(/^(GET|POST|PATCH|DELETE|PUT) (\S+) HTTP\/1\.1/gm)].map((m) => `${m[1]} ${decodeURIComponent(m[2])}`);
    if (parts.length) sent.push(...parts);
    else sent.push(`${req.method()} ${decodeURIComponent(req.url().replace(`http://localhost:${PORT}`, ""))}`);
  });
  page.on("response", async (res) => {
    if (!res.url().includes("/sap/opu/odata4/")) return;
    if (res.status() >= 400) failed.push(res.status() + " " + res.url());
    if (res.url().includes("$batch")) {
      const text = await res.text().catch(() => "");
      for (const m of text.matchAll(/HTTP\/1\.1 (\d{3})[^\r\n]*/g)) {
        if (Number(m[1]) >= 400) failed.push(m[0] + " in a $batch part: " + text.slice(text.indexOf(m[0]), text.indexOf(m[0]) + 400));
      }
    }
  });
  return {sent, failed};
}

const as = (user) => ({authorization: `Basic ${Buffer.from(`${user}:any`).toString("base64")}`});
const writing = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json", "if-match": "*"};
const key = (id, active) => `(trip_uuid='${id}',IsActiveEntity=${active})`;

// the service beside the page, as the browser's user or as another one
async function api(request, method, path, {user, body} = {}) {
  const res = await request.fetch(V4 + path, {method, headers: {...writing, ...(user ? as(user) : {})}, data: body});
  const text = await res.text();
  return {status: res.status(), body: text ? JSON.parse(text) : undefined};
}
async function activeTrip(request, description, user) {
  const made = await api(request, "POST", "/Trip", {user, body: {description}});
  expect(made.status).toBe(201);
  expect((await api(request, "POST", `/Trip${key(made.body.trip_uuid, false)}/ZUI_RAP_DTRIP.Activate`, {user, body: {}})).status).toBe(200);
  return made.body.trip_uuid;
}

const description = (page) => page.getByLabel(/^Description/).locator("visible=true").first();
// type into the object page's Description and leave the field: the draft
// takes the change (PATCH). sap.fe renders the field before the draft's
// data arrives, and a value typed then is overwritten: type until it stays
async function change(page, text) {
  await expect(async () => {
    await description(page).fill(text);
    await description(page).press("Tab");
    await expect(description(page)).toHaveValue(text, {timeout: 2000});
    await expect(page.getByText(/^Draft (updated|saved)$/)).toBeVisible({timeout: 5000});
  }).toPass({timeout: 45_000});
}
// the footer's save: "Create" for a new draft, "Save" for an edit
const save = (page) => page.getByRole("button", {name: /^(Create|Save)$/}).locator("visible=true").last();

test("list report: the latest version of each trip, through the draft list filter", async ({page}) => {
  const {sent, failed} = recorder(page);
  await page.goto("/app/trip4/index.html");
  await expect(page.getByRole("button", {name: "Create"})).toBeVisible();
  await expect(page.getByRole("heading", {name: /^Trips/})).toBeVisible();
  expect(sent.some((r) => r.startsWith("GET " + V4 + "/$metadata"))).toBe(true);
  // the latest version of each trip, with the admin data the draft indicator shows
  await expect.poll(() => sent.some((r) => r.startsWith("GET Trip?$count=true&") &&
    r.includes("$filter=(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)") &&
    r.includes("$expand=DraftAdministrativeData($select=DraftUUID,InProcessByUser,InProcessByUserDescription,"))).toBe(true);
  expect(failed, failed.join("\n")).toEqual([]);
});

test("create a draft, change it, add a leg, save it (Prepare + Activate)", async ({page, request}) => {
  const {sent, failed} = recorder(page);
  const text = `Fjords ${Date.now()}`;
  await page.goto("/app/trip4/index.html");
  await page.getByRole("button", {name: "Create"}).click();
  // no dialog: the key is Core.Computed, the draft comes back with it
  await expect(page).toHaveURL(/#\/Trip\(trip_uuid='[0-9A-F]{32}',IsActiveEntity=false\)/);
  const id = /trip_uuid='([0-9A-F]{32})'/.exec(page.url())[1];
  await expect(description(page)).toBeEditable();
  await change(page, text);
  // a leg below the draft: POST through to_Legs, then PATCH of the draft leg
  await page.getByRole("button", {name: "Create"}).locator("visible=true").first().click();
  const destination = page.locator("table input").locator("visible=true").last();
  await expect(destination).toBeEditable();
  await expect(async () => {
    await destination.fill("Bergen");
    await destination.press("Tab");
    await expect.poll(() => sent.some((r) => r.startsWith("PATCH Leg(")), {timeout: 3000}).toBe(true);
  }).toPass({timeout: 30_000});
  expect((await api(request, "GET", `/Trip${key(id, true)}`)).status, "not active before Save").toBe(404);
  await save(page).click();
  await expect(page.getByRole("button", {name: "Edit"})).toBeVisible();
  // the active trip, by its semantic key (Common.SemanticKey: trip_uuid) after a create
  await expect(page).toHaveURL(new RegExp(`#/Trip\\((trip_uuid=)?'${id}'`));

  expect(sent.some((r) => r === "POST Trip"), sent.join("\n")).toBe(true);
  expect(sent.some((r) => r.startsWith(`GET Trip${key(id, false)}?`) && r.includes("$expand=DraftAdministrativeData("))).toBe(true);
  expect(sent.some((r) => r === `PATCH Trip${key(id, false)}`)).toBe(true);
  expect(sent.some((r) => r === `POST Trip${key(id, false)}/ZUI_RAP_DTRIP.Prepare`)).toBe(true);
  expect(sent.some((r) => r.startsWith(`POST Trip${key(id, false)}/ZUI_RAP_DTRIP.Activate`))).toBe(true);
  expect(sent.some((r) => r === `POST Trip${key(id, false)}/to_Legs`)).toBe(true);
  const trip = await api(request, "GET", `/Trip${key(id, true)}`);
  expect(trip.body).toMatchObject({description: text, status: "N", IsActiveEntity: true, HasDraftEntity: false});
  const legs = await api(request, "GET", `/Trip${key(id, true)}/to_Legs`);
  expect(legs.body.value.map((l) => [l.destination, l.IsActiveEntity])).toEqual([["Bergen", true]]);
  expect((await api(request, "GET", `/Trip${key(id, false)}`)).status, "the draft is gone").toBe(404);
  expect(failed, failed.join("\n")).toEqual([]);
});

test("edit an active trip, change it, save it", async ({page, request}) => {
  const {sent, failed} = recorder(page);
  const id = await activeTrip(request, `Coast ${Date.now()}`);
  await page.goto(`/app/trip4/index.html#/Trip${key(id, true)}`);
  await page.getByRole("button", {name: "Edit"}).click();
  await expect(description(page)).toBeEditable();
  expect(sent.some((r) => r.startsWith(`POST Trip${key(id, true)}/ZUI_RAP_DTRIP.Edit`)), sent.join("\n")).toBe(true);
  await change(page, "Coast by bike");
  expect((await api(request, "GET", `/Trip${key(id, true)}`)).body.description, "the active trip waits").not.toBe("Coast by bike");
  await save(page).click();
  await expect(page.getByRole("button", {name: "Edit"})).toBeVisible();
  expect((await api(request, "GET", `/Trip${key(id, true)}`)).body).toMatchObject({description: "Coast by bike", HasDraftEntity: false});
  expect(failed, failed.join("\n")).toEqual([]);
});

test("edit an active trip, change it, discard the draft", async ({page, request}) => {
  const {sent, failed} = recorder(page);
  const text = `Islands ${Date.now()}`;
  const id = await activeTrip(request, text);
  await page.goto(`/app/trip4/index.html#/Trip${key(id, true)}`);
  await page.getByRole("button", {name: "Edit"}).click();
  await expect(description(page)).toBeEditable();
  await change(page, "Islands by ferry");
  await page.getByRole("button", {name: "Discard Draft"}).click();
  await page.getByRole("button", {name: "Discard", exact: true}).locator("visible=true").last().click();
  await expect(page.getByRole("button", {name: "Edit"})).toBeVisible();
  await expect(page.getByRole("heading", {name: text})).toBeVisible();
  // sap.fe asks for the active version through SiblingEntity, then deletes the draft
  expect(sent.some((r) => r === `GET Trip${key(id, false)}/SiblingEntity`), sent.join("\n")).toBe(true);
  expect(sent.some((r) => r === `DELETE Trip${key(id, false)}`)).toBe(true);
  expect((await api(request, "GET", `/Trip${key(id, true)}`)).body).toMatchObject({description: text, HasDraftEntity: false});
  expect(failed, failed.join("\n")).toEqual([]);
});

test("Editing Status: own drafts, drafts of another user, unchanged", async ({page, request}) => {
  const {sent, failed} = recorder(page);
  const tag = `ES${Date.now()}`;
  // the browser's own draft, an unchanged trip, and one ALICE is editing
  const own = await api(request, "POST", "/Trip", {body: {description: `${tag} mine`}});
  expect(own.status).toBe(201);
  const unchanged = await activeTrip(request, `${tag} unchanged`);
  const locked = await activeTrip(request, `${tag} locked`, "alice");
  expect((await api(request, "POST", `/Trip${key(locked, true)}/ZUI_RAP_DTRIP.Edit`, {user: "alice", body: {PreserveChanges: true}})).status).toBe(200);

  await page.goto("/app/trip4/index.html");
  const search = page.getByLabel(/^Description/).locator("visible=true").first();
  await search.fill(`${tag}*`);
  await search.press("Enter");
  // pick a value of the Editing Status field and run the search: opening,
  // choosing and checking the field's value are retried together, since the
  // list can close between seeing the option and clicking it (critic on #915)
  const pick = async (status) => {
    const field = page.locator('[id$="DraftEditingStatus-inner-inner"]');
    const option = page.getByRole("option").filter({hasText: new RegExp(`^${status.replace(/[()]/g, "\\$&")}$`)}).locator("visible=true").first();
    await expect(async () => {
      if (!(await option.isVisible())) await page.locator('[id$="DraftEditingStatus-inner-vhi"]').click();
      await option.click({timeout: 2000});
      await expect(field).toHaveValue(status, {timeout: 2000});
    }).toPass({timeout: 30_000});
    await page.getByRole("button", {name: "Go"}).click();
  };
  const shows = async (rows) => {
    await expect(page.getByRole("heading", {name: rows.length ? `Trips (${rows.length})` : /^Trips( \(0\))?$/})).toBeVisible();
    for (const r of ["mine", "unchanged", "locked"]) {
      const cell = page.getByText(`${tag} ${r}`, {exact: true});
      if (rows.includes(r)) await expect(cell).toBeVisible();
      else await expect(cell).toBeHidden();
    }
  };
  await page.getByRole("button", {name: "Go"}).click();
  await shows(["mine", "unchanged", "locked"]);
  // the draft indicator beside the semantic key: mine is a draft, ALICE holds the other
  await expect(page.getByRole("row").filter({hasText: `${tag} mine`}).getByText("Draft", {exact: true})).toBeVisible();
  await expect(page.getByRole("row").filter({hasText: `${tag} locked`}).getByText("Locked by ALICE")).toBeVisible();
  await pick("Own Draft");
  await shows(["mine"]);
  await pick("Locked by Another User");
  await shows(["locked"]);
  await pick("Unchanged");
  await shows(["unchanged"]);
  await pick("All (Hiding Drafts)");
  await shows(["unchanged", "locked"]);
  await pick("Unsaved Changes by Another User");
  await shows([]);
  for (const f of ["IsActiveEntity eq false", "IsActiveEntity eq true and HasDraftEntity eq false",
    "IsActiveEntity eq true and SiblingEntity/IsActiveEntity eq null and DraftAdministrativeData/InProcessByUser ne '' and DraftAdministrativeData/InProcessByUser ne null",
    "IsActiveEntity eq true and SiblingEntity/IsActiveEntity eq null and DraftAdministrativeData/InProcessByUser eq ''"]) {
    expect(sent.some((r) => r.includes(`$filter=${f}`)), `${f}\n${sent.join("\n")}`).toBe(true);
  }
  expect(failed, failed.join("\n")).toEqual([]);

  // the browser's user cannot edit what ALICE holds
  await page.goto(`/app/trip4/index.html#/Trip${key(locked, true)}`);
  await page.getByRole("button", {name: "Edit"}).click();
  await expect(page.getByText(/locked by user ALICE/).first()).toBeVisible();
  // leave nothing held
  expect((await api(request, "DELETE", `/Trip${key(locked, false)}`, {user: "alice"})).status).toBe(204);
  expect((await api(request, "DELETE", `/Trip${key(own.body.trip_uuid, false)}`)).status).toBe(204);
  expect(unchanged).toBeTruthy();
});

test("delete an active trip from the list", async ({page, request}) => {
  const {sent, failed} = recorder(page);
  const text = `Gone ${Date.now()}`;
  const id = await activeTrip(request, text);
  await page.goto("/app/trip4/index.html");
  const row = page.getByRole("row").filter({hasText: text});
  await row.getByRole("checkbox").click();
  await page.getByRole("button", {name: "Delete"}).locator("visible=true").first().click();
  await page.locator(".sapMDialog").getByRole("button", {name: "Delete"}).click();
  await expect(row).toBeHidden();
  expect(sent.some((r) => r === `DELETE Trip${key(id, true)}`), sent.join("\n")).toBe(true);
  expect((await api(request, "GET", `/Trip${key(id, true)}`)).status).toBe(404);
  expect(failed, failed.join("\n")).toEqual([]);
});

test("the launchpad tile opens the draft app", async ({page}) => {
  await page.goto("/app/flp.html");
  const tile = launchpadTile(page, "DraftTrip-manage");
  await expect(tile).toContainText("Draft Trips");
  await tile.click();
  await expect(page).toHaveURL(/#DraftTrip-manage(?:$|[?&])/);
  await expect(page.getByRole("button", {name: "Create"})).toBeVisible();
});
