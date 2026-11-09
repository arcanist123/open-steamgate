import {test, expect} from "@playwright/test";
// the port of the gateway under test: STG_PORT, as test/start.mjs reads it, so sessions do not collide on 3030
const PORT = process.env.STG_PORT ?? 3030;
const V4 = "/sap/opu/odata4/sap/ZSTG_DEMO_SRV";

// A Fiori Elements V4 list report and object page (webapp/travel4, SAPUI5
// from the CDN) over the V4 facade of the transpiled demo service. The UI5
// V4 model sends multipart $batch; edit and create go through the facade's
// sticky session (Session.StickySessionSupported). Needs network access for
// the UI5 runtime.

// every V4 request and response of the page, with the bodies of batches
function recorder(page) {
  const sent = [];
  const failed = [];
  page.on("request", (req) => {
    if (req.url().includes("/sap/opu/odata4/")) {
      sent.push(req.method() + " " + req.url().replace(`http://localhost:${PORT}`, "") + " " + (req.postData() || "").replace(/\r?\n/g, " "));
    }
  });
  page.on("response", async (res) => {
    if (!res.url().includes("/sap/opu/odata4/")) return;
    if (res.status() >= 400) failed.push(res.status() + " " + res.url());
    // a part of a batch answers on its own status line
    if (res.url().includes("$batch")) {
      const text = await res.text().catch(() => "");
      for (const m of text.matchAll(/HTTP\/1\.1 (\d{3})[^\r\n]*/g)) {
        if (Number(m[1]) >= 400) failed.push(m[0] + " in a $batch part: " + text.slice(0, 400));
      }
    }
  });
  return {sent, failed};
}

const v4 = (page, path, headers = {}) => page.evaluate(async ([url, h]) => {
  const res = await fetch(url, {headers: h});
  return {status: res.status, body: res.status === 200 ? await res.json() : undefined};
}, [V4 + path, headers]);

// the table's title carries the count the service answered ($count=true)
const travels = (page, n) => expect(page.getByRole("heading", {name: `Travels (${n})`})).toBeVisible();

test("list report: rows from the V4 facade, through a multipart $batch", async ({page}) => {
  const {sent, failed} = recorder(page);
  await page.goto("/app/travel4/index.html");
  await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();
  await expect(page.getByText("Aarhus to Odense")).toBeVisible();
  await travels(page, 4);
  // what the app asked for: CSDL with the UI annotations, a token by HEAD,
  // and the rows inside a multipart batch with $count and $select
  expect(sent.some((r) => r.startsWith("GET " + V4 + "/$metadata"))).toBe(true);
  expect(sent.some((r) => r.startsWith("HEAD " + V4 + "/"))).toBe(true);
  expect(sent.some((r) => r.startsWith("POST " + V4 + "/$batch") && /GET TravelSet\?\$count=true&\$select=/.test(r))).toBe(true);
  expect(failed, failed.join("\n")).toEqual([]);
});

test("filter bar: Status X filters the list through $filter", async ({page}) => {
  const {sent, failed} = recorder(page);
  await page.goto("/app/travel4/index.html");
  await travels(page, 4);
  const status = page.getByRole("combobox", {name: "Status"}).or(page.getByLabel(/^Status/)).locator("visible=true").first();
  await status.fill("X");
  await status.press("Enter");
  await page.getByRole("button", {name: "Go"}).click();
  await expect(page.getByText("Aarhus to Odense")).toBeVisible();
  await expect(page.getByText("Berlin to Copenhagen")).toBeHidden();
  await travels(page, 1);
  expect(sent.some((r) => r.includes("$filter=Status%20eq%20'X'") || r.includes("$filter=Status eq 'X'")), sent.join("\n")).toBe(true);
  expect(failed, failed.join("\n")).toEqual([]);
});

test("object page: header, field group and bookings read through the navigation property", async ({page}) => {
  const {sent, failed} = recorder(page);
  await page.goto("/app/travel4/index.html");
  await page.getByText("Berlin to Copenhagen").click();
  await expect(page).toHaveURL(/#\/TravelSet\('T0001'\)/);
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page.getByText("Grace Hopper")).toBeVisible();
  expect(sent.some((r) => r.includes("GET TravelSet('T0001')/to_Bookings?$count=true"))).toBe(true);
  expect(failed, failed.join("\n")).toEqual([]);
});

test("edit + save: a sticky session, PATCH with If-Match, Save writes through the DPC", async ({page}) => {
  const {sent, failed} = recorder(page);
  await page.goto("/app/travel4/index.html#/TravelSet('T0002')");
  await expect(page.getByRole("heading", {name: "Copenhagen to Aarhus"})).toBeVisible();
  await page.getByRole("button", {name: "Edit"}).click();
  const seats = page.getByLabel(/^Seats/).locator("visible=true").first();
  await expect(seats).toBeEditable();
  await seats.fill("3");
  await seats.press("Tab");
  await page.getByRole("button", {name: "Save"}).click();
  await expect(page.getByRole("button", {name: "Edit"})).toBeVisible();

  const edit = sent.find((r) => r.includes("POST TravelSet('T0002')/ZSTG_DEMO_SRV.OsdStickyEdit"));
  expect(edit, sent.join("\n")).toBeDefined();
  const patch = sent.find((r) => r.includes("PATCH TravelSet('T0002')"));
  expect(patch, sent.join("\n")).toBeDefined();
  expect(patch).toMatch(/If-Match:W\/"/);
  expect(patch).toMatch(/SAP-ContextId:/);
  expect(patch).toContain('"Seats":3');
  expect(sent.some((r) => r.includes("POST TravelSet('T0002')/ZSTG_DEMO_SRV.OsdStickySave"))).toBe(true);
  // written, and only the field that changed
  const travel = await v4(page, "/TravelSet('T0002')");
  expect(travel.body).toMatchObject({Seats: 3, Description: "Copenhagen to Aarhus", Status: "A"});
  expect(failed, failed.join("\n")).toEqual([]);
});

test("create: NewAction asks for the key, Save creates through the DPC", async ({page}) => {
  const {sent, failed} = recorder(page);
  await page.goto("/app/travel4/index.html");
  await travels(page, 4);
  await page.getByRole("button", {name: "Create"}).click();
  await page.getByRole("textbox", {name: "TravelId"}).fill("T0700");
  await page.getByRole("button", {name: "Continue"}).click();
  await expect(page).toHaveURL(/#\/TravelSet\('T0700'\)/);
  const description = page.getByLabel(/^Description/).locator("visible=true").first();
  await expect(description).toBeEditable();
  await description.fill("Created in Fiori V4");
  await description.press("Tab");
  await page.getByRole("button", {name: /^(Create|Save)$/}).locator("visible=true").last().click();
  await expect(page.getByRole("button", {name: "Edit"})).toBeVisible();

  expect(sent.some((r) => r.includes("POST TravelSet/ZSTG_DEMO_SRV.OsdStickyNew") && r.includes('{"TravelId":"T0700"}')), sent.join("\n")).toBe(true);
  expect(sent.some((r) => r.includes("POST TravelSet('T0700')/ZSTG_DEMO_SRV.OsdStickySave"))).toBe(true);
  const travel = await v4(page, "/TravelSet('T0700')");
  expect(travel.status).toBe(200);
  expect(travel.body.Description).toBe("Created in Fiori V4");
  expect(failed, failed.join("\n")).toEqual([]);
  // leave the list as the other specs expect it
  const removed = await page.evaluate(async (url) => (await fetch(url, {method: "DELETE", headers: {"If-Match": "*"}})).status,
    V4 + "/TravelSet('T0700')");
  expect(removed).toBe(204);
});

test("the launchpad tile opens the V4 app", async ({page}) => {
  await page.goto("/app/flp.html");
  await page.getByText("Travels (OData V4)").first().click();
  await expect(page).toHaveURL(/#TravelV4-manage/);
  await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();
});
