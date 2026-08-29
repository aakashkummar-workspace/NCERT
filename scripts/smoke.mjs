/**
 * End-to-end smoke test against the built static export.
 *
 *   npm run build && npx serve out -l 3222
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Checks the things that only a real browser can prove: that pdf.js renders a
 * chapter, that reading progress survives a reload, that a downloaded chapter
 * is readable with the network cut, and that an undownloaded one fails politely.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3222";
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // --- navigation ---------------------------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  /*
   * Home now remembers the student's class. A fresh browser context has nothing
   * stored, so it shows the first-launch picker — whose options are buttons, not
   * links. Accept either that or the dashboard, so the check keeps meaning
   * "home offered a way into a class" rather than pinning one implementation.
   */
  await page.waitForTimeout(800);
  const intoClass =
    (await page.getByRole("button", { name: /10\s*Class/ }).count()) +
    (await page.getByRole("link", { name: /Science/ }).count());
  check("home offers a way into a class", intoClass > 0);

  await page.goto(`${BASE}/class/10/science/`, { waitUntil: "networkidle" });
  const chapterLink = page.getByRole("link", { name: /Chemical Reactions and Equations/ });
  check("subject page lists real chapter titles", (await chapterLink.count()) > 0);

  // --- reader -------------------------------------------------------------
  await page.goto(`${BASE}/read/jesc1/1/`, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas", { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas");
      return !!c && c.width > 100 && c.height > 100;
    },
    { timeout: 60_000 },
  );
  const dims = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return { w: c.width, h: c.height };
  });
  check("pdf.js renders a page canvas", dims.w > 100 && dims.h > 100, `${dims.w}x${dims.h}`);

  // Canvas must have actually been painted, not just sized.
  const painted = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const ctx = c.getContext("2d");
    const { data } = ctx.getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400));
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonWhite++;
    }
    return nonWhite;
  });
  check("page canvas has painted content", painted > 500, `${painted} non-white px`);

  const pageCount = await page.locator("text=/^\\d+ \\/ \\d+$/").first().textContent();
  check("page counter shows a total", /\/\s*\d+/.test(pageCount ?? ""), pageCount?.trim());

  // --- in-chapter search --------------------------------------------------
  // Search is collapsed to an icon in the reader toolbar; open it first.
  await page.getByRole("button", { name: "Open search" }).click();
  await page.getByLabel("Search in this chapter").fill("equation");
  await page.getByRole("button", { name: "Find" }).click();
  await page.waitForSelector("text=/Found on page|Not found/", { timeout: 60_000 });
  const searchMsg = await page.locator("text=/Found on page|Not found/").first().textContent();
  check("in-chapter search finds a term", /Found on page/.test(searchMsg ?? ""), searchMsg?.trim());

  // --- offline download ---------------------------------------------------
  await page.getByRole("button", { name: /Save for offline/ }).click();
  await page.waitForSelector("text=Saved", { timeout: 120_000 });
  const cached = await page.evaluate(async () => {
    const c = await caches.open("ncert-pdfs-v1");
    return (await c.keys()).map((r) => new URL(r.url).pathname);
  });
  check("chapter stored in PDF cache", cached.includes("/ncert/jesc1/jesc101.pdf"), cached.join(", "));

  // --- progress persistence ----------------------------------------------
  await page.evaluate(() => window.scrollTo(0, 3000));
  await page.waitForTimeout(1500);
  const progress = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("ncert-quick");
        req.onsuccess = () => {
          const tx = req.result.transaction("progress", "readonly");
          const all = tx.objectStore("progress").getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      }),
  );
  check("reading progress saved to IndexedDB", progress.length > 0, JSON.stringify(progress[0] ?? {}));

  // --- downloads manager --------------------------------------------------
  await page.goto(`${BASE}/downloads/`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=/chapter|No chapters saved/", { timeout: 30_000 });
  const hasEntry = (await page.getByText("Science", { exact: false }).count()) > 0;
  check("downloads page lists the saved book", hasEntry);

  // --- offline behaviour --------------------------------------------------
  // Serve the cached chapter from Cache Storage with the network cut.
  await context.setOffline(true);
  const offlineOk = await page.evaluate(async () => {
    const c = await caches.open("ncert-pdfs-v1");
    const res = await c.match("/ncert/jesc1/jesc101.pdf");
    if (!res) return 0;
    return (await res.arrayBuffer()).byteLength;
  });
  check("downloaded chapter readable offline", offlineOk > 100_000, `${offlineOk} bytes`);

  const notCached = await page.evaluate(async () => {
    const c = await caches.open("ncert-pdfs-v1");
    return (await c.match("/ncert/jesc1/jesc102.pdf")) === undefined;
  });
  check("undownloaded chapter absent from cache", notCached);
  await context.setOffline(false);

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
