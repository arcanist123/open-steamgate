import {test, expect} from "@playwright/test";
// the port of the gateway under test: STG_PORT, as test/start.mjs reads it, so sessions do not collide on 3030
const PORT = process.env.STG_PORT ?? 3030;

// A Fiori Elements V2 list report (SAPUI5 from the CDN) against the
// transpiled DPC. Needs network access for the UI5 runtime.
test("list report shows the travels served by the transpiled DPC", async ({page}) => {
  const odata = [];
  page.on("request", (req) => {
    if (req.url().includes("/sap/opu/odata/sap/")) {
      odata.push(req.method() + " " + req.url().replace(`http://localhost:${PORT}`, "") + " " + (req.postData() || ""));
    }
  });
  const failed = [];
  page.on("response", (res) => {
    if (res.url().includes("/sap/opu/odata/sap/") && res.status() >= 400) {
      failed.push(res.status() + " " + res.url());
    }
  });

  await page.goto("/app/index.html");

  // the table renders one row per travel
  const rows = page.locator("table tbody tr.sapMListTblRow, .sapUiTableRow:has(.sapUiTableCell)");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();
  await expect(page.getByText("Aarhus to Odense")).toBeVisible();
  await expect(rows).toHaveCount(4);

  // painted, not only present: an ancestor with height 0 and overflow hidden
  // would leave the row in the DOM and the page blank
  const painted = await page.getByText("Berlin to Copenhagen").evaluate((cell) => {
    const r = cell.getBoundingClientRect();
    return cell.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  expect(painted).toBe(true);

  // the picture of each travel: a column of images, every one of them the
  // media resource of the Photo entity, fetched from the transpiled DPC
  // Fiori Elements renders an IsImageURL value as an avatar whose background
  // is the URL, one per row
  const pictures = page.locator(".sapFAvatarImageHolder");
  await expect(pictures.first()).toBeVisible();
  expect(await pictures.count()).toBeGreaterThanOrEqual(4);
  const source = await pictures.first().evaluate((e) => getComputedStyle(e).backgroundImage);
  expect(source).toContain("PhotoSet('T0001')/$value");
  const picture = await page.request.get(`/sap/opu/odata/sap/ZSTG_DEMO_SRV/PhotoSet('T0001')/$value`);
  expect(picture.status()).toBe(200);
  expect(picture.headers()["content-type"]).toBe("image/png");
  expect((await picture.body()).length).toBeGreaterThan(500);

  // the app really went through $metadata and the entity set
  expect(odata.some((r) => r.includes("$metadata"))).toBe(true);
  // in batch mode the entity-set request travels inside the $batch body
  expect(odata.some((r) => r.includes("TravelSet") && r.includes("$inlinecount=allpages"))).toBe(true);
  // nothing the app asked the service for came back as an error
  expect(failed, failed.join("\n")).toEqual([]);
});

test("object page: navigation reads to_Bookings, Edit + Save sends MERGE with the changed field only", async ({page}) => {
  const requests = [];
  page.on("request", (req) => {
    const text = req.method() + " " + req.url() + " " + (req.postData() || "");
    if (text.includes("/sap/opu/odata/sap/")) {
      requests.push(text.replace(/\r?\n/g, " "));
    }
  });
  await page.goto("/app/index.html");
  const row = page.locator("tr.sapMListTblRow", {hasText: "Berlin to Copenhagen"}).first();
  await row.focus();
  await page.keyboard.press("Enter");

  // the object page: header, the General field group, bookings through the navigation property
  await expect(page).toHaveURL(/#\/TravelSet\('T0001'\)/);
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page.getByText("Grace Hopper")).toBeVisible();
  // the header carries the travel's picture (UI.HeaderInfo ImageUrl)
  // the list report's own avatars are still in the DOM behind the page
  const avatar = page.locator(".sapFAvatarImageHolder").locator("visible=true").first();
  await expect(avatar).toBeVisible();
  expect(await avatar.evaluate((e) => getComputedStyle(e).backgroundImage)).toContain("PhotoSet('T0001')/$value");
  expect(requests.some((r) => r.includes("TravelSet('T0001')/to_Bookings?"))).toBe(true);

  // non-draft edit: Edit, change Seats, Save
  await page.getByRole("button", {name: "Edit"}).focus();
  await page.keyboard.press("Enter");
  const seats = page.getByLabel(/^Seats/).first();
  await expect(seats).toBeEditable();
  await seats.fill("3");
  await page.getByRole("button", {name: "Save"}).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", {name: "Edit"})).toBeVisible();

  const merge = requests.find((r) => /MERGE TravelSet\('T0001'\)/.test(r));
  expect(merge, requests.join("\n")).toBeDefined();
  expect(merge).toContain('"Seats":3');
  expect(merge).not.toContain('"Description"');
  // the model sends the ETag of the entry back (the metadata says
  // ConcurrencyMode Fixed and the entries carry __metadata.etag), and the
  // write is only answered because it matches
  expect(merge).toMatch(/If-Match: W\/"/);

  // the gateway laid the request over the entity: the rest survived
  const travel = await page.evaluate(async () => (await fetch("../sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet('T0001')?$format=json")).json());
  expect(travel.d.Seats).toBe(3);
  expect(travel.d.Description).toBe("Berlin to Copenhagen");
  expect(travel.d.Status).toBe("A");
});

test("\"Ber*\" in Description: Fiori sends startswith, the DPC makes it LIKE", async ({page}) => {
  const filters = [];
  page.on("request", (req) => {
    const text = req.url() + " " + (req.postData() || "");
    if (text.includes("TravelSet") && text.includes("$filter")) {
      filters.push(text);
    }
  });
  await page.goto("/app/index.html");
  await expect(page.getByText("Aarhus to Odense")).toBeVisible();
  const description = page.getByLabel(/^Description/).first();
  await description.fill("Ber*");
  await description.press("Enter");
  await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();
  await expect(page.getByText("Aarhus to Odense")).toBeHidden();
  await expect(page.getByText("Copenhagen to Aarhus")).toBeHidden();
  expect(filters.some((u) => /startswith\(Description,'Ber'\)/.test(decodeURIComponent(u))), filters.join("\n")).toBe(true);
});

test("the filter bar's search field goes to the DPC as iv_search_string", async ({page}) => {
  const searches = [];
  page.on("request", (req) => {
    const text = req.url() + " " + (req.postData() || "");
    if (text.includes("TravelSet") && /[?&]search=/.test(text)) {
      searches.push(text);
    }
  });
  await page.goto("/app/index.html");
  await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();
  const search = page.getByRole("searchbox").or(page.getByPlaceholder("Search")).first();
  await search.fill("odense");
  await search.press("Enter");
  await expect(page.getByText("Aarhus to Odense")).toBeVisible();
  await expect(page.getByText("Berlin to Copenhagen")).toBeHidden();
  expect(searches.some((u) => /search=odense/.test(u)), searches.join("\n")).toBe(true);
});

test("filter bar sends $filter that the DPC honours", async ({page}) => {
  await page.goto("/app/index.html");
  await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();

  const filters = [];
  page.on("request", (req) => {
    const text = decodeURIComponent(req.url() + " " + (req.postData() || ""));
    if (text.includes("TravelSet") && text.includes("$filter")) {
      filters.push(text);
    }
  });
  const status = page.getByRole("combobox", {name: /Status/}).or(page.getByLabel(/^Status/).first());
  await status.first().fill("X");
  await status.first().press("Enter");

  await expect(page.getByText("Berlin to Copenhagen")).toHaveCount(0);
  await expect(page.getByText("Aarhus to Odense")).toBeVisible();
  expect(filters.some((u) => /\$filter=Status eq 'X'/.test(u)), filters.join("\n")).toBe(true);

});

test("Delete in the list report goes through a $batch changeset to the DPC", async ({page}) => {
  const deletes = [];
  page.on("request", (req) => {
    const text = req.postData() || "";
    if (req.url().includes("$batch") && /DELETE TravelSet/.test(text)) {
      deletes.push(text);
    }
  });
  await page.goto("/app/index.html");
  const row = page.locator("tr.sapMListTblRow", {hasText: "Aarhus to Odense"});
  await expect(row).toBeVisible();

  // select the row the keyboard way (focus a cell, Space); pointer clicks
  // never pass Playwright's "stable" check under the WSL headless
  // compositor, the same reason screenshots come out blank there
  await row.locator("td").nth(1).focus();
  await page.keyboard.press("Space");
  const del = page.getByRole("button", {name: "Delete"}).first();
  await expect(del).toBeEnabled();
  await del.focus();
  await page.keyboard.press("Enter");
  // sap.m.MessageBox renders as an alertdialog
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).first();
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", {name: /^(Delete|OK)$/});
  await confirm.focus();
  await page.keyboard.press("Enter");

  // the row is gone from the table (the closed MessageBox may linger in the
  // static area for a moment, so look at rows, not at any text)
  await expect(page.locator("tr.sapMListTblRow", {hasText: "Aarhus to Odense"})).toHaveCount(0);
  await expect(page.locator("table tbody tr.sapMListTblRow")).toHaveCount(3);
  expect(deletes.some((t) => /DELETE TravelSet\('T0003'\)/.test(t)), deletes.join("\n")).toBe(true);
  // the delete names an If-Match too (measured: `*` here, the entry's own
  // tag on the Save above), so it is answered rather than refused with 428
  expect(deletes.some((t) => /DELETE TravelSet\('T0003'\)[\s\S]*If-Match: /.test(t)), deletes.join("\n")).toBe(true);

  const res = await fetch(`http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet('T0003')`);
  expect(res.status).toBe(404);
});

test("object page: Create on the bookings table posts to TravelSet('T0001')/to_Bookings", async ({page}) => {
  const requests = [];
  page.on("request", (req) => {
    const text = req.method() + " " + req.url() + " " + (req.postData() || "");
    if (text.includes("/sap/opu/odata/sap/")) {
      requests.push(text.replace(/\r?\n/g, " "));
    }
  });
  await page.goto("/app/index.html#/TravelSet('T0001')");
  await expect(page.getByText("Ada Lovelace")).toBeVisible();

  // the sub-object page in create mode (non-draft): keys and fields editable
  // FCL also keeps the list's Create visible: target the bookings column.
  await page.locator(".sapFFCLColumnMid").getByRole("button", {name: "Create", exact: true}).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", {name: "Unnamed Object"})).toBeVisible();
  const bookingId = page.getByRole("textbox", {name: "Booking"});
  await expect(bookingId).toBeEditable();
  await bookingId.fill("B009");
  await page.getByRole("textbox", {name: "Customer"}).fill("Alan Turing");
  // the footer's Create (the table's is gone with the page)
  await page.getByRole("button", {name: "Create"}).last().focus();
  await page.keyboard.press("Enter");

  // ODataModel submits its changeset asynchronously after the UI event.
  // Observe the completed navigation before inspecting the captured request;
  // reading the array immediately races the $batch dispatch on CI runners.
  await expect(page.getByRole("heading", {name: "Alan Turing"})).toBeVisible();

  // created below the travel: the POST goes through the navigation property,
  // the parent key travels in the URL, not in the payload
  // (inside a $batch changeset, hence the search by payload)
  const post = requests.find((r) => r.includes('"Customer":"Alan Turing"'));
  expect(post, requests.join("\n")).toBeDefined();
  expect(post).toMatch(/POST TravelSet\('T0001'\)\/to_Bookings/);
  expect(post).toContain('"BookingId":"B009"');

  // Close the nested FCL column: the parent table shows the new booking.
  await page.locator(".sapFFCLColumnEnd").getByRole("button", {name: "Close", exact: true}).click();
  await expect(page.getByRole("gridcell", {name: "Ada Lovelace"})).toBeVisible();
  await expect(page.getByRole("gridcell", {name: "Alan Turing"})).toBeVisible();
});

test("launchpad: intent navigation from a booking to the Bookings app and back to the filtered Travels", async ({page}) => {
  await page.goto("/app/flp.html");
  // the sandbox shell with our two tiles
  const travels = page.getByRole("link", {name: /Travels/}).or(page.locator(".sapUshellTile", {hasText: "Travels"})).first();
  await expect(travels).toBeVisible();
  // only our group: the sandbox's own catalog (RTA Demo App...) is not shown
  await expect(page.getByText("RTA Demo App")).toHaveCount(0);
  await expect(page.locator(".sapUshellTile", {hasText: "SEGW"}).first()).toBeVisible();
  await travels.click();
  await expect(page).toHaveURL(/#Travel-manage/);
  await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();

  // into the object page, select the first booking, the intent button opens the Bookings app
  const row = page.locator("tr.sapMListTblRow", {hasText: "Berlin to Copenhagen"}).first();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  // single selection: the row's radio button
  const bookingRow = page.locator("tr.sapMListTblRow", {hasText: "Ada Lovelace"}).first();
  await bookingRow.locator(".sapMRb, .sapMCb").first().click();
  const open = page.getByRole("button", {name: "Open in Bookings"});
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page).toHaveURL(/#Booking-display/);
  // both keys travel with the intent, so the Bookings app opens that booking's page
  await expect(page.getByRole("heading", {name: "Ada Lovelace"})).toBeVisible();
  await expect(page.getByText("Grace Hopper")).toHaveCount(0);

  // the travel field is a link (UI.DataFieldWithIntentBasedNavigation): back
  // to the Travels app on that travel
  await page.getByRole("link", {name: "T0001"}).first().click();
  await expect(page).toHaveURL(/#Travel-manage/);
  // the key came along, so the Travels app lands on that travel's page
  await expect(page.getByRole("heading", {name: "Berlin to Copenhagen"})).toBeVisible();
  await expect(page.getByText("Aarhus to Odense")).toHaveCount(0);
});
