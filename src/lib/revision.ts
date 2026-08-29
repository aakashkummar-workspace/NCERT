"use client";

/**
 * Spaced-repetition scheduling (Phase 4).
 *
 * Every question a student self-scores becomes a card. The scheduler decides
 * when to show it again, so revision concentrates on what they got wrong rather
 * than on what they already know.
 *
 * The algorithm is SM-2. The pure scheduling maths is deliberately separated
 * from storage so it can be tested without a browser — see scripts/test-sm2.mjs.
 *
 * Cards carry `subject` / `bookCode` / `chapter` so the Phase 5 dashboard can
 * cross confidence against the syllabus marks weightage.
 */
import Dexie, { type EntityTable } from "dexie";

/**
 * How well the student felt they did. Deliberately four buttons, not SM-2's
 * raw 0–5: students cannot calibrate six levels honestly, and self-assessment
 * is already noisy.
 */
export type Confidence = "again" | "hard" | "good" | "easy";

/** Map the four buttons onto SM-2 quality grades. */
const GRADE: Record<Confidence, number> = { again: 1, hard: 3, good: 4, easy: 5 };

/** Below this, SM-2 treats the answer as failed and restarts the interval. */
const PASS_GRADE = 3;

/** SM-2's floor; below it intervals collapse and cards churn forever. */
const MIN_EASE = 1.3;
const DEFAULT_EASE = 2.5;

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface Card {
  /** `${sourceType}:${sourceId}:${questionNo}` */
  id: string;
  sourceType: "paper" | "exercise";
  /** paper slug, or NCERT book code for an exercise */
  sourceId: string;
  subject: string;
  classNum: 9 | 10;
  /** Present where the question can be tied to a chapter; drives Phase 5. */
  bookCode?: string;
  chapter?: number;
  questionNo: number;
  maxMarks?: number;
  /** Marks the student gave themselves on the most recent attempt. */
  lastScore?: number;

  // --- SM-2 state ---
  ease: number;
  /** Days until the next review. */
  interval: number;
  repetitions: number;
  dueAt: number;
  lastConfidence?: Confidence;
  lastReviewedAt?: number;
  createdAt: number;
}

export interface Schedule {
  ease: number;
  interval: number;
  repetitions: number;
  dueAt: number;
}

/**
 * Pure SM-2 step. Given a card's current schedule and how the student rated
 * themselves, return the next schedule.
 *
 * Exported (and dependency-free) so it can be unit-tested in plain Node.
 */
export function schedule(
  current: Pick<Card, "ease" | "interval" | "repetitions">,
  confidence: Confidence,
  now = Date.now(),
): Schedule {
  const q = GRADE[confidence];

  // Ease drifts with performance, but never below the floor.
  const ease = Math.max(MIN_EASE, current.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  if (q < PASS_GRADE) {
    // Failed: relearn tomorrow, but keep the (reduced) ease we just computed.
    return { ease, interval: 1, repetitions: 0, dueAt: now + DAY_MS };
  }

  const repetitions = current.repetitions + 1;
  let interval: number;
  if (current.repetitions === 0) interval = 1;
  else if (current.repetitions === 1) interval = 6;
  else interval = Math.round(current.interval * ease);

  return { ease, interval, repetitions, dueAt: now + interval * DAY_MS };
}

/** A brand-new card is due immediately — it has never been reviewed. */
export function newCardState(now = Date.now()): Schedule {
  return { ease: DEFAULT_EASE, interval: 0, repetitions: 0, dueAt: now };
}

export function cardId(
  sourceType: Card["sourceType"],
  sourceId: string,
  questionNo: number,
): string {
  return `${sourceType}:${sourceId}:${questionNo}`;
}

// --- storage -------------------------------------------------------------

const db = new Dexie("ncert-revision") as Dexie & {
  cards: EntityTable<Card, "id">;
};

db.version(1).stores({
  cards: "id, dueAt, subject, classNum, bookCode, sourceId",
});

export type NewCard = Omit<
  Card,
  "ease" | "interval" | "repetitions" | "dueAt" | "createdAt" | "id"
>;

/**
 * Create or update a card after a question is scored.
 *
 * Re-attempting a paper must not reset the student's scheduling history, so an
 * existing card keeps its SM-2 state and only refreshes the descriptive fields.
 */
export async function upsertCard(input: NewCard, now = Date.now()): Promise<Card> {
  const id = cardId(input.sourceType, input.sourceId, input.questionNo);
  const existing = await db.cards.get(id);
  const card: Card = existing
    ? { ...existing, ...input, id }
    : { ...input, id, ...newCardState(now), createdAt: now };
  await db.cards.put(card);
  return card;
}

/** Record a review and advance the schedule. */
export async function review(
  id: string,
  confidence: Confidence,
  now = Date.now(),
): Promise<Card | undefined> {
  const card = await db.cards.get(id);
  if (!card) return undefined;
  const next = schedule(card, confidence, now);
  const updated: Card = { ...card, ...next, lastConfidence: confidence, lastReviewedAt: now };
  await db.cards.put(updated);
  return updated;
}

/** Cards due now, hardest first so limited study time goes to the weakest material. */
export async function dueCards(limit = 20, now = Date.now()): Promise<Card[]> {
  const due = await db.cards.where("dueAt").belowOrEqual(now).toArray();
  due.sort((a, b) => a.ease - b.ease || a.dueAt - b.dueAt);
  return due.slice(0, limit);
}

export async function dueCount(now = Date.now()): Promise<number> {
  return db.cards.where("dueAt").belowOrEqual(now).count();
}

export interface ChapterConfidence {
  bookCode: string;
  chapter: number;
  total: number;
  shaky: number;
  /** 0–1; lower means weaker. Derived from ease, which is what SM-2 tracks. */
  confidence: number;
}

/**
 * Per-chapter confidence, for the Phase 5 weak-area dashboard.
 *
 * "Shaky" is any card whose ease has fallen below the default — i.e. the
 * student has got it wrong or found it hard at least once.
 */
export async function chapterConfidence(): Promise<ChapterConfidence[]> {
  const all = await db.cards.toArray();
  const byChapter = new Map<string, Card[]>();
  for (const c of all) {
    if (!c.bookCode || c.chapter === undefined) continue;
    const key = `${c.bookCode}:${c.chapter}`;
    const list = byChapter.get(key) ?? [];
    list.push(c);
    byChapter.set(key, list);
  }

  return [...byChapter.entries()].map(([key, cards]) => {
    const [bookCode, chapter] = key.split(":");
    const shaky = cards.filter((c) => c.ease < DEFAULT_EASE).length;
    // Normalise ease (1.3–2.5+) onto 0–1 so it can be shown as a bar.
    const avgEase = cards.reduce((n, c) => n + c.ease, 0) / cards.length;
    return {
      bookCode,
      chapter: Number(chapter),
      total: cards.length,
      shaky,
      confidence: Math.max(0, Math.min(1, (avgEase - MIN_EASE) / (DEFAULT_EASE - MIN_EASE))),
    };
  });
}

export async function allCards(): Promise<Card[]> {
  return db.cards.toArray();
}

export async function clearAll(): Promise<void> {
  await db.cards.clear();
}
