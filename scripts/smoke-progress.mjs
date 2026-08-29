/**
 * Checks the weak-area dashboard against the built static export.
 *
 *   npm run build && npx serve out -l 3222
 *   node scripts/smoke-progress.mjs [baseUrl]
 *
 * The page crosses CBSE marks weightage against per-chapter confidence, so the
 * things worth proving in a browser are that the weightage renders with no
 * revision history at all, that each subject's units still sum to the marks
 * CBSE gives it, and that scoring a paper actually moves the ranking.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3222";
const syllabus = JSON.parse(readFileSync("data/syllabus.json", "utf8"));
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

  // --- the cold-start case ------------------------------------------------
  // A student who has never practised must still get the official weightage;
  // an empty dashboard would waste the one thing that needs no history.
  await page.goto(`${BASE}/progress/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const cold = (await page.textContent("body")) ?? "";

  check(
    "weightage shows before anything has been tested",
    /marks/.test(cold) && !/Working out where your marks are/.test(cold),
    "renders without revision history",
  );

  // Every unit name in the data should be reachable on the page for at least
  // one subject; spot-check the first mapped subject rather than all eight.
  const subject = syllabus.subjects.find((s) => s.units.some((u) => u.chapters.length > 0));
  check("a mapped subject exists in the syllabus data", !!subject,
    subject ? `class ${subject.class} ${subject.subject}` : "none mapped");

  if (subject) {
    const shown = subject.units.filter((u) => cold.includes(u.name)).length;
    check(
      "its units are listed on the page",
      shown === subject.units.length,
      `${shown}/${subject.units.length} unit names found`,
    );

    const sum = subject.units.reduce((n, u) => n + u.marks, 0);
    check(
      "unit marks sum to the subject total",
      sum === subject.totalMarks,
      `${sum} vs ${subject.totalMarks}`,
    );
  }

  // --- with revision history ----------------------------------------------
  // Seed a shaky chapter directly so the dashboard's ranking can be checked
  // without sitting a three-hour paper first.
  await page.evaluate(async () => {
    // Open at whatever version Dexie already created; naming a version here
    // would be rejected as a downgrade.
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open("ncert-revision");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const now = Date.now();
    const tx = db.transaction("cards", "readwrite");
    const store = tx.objectStore("cards");
    // Class 10 Science, chapter 1 — dropped outright, so its marks are at risk.
    store.put({
      id: "paper:seed:1", sourceType: "paper", sourceId: "seed",
      subject: "Science", classNum: 10, bookCode: "jesc1", chapter: 1,
      questionNo: 1, maxMarks: 5, lastScore: 0,
      ease: 1.3, interval: 1, repetitions: 0, dueAt: now, createdAt: now,
    });
    await new Promise((res) => (tx.oncomplete = res));
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const warm = (await page.textContent("body")) ?? "";

  check("a shaky chapter produces a study-next recommendation",
    /Study next:/.test(warm),
    warm.match(/Study next:[^.]*\./)?.[0]?.slice(0, 90) ?? "absent");

  check("marks at risk are reported against the unit total",
    /\d+ of \d+ marks at risk/.test(warm),
    warm.match(/\d+ of \d+ marks at risk/)?.[0] ?? "absent");

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
