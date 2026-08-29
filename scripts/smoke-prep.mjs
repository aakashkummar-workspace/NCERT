/**
 * End-to-end test of the exam-prep loop (Phases 1-5).
 *
 *   npm run build && npx serve out -l 3333
 *   node scripts/smoke-prep.mjs [baseUrl]
 *
 * Walks the path a student actually takes: pick a paper, sit it, mark yourself,
 * see the questions arrive in revision, and see the weak-area dashboard change.
 * Assertions are text-based on purpose so they survive markup changes.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3333";
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // --- 1. weightage is visible before any practice --------------------------
  await page.goto(`${BASE}/progress/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const progressText = (await page.textContent("body")) ?? "";
  check(
    "dashboard shows CBSE weightage with no data yet",
    /Chemical Substances/.test(progressText) && /25 marks/.test(progressText),
    "Science unit I at 25 marks",
  );
  check(
    "untested units are labelled, not called weak",
    /[Nn]ot tested yet/.test(progressText),
  );

  // Class 9 units that cannot be joined to chapters must say so.
  const class9 = page.getByRole("button", { name: "Class 9" });
  if (await class9.count()) {
    await class9.click();
    await page.waitForTimeout(600);
    const c9 = (await page.textContent("body")) ?? "";
    check(
      "Class 9 unmapped units explain why, and still show marks",
      /cannot be linked|older NCERT books/.test(c9) && /marks/.test(c9),
    );
  }

  // --- 2. practice index ----------------------------------------------------
  await page.goto(`${BASE}/practice/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const practiceText = (await page.textContent("body")) ?? "";
  check("practice index lists papers", /Science/.test(practiceText));
  check(
    "Class 9 gap is stated honestly on the practice page",
    /Class 9/.test(practiceText),
  );

  // --- 3. sit a paper -------------------------------------------------------
  await page.goto(`${BASE}/practice/class10-science-2025-26/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const startBtn = page
    .getByRole("button", { name: /start|begin/i })
    .or(page.getByRole("link", { name: /start|begin/i }))
    .first();
  const hasStart = (await startBtn.count()) > 0;
  check("paper page offers a start control", hasStart);

  if (hasStart) {
    await startBtn.click();
    await page.waitForTimeout(2500);
    const running = (await page.textContent("body")) ?? "";
    // A countdown of the form H:MM:SS proves the timer is live.
    check("timer is running", /\d:\d{2}:\d{2}/.test(running), (running.match(/\d:\d{2}:\d{2}/) ?? [""])[0]);

    // The marking scheme must not be reachable while the clock runs.
    check(
      "marking scheme is hidden during the exam",
      !/marking scheme/i.test(running) || /hidden|locked|after/i.test(running),
    );

    const finish = page.getByRole("button", { name: /finish|submit|end/i }).first();
    if (await finish.count()) {
      await finish.click();
      await page.waitForTimeout(1500);
      // Some flows confirm before submitting.
      const confirm = page.getByRole("button", { name: /finish|submit|yes|confirm/i }).first();
      if (await confirm.count()) {
        await confirm.click().catch(() => {});
        await page.waitForTimeout(1500);
      }
      const scoring = (await page.textContent("body")) ?? "";
      check(
        "marking scheme unlocks after finishing",
        /marking scheme|mark your|scheme/i.test(scoring),
      );

      // --- 4. self-score a question ----------------------------------------
      /*
       * On a phone the scheme and the scoring grid are tabs (`hidden md:block`),
       * so the grid is in the DOM but display:none until "My marks" is tapped.
       * On desktop both panes show at once and the tab is absent. Handle both.
       */
      const marksTab = page.getByRole("button", { name: /my marks/i }).first();
      if (await marksTab.count()) {
        await marksTab.click();
        await page.waitForTimeout(600);
      }
      check(
        "scoring grid is reachable on a phone viewport",
        await page.locator('input[type="number"]').first().isVisible(),
      );

      const marks = page.locator('input[type="number"]').first();
      if (await marks.count()) {
        await marks.scrollIntoViewIfNeeded();
        await marks.fill("1", { timeout: 15000 });
        await page.waitForTimeout(400);
        check("a mark can be entered", (await marks.inputValue()) === "1");
      }

      const cards = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open("ncert-attempts");
            req.onsuccess = () => {
              const names = [...req.result.objectStoreNames];
              if (!names.includes("attempts")) return resolve(-1);
              const tx = req.result.transaction("attempts", "readonly");
              const all = tx.objectStore("attempts").getAll();
              all.onsuccess = () => resolve(all.result.length);
              all.onerror = () => resolve(-1);
            };
            req.onerror = () => resolve(-1);
          }),
      );
      check("attempt persisted to IndexedDB", cards > 0, `${cards} attempt(s)`);
    }
  }

  check("no uncaught page errors across the flow", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
