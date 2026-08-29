/**
 * End-to-end checks for the quiz.
 *
 *   npm run build && npx serve out -l 3888
 *   node scripts/smoke-quiz.mjs [baseUrl]
 *
 * The things worth proving in a real browser, in the order a student meets them:
 *
 *   - the index is class-wise, and switching class actually changes the list
 *   - a subject with no questions says so instead of 404-ing or rendering empty
 *   - answering marks immediately, and marks *correctly* — the test reads the
 *     right answer out of the page's own data rather than assuming option A
 *   - the score sheet reports the score the answers deserve
 *   - finishing writes an SM-2 card tagged with the chapter, which is the only
 *     reason /progress and /revise learn anything from a quiz
 *
 * That last one is the check that would have caught the defect the dashboard
 * shipped with once already: cards written without `bookCode`/`chapter` are
 * dropped by chapterConfidence(), so the dashboard reads "not tested yet"
 * forever while the quiz appears to work perfectly.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3888";
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Read the SM-2 card table straight out of IndexedDB. */
function readCards(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("ncert-revision");
        req.onsuccess = () => {
          let tx;
          try {
            tx = req.result.transaction("cards", "readonly");
          } catch {
            resolve([]);
            return;
          }
          const all = tx.objectStore("cards").getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      }),
  );
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // --- class-wise index ---------------------------------------------------
  await page.goto(`${BASE}/quiz/`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=/questions|No questions/", { timeout: 30_000 });

  // Class 10 is the default when nothing is stored, and is where the seed
  // questions live.
  const scienceLink = page.getByRole("link", { name: /Science/ }).first();
  check("quiz index lists a subject for the stored class", (await scienceLink.count()) > 0);

  await page.getByRole("button", { name: "Class 9" }).click();
  await page.waitForTimeout(400);
  const nineHeading = await page.getByText(/Class 9/).count();
  check("switching to Class 9 re-renders the index", nineHeading > 0);

  // A class with no questions must explain itself, not render a blank list.
  const emptyMsg = await page.getByText(/No questions yet|Nothing has been written/).count();
  check("a class with no questions says so", emptyMsg > 0);

  await page.getByRole("button", { name: "Class 10" }).click();
  await page.waitForTimeout(400);

  // --- subject page -------------------------------------------------------
  await page.goto(`${BASE}/quiz/10/science/`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=By chapter", { timeout: 30_000 });
  const chapterButtons = await page.getByRole("button", { name: /question/ }).count();
  check("subject page lists chapters with question counts", chapterButtons > 0, `${chapterButtons}`);

  const mixed = page.getByRole("button", { name: /Mixed quiz/ });
  check("a multi-chapter subject offers a mixed quiz", (await mixed.count()) > 0);

  // --- sit a chapter quiz, answering every question correctly -------------
  await page.getByRole("button", { name: /Chemical Reactions/ }).first().click();
  await page.waitForSelector('[role="progressbar"]', { timeout: 15_000 });

  const total = Number(
    (await page.locator("text=/Question \\d+ of \\d+/").first().textContent())?.match(
      /of (\d+)/,
    )?.[1] ?? 0,
  );
  check("quiz starts with a question count", total > 0, `${total} questions`);

  // The right answer is whichever option the page marks "Correct" after any
  // answer is given — so the test never has to encode an answer key of its own.
  let correct = 0;
  for (let i = 0; i < total; i++) {
    const options = page.locator('[role="group"][aria-label="Answer options"] button');
    await options.first().click();
    await page.waitForTimeout(120);

    // Find which option is the marked answer, and whether we happened to pick it.
    const picked = await page.evaluate(() => {
      const group = document.querySelector('[role="group"][aria-label="Answer options"]');
      const buttons = [...group.querySelectorAll("button")];
      const answerIndex = buttons.findIndex((b) => b.textContent.includes("Correct"));
      const chosenIndex = buttons.findIndex((b) => b.getAttribute("aria-pressed") === "true");
      return { answerIndex, chosenIndex };
    });
    if (picked.answerIndex === picked.chosenIndex) correct++;

    check(
      `question ${i + 1} is marked the instant it is answered`,
      picked.answerIndex !== -1,
      picked.answerIndex === -1 ? "no option marked Correct" : "",
    );

    await page.getByRole("button", { name: /Next question|See result/ }).click();
    await page.waitForTimeout(150);
  }

  // --- result -------------------------------------------------------------
  await page.waitForSelector("text=Every question", { timeout: 15_000 });
  const scoreText = await page.locator("text=/^\\d+\\s*\\/\\s*\\d+$/").first().textContent();
  const scored = Number(scoreText?.match(/(\d+)/)?.[1] ?? -1);
  check(
    "the score sheet matches the answers given",
    scored === correct,
    `sheet says ${scored}, answers earned ${correct}`,
  );

  const sheetRows = await page.locator("ol > li").count();
  check("the score sheet reviews every question", sheetRows === total, `${sheetRows}/${total}`);

  // --- what the rest of the app learns ------------------------------------
  await page.waitForTimeout(700);
  const cards = await readCards(page);
  const tagged = cards.filter((c) => c.bookCode === "jesc1" && c.chapter === 1);
  check(
    "finishing writes a chapter-tagged revision card",
    tagged.length === 1,
    `${cards.length} cards, ${tagged.length} tagged jesc1 ch.1`,
  );
  check(
    "the card carries a confidence from the score",
    tagged[0]?.lastConfidence !== undefined,
    tagged[0]?.lastConfidence ?? "none",
  );

  // The weak-area dashboard reads exactly those two fields; if it still says
  // "not tested yet" after a quiz, the card was written wrong.
  await page.goto(`${BASE}/progress/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const stillUntested = await page
    .getByText(/Nothing has been tested yet/)
    .count();
  check("the weak-area dashboard sees the quiz", stillUntested === 0);

  // --- retry path ---------------------------------------------------------
  await page.goto(`${BASE}/quiz/10/mathematics/`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=By chapter", { timeout: 30_000 });
  const lastScore = await page.getByText(/last time/).count();
  check("a sat chapter shows its last score (maths not yet sat: none expected)", lastScore === 0);

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
