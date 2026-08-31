/**
 * Unit tests for the micro-bridge engine in src/lib/bridge.ts.
 *
 *   node scripts/test-bridge.mjs
 *
 * Everything tested here is a judgement about when to interrupt a fourteen-
 * year-old who is already having a bad afternoon, which is exactly the kind of
 * logic that is easy to get wrong and impossible to notice in a browser: a
 * broken rate limiter looks fine on a fresh install and only misbehaves on the
 * day a student gets four chapters wrong in a row.
 *
 * The module is "use client" and imports a JSON alias, so — following
 * scripts/test-sm2.mjs — the pure functions are re-implemented here and the
 * source is checked to make sure the constants and exports they depend on have
 * not drifted. The *data* is not re-implemented: every selection test below
 * runs against the real data/prerequisites.json, so a bad edit to the map fails
 * the tests as well as the validator.
 */
import { readFile } from "node:fs/promises";

const src = await readFile("src/lib/bridge.ts", "utf8");
const prereqs = JSON.parse(await readFile("data/prerequisites.json", "utf8"));
const manifest = JSON.parse(await readFile("data/manifest.json", "utf8"));

let failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || (typeof actual === "number" && Math.abs(actual - expected) < 1e-9);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// --- guards: the re-implementation must still match the source -------------

const CONSTANTS = [
  ["MAX_BRIDGE_MINUTES", "3"],
  ["WEAK_CONFIDENCE", "0.6"],
  ["WEAK_SCORE", "0.5"],
  ["MAX_DISMISSALS", "2"],
  ["MAX_OFFERS_PER_DAY", "2"],
  ["MIN_GAP_MS", "6 \\* HOUR_MS"],
  ["IGNORED_QUIET_MS", "DAY_MS"],
  ["DISMISS_QUIET_MS", "\\[2 \\* DAY_MS, 14 \\* DAY_MS\\]"],
  ["TAKEN_QUIET_MS", "21 \\* DAY_MS"],
];
for (const [name, value] of CONSTANTS) {
  if (!new RegExp(`${name} = ${value}`).test(src)) {
    console.error(`FAIL  ${name} in src/lib/bridge.ts no longer matches ${value}`);
    process.exit(1);
  }
}
for (const name of [
  "isEarlier",
  "bridgeFor",
  "isOfferable",
  "isEligible",
  "withinRateLimit",
  "selectBridge",
  "signalsFromAnswers",
  "signalsFromConfidence",
  "noteOffered",
  "noteDismissed",
  "noteTaken",
]) {
  if (!new RegExp(`function ${name}\\b`).test(src)) {
    console.error(`FAIL  src/lib/bridge.ts no longer defines ${name}()`);
    process.exit(1);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MAX_BRIDGE_MINUTES = 3;
const WEAK_CONFIDENCE = 0.6;
const WEAK_SCORE = 0.5;
const MAX_DISMISSALS = 2;
const MAX_OFFERS_PER_DAY = 2;
const MIN_GAP_MS = 6 * HOUR;
const IGNORED_QUIET_MS = DAY;
const DISMISS_QUIET_MS = [2 * DAY, 14 * DAY];
const TAKEN_QUIET_MS = 21 * DAY;

// --- the engine, re-implemented -------------------------------------------

const books = new Map(manifest.books.map((b) => [b.code, b]));

function isEarlier(target, prereq) {
  if (prereq.classNum < target.classNum) return true;
  if (prereq.classNum > target.classNum) return false;
  return prereq.bookCode === target.bookCode && prereq.chapter < target.chapter;
}

/** Same drop-anything-untrusted normalisation as src/lib/bridge.ts. */
function normalise(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const book = books.get(row.bookCode);
    if (!book || !row.id || seen.has(row.id)) continue;
    if (!book.chapters.some((c) => c.n === row.chapter)) continue;
    const target = { classNum: book.class, bookCode: book.code, chapter: row.chapter };

    const steps = [];
    const gaps = [];
    for (const p of row.prerequisites ?? []) {
      if (p.kind === "out-of-corpus") {
        if (p.grade && p.topic && p.why) gaps.push(p);
        continue;
      }
      const pBook = books.get(p.bookCode);
      if (!pBook || !pBook.chapters.some((c) => c.n === p.chapter)) continue;
      const ref = { classNum: pBook.class, bookCode: pBook.code, chapter: p.chapter };
      if (!isEarlier(target, ref)) continue;
      if (!p.why || !(p.recap ?? []).length) continue;
      if (!(p.minutes > 0 && p.minutes <= MAX_BRIDGE_MINUTES)) continue;
      steps.push({ ...ref, minutes: p.minutes });
    }
    if (steps.length === 0 && gaps.length === 0) continue;
    const minutes = steps.reduce((n, s) => n + s.minutes, 0);
    if (minutes > MAX_BRIDGE_MINUTES) continue;

    seen.add(row.id);
    out.push({
      id: row.id,
      bookCode: book.code,
      chapter: row.chapter,
      classNum: book.class,
      subject: book.subject,
      concept: row.concept,
      questionIds: row.questionIds ?? [],
      steps,
      gaps,
      minutes,
    });
  }
  return out;
}

const BRIDGES = normalise(prereqs.bridges);

function bridgesForChapter(bookCode, chapter) {
  return BRIDGES.filter((b) => b.bookCode === bookCode && b.chapter === chapter).sort(
    (a, b) => Number(Boolean(a.concept)) - Number(Boolean(b.concept)) || a.id.localeCompare(b.id),
  );
}

function bridgeFor(bookCode, chapter, concept) {
  const candidates = bridgesForChapter(bookCode, chapter);
  if (concept) {
    const key = concept.toLowerCase();
    const exact = candidates.find((b) => b.concept?.toLowerCase() === key);
    if (exact) return exact;
  }
  return candidates.find((b) => !b.concept) ?? candidates[0];
}

const isOfferable = (b) => b.steps.length > 0;

function isEligible(record, now) {
  if (!record) return true;
  if (record.dismissed >= MAX_DISMISSALS) return false;
  if (record.dismissed > 0) {
    const quiet = DISMISS_QUIET_MS[Math.min(record.dismissed, DISMISS_QUIET_MS.length) - 1];
    if (now - (record.lastDismissedAt ?? record.lastOfferedAt) < quiet) return false;
  }
  if (record.takenAt !== undefined && now - record.takenAt < TAKEN_QUIET_MS) return false;
  if (record.offered > 0 && now - record.lastOfferedAt < IGNORED_QUIET_MS) return false;
  return true;
}

function withinRateLimit(memory, now) {
  let recent = 0;
  for (const record of Object.values(memory)) {
    if (now - record.lastOfferedAt < MIN_GAP_MS) return false;
    if (now - record.lastOfferedAt < DAY) recent++;
  }
  return recent < MAX_OFFERS_PER_DAY;
}

function selectBridge(signals, memory = {}, now = Date.now()) {
  if (!withinRateLimit(memory, now)) return null;
  const candidates = [];
  const seen = new Set();
  for (const signal of signals) {
    const bridge = bridgeFor(signal.bookCode, signal.chapter, signal.concept);
    if (!bridge || !isOfferable(bridge) || seen.has(bridge.id)) continue;
    seen.add(bridge.id);
    if (!isEligible(memory[bridge.id], now)) continue;
    candidates.push({ bridge, signal });
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      b.signal.strength - a.signal.strength ||
      Number(b.signal.source === "quiz") - Number(a.signal.source === "quiz") ||
      a.bridge.minutes - b.bridge.minutes ||
      a.bridge.id.localeCompare(b.bridge.id),
  );
  return candidates[0];
}

function noteOffered(memory, id, now) {
  const prev = memory[id];
  return { ...memory, [id]: { ...(prev ?? { dismissed: 0 }), offered: (prev?.offered ?? 0) + 1, lastOfferedAt: now } };
}
function noteDismissed(memory, id, now) {
  const prev = memory[id] ?? { offered: 0, lastOfferedAt: now, dismissed: 0 };
  return { ...memory, [id]: { ...prev, dismissed: prev.dismissed + 1, lastDismissedAt: now } };
}
function noteTaken(memory, id, now) {
  const prev = memory[id] ?? { offered: 0, lastOfferedAt: now, dismissed: 0 };
  return { ...memory, [id]: { ...prev, takenAt: now } };
}

function bridgeForQuestion(id) {
  return BRIDGES.find((b) => b.questionIds.includes(id));
}

function signalsFromAnswers(answers, now) {
  const byChapter = new Map();
  for (const a of answers) {
    if (!a.bookCode || a.chapter === undefined) continue;
    const key = `${a.bookCode}:${a.chapter}`;
    const slot = byChapter.get(key) ?? { wrong: [], total: 0 };
    slot.total++;
    if (!a.correct) slot.wrong.push(a);
    byChapter.set(key, slot);
  }
  const out = [];
  for (const [key, { wrong, total }] of byChapter) {
    const ratio = wrong.length / total;
    if (wrong.length === 0 || 1 - ratio > WEAK_SCORE) continue;
    const [bookCode, chapter] = key.split(":");
    const tagged = wrong.map((w) => (w.id ? bridgeForQuestion(w.id) : undefined)).filter((b) => b?.concept);
    const concept =
      tagged.length === wrong.length && new Set(tagged.map((b) => b.id)).size === 1
        ? tagged[0].concept
        : undefined;
    out.push({ bookCode, chapter: Number(chapter), concept, strength: ratio, at: now, source: "quiz" });
  }
  return out;
}

function signalsFromConfidence(rows, now) {
  return rows
    .filter((r) => r.total > 0 && r.confidence < WEAK_CONFIDENCE)
    .map((r) => ({
      bookCode: r.bookCode,
      chapter: r.chapter,
      strength: Math.min(1, (1 - r.confidence) * Math.min(1, 0.5 + r.shaky / 4)),
      at: now,
      source: "confidence",
    }));
}

// --- the map itself --------------------------------------------------------

console.log(`# the map (${BRIDGES.length} bridges survive normalisation)\n`);

check("every authored bridge survives normalisation", BRIDGES.length, prereqs.bridges.length);
check(
  "no bridge exceeds the three-minute promise",
  BRIDGES.every((b) => b.minutes <= MAX_BRIDGE_MINUTES),
  true,
);
check(
  "every in-corpus prerequisite is strictly earlier",
  BRIDGES.every((b) =>
    b.steps.every((s) => isEarlier({ classNum: b.classNum, bookCode: b.bookCode, chapter: b.chapter }, s)),
  ),
  true,
);

// A cycle is the one failure a student could never diagnose: A sends them to B,
// B sends them back to A, forever. The ordering rule above should make it
// impossible; this proves it over the real map rather than assuming it.
const graph = new Map();
for (const b of BRIDGES) {
  const from = `${b.bookCode}:${b.chapter}`;
  const edges = graph.get(from) ?? new Set();
  for (const s of b.steps) edges.add(`${s.bookCode}:${s.chapter}`);
  graph.set(from, edges);
}
const colour = new Map();
let cycles = 0;
function visit(node, stack = []) {
  colour.set(node, "grey");
  for (const next of graph.get(node) ?? []) {
    if (colour.get(next) === "grey") cycles++;
    else if (!colour.has(next)) visit(next, [...stack, node]);
  }
  colour.set(node, "black");
}
for (const node of graph.keys()) if (!colour.has(node)) visit(node);
check("the real map contains no cycle", cycles, 0);

// The ordering rule is what guarantees that, so check it rejects the one shape
// that would break it: two books of the same class pointing at each other.
check(
  "a same-class cross-book link is rejected",
  isEarlier(
    { classNum: 10, bookCode: "jesc1", chapter: 11 },
    { classNum: 10, bookCode: "jemh1", chapter: 3 },
  ),
  false,
);
check(
  "a later chapter of the same book is rejected",
  isEarlier({ classNum: 10, bookCode: "jesc1", chapter: 9 }, { classNum: 10, bookCode: "jesc1", chapter: 10 }),
  false,
);
check(
  "a Class 9 chapter is accepted for a Class 10 target",
  isEarlier({ classNum: 10, bookCode: "jesc1", chapter: 10 }, { classNum: 9, bookCode: "iesc1", chapter: 1 }),
  true,
);

// --- selection -------------------------------------------------------------

console.log("\n# selection\n");

const t0 = Date.UTC(2026, 7, 31, 9, 0, 0);
const weakEye = { bookCode: "jesc1", chapter: 10, strength: 0.8, at: t0, source: "quiz" };
const weakStats = { bookCode: "jemh1", chapter: 13, strength: 0.9, at: t0, source: "quiz" };
const weakAp = { bookCode: "jemh1", chapter: 5, strength: 0.6, at: t0, source: "quiz" };

check("a weak chapter selects its bridge", selectBridge([weakEye], {}, t0)?.bridge.id, "jesc1-10");
check(
  "the run-up is the chapter before it",
  selectBridge([weakEye], {}, t0)?.bridge.steps[0].chapter,
  9,
);

// The chapter with no Class 9 prerequisite must offer nothing at all, rather
// than the nearest chapter that sounds similar.
check("a chapter with no in-corpus prerequisite offers nothing", selectBridge([weakStats], {}, t0), null);
check(
  "and it is still on record as an admitted gap",
  bridgeFor("jemh1", 13).gaps[0].grade,
  8,
);

// A concept-level miss goes to the concept bridge, which is shorter.
const balancing = { bookCode: "jesc1", chapter: 1, concept: "Balancing a chemical equation", strength: 1, at: t0, source: "quiz" };
check("a named concept selects the concept bridge", selectBridge([balancing], {}, t0)?.bridge.id, "jesc1-01-balancing");
check("the chapter-wide bridge is the default", selectBridge([{ ...balancing, concept: undefined }], {}, t0)?.bridge.id, "jesc1-01");
check(
  "an unrecognised concept falls back to the chapter bridge",
  selectBridge([{ ...balancing, concept: "Something nobody wrote" }], {}, t0)?.bridge.id,
  "jesc1-01",
);

// Never more than one, however many gaps show up at once.
const many = [weakEye, weakAp, { bookCode: "jesc1", chapter: 12, strength: 0.5, at: t0, source: "quiz" }];
check("only one bridge is ever offered", selectBridge(many, {}, t0) === null ? 0 : 1, 1);
check("the strongest signal wins", selectBridge(many, {}, t0)?.bridge.id, "jesc1-10");

// --- deduplication ---------------------------------------------------------

console.log("\n# deduplication\n");

let memory = noteOffered({}, "jesc1-10", t0);
check("the same bridge is not offered twice in a row", selectBridge([weakEye], memory, t0 + 7 * HOUR), null);
check("nor later the same day", selectBridge([weakEye], memory, t0 + 20 * HOUR), null);
check("but the gap is re-offered the next day", selectBridge([weakEye], memory, t0 + 25 * HOUR)?.bridge.id, "jesc1-10");

// Two signals for the same chapter — one from the quiz, one from the cards —
// must not become two offers.
const doubled = [weakEye, { ...weakEye, source: "confidence", strength: 0.7 }];
check("two signals for one chapter make one offer", selectBridge(doubled, {}, t0)?.bridge.id, "jesc1-10");

// Taken once, and it stays quiet for three weeks.
memory = noteTaken(noteOffered({}, "jesc1-10", t0), "jesc1-10", t0);
check("a bridge already read is not re-offered", selectBridge([weakEye], memory, t0 + 10 * DAY), null);
check("until well after it is stale", selectBridge([weakEye], memory, t0 + 22 * DAY)?.bridge.id, "jesc1-10");

// --- rate limiting ---------------------------------------------------------

console.log("\n# rate limiting\n");

memory = noteOffered({}, "jesc1-10", t0);
check("a second offer is blocked within six hours", selectBridge([weakAp], memory, t0 + 3 * HOUR), null);
check("and allowed after them", selectBridge([weakAp], memory, t0 + 7 * HOUR)?.bridge.id, "jemh1-05");

memory = noteOffered(noteOffered({}, "jesc1-10", t0), "jemh1-05", t0 + 7 * HOUR);
check(
  "a third offer in one day is blocked",
  selectBridge([{ bookCode: "jesc1", chapter: 12, strength: 1, at: t0, source: "quiz" }], memory, t0 + 14 * HOUR),
  null,
);
check(
  "the day after, offers resume",
  selectBridge([{ bookCode: "jesc1", chapter: 12, strength: 1, at: t0, source: "quiz" }], memory, t0 + 40 * HOUR)?.bridge.id,
  "jesc1-12",
);

// A student having a genuinely bad afternoon: eight wrong chapters, and the
// engine must not turn that into eight interruptions.
let bad = {};
let offers = 0;
for (let i = 0; i < 8; i++) {
  const now = t0 + i * HOUR;
  const chosen = selectBridge(
    [
      { bookCode: "jesc1", chapter: 10, strength: 0.9, at: now, source: "quiz" },
      { bookCode: "jesc1", chapter: 12, strength: 0.8, at: now, source: "quiz" },
      { bookCode: "jemh1", chapter: 5, strength: 0.7, at: now, source: "quiz" },
      { bookCode: "jemh1", chapter: 9, strength: 0.6, at: now, source: "quiz" },
    ],
    bad,
    now,
  );
  if (chosen) {
    offers++;
    bad = noteOffered(bad, chosen.bridge.id, now);
  }
}
check("eight bad hours produce at most two offers", offers <= MAX_OFFERS_PER_DAY, true);
check("but at least one", offers >= 1, true);

// --- dismissal -------------------------------------------------------------

console.log("\n# dismissal\n");

memory = noteDismissed(noteOffered({}, "jesc1-10", t0), "jesc1-10", t0);
check("a dismissed offer goes quiet", selectBridge([weakEye], memory, t0 + 25 * HOUR), null);
check("and comes back quietly after two days", selectBridge([weakEye], memory, t0 + 3 * DAY)?.bridge.id, "jesc1-10");

memory = noteDismissed(noteOffered(memory, "jesc1-10", t0 + 3 * DAY), "jesc1-10", t0 + 3 * DAY);
check("dismissed twice is taken as final", selectBridge([weakEye], memory, t0 + 400 * DAY), null);
check("two dismissals is the limit", memory["jesc1-10"].dismissed, MAX_DISMISSALS);

// Dismissing one bridge must not silence a different, unrelated gap. Checked a
// day later than the last offer above, so it is the dismissal being tested and
// not the shared rate limit.
check(
  "dismissing one bridge does not silence another",
  selectBridge([weakAp], memory, t0 + 4 * DAY + HOUR)?.bridge.id,
  "jemh1-05",
);

// --- the weakness signal ---------------------------------------------------

console.log("\n# the weakness signal\n");

const quiz = (correct, total, extra = {}) =>
  Array.from({ length: total }, (_, i) => ({ bookCode: "jesc1", chapter: 10, correct: i < correct, ...extra }));

check("4 of 10 correct is a gap", signalsFromAnswers(quiz(4, 10), t0).length, 1);
check("8 of 10 correct is a slip, not a gap", signalsFromAnswers(quiz(8, 10), t0).length, 0);
check("10 of 10 raises nothing", signalsFromAnswers(quiz(10, 10), t0).length, 0);
check("the signal's strength is the fraction missed", signalsFromAnswers(quiz(4, 10), t0)[0].strength, 0.6);
check("an untagged question raises no concept", signalsFromAnswers(quiz(4, 10), t0)[0].concept, undefined);

// A question the bank ties to a concept bridge aims the offer at that concept.
const tagged = [
  { bookCode: "jesc1", chapter: 1, id: "jesc1-01-005", correct: false },
  { bookCode: "jesc1", chapter: 1, id: "jesc1-01-001", correct: true },
];
check("a tagged wrong answer names its concept", signalsFromAnswers(tagged, t0)[0].concept, "Balancing a chemical equation");
check("and that concept selects the short bridge", selectBridge(signalsFromAnswers(tagged, t0), {}, t0)?.bridge.id, "jesc1-01-balancing");

// No data is not the same as weak — the honesty rule from WeakAreas.tsx.
const confidence = (c, total, shaky) => [{ bookCode: "jesc1", chapter: 10, confidence: c, total, shaky }];
check("an untested chapter raises nothing", signalsFromConfidence(confidence(0, 0, 0), t0).length, 0);
check("a confident chapter raises nothing", signalsFromConfidence(confidence(0.85, 4, 0), t0).length, 0);
check("a shaky chapter raises a signal", signalsFromConfidence(confidence(0.3, 4, 3), t0).length, 1);
check(
  "the threshold is WEAK_CONFIDENCE",
  signalsFromConfidence(confidence(WEAK_CONFIDENCE, 4, 1), t0).length,
  0,
);
check(
  "repeated misses give a stronger signal than one",
  signalsFromConfidence(confidence(0.3, 4, 4), t0)[0].strength >
    signalsFromConfidence(confidence(0.3, 4, 0), t0)[0].strength,
  true,
);

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
