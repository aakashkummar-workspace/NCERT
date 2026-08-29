/**
 * End-to-end check of practice mode (Tier 1) against the built static export.
 *
 *   npm run build && npx serve out -l 3222
 *   node scripts/smoke-practice.mjs [baseUrl]
 *
 * Covers the things only a real browser can prove: that the marking scheme is
 * genuinely not fetched while the clock is running, that the countdown survives
 * a reload without restarting, that self-scored marks reach IndexedDB, and that
 * scoring a paper puts cards into the revision queue.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3222";
const SLUG = "class10-science-2025-26";
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

  // Every PDF the page asks for, so "the scheme stays locked" can be asserted
  // against the network rather than against what is on screen.
  const pdfRequests = [];
  page.on("request", (r) => {
    if (r.url().endsWith(".pdf")) pdfRequests.push(r.url());
  });

  // --- the list -----------------------------------------------------------
  await page.goto(`${BASE}/practice/`, { waitUntil: "networkidle" });
  const paperLinks = await page.locator('a[href*="/practice/class10-"]').count();
  check("practice page lists mirrored papers", paperLinks >= 3, `${paperLinks} links`);

  // --- pre-flight ---------------------------------------------------------
  await page.goto(`${BASE}/practice/${SLUG}/`, { waitUntil: "networkidle" });
  const body = () => page.textContent("body");
  const preflight = (await body()) ?? "";
  check(
    "pre-flight states marks, questions and duration",
    /80/.test(preflight) && /39/.test(preflight) && /3 hours/.test(preflight),
    "80 marks · 39 questions · 3 hours",
  );

  // --- running ------------------------------------------------------------
  await page.getByRole("button", { name: /^Start —/ }).click();
  await page.waitForTimeout(2500);

  const clock = await page.locator("text=/[0-9]:[0-5][0-9]:[0-5][0-9]/").first().textContent();
  check("timer starts near the full duration", /^2:59:5[0-9]$/.test(clock?.trim() ?? ""), clock?.trim());

  const schemeFetched = pdfRequests.some((u) => u.includes("-ms.pdf"));
  check("marking scheme is not fetched while the clock runs", !schemeFetched,
    schemeFetched ? "scheme PDF was requested" : `${pdfRequests.length} pdf request(s), none the scheme`);

  const paperFetched = pdfRequests.some((u) => u.includes("-sqp.pdf"));
  check("question paper renders during the exam", paperFetched);

  // A reload mid-exam must resume the same clock, not start a new one: the
  // countdown is derived from a persisted wall-clock timestamp.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const afterReload = (await page.textContent("body")) ?? "";
  const resumed = /2:5[0-9]:[0-5][0-9]/.test(afterReload);
  check("reload mid-exam resumes the same clock", resumed && !/^3:00:00/.test(afterReload));

  // A reload deliberately lands back on pre-flight offering Resume, so a
  // running clock is never silently restarted — the student taps to go back in.
  const resume = page.getByRole("button", { name: "Resume" });
  check("a reloaded exam offers Resume rather than restarting", (await resume.count()) > 0);
  if (await resume.count()) {
    await resume.click();
    await page.waitForTimeout(1500);
  }

  // --- scoring ------------------------------------------------------------
  await page.getByRole("button", { name: "Submit and score" }).click();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await page.waitForTimeout(2000);

  // On a 412px viewport the scoring pane is behind the "My marks" toggle.
  const marksToggle = page.getByRole("button", { name: "My marks" });
  if (await marksToggle.count()) await marksToggle.click();
  await page.waitForTimeout(500);

  const inputs = page.locator('input[type="number"]');
  const rows = await inputs.count();
  check("scoring grid has one row per question", rows === 39, `${rows} rows`);

  const schemeNowFetched = pdfRequests.some((u) => u.includes("-ms.pdf"));
  check("marking scheme unlocks on submit", schemeNowFetched);

  // Score three questions: full, partial, zero.
  await inputs.nth(0).fill("1");
  await inputs.nth(9).fill("1");
  await inputs.nth(38).fill("0");
  await page.waitForTimeout(800);

  const stored = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open("ncert-attempts");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const all = await new Promise((res, rej) => {
      const req = db.transaction("attempts").objectStore("attempts").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const a = all[0];
    return a ? { status: a.status, scored: a.scores.filter((s) => s.score !== null).length } : null;
  });
  check("marks are written to IndexedDB as they are entered",
    !!stored && stored.scored === 3 && stored.status === "submitted",
    stored ? `${stored.scored} scored, ${stored.status}` : "no attempt row");

  // Marks are saved without being awaited, so several writes can be in flight at
  // once. Enter every mark in one tick — the worst case a slow phone produces —
  // and check none was lost: a read-modify-write of the whole record would let
  // the last write erase the rest while the UI still showed them as saved.
  const race = await page.evaluate(async () => {
    const fields = [...document.querySelectorAll('input[type="number"]')];
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    for (const el of fields) {
      setter.call(el, "1");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 3000));

    const db = await new Promise((res, rej) => {
      const req = indexedDB.open("ncert-attempts");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const all = await new Promise((res, rej) => {
      const req = db.transaction("attempts").objectStore("attempts").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const a = all.sort((x, y) => y.startedAt - x.startedAt)[0];
    return { typed: fields.length, kept: a.scores.filter((s) => s.score !== null).length };
  });
  check(
    "concurrent mark entry loses nothing",
    race.kept === race.typed,
    `${race.kept}/${race.typed} persisted`,
  );

  // Put one question back to zero: a dropped question is what proves the card
  // it creates is scheduled to come back soonest.
  await inputs.nth(38).fill("0");
  await page.waitForTimeout(600);

  await page.getByRole("button", { name: "Finish scoring" }).click();
  await page.waitForTimeout(1500);
  const done = (await page.textContent("body")) ?? "";
  // 38 questions at one mark, plus the one deliberately dropped to zero.
  check(
    "summary reports the total",
    /\b38\b/.test(done) && /80/.test(done),
    done.match(/\b38\b[^.]{0,20}80/)?.[0] ?? "38 of 80",
  );

  // --- revision -----------------------------------------------------------
  await page.goto(`${BASE}/revise/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const revise = (await page.textContent("body")) ?? "";
  // SM-2 puts a freshly scored question at least a day out, so the queue is
  // correctly empty here — what matters is that it says the cards exist rather
  // than telling a student who just marked a paper that they have never sat one.
  check(
    "revision reports the cards scheduled by scoring",
    /39 cards are waiting/.test(revise) && /due tomorrow/.test(revise),
    revise.match(/\d+ cards? (is|are) waiting[^.]*\./)?.[0] ?? "not reported",
  );

  const cards = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open("ncert-revision");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return new Promise((res, rej) => {
      const req = db.transaction("cards").objectStore("cards").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  });
  check("one card per scored question, tagged to the paper", cards.length === 39,
    `${cards.length} cards, sources ${[...new Set(cards.map((c) => c.sourceId))].join(",")}`);

  const dropped = cards.find((c) => c.lastScore === 0);
  check("a dropped question is scheduled to come back", !!dropped && dropped.interval <= 1,
    dropped ? `interval ${dropped.interval}d, ease ${dropped.ease.toFixed(2)}` : "none");

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
