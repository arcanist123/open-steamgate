import {test, expect} from "@playwright/test";
import {spawn} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

// The read-only Fiori Elements V2 app (webapp/h5x) on tools/hana-serve.mjs:
// list report -> object page -> the sub-list through a navigation, every
// read in a $batch of GETs. One spec, two targets (docs/hana-milestone-3.md):
//
//   - here and in CI: the spec starts hana-serve itself over the twin
//     service of test/hana-m2 (ZOSD_H5X_APP_SRV, --register) and a fake
//     DatabaseClient that answers SQL (test/fixtures/hana-serve/
//     twin-client.mjs); it expects test/e2e/fixtures/h5x-app.expect.json;
//   - by hand on a bed: OSD_E2E_BASE_URL names a running hana-serve over a
//     real service, OSD_E2E_APP_PATH the page of an app configuration kept
//     outside the tree (served with --app), OSD_E2E_EXPECT a file of the
//     same shape as the fixture with that service's cells. Nothing of that
//     service is in the tree.
//
// What it asserts in both: the column headers are the service's sap:label
// (checked to be in $metadata and in none of the app's own files, so a
// label typed into the app cannot pass), the rows and their order cell by
// cell, a sort and a filter the user makes and the rows they give, the
// object page and its sub-list, a $batch really sent with every part a GET,
// no answer >= 400 (batch parts included), and no Create / Edit / Delete.
// Needs network access for the UI5 runtime.
const root = fileURLToPath(new URL("../..", import.meta.url));
const expectFile = process.env.OSD_E2E_EXPECT ?? join(root, "test", "e2e", "fixtures", "h5x-app.expect.json");
const want = JSON.parse(readFileSync(expectFile, "utf8"));
const appPath = process.env.OSD_E2E_APP_PATH ?? want.app;

test.describe.configure({mode: "serial"});

let base = process.env.OSD_E2E_BASE_URL?.replace(/\/$/, "");
let host;

test.beforeAll(async () => {
  if (base !== undefined) return;
  // CI: our own hana-serve over the twin, on a free port
  const output = join(root, "output");
  if (!existsSync(join(output, "init.mjs"))) throw new Error("no generation in output/: build the tree first (npm run transpile)");
  const env = {...process.env};
  for (const name of ["STG_DB", "STG_SQL_TRACE", "STG_DB_TRACE", "OSD_HANA_WRITE", "STG_DB_FRESH", "OSD_BIND", "STG_TABLE_PROXY", "STG_RFC_PROXY", "HANA_OWN_SCHEMA"]) delete env[name];
  Object.assign(env, {HANA_EXISTING_SCHEMA: "1", OSD_CLIENT: "100", HANA_SCHEMA: "OSDH5XTENANT", OSD_OUTPUT: output});
  const lines = [];
  host = spawn(process.execPath, [resolve(root, "tools", "hana-serve.mjs"), "--port", "0",
    "--client-module", "test/fixtures/hana-serve/twin-client.mjs",
    "--register", "ZOSD_H5X_APP_SRV=ZCL_OSD_H5X_APP_MPC,ZCL_OSD_H5X_DPC"], {cwd: root, env, stdio: ["ignore", "pipe", "pipe"]});
  base = await new Promise((done, fail) => {
    const take = (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line === "") continue;
        lines.push(line);
        const m = /listening on (http:\/\/\S+?)\/sap\/opu\/odata\//.exec(line);
        if (m) done(m[1]);
      }
    };
    host.stdout.on("data", take);
    host.stderr.on("data", take);
    host.on("exit", (code) => fail(new Error(`hana-serve exited ${code} before listening:\n${lines.join("\n")}`)));
  });
});

test.afterAll(async () => {
  if (host === undefined || host.exitCode !== null) return;
  const gone = new Promise((done) => host.once("exit", done));
  host.kill("SIGTERM");
  await gone;
});

/** every request to the service, batch parts unpacked, and every failure */
function recorder(page) {
  const batches = [];
  const singles = [];
  const failed = [];
  page.on("request", (req) => {
    if (!req.url().includes(want.service)) return;
    if (/\/\$batch(\?|$)/.test(req.url())) {
      const body = req.postData() ?? "";
      // a request line of a part: method, URL, version
      const parts = [...body.matchAll(/^([A-Z]+) (\S+) HTTP\/1\.1\r?$/gm)].map((m) => ({method: m[1], url: decodeURIComponent(m[2])}));
      batches.push({method: req.method(), parts, changeset: /content-type:\s*multipart\/mixed;\s*boundary=changeset/i.test(body)});
    } else {
      singles.push({method: req.method(), url: decodeURIComponent(req.url())});
    }
  });
  page.on("response", async (res) => {
    // the service's answers only: UI5 probes optional files of the app
    // (i18n_en.properties, changes bundles) and takes a 404 as "none"
    if (!res.url().includes(want.service)) return;
    if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
    if (/\/\$batch(\?|$)/.test(res.url())) {
      const text = await res.text().catch(() => "");
      for (const m of text.matchAll(/HTTP\/1\.1 (\d{3})[^\r\n]*/g)) {
        if (Number(m[1]) >= 400) failed.push(`${m[0]} in a $batch part: ${text.slice(m.index, m.index + 300)}`);
      }
    }
  });
  return {batches, singles, failed, parts: () => batches.flatMap((b) => b.parts)};
}

// a data row of a ResponsiveTable (its header row carries sapMListTblRow too)
const ROW = "tr.sapMListTblRow:not(.sapMListTblHeader)";
const table = (page) => page.locator("table").filter({has: page.locator(ROW), visible: true}).first();

/** the visible header texts and the rows of the first visible table that has rows */
async function readTable(page, scope) {
  const t = scope ?? table(page);
  const headers = (await t.locator("th").filter({visible: true}).allInnerTexts()).map((s) => s.trim()).filter((s) => s !== "");
  const rows = [];
  for (const row of await t.locator(ROW).all()) {
    const cells = (await row.locator("td.sapMListTblCell").allInnerTexts()).map((s) => s.trim());
    rows.push(cells);
  }
  return {headers, rows};
}

/** the rows as rendered, every row checked to carry exactly `width` cells
 *  (ResponsiveTable renders one td per column, in LineItem order): a column
 *  nobody expected, or one missing, is a failure and not a slice */
function cellsOf(rows, width) {
  for (const [i, row] of rows.entries()) expect(row.length, `row ${i + 1} has ${row.length} cells, expected ${width}: ${JSON.stringify(row)}`).toBe(width);
  return rows;
}

test("the read-only app: list, sort, filter, object page, sub-list -- every read a GET in a $batch", async ({page}) => {
  // 0. the labels are the service's, not the app's: each header is a
  //    sap:label of $metadata and is written in none of the app's files
  const metadata = await (await page.request.get(`${base}${want.service}$metadata`)).text();
  const labels = [...want.list.headers, ...(want.object.subHeaders ?? [])];
  for (const label of labels) expect(metadata, `sap:label="${label}" in $metadata`).toContain(`sap:label="${label}"`);
  for (const file of want.appFiles ?? []) {
    const answer = await page.request.get(`${base}${file}`);
    expect(answer.status(), file).toBe(200);
    const text = await answer.text();
    for (const label of labels) expect(text.includes(label), `${file} must not carry the label "${label}"`).toBe(false);
  }

  const net = recorder(page);
  await page.goto(`${base}${appPath}`);

  // 1. the list: the headers and every row, in order
  await expect(table(page).locator(ROW).first()).toBeVisible();
  await expect(table(page).locator(ROW)).toHaveCount(want.list.rows.length);
  const list = await readTable(page);
  const width = want.list.headers.length;
  // exactly these headers, in this order: an extra column is a failure
  expect(list.headers).toEqual(want.list.headers);
  expect(cellsOf(list.rows, width)).toEqual(want.list.rows);
  if (want.list.count !== undefined) {
    // the inline count the table shows in its title: "(6)"
    await expect(page.getByText(`(${want.list.count})`, {exact: false}).first()).toBeVisible();
  }

  // 2. a sort the user makes: the column header's menu, Ascending or Descending
  await table(page).locator("th").filter({hasText: want.sort.header}).first().click();
  const direction = want.sort.descending ? "Descending" : "Ascending";
  await page.getByRole("button", {name: `Sort By: ${want.sort.header} ${direction}`}).click();
  await expect(table(page).locator(ROW).first()).toContainText(want.sort.firstRow[1]);
  const sorted = await readTable(page);
  expect(cellsOf(sorted.rows, width)[0]).toEqual(want.sort.firstRow);
  const sortPart = net.parts().find((p) => p.url.includes(`$orderby=${want.sort.property}${want.sort.descending ? " desc" : ""}`));
  expect(sortPart, net.parts().map((p) => p.url).join("\n")).toBeDefined();

  // 3. a filter the user makes, and the rows it gives
  const field = page.getByLabel(new RegExp(`^${want.filter.label}`)).first();
  await field.fill(want.filter.value);
  await field.press("Enter");
  await expect(table(page).locator(ROW)).toHaveCount(want.filter.rows.length);
  const filtered = await readTable(page);
  expect(cellsOf(filtered.rows, width)).toEqual(want.filter.rows);
  expect(net.parts().some((p) => p.url.includes("$filter=") && p.url.includes(want.filter.property)), net.parts().map((p) => p.url).join("\n")).toBe(true);

  // 4. the object page of the first row, and its sub-list through the navigation
  const first = table(page).locator(ROW).first();
  await first.focus();
  await page.keyboard.press("Enter");
  // the object page is open (its route), and its header is this entity:
  // the title text alone would also match the list's cell behind it
  await expect(page).toHaveURL(/#\/\w+\(.+\)/);
  await expect(page.getByRole("heading", {name: want.object.title, exact: true}).filter({visible: true}).first()).toBeVisible();
  for (const text of want.object.fields ?? []) await expect(page.getByText(text, {exact: true}).filter({visible: true}).first()).toBeVisible();
  const subTable = page.locator("section, .sapUxAPObjectPageSection").filter({has: page.locator(ROW)}).locator("table").filter({visible: true}).last();
  await expect(subTable.locator(ROW)).toHaveCount(want.object.subRows.length);
  const sub = await readTable(page, subTable);
  if (want.object.subHeaders) expect(sub.headers).toEqual(want.object.subHeaders);
  expect(cellsOf(sub.rows, want.object.subRows[0].length)).toEqual(want.object.subRows);
  expect(net.parts().some((p) => p.url.includes(`/${want.object.navigation}`)), net.parts().map((p) => p.url).join("\n")).toBe(true);

  // 5. the wire: batches were sent, every part a GET and no changeset; no
  //    read went around the batch; nothing failed
  expect(net.batches.length, "no $batch was sent: is useBatch on?").toBeGreaterThan(0);
  for (const batch of net.batches) {
    expect(batch.method).toBe("POST");
    expect(batch.changeset).toBe(false);
    expect(batch.parts.length).toBeGreaterThan(0);
    for (const part of batch.parts) expect(part.method, part.url).toBe("GET");
  }
  const reads = net.singles.filter((r) => !/\$metadata/.test(r.url));
  expect(reads.filter((r) => r.method !== "HEAD"), "only $metadata and a token fetch go outside the batch").toEqual([]);
  expect(net.failed, net.failed.join("\n")).toEqual([]);

  // 6. a read-only app offers no write
  for (const name of ["Create", "Edit", "Delete"]) await expect(page.getByRole("button", {name, exact: true}).filter({visible: true})).toHaveCount(0);
});
