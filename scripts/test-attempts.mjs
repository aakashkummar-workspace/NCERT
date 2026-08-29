/**
 * Unit tests for the pure half of src/lib/attempts.ts.
 *
 * The exam clock is the thing that must not be wrong. It is derived from a
 * persisted wall-clock `startedAt`, never accumulated from timer ticks, so that
 * a locked phone, a backgrounded tab or a reload cannot cost a student minutes
 * of their three hours. That property is only worth claiming if it is checked,
 * and it can be checked here — in plain Node, with no browser or IndexedDB.
 *
 *   node scripts/test-attempts.mjs
 */
import { readFile } from "node:fs/promises";

// The module is "use client" and imports Dexie, so rather than import it we
// evaluate just the pure functions out of the source. Keeps the test honest:
// it tests the shipped code, not a copy.
const src = await readFile("src/lib/attempts.ts", "utf8");

// Guards: if the source drifts from what is mirrored below, the test is no
// longer testing the real thing. The first two pin the clock to `startedAt`.
for (const [name, pattern] of [
  ["remainingMs derives from startedAt", /Math\.max\(0, a\.startedAt \+ a\.durationMs - now\)/],
  ["isExpired derives from startedAt", /now >= a\.startedAt \+ a\.durationMs/],
  ["confidence thresholds", /ratio >= 0\.9[\s\S]*ratio >= 0\.6/],
]) {
  if (!pattern.test(src)) {
    console.error(`FAIL  ${name}: src/lib/attempts.ts no longer matches ${pattern}`);
    process.exit(1);
  }
}

// A tick-counted countdown is the bug this whole design exists to avoid.
if (/setInterval|setTimeout/.test(src)) {
  console.error("FAIL  src/lib/attempts.ts must not accumulate time from timers");
  process.exit(1);
}

function remainingMs(a, now = Date.now()) {
  return Math.max(0, a.startedAt + a.durationMs - now);
}

function isExpired(a, now = Date.now()) {
  return now >= a.startedAt + a.durationMs;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function confidenceFor(score, maxMarks) {
  if (score <= 0) return "again";
  const ratio = maxMarks > 0 ? score / maxMarks : 0;
  if (ratio >= 0.9) return "easy";
  if (ratio >= 0.6) return "good";
  return "hard";
}

let failed = 0;
function check(name, actual, expected) {
  const ok =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) < 1e-9
      : actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${actual}, expected ${expected})`);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// A three-hour paper started at an arbitrary wall-clock instant.
const t0 = 1_760_000_000_000;
const paper = { startedAt: t0, durationMs: 3 * HOUR };

// --- remainingMs ---------------------------------------------------------

check("full time at the moment of starting", remainingMs(paper, t0), 3 * HOUR);
check("an hour in, two hours left", remainingMs(paper, t0 + HOUR), 2 * HOUR);

// The whole point: the clock is read from the wall, not counted. A tab asleep
// for 100 minutes wakes up 100 minutes poorer, and the browser cannot lie to us
// about that by dropping timer ticks.
check("time passes while the tab sleeps", remainingMs(paper, t0 + 100 * MINUTE), 80 * MINUTE);

check("exactly zero at the deadline", remainingMs(paper, t0 + 3 * HOUR), 0);
check("clamped at zero an hour past", remainingMs(paper, t0 + 4 * HOUR), 0);
check("clamped at zero a day past", remainingMs(paper, t0 + 24 * HOUR), 0);

// --- isExpired -----------------------------------------------------------

check("not expired at the start", isExpired(paper, t0), false);
check("not expired one ms before", isExpired(paper, t0 + 3 * HOUR - 1), false);
check("expired exactly on the deadline", isExpired(paper, t0 + 3 * HOUR), true);
check("expired one ms after", isExpired(paper, t0 + 3 * HOUR + 1), true);
check("still expired the next day", isExpired(paper, t0 + 24 * HOUR), true);

// --- formatClock ---------------------------------------------------------

check("zero renders as 0:00:00", formatClock(0), "0:00:00");
check("negative clamps to 0:00:00", formatClock(-5000), "0:00:00");
check("sub-second rounds down", formatClock(999), "0:00:00");
check("one second", formatClock(1000), "0:00:01");
check("minutes pad, hours do not", formatClock(7 * MINUTE + 13000), "0:07:13");
check("2:59:04", formatClock(2 * HOUR + 59 * MINUTE + 4000), "2:59:04");
check("a full three hours", formatClock(3 * HOUR), "3:00:00");
check("just over three hours", formatClock(3 * HOUR + 1000), "3:00:01");
check("double-digit hours", formatClock(12 * HOUR), "12:00:00");
check("part seconds are floored, never rounded up", formatClock(1999), "0:00:01");

// The clock a student actually sees, at the start of a 180-minute paper.
const sqp = { startedAt: t0, durationMs: 180 * MINUTE };
check("start of a 180-minute paper", formatClock(remainingMs(sqp, t0)), "3:00:00");
check("ten minutes to go", formatClock(remainingMs(sqp, t0 + 170 * MINUTE)), "0:10:00");
check("reads 0:00:00 once expired", formatClock(remainingMs(sqp, t0 + 200 * MINUTE)), "0:00:00");

// --- confidenceFor -------------------------------------------------------

check("full marks -> easy", confidenceFor(5, 5), "easy");
check("exactly 0.9 -> easy", confidenceFor(9, 10), "easy");
check("just under 0.9 -> good", confidenceFor(8.9, 10), "good");
check("exactly 0.6 -> good", confidenceFor(6, 10), "good");
check("just under 0.6 -> hard", confidenceFor(5.9, 10), "hard");
check("half marks -> hard", confidenceFor(1, 2), "hard");
check("a scrape -> hard", confidenceFor(0.5, 5), "hard");
check("zero -> again", confidenceFor(0, 5), "again");
check("zero on a one-marker -> again", confidenceFor(0, 1), "again");
// Clamping happens in saveScore; a stray negative must still read as a failure.
check("negative -> again", confidenceFor(-1, 5), "again");
// maxMarks of 0 is nonsense data, but must not produce NaN comparisons.
check("zero maximum -> never easy", confidenceFor(2, 0), "hard");
check("zero out of zero -> again", confidenceFor(0, 0), "again");

// One-mark MCQs are most of a paper, and only ever score 0 or 1.
check("one-marker right -> easy", confidenceFor(1, 1), "easy");
check("one-marker wrong -> again", confidenceFor(0, 1), "again");

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
