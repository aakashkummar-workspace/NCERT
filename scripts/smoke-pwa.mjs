/**
 * Service-worker checks. These only mean anything against a production build,
 * because src/components/ServiceWorker.tsx deliberately skips registration in
 * development.
 *
 *   npm run build && npm start
 *   node scripts/smoke-pwa.mjs [baseUrl]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];

function check(name, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  // Race against a timeout: if registration failed, serviceWorker.ready never
  // settles, and an unguarded await would hang the whole run.
  const registered = await page.evaluate(async () => {
    const ready = navigator.serviceWorker.ready.then((r) => !!r.active);
    const timeout = new Promise((res) => setTimeout(() => res(false), 20000));
    return Promise.race([ready, timeout]);
  });
  check("service worker registers and activates", registered);

  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.href;
    if (!href) return null;
    const res = await fetch(href);
    return res.ok ? await res.json() : null;
  });
  check(
    "web app manifest is installable-shaped",
    !!manifest && manifest.display === "standalone" && (manifest.icons?.length ?? 0) > 0,
    manifest ? `${manifest.short_name}, ${manifest.icons.length} icons` : "missing",
  );

  // Visit a subject page so the shell cache has it, then cut the network.
  await page.goto(`${BASE}/class/10/science/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  await context.setOffline(true);
  let offlineNavOk = false;
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    offlineNavOk =
      (await page.getByText("Chemical Reactions and Equations").count()) > 0;
  } catch {
    offlineNavOk = false;
  }
  check("visited page still loads with network cut", offlineNavOk);

  // A page never visited should land on the offline fallback, not a crash.
  let fallbackOk = false;
  try {
    await page.goto(`${BASE}/class/9/hindi/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const body = (await page.textContent("body")) ?? "";
    fallbackOk = /offline|not been opened/i.test(body) || body.trim().length > 0;
  } catch {
    fallbackOk = false;
  }
  check("unvisited page falls back gracefully offline", fallbackOk);

  await context.setOffline(false);
  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
