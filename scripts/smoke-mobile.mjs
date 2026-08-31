/**
 * Mobile UI standards, enforced as a test rather than left to taste.
 *
 * This app is used almost entirely on low-end Android phones, so the things
 * below are correctness issues, not polish:
 *
 *   - Tap targets. Apple's HIG minimum is 44x44pt, Material's is 48dp. Anything
 *     smaller is a mis-tap on a moving bus.
 *   - Truncated titles. A chapter's name is the whole reason a row exists; an
 *     ellipsis in the middle of it makes the list unusable.
 *   - Horizontal overflow. A page that pans sideways feels broken.
 *
 * A previous audit found 49 sub-40px controls and 5 truncated chapter titles on
 * one screen, none of which any existing suite noticed.
 *
 *   npm run build && npx serve out -l 3777
 *   node scripts/smoke-mobile.mjs [baseUrl]
 *
 * A preflight runs first and exits 3 without testing anything if the base URL is
 * not a live build of this app — see scripts/lib/preflight.mjs.
 */
import { chromium } from "playwright";
import { preflight } from "./lib/preflight.mjs";

const BASE = process.argv[2] ?? "http://localhost:3777";

/** Apple HIG minimum. Material's 48dp is stricter; 44 is the floor we enforce. */
const MIN_TAP = 44;

const SCREENS = [
  ["home", "/"],
  ["class", "/class/10/"],
  ["chapters", "/class/10/science/"],
  ["practice", "/practice/"],
  ["quiz", "/quiz/"],
  ["quiz-subject", "/quiz/10/science/"],
  ["progress", "/progress/"],
  ["revise", "/revise/"],
  ["downloads", "/downloads/"],
  ["bookmarks", "/bookmarks/"],
  ["reader", "/read/jesc1/1/"],
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function audit(page) {
  return page.evaluate((MIN) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };

    const small = [];
    for (const el of document.querySelectorAll("a,button,input,select,[role=button]")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // An inline text link inside a paragraph is held to line-height, not 44px;
      // only standalone controls are judged.
      const inProse = el.closest("p") !== null && el.tagName === "A";
      if (inProse) continue;
      if (r.height < MIN || r.width < MIN) {
        small.push(
          `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}] ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }

    // Any element whose text is clipped by an ellipsis.
    const truncated = [];
    for (const el of document.querySelectorAll("span,p,h1,h2,h3,a,div")) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow !== "ellipsis") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        truncated.push((el.textContent || "").trim().slice(0, 40));
      }
    }

    return {
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      small,
      truncated,
      hasTabBar: !!document.querySelector('nav[aria-label="Main"]'),
    };
  }, MIN_TAP);
}

async function main() {
  await preflight(BASE, "scripts/smoke-mobile.mjs");

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${e.message}`));

  let totalSmall = 0;
  let totalTruncated = 0;

  for (const [name, url] of SCREENS) {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    // The reader needs a moment for pdf.js to lay out its toolbar.
    await page.waitForTimeout(name === "reader" ? 3500 : 1200);

    const a = await audit(page);
    totalSmall += a.small.length;
    totalTruncated += a.truncated.length;

    check(`${name}: no horizontal overflow`, a.overflow === 0, `${a.overflow}px`);
    check(
      `${name}: all controls >= ${MIN_TAP}px`,
      a.small.length === 0,
      a.small.length ? `${a.small.length} small — e.g. ${a.small.slice(0, 2).join(", ")}` : "",
    );
    check(
      `${name}: no truncated text`,
      a.truncated.length === 0,
      a.truncated.length ? `${a.truncated.length} — e.g. "${a.truncated[0]}"` : "",
    );

    // The tab bar belongs everywhere except the reader, which is full-bleed and
    // has its own bottom toolbar; two stacked bars would eat the page.
    if (name === "reader") {
      check("reader: no tab bar (full-bleed reading)", !a.hasTabBar);
    } else {
      check(`${name}: tab bar present`, a.hasTabBar);
    }
  }

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} checks passed` +
      `   (${totalSmall} small tap targets, ${totalTruncated} truncated strings)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
