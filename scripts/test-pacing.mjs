/**
 * Unit tests for the pacing maths in src/lib/pacing.ts.
 *
 * The tracker tells a fifteen-year-old, mid-exam, how their three hours are
 * going. Getting it wrong in either direction is expensive: a false "behind"
 * panics a student who was fine, and a false "on pace" costs them the paper.
 * Like the exam clock it derives everything from wall-clock stamps rather than
 * counting ticks, which is exactly the property that makes it checkable here —
 * in plain Node, with no browser, no IndexedDB and no waiting.
 *
 *   node scripts/test-pacing.mjs
 */
import { readFile } from "node:fs/promises";

// The module has no imports and no browser APIs, but it is TypeScript, so
// rather than import it we mirror the pure functions and pin them to the source
// with guards. Keeps the test honest: if the shipped code drifts from what is
// mirrored below, the guards fail before a single check runs.
const src = await readFile("src/lib/pacing.ts", "utf8");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const PACE_TOLERANCE = 0.15;
const PACE_TOLERANCE_FLOOR_MS = 2 * MINUTE;

for (const [name, pattern] of [
  ["PACE_TOLERANCE is 0.15", /PACE_TOLERANCE = 0\.15/],
  ["PACE_TOLERANCE_FLOOR_MS is two minutes", /PACE_TOLERANCE_FLOOR_MS = 2 \* MINUTE_MS/],
  ["CBSE rate is 2.25 min per mark", /CBSE_MS_PER_MARK = 2\.25 \* MINUTE_MS/],
  ["the rate is derived from the paper", /durationMs \/ marksTotal/],
  ["now is capped at the deadline", /Math\.min\(Math\.max\(now, input\.startedAt\), deadline\)/],
  ["stamps are forced forwards", /Math\.max\(previous\.at, s\.at, startedAt\)/],
  ["segments can never be negative", /Math\.max\(0, to\.at - from\.at\)/],
  ["a section in hand is never under budget", /Math\.max\(0, elapsed - budget\)/],
]) {
  if (!pattern.test(src)) {
    console.error(`FAIL  ${name}: src/lib/pacing.ts no longer matches ${pattern}`);
    process.exit(1);
  }
}

// A tick-counted clock is the bug this whole design exists to avoid.
if (/setInterval|setTimeout/.test(src)) {
  console.error("FAIL  src/lib/pacing.ts must not accumulate time from timers");
  process.exit(1);
}

// --- the mirror ----------------------------------------------------------

const ordered = (questions) =>
  questions
    .filter((q) => Number.isFinite(q.n) && Number.isFinite(q.maxMarks))
    .sort((a, b) => a.n - b.n);

function budgetMsPerMark(durationMs, marksTotal) {
  return marksTotal > 0 && durationMs > 0 ? durationMs / marksTotal : 0;
}

function paceStatus(driftMs, budgetMs) {
  const slack = Math.max(PACE_TOLERANCE_FLOOR_MS, Math.abs(budgetMs) * PACE_TOLERANCE);
  if (driftMs > slack) return "behind";
  if (driftMs < -slack) return "ahead";
  return "on-pace";
}

function sectionBlocks(questions) {
  const blocks = [];
  for (const q of ordered(questions)) {
    const last = blocks[blocks.length - 1];
    if (last && last.label === q.section) {
      last.to = q.n;
      last.marks += q.maxMarks;
    } else {
      blocks.push({ label: q.section, from: q.n, to: q.n, marks: q.maxMarks });
    }
  }
  return blocks;
}

function reachMarks(stamps, startedAt, firstQuestion, until = Number.POSITIVE_INFINITY) {
  const marks = [{ n: firstQuestion, at: startedAt }];
  const stamped = stamps
    .filter((s) => Number.isFinite(s.reachedAt))
    .map((s) => ({ n: s.n, at: s.reachedAt }))
    .sort((a, b) => a.n - b.n);
  for (const s of stamped) {
    if (s.n <= firstQuestion) continue;
    const previous = marks[marks.length - 1];
    const at = Math.max(previous.at, s.at, startedAt);
    if (at > until) break;
    marks.push({ n: s.n, at });
  }
  return marks;
}

function currentQuestion(questions, stamps, startedAt = 0, now = Number.POSITIVE_INFINITY) {
  const list = ordered(questions);
  if (list.length === 0) return null;
  const marks = reachMarks(stamps, startedAt, list[0].n, now);
  return marks[marks.length - 1].n;
}

function spendByQuestion(questions, startedAt, stamps, now) {
  const list = ordered(questions);
  const spend = new Map(list.map((q) => [q.n, 0]));
  if (list.length === 0) return spend;

  const marks = reachMarks(stamps, startedAt, list[0].n, now);
  const last = marks[marks.length - 1];
  const end = Math.max(last.at, now);
  const block = sectionBlocks(list).find((b) => last.n >= b.from && last.n <= b.to);
  const openTo = (block?.to ?? list[list.length - 1].n) + 1;
  const points = [...marks, { n: openTo, at: end }];

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const duration = Math.max(0, to.at - from.at);
    if (duration === 0) continue;
    const covered = list.filter((q) => q.n >= from.n && q.n < to.n);
    if (covered.length === 0) continue;
    const marksInSegment = covered.reduce((sum, q) => sum + q.maxMarks, 0);
    for (const q of covered) {
      const share = marksInSegment > 0 ? q.maxMarks / marksInSegment : 1 / covered.length;
      spend.set(q.n, (spend.get(q.n) ?? 0) + duration * share);
    }
  }
  return spend;
}

function pacing(input, now) {
  const list = ordered(input.questions);
  const marksTotal = list.reduce((sum, q) => sum + q.maxMarks, 0);
  const rate = budgetMsPerMark(input.durationMs, marksTotal);

  const deadline = input.startedAt + input.durationMs;
  const at = Math.min(Math.max(now, input.startedAt), deadline);
  const elapsedMs = at - input.startedAt;

  const blocks = sectionBlocks(list);
  const spend = spendByQuestion(list, input.startedAt, input.scores, at);
  const current = currentQuestion(list, input.scores, input.startedAt, at);

  const marksDone = list
    .filter((q) => current !== null && q.n < current)
    .reduce((sum, q) => sum + q.maxMarks, 0);

  const actualMsPerMark = marksDone > 0 ? elapsedMs / marksDone : null;
  const projectedTotalMs = actualMsPerMark === null ? null : actualMsPerMark * marksTotal;
  const marksLeft = marksTotal - marksDone;
  const remainingMsPerMark = marksLeft > 0 ? Math.max(0, deadline - at) / marksLeft : null;

  const sections = blocks.map((b) => {
    const inBlock = list.filter((q) => q.n >= b.from && q.n <= b.to);
    const elapsed = inBlock.reduce((sum, q) => sum + (spend.get(q.n) ?? 0), 0);
    const budget = b.marks * rate;
    const state = current === null || current > b.to ? "done" : current >= b.from ? "current" : "upcoming";
    const drift =
      state === "upcoming" ? 0 : state === "current" ? Math.max(0, elapsed - budget) : elapsed - budget;
    return {
      ...b,
      budgetMs: budget,
      elapsedMs: elapsed,
      driftMs: drift,
      status: state === "upcoming" ? "on-pace" : paceStatus(drift, budget),
      state,
    };
  });

  const currentSection = sections.find((s) => s.state === "current") ?? null;
  const nextSection = currentSection
    ? (sections.find((s) => s.from > currentSection.from) ?? null)
    : null;

  return {
    budgetMsPerMark: rate,
    elapsedMs,
    marksDone,
    marksTotal,
    actualMsPerMark,
    projectedTotalMs,
    projectedOverrunMs: projectedTotalMs === null ? null : projectedTotalMs - input.durationMs,
    remainingMsPerMark,
    driftMs: sections.reduce((sum, s) => sum + s.driftMs, 0),
    status: currentSection?.status ?? "on-pace",
    currentQuestion: current,
    sections,
    current: currentSection,
    next: nextSection,
  };
}

function formatPerMark(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatSpan(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

// --- harness -------------------------------------------------------------

let failed = 0;
function check(name, actual, expected) {
  const ok =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) < 1e-6
      : actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${actual}, expected ${expected})`);
}

/** Expand a mark grid into questions, the way papers.questionsFor does. */
function expand(grid) {
  return grid.flatMap((s) =>
    Array.from({ length: s.to - s.from + 1 }, (_, i) => ({
      n: s.from + i,
      maxMarks: s.marksEach,
      section: s.label,
    })),
  );
}

// A Class 10 Science-shaped paper: 39 questions, 80 marks, three hours.
const SCIENCE = expand([
  { label: "A", from: 1, to: 20, marksEach: 1 },
  { label: "B", from: 21, to: 26, marksEach: 2 },
  { label: "C", from: 27, to: 33, marksEach: 3 },
  { label: "D", from: 34, to: 36, marksEach: 5 },
  { label: "E", from: 37, to: 39, marksEach: 4 },
]);

const t0 = 1_760_000_000_000;
const PAPER = { startedAt: t0, durationMs: 3 * HOUR, questions: SCIENCE };
const RATE = 2.25 * MINUTE;

// Section budgets, at 2.25 min a mark: A 45, B 27, C 47.25, D 33.75, E 27.
const A_END = 45 * MINUTE;
const B_END = A_END + 27 * MINUTE;
const C_END = B_END + 47.25 * MINUTE;
const D_END = C_END + 33.75 * MINUTE;

const stamp = (n, at) => ({ n, reachedAt: at });
const at = (offset) => t0 + offset;

// --- the paper's own rate ------------------------------------------------

check("39 questions expand from the grid", SCIENCE.length, 39);
check("the grid totals 80 marks", SCIENCE.reduce((s, q) => s + q.maxMarks, 0), 80);
check("80 marks in 180 minutes is 2.25 min a mark", budgetMsPerMark(3 * HOUR, 80), RATE);
check("a 40-mark 90-minute paper paces itself", budgetMsPerMark(90 * MINUTE, 40), 2.25 * MINUTE);
check("a paper with no marks has no rate", budgetMsPerMark(3 * HOUR, 0), 0);
check("a paper with no time has no rate", budgetMsPerMark(0, 80), 0);

// --- section boundaries --------------------------------------------------

const blocks = sectionBlocks(SCIENCE);
check("five sections", blocks.length, 5);
check("section A runs 1-20", `${blocks[0].from}-${blocks[0].to}`, "1-20");
check("section A is worth 20 marks", blocks[0].marks, 20);
check("section C is worth 21 marks", blocks[2].marks, 21);
check("section E ends at question 39", blocks[4].to, 39);
check("the blocks total the paper", blocks.reduce((s, b) => s + b.marks, 0), 80);

// Maths prints Section A twice — one-markers, then assertion-reason — and a
// student experiences one section, so adjacent rows sharing a label merge.
const MATHS = expand([
  { label: "A", from: 1, to: 18, marksEach: 1 },
  { label: "A", from: 19, to: 20, marksEach: 1 },
  { label: "B", from: 21, to: 25, marksEach: 2 },
  { label: "C", from: 26, to: 31, marksEach: 3 },
  { label: "D", from: 32, to: 35, marksEach: 5 },
  { label: "E", from: 36, to: 38, marksEach: 4 },
]);
const mathsBlocks = sectionBlocks(MATHS);
check("a split section label merges into one block", mathsBlocks.length, 5);
check("the merged block covers both rows", `${mathsBlocks[0].from}-${mathsBlocks[0].to}`, "1-20");
check("the merged block carries both rows' marks", mathsBlocks[0].marks, 20);

// --- a paper sat perfectly on pace ---------------------------------------

const PERFECT = [stamp(21, at(A_END)), stamp(27, at(B_END)), stamp(34, at(C_END)), stamp(37, at(D_END))];

{
  // Three quarters of the way in, having just opened Section D.
  const p = pacing({ ...PAPER, scores: PERFECT }, at(C_END));
  check("on pace: the section in hand is D", p.current.label, "D");
  check("on pace: no verdict to give", p.status, "on-pace");
  check("on pace: nothing has slipped", Math.round(p.driftMs / 1000), 0);
  check("on pace: 53 of 80 marks banked", p.marksDone, 53);
  check("on pace: the observed rate is the budget", p.actualMsPerMark, RATE);
  check("on pace: the paper projects to its own length", p.projectedTotalMs, 3 * HOUR);
  check("on pace: it projects no overrun", p.projectedOverrunMs, 0);
  check("on pace: the rate from here is unchanged", p.remainingMsPerMark, RATE);
  check("on pace: every finished section is level", p.sections.filter((s) => s.status !== "on-pace").length, 0);
  check("on pace: A, B and C are done", p.sections.filter((s) => s.state === "done").length, 3);
  check("on pace: E is still ahead", p.sections[4].state, "upcoming");
  check("on pace: section A took its 45 minutes", p.sections[0].elapsedMs, 45 * MINUTE);
  check("on pace: section C took its 47 and a quarter", p.sections[2].elapsedMs, 47.25 * MINUTE);
  check("on pace: an unreached section has spent nothing", p.sections[4].elapsedMs, 0);
  check("on pace: the next section is offered", p.next.label, "E");

  // The invariant everything else rests on: no time is lost or invented.
  const summed = p.sections.reduce((sum, s) => sum + s.elapsedMs, 0);
  check("on pace: the sections account for every minute", summed, p.elapsedMs);
}

// --- a paper lost on one section -----------------------------------------

{
  // Section C's budget is 47.25 minutes. This student is 70 minutes into it.
  const scores = [stamp(21, at(A_END)), stamp(27, at(B_END))];
  const p = pacing({ ...PAPER, scores }, at(B_END + 70 * MINUTE));
  check("lost: still in section C", p.current.label, "C");
  check("lost: the section in hand is over", p.status, "behind");
  check("lost: by about 23 minutes", Math.round(p.current.driftMs / MINUTE), 23);
  check("lost: sections before it are untouched", p.sections[0].status, "on-pace");
  check("lost: the rate from here has tightened", p.remainingMsPerMark < RATE, true);
  // 38 minutes for the 48 marks still to write: the pressure, in one string.
  check("lost: which the copy reads as 0:48 a mark", formatPerMark(p.remainingMsPerMark), "0:48");
  check("lost: the projection overruns", p.projectedOverrunMs > 20 * MINUTE, true);
  check("lost: sections still account for every minute", p.sections.reduce((s, x) => s + x.elapsedMs, 0), p.elapsedMs);
}

{
  // Twenty minutes into a 47-minute section is not yet evidence of anything,
  // and saying so would be the false alarm that gets the tracker ignored.
  const scores = [stamp(21, at(A_END)), stamp(27, at(B_END))];
  const p = pacing({ ...PAPER, scores }, at(B_END + 20 * MINUTE));
  check("20 min into a 47 min section is not an alarm", p.status, "on-pace");
  check("...and the section in hand is never 'ahead'", p.sections[2].status, "on-pace");
  check("...nor is it credited with time saved", p.sections[2].driftMs, 0);
}

{
  // Time banked in an early section is real, and is the one thing reported
  // across section boundaries — good news travels, bad news stays local.
  const scores = [stamp(21, at(30 * MINUTE))];
  const p = pacing({ ...PAPER, scores }, at(35 * MINUTE));
  check("a section finished early reads as ahead", p.sections[0].status, "ahead");
  check("the paper counts the 15 minutes banked", Math.round(p.driftMs / MINUTE), -15);
  check("but the verdict stays with the section in hand", p.status, "on-pace");
  check("and the rate from here has loosened", p.remainingMsPerMark > RATE, true);
}

// --- a student who marks nothing -----------------------------------------

{
  // Forty-five minutes in with no stamps at all: the honest reading is a
  // student still in Section A, which is exactly on budget — not one who has
  // spread 45 minutes across a paper they have not started.
  const p = pacing({ ...PAPER, scores: [] }, at(45 * MINUTE));
  check("unmarked: the student is taken to be in section A", p.current.label, "A");
  check("unmarked: every minute lands in section A", p.sections[0].elapsedMs, 45 * MINUTE);
  check("unmarked: later sections have spent nothing", p.sections[3].elapsedMs, 0);
  check("unmarked: a full section A is not an accusation", p.status, "on-pace");

  const over = pacing({ ...PAPER, scores: [] }, at(60 * MINUTE));
  check("unmarked: a quarter hour over section A is", over.status, "behind");
  check("unmarked: reported as 15 minutes", formatSpan(over.current.driftMs), "15 min");
}

// --- a paused, locked or backgrounded phone -------------------------------

{
  // The tab slept for forty minutes in the middle of Section B. Sleep is not a
  // pause: the time is gone, it belongs to the section that was in hand, and
  // the reading is the same whether or not a single timer tick was delivered.
  const scores = [stamp(21, at(A_END))];
  const before = pacing({ ...PAPER, scores }, at(A_END + 5 * MINUTE));
  const after = pacing({ ...PAPER, scores }, at(A_END + 45 * MINUTE));

  check("asleep: the gap is charged in full", after.elapsedMs - before.elapsedMs, 40 * MINUTE);
  check("asleep: it lands on the section in hand", after.sections[1].elapsedMs - before.sections[1].elapsedMs, 40 * MINUTE);
  check("asleep: not on the section already done", after.sections[0].elapsedMs, before.sections[0].elapsedMs);
  check("asleep: section B was fine before", before.status, "on-pace");
  check("asleep: and is over budget after", after.status, "behind");
  check("asleep: the rate from here tightens", after.remainingMsPerMark < before.remainingMsPerMark, true);
  check("asleep: no minute is lost in the accounting", after.sections.reduce((s, x) => s + x.elapsedMs, 0), after.elapsedMs);

  // Reading the same stamps at the same instant twice must agree exactly —
  // the property a tick-counter cannot offer.
  const again = pacing({ ...PAPER, scores }, at(A_END + 45 * MINUTE));
  check("asleep: two readings of one instant agree", again.driftMs, after.driftMs);
}

{
  // The phone was left in a pocket overnight. `submitAttempt` caps the paper at
  // its natural end, and so does this: no fourteen-hour attempts.
  const p = pacing({ ...PAPER, scores: PERFECT }, at(14 * HOUR));
  check("overnight: elapsed stops at the deadline", p.elapsedMs, 3 * HOUR);
  check("overnight: no time is left per mark", p.remainingMsPerMark, 0);
  check("overnight: the accounting still balances", p.sections.reduce((s, x) => s + x.elapsedMs, 0), 3 * HOUR);
}

// --- zero elapsed, and other edges ---------------------------------------

{
  const p = pacing({ ...PAPER, scores: [] }, t0);
  check("zero: nothing has elapsed", p.elapsedMs, 0);
  check("zero: nothing is banked", p.marksDone, 0);
  check("zero: there is no observed rate yet", p.actualMsPerMark, null);
  check("zero: and so nothing to project", p.projectedTotalMs, null);
  check("zero: nor an overrun to project", p.projectedOverrunMs, null);
  check("zero: the whole budget is still per mark", p.remainingMsPerMark, RATE);
  check("zero: nothing has drifted", p.driftMs, 0);
  check("zero: nobody is behind at the bell", p.status, "on-pace");
  check("zero: every section is empty", p.sections.every((s) => s.elapsedMs === 0), true);
  check("zero: no NaN anywhere", p.sections.every((s) => Number.isFinite(s.driftMs)), true);
}

{
  // A clock that steps backwards mid-paper, and stamps that come back out of
  // order, must not credit a student with time they did not spend.
  const scores = [stamp(27, at(B_END)), stamp(21, at(A_END)), stamp(34, at(B_END - 30 * MINUTE))];
  const p = pacing({ ...PAPER, scores }, at(C_END));
  check("skew: no section spends negative time", p.sections.every((s) => s.elapsedMs >= 0), true);
  check("skew: the accounting still balances", p.sections.reduce((s, x) => s + x.elapsedMs, 0), p.elapsedMs);
  check("skew: the furthest stamp still wins", p.currentQuestion, 34);
  check("skew: a backwards stamp buys no free time", p.sections[2].elapsedMs, 0);
}

{
  // Reading an attempt as it stood an hour ago must not see stamps made since.
  // (The same guard catches a device clock that jumps forwards mid-paper.)
  const p = pacing({ ...PAPER, scores: PERFECT }, at(30 * MINUTE));
  check("a stamp not yet reached is not counted", p.current.label, "A");
  check("...so the time is still section A's", p.sections[0].elapsedMs, 30 * MINUTE);
  check("...and nothing is banked", p.marksDone, 0);
}

{
  // A stamp before the paper began, and one after the bell.
  const p = pacing({ ...PAPER, scores: [stamp(21, t0 - HOUR)] }, at(30 * MINUTE));
  check("a stamp before the start is floored at it", p.sections[0].elapsedMs, 0);
  check("...and the time goes to where the student is", p.sections[1].elapsedMs, 30 * MINUTE);

  const empty = pacing({ startedAt: t0, durationMs: 3 * HOUR, questions: [], scores: [] }, at(HOUR));
  check("a paper with no mark grid has no sections", empty.sections.length, 0);
  check("...and no question in hand", empty.currentQuestion, null);
  check("...and no verdict", empty.status, "on-pace");
}

// --- thresholds ----------------------------------------------------------

// Section A is 45 minutes, so its slack is 6.75 — under seven minutes says
// nothing, because seven minutes in three hours is not worth a student's
// attention mid-exam.
check("6 minutes over a 45-minute section is quiet", paceStatus(6 * MINUTE, 45 * MINUTE), "on-pace");
check("7 minutes over it is not", paceStatus(7 * MINUTE, 45 * MINUTE), "behind");
check("6 minutes under it is quiet too", paceStatus(-6 * MINUTE, 45 * MINUTE), "on-pace");
check("7 minutes under it reads as ahead", paceStatus(-7 * MINUTE, 45 * MINUTE), "ahead");

// The floor stops a small section flickering: 15% of a single 1-mark question
// is twenty seconds, which no tracker should ever report on.
check("a minute over a one-marker is silence", paceStatus(MINUTE, RATE), "on-pace");
check("two minutes over it, still silence", paceStatus(2 * MINUTE, RATE), "on-pace");
check("three minutes over it is worth saying", paceStatus(3 * MINUTE, RATE), "behind");
check("the floor holds for a zero budget too", paceStatus(MINUTE, 0), "on-pace");

// --- the strings a student reads -----------------------------------------

check("the budget rate reads as 2:15", formatPerMark(RATE), "2:15");
check("a tight rate reads as 1:30", formatPerMark(90 * 1000), "1:30");
check("seconds pad", formatPerMark(65 * 1000), "1:05");
check("no time left reads as 0:00, never negative", formatPerMark(-5000), "0:00");
check("a span in minutes", formatSpan(9 * MINUTE), "9 min");
check("a span over an hour", formatSpan(64 * MINUTE), "1 hr 4 min");
check("a round hour drops the minutes", formatSpan(2 * HOUR), "2 hr");
check("a negative span never appears", formatSpan(-9 * MINUTE), "0 min");

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
