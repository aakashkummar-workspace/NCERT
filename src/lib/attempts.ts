"use client";

/**
 * A timed run at a CBSE sample paper, and the marks the student gives themselves.
 *
 * CBSE papers are overwhelmingly descriptive, so nothing here tries to grade an
 * answer. The student writes on paper, as in the exam, then marks their own work
 * against the official scheme — which is the honest model, and reading the scheme
 * is itself an exam skill. Each scored question becomes a revision card, so this
 * store is the input to the SM-2 engine in src/lib/revision.ts.
 *
 * The countdown is derived, never accumulated: `startedAt` is a wall-clock stamp
 * in IndexedDB and the remaining time is always `startedAt + durationMs - now`.
 * A phone locks, backgrounds the tab and throttles timers repeatedly across three
 * hours, so a clock counted from interval ticks would drift or die; one that
 * cannot survive a reload is worse than no clock at all. That is why
 * `remainingMs` / `isExpired` are pure functions of (startedAt, durationMs, now)
 * — and, like the SM-2 maths, testable without a browser. See
 * scripts/test-attempts.mjs.
 */
import Dexie, { type EntityTable } from "dexie";
import { review, upsertCard, type Confidence } from "@/lib/revision";

export type AttemptStatus = "in-progress" | "submitted";

export interface QuestionScore {
  n: number;
  maxMarks: number;
  /** Marks the student awarded themselves; null until scored, or when skipped. */
  score: number | null;
  /** False when the student left the question blank in the exam. */
  attempted: boolean;
}

export interface Attempt {
  /** `${paperSlug}:${startedAt}` */
  id: string;
  paperSlug: string;
  subject: string;
  classNum: 9 | 10;
  /** Wall-clock ms — the timer's ONLY source of truth. */
  startedAt: number;
  durationMs: number;
  submittedAt?: number;
  status: AttemptStatus;
  scores: QuestionScore[];
  /** Set by finaliseScoring. */
  totalScore?: number;
  maxMarks: number;
}

// --- the clock ------------------------------------------------------------

const MINUTE_MS = 60 * 1000;

/** Milliseconds left in the paper, clamped at zero. */
export function remainingMs(
  a: Pick<Attempt, "startedAt" | "durationMs">,
  now = Date.now(),
): number {
  return Math.max(0, a.startedAt + a.durationMs - now);
}

export function isExpired(
  a: Pick<Attempt, "startedAt" | "durationMs">,
  now = Date.now(),
): boolean {
  return now >= a.startedAt + a.durationMs;
}

/** `H:MM:SS` — hours unpadded, because "3:00:00" reads as a paper length. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Turn a mark out of a maximum into one of SM-2's four buttons.
 *
 * Full or near-full marks is "easy"; a pass is "good"; anything scraped is
 * "hard"; a zero is "again" whatever the question was out of.
 */
export function confidenceFor(score: number, maxMarks: number): Confidence {
  if (score <= 0) return "again";
  const ratio = maxMarks > 0 ? score / maxMarks : 0;
  if (ratio >= 0.9) return "easy";
  if (ratio >= 0.6) return "good";
  return "hard";
}

// --- storage --------------------------------------------------------------

const db = new Dexie("ncert-attempts") as Dexie & {
  attempts: EntityTable<Attempt, "id">;
};

db.version(1).stores({
  attempts: "id, paperSlug, startedAt, status",
});

const attemptId = (paperSlug: string, startedAt: number) => `${paperSlug}:${startedAt}`;

const sumScores = (scores: QuestionScore[]): number =>
  scores.reduce((n, q) => n + (q.score ?? 0), 0);

/**
 * Begin a paper — or resume the one already running.
 *
 * Reloading mid-exam (or reopening the tab after the phone locked) must not
 * restart the clock, so an in-progress attempt at this paper is returned as-is
 * rather than replaced. An expired-but-unsubmitted attempt still counts: it is
 * the caller's job to submit it, which is what unlocks a fresh run.
 */
export async function startAttempt(input: {
  paperSlug: string;
  subject: string;
  classNum: 9 | 10;
  durationMinutes: number;
  maxMarks: number;
  questions: { n: number; maxMarks: number }[];
}): Promise<Attempt> {
  const running = await activeAttempt(input.paperSlug);
  if (running) return running;

  // Two attempts at the same paper in the same millisecond would share a key.
  let startedAt = Date.now();
  while (await db.attempts.get(attemptId(input.paperSlug, startedAt))) startedAt++;

  const attempt: Attempt = {
    id: attemptId(input.paperSlug, startedAt),
    paperSlug: input.paperSlug,
    subject: input.subject,
    classNum: input.classNum,
    startedAt,
    durationMs: input.durationMinutes * MINUTE_MS,
    status: "in-progress",
    scores: input.questions.map((q) => ({
      n: q.n,
      maxMarks: q.maxMarks,
      score: null,
      attempted: true,
    })),
    maxMarks: input.maxMarks,
  };
  await db.attempts.put(attempt);
  return attempt;
}

export async function getAttempt(id: string): Promise<Attempt | undefined> {
  return db.attempts.get(id);
}

export async function activeAttempt(paperSlug: string): Promise<Attempt | undefined> {
  const running = await db.attempts
    .where("paperSlug")
    .equals(paperSlug)
    .filter((a) => a.status === "in-progress")
    .toArray();
  running.sort((a, b) => b.startedAt - a.startedAt);
  return running[0];
}

/**
 * End the timed phase and unlock the marking scheme.
 *
 * A paper whose time ran out while the tab was closed is submitted at its
 * natural end time, not at the moment the student happened to come back —
 * otherwise a phone left in a pocket overnight records a 14-hour attempt.
 */
export async function submitAttempt(id: string, now = Date.now()): Promise<Attempt | undefined> {
  return db.transaction("rw", db.attempts, async () => {
    const attempt = await db.attempts.get(id);
    if (!attempt) return undefined;
    if (attempt.status === "submitted") return attempt;

    const updated: Attempt = {
      ...attempt,
      status: "submitted",
      submittedAt: Math.min(now, attempt.startedAt + attempt.durationMs),
    };
    await db.attempts.put(updated);
    return updated;
  });
}

/**
 * Record the marks for one question. Marks are clamped to what the question is
 * out of, since a mistyped 30 on a 3-mark question would otherwise flatter the
 * total and hand SM-2 a false "easy". Returns undefined if the attempt has no
 * such question number.
 *
 * The read and the write are one transaction because the caller does not await
 * this — 39 number inputs must not block on IndexedDB between keystrokes, so
 * several saves can be in flight at once. Without the transaction each one
 * rewrites the whole record from its own stale snapshot and the last write
 * silently erases the marks entered just before it, while the optimistic UI
 * goes on showing them as saved.
 */
export async function saveScore(
  id: string,
  n: number,
  score: number | null,
  attempted = true,
): Promise<Attempt | undefined> {
  return db.transaction("rw", db.attempts, async () => {
    const attempt = await db.attempts.get(id);
    if (!attempt) return undefined;
    const row = attempt.scores.find((q) => q.n === n);
    if (!row) return undefined;

    const next: number | null =
      !attempted || score === null ? null : Math.max(0, Math.min(row.maxMarks, score));
    const scores = attempt.scores.map((q) => (q.n === n ? { ...q, score: next, attempted } : q));

    const updated: Attempt = {
      ...attempt,
      scores,
      // Keep an already-published total honest when a mark is corrected.
      totalScore: attempt.totalScore === undefined ? undefined : sumScores(scores),
    };
    await db.attempts.put(updated);
    return updated;
  });
}

/**
 * Total the attempt and push every scored question into the revision engine.
 *
 * Unscored questions are skipped rather than assumed zero — a student who has
 * only marked half the paper should not be told the other half was wrong.
 *
 * Calling this twice must not advance the SM-2 schedule twice, and the student
 * will call it twice: they finish scoring, spot a mistake, fix it and press save
 * again. `upsertCard` is idempotent by design, but `review` is not — it is the
 * step that moves the card's interval. So a card already reviewed at or after
 * this attempt's submission is left alone; its schedule already reflects this
 * paper (or a genuine later review, which should not be undone). A second,
 * genuinely new attempt has a later `submittedAt` and so does review again.
 */
export async function finaliseScoring(id: string): Promise<Attempt | undefined> {
  // Totalling reads the scores back, so it has to be atomic against a saveScore
  // still in flight from the last keystroke before Finish was pressed. The card
  // writes stay outside: they belong to the revision database, and holding this
  // transaction open across them would span two Dexie instances.
  const updated = await db.transaction("rw", db.attempts, async () => {
    const attempt = await db.attempts.get(id);
    if (!attempt) return undefined;
    const totalled: Attempt = { ...attempt, totalScore: sumScores(attempt.scores) };
    await db.attempts.put(totalled);
    return totalled;
  });
  if (!updated) return undefined;

  const reviewedFrom = updated.submittedAt ?? updated.startedAt;
  for (const q of updated.scores) {
    if (q.score === null) continue;
    const card = await upsertCard({
      sourceType: "paper",
      sourceId: updated.paperSlug,
      subject: updated.subject,
      classNum: updated.classNum,
      questionNo: q.n,
      maxMarks: q.maxMarks,
      lastScore: q.score,
    });
    if (card.lastReviewedAt !== undefined && card.lastReviewedAt >= reviewedFrom) continue;
    await review(card.id, confidenceFor(q.score, q.maxMarks));
  }

  return updated;
}

/** Newest first, so the history list reads as a timeline. */
export async function attemptsFor(paperSlug: string): Promise<Attempt[]> {
  const list = await db.attempts.where("paperSlug").equals(paperSlug).toArray();
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

export async function recentAttempts(limit = 10): Promise<Attempt[]> {
  return db.attempts.orderBy("startedAt").reverse().limit(limit).toArray();
}

export async function deleteAttempt(id: string): Promise<void> {
  await db.attempts.delete(id);
}
