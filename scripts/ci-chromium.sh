#!/usr/bin/env bash
# Make Chromium usable for the Playwright jobs in CI (tests.yml e2e,
# preview.yml), without making apt the judge.
#
# 1. Download the browser from Playwright's CDN unless the cache restored
#    it (`playwright install chromium` does not touch apt).
# 2. Launch it. ubuntu-latest already carries the shared libraries Chromium
#    needs, so on the runner this normally passes and apt is never called.
# 3. Only if the launch fails: `playwright install-deps chromium` (apt),
#    retried with backoff, because the archive mirrors' DNS does fail for
#    hours at a time.
# 4. Launch again. That launch decides: a missing library still fails the
#    step, whatever apt's exit code was.
#
# Usage: scripts/ci-chromium.sh [cache-hit]   (cache-hit = "true" skips 1)
set -uo pipefail

cache_hit="${1:-false}"

smoke() {
  node -e '
    const { chromium } = require("@playwright/test");
    (async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      await page.setContent("<p id=x>ok</p>");
      const text = await page.textContent("#x");
      console.log("chromium " + browser.version() + " launched, page says " + text);
      await browser.close();
      if (text !== "ok") process.exit(1);
    })().catch(e => { console.error(String(e && e.message || e).split("\n").slice(0, 20).join("\n")); process.exit(1); });
  '
}

if [[ "$cache_hit" != true ]]; then
  ok=0
  for attempt in 1 2 3; do
    if npx playwright install chromium; then ok=1; break; fi
    echo "::warning::playwright install chromium failed (attempt $attempt)"
    sleep $((attempt * 15))
  done
  [[ $ok == 1 ]] || { echo "::error::could not download Chromium"; exit 1; }
fi

if smoke; then
  echo "Chromium launches with the runner's own libraries; apt not needed."
  exit 0
fi

echo "::warning::Chromium does not launch yet; installing system dependencies with apt."
for attempt in 1 2 3 4; do
  if npx playwright install-deps chromium; then break; fi
  echo "::warning::playwright install-deps failed (attempt $attempt)"
  [[ $attempt == 4 ]] || sleep $((attempt * 20))
done

# The launch decides, not apt's exit code.
if smoke; then
  exit 0
fi
echo "::error::Chromium still does not launch after installing system dependencies."
exit 1
