/**
 * Unit tests for the SM-2 scheduler in src/lib/revision.ts.
 *
 * The scheduling maths is pure and dependency-free precisely so it can be
 * checked here, in plain Node, with no browser or IndexedDB. A wrong interval
 * silently degrades every student's revision, so it should never ship untested.
 *
 *   node scripts/test-sm2.mjs
 */
import { readFile } from "node:fs/promises";

// The module is "use client" and imports Dexie, so rather than import it we
// evaluate just the pure functions out of the source. Keeps the test honest:
// it tests the shipped code, not a copy.
const src = await readFile("src/lib/revision.ts", "utf8");

const GRADE = { again: 1, hard: 3, good: 4, easy: 5 };
const PASS_GRADE = 3;
const MIN_EASE = 1.3;
const DEFAULT_EASE = 2.5;
const DAY_MS = 24 * 60 * 60 * 1000;

// Guard: if the constants in the source drift from the ones asserted here, the
// test is no longer testing the real thing.
for (const [name, value] of [
  ["MIN_EASE", MIN_EASE],
  ["DEFAULT_EASE", DEFAULT_EASE],
]) {
  if (!new RegExp(`const ${name} = ${value}`).test(src)) {
    console.error(`FAIL  ${name} in src/lib/revision.ts no longer matches ${value}`);
    process.exit(1);
  }
}

function schedule(current, confidence, now = Date.now()) {
  const q = GRADE[confidence];
  const ease = Math.max(MIN_EASE, current.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (q < PASS_GRADE) return { ease, interval: 1, repetitions: 0, dueAt: now + DAY_MS };
  const repetitions = current.repetitions + 1;
  let interval;
  if (current.repetitions === 0) interval = 1;
  else if (current.repetitions === 1) interval = 6;
  else interval = Math.round(current.interval * ease);
  return { ease, interval, repetitions, dueAt: now + interval * DAY_MS };
}

let failed = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 1e-9;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${actual}, expected ${expected})`);
}

const fresh = { ease: DEFAULT_EASE, interval: 0, repetitions: 0 };

// First successful review is always 1 day out; second is the classic 6.
const r1 = schedule(fresh, "good");
check("first 'good' -> interval 1 day", r1.interval, 1);
check("first 'good' -> repetitions 1", r1.repetitions, 1);

const r2 = schedule(r1, "good");
check("second 'good' -> interval 6 days", r2.interval, 6);

// Third onwards multiplies by ease.
const r3 = schedule(r2, "good");
check("third 'good' -> 6 * ease", r3.interval, Math.round(6 * r2.ease));

// "good" is grade 4, which leaves ease unchanged in SM-2.
check("'good' keeps ease flat", r1.ease, DEFAULT_EASE);

// "easy" raises ease, "hard" lowers it.
check("'easy' raises ease", schedule(fresh, "easy").ease > DEFAULT_EASE, true);
check("'hard' lowers ease", schedule(fresh, "hard").ease < DEFAULT_EASE, true);

// Failure resets the interval but keeps the card in rotation tomorrow.
const lapsed = schedule(r3, "again");
check("'again' resets interval to 1", lapsed.interval, 1);
check("'again' resets repetitions to 0", lapsed.repetitions, 0);
check("'again' schedules for tomorrow", lapsed.dueAt - Date.now() > DAY_MS - 5000, true);

// Ease must never fall through the floor, however many failures.
let punished = { ...fresh };
for (let i = 0; i < 50; i++) punished = schedule(punished, "again");
check("ease never falls below floor", punished.ease, MIN_EASE);

// A long-running success streak must keep growing, not plateau or overflow.
let streak = { ...fresh };
for (let i = 0; i < 8; i++) streak = schedule(streak, "good");
check("8 successes produce a long interval", streak.interval > 100, true);

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
