/**
 * Regression test for the defect that made the weak-area dashboard inert.
 *
 * `chapterConfidence()` drops any card lacking `bookCode` + `chapter`. For a
 * while the only writer of cards was src/lib/attempts.ts, which cannot supply
 * either — CBSE paper questions carry no chapter tag. So /progress was stuck on
 * "Not tested yet" permanently, and every existing suite passed straight over
 * it because they only ever asserted the empty state.
 *
 * This test drives the real UI write path, deliberately: seeding a card into
 * IndexedDB (as scripts/smoke-progress.mjs does) proves the *render* works but
 * would not have caught this bug, because seeding bypasses the broken step.
 *
 *   npm run build && npx serve out -l 3555
 *   node scripts/smoke-rating.mjs [baseUrl]
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3555";
const results = [];

function check(name, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const progressText = async (page) => {
  await page.goto(`${BASE}/progress/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  return (await page.textContent("body")) ?? "";
};

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const before = await progressText(page);
  check("baseline: nothing tested", /Not tested yet/.test(before));

  // --- the chapter list ----------------------------------------------------
  await page.goto(`${BASE}/class/10/science/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const list = (await page.textContent("body")) ?? "";
  check(
    "chapter rows show what the chapter is worth",
    /~?\s*[\d.]+\s*marks?/i.test(list),
    (list.match(/~?\s*[\d.]+\s*marks?/i) ?? ["none"])[0],
  );

  // The control is collapsed behind a trigger on a narrow screen.
  const trigger = page.getByRole("button", { name: /rate|how well|know this/i }).first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForTimeout(500);
  }
  // The accessible name is the label plus its hint ("Goodsolid"), so anchor at
  // the start only — an exact match never fires.
  const good = page.getByRole("button", { name: /^good/i }).first();
  const canRate = (await good.count()) > 0;
  check("a chapter can be rated", canRate);

  if (canRate) {
    await good.click();
    await page.waitForTimeout(1200);

    // The specific field pair whose absence caused the defect.
    const card = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("ncert-revision");
          req.onsuccess = () => {
            if (![...req.result.objectStoreNames].includes("cards")) return resolve(null);
            const all = req.result.transaction("cards", "readonly").objectStore("cards").getAll();
            all.onsuccess = () =>
              resolve(all.result.find((c) => c.bookCode && c.chapter !== undefined) ?? null);
            all.onerror = () => resolve(null);
          };
          req.onerror = () => resolve(null);
        }),
    );
    check(
      "rating writes a chapter-tagged card",
      card !== null,
      card ? `${card.bookCode} ch.${card.chapter}` : "no card carried bookCode + chapter",
    );

    const after = await progressText(page);
    const litUp = /% confident/.test(after) || /marks at risk/.test(after);
    check(
      "dashboard reflects the rating (the whole point)",
      litUp,
      litUp
        ? (after.match(/\d+% confident[^.]{0,40}/) ?? ["yes"])[0]
        : "still stuck on 'Not tested yet'",
    );
  }

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
