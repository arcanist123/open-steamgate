// The launchpad is the public entry point for the local applications.  Keep
// the route list and the browser assertions in one place so the Node server
// and the static Pages build exercise the same user journey.

import {identity} from "../../tools/osd-identity.mjs";

// the system id the server (and the preview, at build) took from the one
// identity: OSD_SID, its alias STG_ADT_SID, else OSD
const SID = identity().sid;

const CORE_APPS = [
  {
    title: "Travels",
    intent: "Travel-manage",
    ready: (page) => page.getByText("Berlin to Copenhagen").first(),
  },
  {
    title: "Bookings",
    intent: "Booking-display",
    ready: (page) => page.getByText("Ada Lovelace").first(),
  },
  {
    title: "Flight analytics",
    intent: "Flight-analyze",
    ready: (page) => page.getByText("SQ").first(),
  },
  {
    title: "NYC taxi analytics",
    intent: "Taxi-analyze",
    ready: (page) => page.getByText("Manhattan").first(),
  },
  {
    title: "SEGW",
    intent: "SegwProject-manage",
    ready: (page) => page.getByText("Entity Types").first(),
  },
  {
    title: "ICF services",
    intent: "IcfNode-manage",
    ready: (page) => page.getByText("ICF nodes").first(),
  },
  {
    title: "System status",
    intent: "System-status",
    ready: (page) => page.locator(".sapMListTblRow", {hasText: SID}).first(),
  },
];

function quoteRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The launchpad tile whose target is `intent` ("Travel-manage"), and only that
 * one.  A tile is picked by where it goes, not by its title: a title match is
 * a prefix or substring match, and "Travels" also matched the V4 app's tile.
 * The sandbox renders each tile's content asynchronously, so `.first()` over
 * both landed on whichever had rendered first and opened #TravelV4-manage now
 * and then.  `$=` on the href is exact: "#Travel-manage" is not a suffix of
 * "#TravelV4-manage", and the prefix (origin, Pages mount, query) is free.
 */
function launchpadTile(page, intent) {
  return page.locator(".sapUshellTile", {has: page.locator(`a[href$="#${intent}"]`)});
}

/**
 * Register the same launchpad smoke checks for either hosting shape.
 *
 * `openLaunchpad` owns the host-specific setup (the Node server can navigate
 * directly, while Pages must first give its service worker control).  A
 * caller may provide a persistent-context fixture as `pageFixture`; this is
 * useful for browsers that do not retain service-worker storage in an
 * ephemeral Playwright context.
 */
export function registerLaunchpadNavigationTests({test, expect, openLaunchpad, pageFixture = "page"}) {
  const run = async (page, app) => {
    await openLaunchpad(page);

    const tile = launchpadTile(page, app.intent);
    await expect(tile).toBeVisible({timeout: 60_000});
    await expect(tile).toContainText(app.title);
    await tile.click();

    await expect(page).toHaveURL(new RegExp(`#${quoteRegExp(app.intent)}(?:$|[?&])`), {timeout: 60_000});
    await expect(page.locator("body")).not.toContainText("could not be loaded", {timeout: 60_000});
    await expect(app.ready(page)).toBeVisible({timeout: 60_000});
    if (app.intent === "IcfNode-manage") {
      const node = page.locator("tr.sapMListTblRow", {hasText: "/sap/bc/apc/sap/zapc_zork/"});
      await expect(node).toBeVisible();
      await node.click();
      const apc = page.getByRole("region", {name: "WebSocket (APC)", exact: true});
      await expect(apc.getByText("ZCL_APC_ZORK", {exact: true})).toBeVisible();
      await expect(apc.getByText("Implementation class", {exact: true})).toBeVisible();
    }
  };

  for (const app of CORE_APPS) {
    if (pageFixture === "page") {
      test(`launchpad: opens the ${app.title} application`, async ({page}) => run(page, app));
    } else {
      test(`launchpad: opens the ${app.title} application`, async ({launchpadPage}) => run(launchpadPage, app));
    }
  }
}

export {CORE_APPS, launchpadTile};
