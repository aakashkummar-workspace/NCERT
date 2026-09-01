"use client";

/**
 * One dual-track sitting, stored on the device.
 *
 * A test is a single exam with two tracks under one clock. Section A is marked
 * by the app the moment the paper is submitted; Section B is written by hand on
 * paper, exactly as in the hall, and this store records only the student's
 * *intent to submit written work* — which questions they attempted, and where
 * the page they wrote will later be attached. **Nothing here photographs or
 * grades an answer.** That is another lane's work, and the seam between the two
 * is `WrittenHandoff`, documented below.
 *
 * ## The clock
 *
 * `startedAt` is a wall-clock stamp and the remaining time is always derived
 * from it, never accumulated. This module does not re-implement that: it
 * imports `remainingMs` / `isExpired` from `src/lib/attempts.ts` and re-exports
 * them, so a three-hour dual-track sitting and a three-hour sample paper cannot
 * drift apart. The reason is in that file's header and it is worth repeating —
 * across three hours a phone locks, the tab is backgrounded and intervals are
 * throttled or stopped, so a countdown that subtracts a second per tick ends up
 * wildly ahead of the wall clock and cannot survive a reload.
 *
 * ## The score
 *
 * One sitting, one score. `scoreTest` adds the auto-marked Section A to the
 * Section B marks and that total is what the student sees and what the
 * revision engine is fed. Section B marks come from the grading lane where it
 * has supplied a grade, and from the student's own marking against the official
 * scheme where it has not — `writtenMarks` is the single place that precedence
 * is decided.
 *
 * ## Revision
 *
 * On finishing, this writes **one SM-2 card per chapter**, which is the same
 * card `ChapterRating`, /quiz and this app's whole revision model already use.
 * Section A questions carry a chapter through `bookCode` from the manifest;
 * Section B questions carry one through their rubric. Marks from both tracks
 * land in the same per-chapter bucket, because a chapter a student is weak on
 * is weak whether they missed the MCQ or lost the five-marker. A Section B
 * question with no rubric has no chapter to go to, so it falls back to the
 * per-question `paper` card `src/lib/attempts.ts` already writes for /practice.
 * Either way `/revise` and `/progress` need no code of their own.
 *
 * The pure halves — `markSectionA`, `writtenMarks`, `scoreTest`, `handoffId` —
 * are dependency-free so they can be checked in plain Node; see
 * scripts/test-dualtrack.mjs.
 */
import Dexie, { type EntityTable } from "dexie";
import { confidenceFor, formatClock, isExpired, remainingMs } from "./attempts";
import { review, upsertCard } from "./revision";
import type { ClassNum } from "./manifest";
import type { QuestionType as PaperQuestionType } from "./papers";
import type { DualTrackTest } from "./tests";

/**
 * The clock, re-exported rather than re-implemented. A dual-track sitting and a
 * sample-paper sitting must not be able to drift apart, so there is exactly one
 * derivation of "how long is left" in the app and this is it.
 */
export { formatClock, isExpired, remainingMs };

export type TestAttemptStatus = "in-progress" | "submitted";

/**
 * What the student has said about one Section B question.
 *
 * Three states, not two, and the third is the point. `unmarked` is the state
 * every row starts in and means **the student has not said anything yet** —
 * it is the absence of a declaration, not a declaration of a blank. `skipped`
 * is the student saying, in as many words, that they left the question out;
 * that is a genuine zero and it is scored as one.
 *
 * The distinction used to be inferred from a default. Every row began at
 * `"unattempted"` and `writtenMarks` read that as zero, so a sitting where a
 * student ticked two of nineteen boxes scored the other seventeen at nought
 * and scheduled every one of them for re-revision at confidence "again" —
 * exactly what the comment on `writeRevisionCards` says must not happen. A
 * default cannot carry a meaning; only a state the student put the row into
 * can. Hence three names.
 *
 * Attempts written before this existed carry the old `"unattempted"` string.
 * `writtenMarks` treats any status that is not `written` or `skipped` as
 * unmarked, which reads a legacy blank as "nobody said" — the lenient reading,
 * and the one that cannot invent a zero the student never claimed.
 */
export type WrittenStatus = "unmarked" | "written" | "skipped";

/** One Section A question as this sitting recorded it. */
export interface McqResponse {
  /** Position in Section A, 1-based. */
  n: number;
  questionId: string;
  bookCode?: string;
  chapter?: number;
  maxMarks: number;
  /**
   * 0-based index of the right option, copied in when the attempt starts.
   *
   * Carried on the attempt rather than looked up later so a finished sitting can
   * be re-scored, and a result sheet re-drawn, without the question bank — the
   * bank is authored and may be edited or re-ordered between attempts.
   */
  correct: number;
  /** What the student chose; null while unanswered, and after time is up. */
  chosen: number | null;
}

// --- the Section B handoff ------------------------------------------------

/**
 * What one step of a rubric came to, for the green/orange/red overlay described
 * in data/rubrics.schema.md. Opaque here: this module never produces one.
 */
export interface WrittenStepOutcome {
  stepId: string;
  outcome: "hit" | "partial" | "miss" | "unmarked";
  awarded: number;
}

/**
 * A mark awarded to a written answer, by whoever awarded it.
 *
 * `source` is the whole point of the field. `self` is the student marking their
 * own page against the official scheme, which is what /practice has always done;
 * `rubric` is the grading lane matching a photographed answer against
 * data/rubrics.json; `teacher` is a human overriding either. A grade of any
 * source supersedes the student's self-report — see `writtenMarks`.
 */
export interface WrittenGrade {
  awarded: number;
  maxMarks: number;
  gradedAt: number;
  source: "self" | "rubric" | "teacher";
  /** Which rubric, and which variant of it, the answer was matched against. */
  rubricId?: string;
  variant?: string;
  steps?: WrittenStepOutcome[];
  /**
   * Copied from the rubric. While true nothing may be painted red: an unchecked
   * conversion may accuse a student of writing nothing of value.
   */
  needsReview?: boolean;
}

/**
 * **The handoff contract.** This is the seam between this lane and the scan and
 * grading lanes, and it is the only part of this module another lane writes to.
 *
 * A `WrittenHandoff` is created — one per Section B question — when the attempt
 * starts, and it never moves or changes identity afterwards. `id` is stable for
 * the life of the attempt and is the key to write back on:
 *
 *   1. This lane creates it, filled in down to `chapter`, and leaves `scanId`
 *      and `grade` undefined. `pendingHandoffs()` lists exactly the ones a
 *      student says they wrote and nobody has graded.
 *   2. The scan lane photographs the page and calls `attachScan(id, scanId)`.
 *      `scanId` is opaque here — this module never dereferences it, so the scan
 *      lane owns its own storage entirely.
 *   3. The grading lane reads `rubricIds` (empty where the file has no rubric
 *      for that question yet), grades the scan against them and calls
 *      `attachGrade(id, grade)`.
 *
 * Both writers are idempotent and both are safe to call after the sitting is
 * finished: `attachGrade` re-totals the attempt and re-runs the revision write,
 * so a grade that arrives late still reaches /revise. Neither ever needs to
 * touch the attempt record directly, and neither can move a mark to the wrong
 * question, because `questionNo` is the paper's own printed number — the same
 * number the rubric, the marking scheme and the student's page all use.
 */
export interface WrittenHandoff {
  /** `${attemptId}#${questionNo}` — stable, and unique across all attempts. */
  id: string;
  attemptId: string;
  /** The source paper, for the mirrored PDF and the marking scheme. */
  paperSlug: string;
  /** The number the paper prints, not a position in a list. */
  questionNo: number;
  maxMarks: number;
  /** Every rubric in data/rubrics.json for this question; variants included. */
  rubricIds: string[];
  /** From the rubric, via the manifest — where a grade is filed for revision. */
  bookCode?: string;
  chapter?: number;
  /** Written by the scan lane only. Opaque to this module. */
  scanId?: string;
  capturedAt?: number;
  /** Written by the grading lane only. */
  grade?: WrittenGrade;
}

/** What the student declared about a Section B question they wrote on paper. */
export interface WrittenAnswer {
  n: number;
  section: string;
  topic?: string;
  /**
   * The paper's own form for this question, carried so a finished sitting can
   * be described to the server without the paper. Optional: a sitting written
   * before the sync existed has none, and reads as a short answer.
   */
  type?: PaperQuestionType;
  maxMarks: number;
  /**
   * "written" is the intent to submit a page, "skipped" is the student saying
   * they left it out, and "unmarked" — the state every row starts in — is the
   * student having said nothing at all. See `WrittenStatus`.
   */
  status: WrittenStatus;
  /** Marks the student gave themselves against the scheme; null until scored. */
  selfMarks: number | null;
  handoff: WrittenHandoff;
}

export interface TestAttempt {
  /** `${testSlug}:${startedAt}` */
  id: string;
  testSlug: string;
  paperSlug: string;
  title: string;
  subject: string;
  classNum: ClassNum;
  /** Wall-clock ms — the timer's ONLY source of truth. */
  startedAt: number;
  durationMs: number;
  submittedAt?: number;
  status: TestAttemptStatus;
  sectionA: McqResponse[];
  sectionB: WrittenAnswer[];
  maxMarks: number;
  /**
   * The `Attempt.id` this sitting was synced to, once it has been.
   *
   * A UUID minted by the server; the Dexie key above is what the server knows
   * it by (`Attempt.clientAttemptId`). Undefined means the sitting has never
   * reached the server, which is the normal state of an exam sat on a train:
   * `src/lib/handoff-sync.ts` retries later, and nothing about the sitting
   * depends on it.
   */
  serverAttemptId?: string;
  /** Set by finaliseTest, and refreshed whenever a late grade arrives. */
  sectionAMarks?: number;
  sectionBMarks?: number;
  totalScore?: number;
}

// --- pure scoring ---------------------------------------------------------

const MINUTE_MS = 60 * 1000;

export const handoffId = (attemptId: string, questionNo: number): string =>
  `${attemptId}#${questionNo}`;

export interface SectionAResult {
  correct: number;
  answered: number;
  total: number;
  marks: number;
  maxMarks: number;
  /** Ids of the questions got wrong, for a "retry mistakes" run in /quiz. */
  wrong: string[];
}

/**
 * Mark Section A. An unanswered question is wrong, not excluded: in an exam a
 * blank scores nothing, and counting it out would flatter the percentage.
 */
export function markSectionA(responses: McqResponse[]): SectionAResult {
  let correct = 0;
  let answered = 0;
  let marks = 0;
  let maxMarks = 0;
  const wrong: string[] = [];
  for (const r of responses) {
    maxMarks += r.maxMarks;
    if (r.chosen !== null) answered++;
    if (r.chosen !== null && r.chosen === r.correct) {
      correct++;
      marks += r.maxMarks;
    } else {
      wrong.push(r.questionId);
    }
  }
  return { correct, answered, total: responses.length, marks, maxMarks, wrong };
}

/**
 * What one written answer is worth, and the one place that precedence lives.
 *
 * A grade from the grading lane wins over the student's own marking — it was
 * produced against the official rubric, and the student may not even have marked
 * that question. `null` means nobody has scored it yet, which is different from
 * zero: an unscored question is skipped by the revision write rather than
 * treated as a question the student got wrong.
 *
 * **A question the student never touched is `null`, not zero.** It is the third
 * status, not a default, that decides this — see `WrittenStatus`.
 */
export function writtenMarks(answer: WrittenAnswer): number | null {
  if (answer.handoff.grade) return answer.handoff.grade.awarded;
  // Said to be blank by the student: a real zero, and scored as one.
  if (answer.status === "skipped") return 0;
  // Nothing said. Not `written` and not `skipped` — including the legacy
  // `"unattempted"` a sitting from before this distinction existed carries —
  // is the absence of a declaration, and the absence of a declaration is not
  // a zero. It is skipped by the revision write rather than treated as a
  // question the student got wrong.
  if (answer.status !== "written") return null;
  return answer.selfMarks;
}

export interface TestScore {
  sectionAMarks: number;
  sectionAMax: number;
  sectionBMarks: number;
  sectionBMax: number;
  total: number;
  maxMarks: number;
  /** Section B questions nobody has scored yet; they count zero in `total`. */
  unscored: number;
}

/** One sitting, one score: the auto-marked half plus the written half. */
export function scoreTest(attempt: Pick<TestAttempt, "sectionA" | "sectionB">): TestScore {
  const a = markSectionA(attempt.sectionA);
  let sectionBMarks = 0;
  let sectionBMax = 0;
  let unscored = 0;
  for (const w of attempt.sectionB) {
    sectionBMax += w.maxMarks;
    const marks = writtenMarks(w);
    if (marks === null) unscored++;
    else sectionBMarks += marks;
  }
  return {
    sectionAMarks: a.marks,
    sectionAMax: a.maxMarks,
    sectionBMarks,
    sectionBMax,
    total: a.marks + sectionBMarks,
    maxMarks: a.maxMarks + sectionBMax,
    unscored,
  };
}

// --- storage --------------------------------------------------------------

const db = new Dexie("ncert-tests") as Dexie & {
  attempts: EntityTable<TestAttempt, "id">;
};

db.version(1).stores({
  attempts: "id, testSlug, paperSlug, startedAt, status",
});

const attemptKey = (testSlug: string, startedAt: number) => `${testSlug}:${startedAt}`;

/**
 * Begin a test — or resume the one already running.
 *
 * Reloading mid-exam must not restart the clock, so an in-progress attempt at
 * this test is returned as-is. An expired-but-unsubmitted attempt still counts:
 * submitting it is what unlocks a fresh run.
 */
export async function startTestAttempt(test: DualTrackTest): Promise<TestAttempt> {
  const running = await activeTestAttempt(test.slug);
  if (running) return running;

  // Two attempts in the same millisecond would share a key.
  let startedAt = Date.now();
  while (await db.attempts.get(attemptKey(test.slug, startedAt))) startedAt++;
  const id = attemptKey(test.slug, startedAt);

  const attempt: TestAttempt = {
    id,
    testSlug: test.slug,
    paperSlug: test.paperSlug,
    title: test.title,
    subject: test.subject,
    classNum: test.classNum,
    startedAt,
    durationMs: test.durationMinutes * MINUTE_MS,
    status: "in-progress",
    sectionA: test.sectionA.map((item) => ({
      n: item.n,
      questionId: item.question.id,
      bookCode: item.question.bookCode,
      chapter: item.question.chapter,
      maxMarks: item.marks,
      correct: item.question.answer,
      chosen: null,
    })),
    sectionB: test.sectionB.map((item) => ({
      n: item.n,
      section: item.section,
      topic: item.topic,
      type: item.type,
      maxMarks: item.maxMarks,
      status: "unmarked",
      selfMarks: null,
      handoff: {
        id: handoffId(id, item.n),
        attemptId: id,
        paperSlug: test.paperSlug,
        questionNo: item.n,
        maxMarks: item.maxMarks,
        rubricIds: item.rubrics.map((r) => r.id),
        bookCode: item.bookCode,
        chapter: item.chapter,
      },
    })),
    maxMarks: test.maxMarks,
  };

  await db.attempts.put(attempt);
  return attempt;
}

export async function getTestAttempt(id: string): Promise<TestAttempt | undefined> {
  return db.attempts.get(id);
}

export async function activeTestAttempt(testSlug: string): Promise<TestAttempt | undefined> {
  const running = await db.attempts
    .where("testSlug")
    .equals(testSlug)
    .filter((a) => a.status === "in-progress")
    .toArray();
  running.sort((a, b) => b.startedAt - a.startedAt);
  return running[0];
}

/** Newest first, so the history list reads as a timeline. */
export async function testAttemptsFor(testSlug: string): Promise<TestAttempt[]> {
  const list = await db.attempts.where("testSlug").equals(testSlug).toArray();
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

export async function recentTestAttempts(limit = 10): Promise<TestAttempt[]> {
  return db.attempts.orderBy("startedAt").reverse().limit(limit).toArray();
}

export async function deleteTestAttempt(id: string): Promise<void> {
  await db.attempts.delete(id);
}

/**
 * Every write below reads and writes inside one transaction, for the reason
 * src/lib/attempts.ts gives: the UI does not await these — forty inputs must not
 * block on IndexedDB between keystrokes — so several are in flight at once, and
 * without the transaction each rewrites the whole record from its own stale
 * snapshot and the last write silently erases the one before it.
 */
function edit(
  id: string,
  change: (attempt: TestAttempt) => TestAttempt | undefined,
): Promise<TestAttempt | undefined> {
  return db.transaction("rw", db.attempts, async () => {
    const attempt = await db.attempts.get(id);
    if (!attempt) return undefined;
    const updated = change(attempt);
    if (!updated) return attempt;
    await db.attempts.put(updated);
    return updated;
  });
}

/** Record a Section A choice. Answers may be changed until the paper is submitted. */
export async function answerMcq(
  id: string,
  n: number,
  chosen: number | null,
): Promise<TestAttempt | undefined> {
  return edit(id, (attempt) => {
    if (attempt.status !== "in-progress") return undefined;
    return {
      ...attempt,
      sectionA: attempt.sectionA.map((r) => (r.n === n ? { ...r, chosen } : r)),
    };
  });
}

/** Record that a Section B answer was written on paper, or left blank. */
export async function setWrittenStatus(
  id: string,
  n: number,
  status: WrittenStatus,
): Promise<TestAttempt | undefined> {
  return edit(id, (attempt) => {
    const sectionB = attempt.sectionB.map((w) =>
      w.n === n ? { ...w, status, selfMarks: status === "written" ? w.selfMarks : null } : w,
    );
    // Declaring a question blank after the total has been published moves the
    // total: it is a mark the student has now claimed, where before there was
    // no claim at all.
    return { ...attempt, sectionB, ...publishedTotals(attempt, sectionB) };
  });
}

/**
 * Record the marks the student gave a written answer. Clamped to what the
 * question is out of and snapped to the half mark CBSE awards, so a mistyped 30
 * on a 3-mark question cannot flatter the total or hand SM-2 a false "easy".
 */
export async function saveWrittenMarks(
  id: string,
  n: number,
  marks: number | null,
): Promise<TestAttempt | undefined> {
  return edit(id, (attempt) => {
    const row = attempt.sectionB.find((w) => w.n === n);
    if (!row) return undefined;
    const next =
      marks === null
        ? null
        : Math.min(row.maxMarks, Math.max(0, Math.round(marks * 2) / 2));
    const sectionB = attempt.sectionB.map((w) =>
      w.n === n ? { ...w, selfMarks: next, status: next === null ? w.status : "written" } : w,
    );
    return { ...attempt, sectionB, ...publishedTotals(attempt, sectionB) };
  });
}

/** Keep an already-published total honest when a mark is corrected afterwards. */
function publishedTotals(
  attempt: TestAttempt,
  sectionB: WrittenAnswer[],
): Partial<TestAttempt> {
  if (attempt.totalScore === undefined) return {};
  const s = scoreTest({ sectionA: attempt.sectionA, sectionB });
  return { sectionAMarks: s.sectionAMarks, sectionBMarks: s.sectionBMarks, totalScore: s.total };
}

/**
 * End the timed phase and unlock the marking scheme.
 *
 * A test whose time ran out while the tab was closed is submitted at its natural
 * end time, not when the student happened to come back — otherwise a phone left
 * in a pocket overnight records a fourteen-hour sitting.
 */
export async function submitTestAttempt(
  id: string,
  now = Date.now(),
): Promise<TestAttempt | undefined> {
  return edit(id, (attempt) => {
    if (attempt.status === "submitted") return undefined;
    return {
      ...attempt,
      status: "submitted",
      submittedAt: Math.min(now, attempt.startedAt + attempt.durationMs),
    };
  });
}

// --- the handoff, written by the scan and grading lanes -------------------

/** Locate a handoff by its stable id, wherever it lives. */
export async function findHandoff(id: string): Promise<WrittenHandoff | undefined> {
  const attemptId = id.split("#")[0];
  const attempt = await db.attempts.get(attemptId);
  return attempt?.sectionB.find((w) => w.handoff.id === id)?.handoff;
}

/**
 * Attach a photographed page to a written answer. Called by the scan lane;
 * `scanId` is opaque to this module and is never dereferenced here.
 */
export async function attachScan(
  id: string,
  scanId: string,
  capturedAt = Date.now(),
): Promise<TestAttempt | undefined> {
  const attemptId = id.split("#")[0];
  return edit(attemptId, (attempt) => ({
    ...attempt,
    sectionB: attempt.sectionB.map((w) =>
      w.handoff.id === id
        ? { ...w, status: "written", handoff: { ...w.handoff, scanId, capturedAt } }
        : w,
    ),
  }));
}

/**
 * Attach a grade to a written answer. Called by the grading lane.
 *
 * A grade that lands after the sitting was finished re-totals it and re-runs the
 * revision write, so a page graded tomorrow still reaches /revise — which is why
 * the return value is worth keeping: the caller can show the new total.
 */
export async function attachGrade(
  id: string,
  grade: WrittenGrade,
): Promise<TestAttempt | undefined> {
  const attemptId = id.split("#")[0];
  const updated = await edit(attemptId, (attempt) => {
    const sectionB = attempt.sectionB.map((w) =>
      w.handoff.id === id ? { ...w, status: "written" as const, handoff: { ...w.handoff, grade } } : w,
    );
    return { ...attempt, sectionB, ...publishedTotals(attempt, sectionB) };
  });
  if (updated?.totalScore !== undefined) await writeRevisionCards(updated);
  return updated;
}

/**
 * Remember which server `Attempt` this sitting is. Written by the sync in
 * `src/lib/handoff-sync.ts` and by nothing else; idempotent, because the server
 * keys on `clientAttemptId` and so answers with the same id every time.
 */
export async function setServerAttemptId(
  id: string,
  serverAttemptId: string,
): Promise<TestAttempt | undefined> {
  return edit(id, (attempt) =>
    attempt.serverAttemptId === serverAttemptId
      ? undefined
      : { ...attempt, serverAttemptId },
  );
}

/** Every sitting on this device, newest first. */
export async function allTestAttempts(): Promise<TestAttempt[]> {
  const all = await db.attempts.toArray();
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

/** Written answers a student says they wrote and nobody has graded yet. */
export async function pendingHandoffs(): Promise<WrittenHandoff[]> {
  const all = await db.attempts.toArray();
  return all.flatMap((a) =>
    a.sectionB
      .filter((w) => w.status === "written" && !w.handoff.grade)
      .map((w) => w.handoff),
  );
}

// --- finishing ------------------------------------------------------------

/**
 * Total the sitting and feed the revision engine.
 *
 * Calling this twice must not advance the SM-2 schedule twice, and the student
 * will call it twice: they finish marking, spot a mistake, fix it and press save
 * again. `upsertCard` is idempotent; `review` is not, since it is what moves the
 * interval. So a card already reviewed at or after this attempt's submission is
 * left alone — its schedule already reflects this sitting, or a genuine later
 * review that should not be undone.
 */
export async function finaliseTest(id: string): Promise<TestAttempt | undefined> {
  // Totalling reads the marks back, so it has to be atomic against a save still
  // in flight from the last keystroke before Finish was pressed. The card writes
  // stay outside: they belong to another Dexie database.
  const updated = await edit(id, (attempt) => {
    const s = scoreTest(attempt);
    return {
      ...attempt,
      sectionAMarks: s.sectionAMarks,
      sectionBMarks: s.sectionBMarks,
      totalScore: s.total,
    };
  });
  if (!updated) return undefined;
  await writeRevisionCards(updated);
  return updated;
}

interface ChapterBucket {
  bookCode: string;
  chapter: number;
  score: number;
  maxMarks: number;
}

/**
 * One card per chapter, plus the per-question fallback for written answers that
 * have no rubric and so no chapter.
 *
 * Both tracks pour into the same per-chapter bucket and the card is rated on
 * marks out of marks, with the same bands /practice uses. Rating a chapter on
 * the whole sitting instead would mark chapter 2 as known because chapter 1 went
 * well, which is the mistake `saveQuizResult` already avoids.
 */
async function writeRevisionCards(attempt: TestAttempt): Promise<void> {
  const reviewedFrom = attempt.submittedAt ?? attempt.startedAt;
  const buckets = new Map<string, ChapterBucket>();

  function pour(bookCode: string, chapter: number, score: number, maxMarks: number) {
    const key = `${bookCode}:${chapter}`;
    const bucket = buckets.get(key) ?? { bookCode, chapter, score: 0, maxMarks: 0 };
    bucket.score += score;
    bucket.maxMarks += maxMarks;
    buckets.set(key, bucket);
  }

  for (const r of attempt.sectionA) {
    if (!r.bookCode || r.chapter === undefined) continue;
    pour(r.bookCode, r.chapter, r.chosen === r.correct ? r.maxMarks : 0, r.maxMarks);
  }

  // Unscored written answers are skipped rather than assumed zero: a student who
  // has only marked half the paper should not be told the other half was wrong.
  const loose: WrittenAnswer[] = [];
  for (const w of attempt.sectionB) {
    const marks = writtenMarks(w);
    if (marks === null) continue;
    const { bookCode, chapter } = w.handoff;
    if (bookCode && chapter !== undefined) pour(bookCode, chapter, marks, w.maxMarks);
    else loose.push(w);
  }

  for (const bucket of buckets.values()) {
    const card = await upsertCard({
      sourceType: "exercise",
      sourceId: bucket.bookCode,
      subject: attempt.subject,
      classNum: attempt.classNum,
      bookCode: bucket.bookCode,
      chapter: bucket.chapter,
      questionNo: bucket.chapter,
      maxMarks: bucket.maxMarks,
      lastScore: bucket.score,
    });
    if (card.lastReviewedAt !== undefined && card.lastReviewedAt >= reviewedFrom) continue;
    await review(card.id, confidenceFor(bucket.score, bucket.maxMarks));
  }

  for (const w of loose) {
    const marks = writtenMarks(w) ?? 0;
    const card = await upsertCard({
      sourceType: "paper",
      sourceId: attempt.paperSlug,
      subject: attempt.subject,
      classNum: attempt.classNum,
      questionNo: w.n,
      maxMarks: w.maxMarks,
      lastScore: marks,
    });
    if (card.lastReviewedAt !== undefined && card.lastReviewedAt >= reviewedFrom) continue;
    await review(card.id, confidenceFor(marks, w.maxMarks));
  }
}
