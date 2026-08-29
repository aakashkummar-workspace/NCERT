"use client";

/**
 * What happened when a student sat a quiz, and what the rest of the app learns
 * from it.
 *
 * Two stores are written on finishing a quiz, and they answer different
 * questions:
 *
 *  - `ncert-quiz` keeps the attempt itself, so the chapter picker can show
 *    "last time: 7/10" and the student can see whether they are improving.
 *  - The existing SM-2 card table (`ncert-revision`) gets **one card per
 *    chapter**, exactly the card `ChapterRating` writes.
 *
 * That second choice is the important one. A quiz on chapter 2 is a measurement
 * of chapter 2, so it belongs on the same card a self-rating writes rather than
 * on a new per-question card: the weak-area dashboard and the revision queue
 * then pick it up with no changes at all, and an objective score simply
 * overrides an earlier guess about the same chapter. Writing per-question cards
 * would instead flood /revise with hundreds of one-mark MCQs and leave the
 * dashboard reading "not tested yet" until someone joined them back up.
 */
import Dexie, { type EntityTable } from "dexie";
import { upsertCard, review, type Confidence } from "./revision";
import type { QuizQuestion } from "./quiz";

export interface QuizAttempt {
  /** `${scope}:${at}` — unique per sitting, so re-attempts accumulate. */
  id: string;
  classNum: 9 | 10;
  subject: string;
  /** Absent for a mixed quiz spanning several chapters. */
  bookCode?: string;
  chapter?: number;
  /** Human label for the result list: "Chapter 2" or "Mixed". */
  scopeLabel: string;
  total: number;
  correct: number;
  marks: number;
  maxMarks: number;
  /** Ids of the questions answered wrongly, for a "retry mistakes" run. */
  wrong: string[];
  at: number;
  durationMs: number;
}

const db = new Dexie("ncert-quiz") as Dexie & {
  attempts: EntityTable<QuizAttempt, "id">;
};

db.version(1).stores({
  attempts: "id, at, classNum, subject, bookCode, [bookCode+chapter]",
});

/**
 * Score to self-rating.
 *
 * The bands are deliberately generous at the bottom: a student who scores 4/10
 * has not "failed" the chapter, they have found the half they do not know, and
 * SM-2's "again" would put it back tomorrow either way. The top band is strict
 * because "easy" pushes the next review out by weeks, and one lucky MCQ run
 * should not buy that.
 */
export function confidenceFromScore(correct: number, total: number): Confidence {
  if (total === 0) return "again";
  const ratio = correct / total;
  if (ratio >= 0.9) return "easy";
  if (ratio >= 0.7) return "good";
  if (ratio >= 0.4) return "hard";
  return "again";
}

export interface AnsweredQuestion {
  question: QuizQuestion;
  /** Index the student chose, or null if they skipped it. */
  chosen: number | null;
}

function scoreOf(answers: AnsweredQuestion[]) {
  let correct = 0;
  let marks = 0;
  let maxMarks = 0;
  const wrong: string[] = [];
  for (const a of answers) {
    maxMarks += a.question.marks;
    if (a.chosen === a.question.answer) {
      correct++;
      marks += a.question.marks;
    } else {
      wrong.push(a.question.id);
    }
  }
  return { correct, marks, maxMarks, wrong };
}

export interface SavedResult {
  attempt: QuizAttempt;
  /** Chapters whose revision schedule this attempt moved. */
  chaptersScheduled: number;
}

/**
 * Record a finished quiz: store the attempt and advance the SM-2 schedule for
 * every chapter it touched.
 *
 * Storage can be unavailable outright (private windows refuse IndexedDB), so
 * every caller must be prepared for this to throw; the UI shows the score
 * regardless, because the score is already on screen and losing the record is
 * not worth losing the result over.
 */
export async function saveQuizResult(
  answers: AnsweredQuestion[],
  meta: {
    classNum: 9 | 10;
    subject: string;
    bookCode?: string;
    chapter?: number;
    scopeLabel: string;
    durationMs: number;
  },
  now = Date.now(),
): Promise<SavedResult> {
  const { correct, marks, maxMarks, wrong } = scoreOf(answers);

  const attempt: QuizAttempt = {
    id: `${meta.bookCode ?? meta.subject}:${meta.chapter ?? "mixed"}:${now}`,
    classNum: meta.classNum,
    subject: meta.subject,
    bookCode: meta.bookCode,
    chapter: meta.chapter,
    scopeLabel: meta.scopeLabel,
    total: answers.length,
    correct,
    marks,
    maxMarks,
    wrong,
    at: now,
    durationMs: meta.durationMs,
  };
  await db.attempts.put(attempt);

  // A mixed quiz measures several chapters at once, so each is rated on its own
  // slice rather than on the quiz as a whole — scoring 10/10 on chapter 1 must
  // not mark chapter 2 as known.
  const byChapter = new Map<string, AnsweredQuestion[]>();
  for (const a of answers) {
    const { bookCode, chapter } = a.question;
    if (!bookCode || chapter === undefined) continue;
    const key = `${bookCode}:${chapter}`;
    const list = byChapter.get(key) ?? [];
    list.push(a);
    byChapter.set(key, list);
  }

  for (const [key, slice] of byChapter) {
    const [bookCode, chapterStr] = key.split(":");
    const chapter = Number(chapterStr);
    const s = scoreOf(slice);
    const card = await upsertCard({
      sourceType: "exercise",
      sourceId: bookCode,
      subject: meta.subject,
      classNum: meta.classNum,
      bookCode,
      chapter,
      questionNo: chapter,
      maxMarks: s.maxMarks,
      lastScore: s.marks,
    });
    await review(card.id, confidenceFromScore(s.correct, slice.length), now);
  }

  return { attempt, chaptersScheduled: byChapter.size };
}

/** Most recent attempts, newest first. */
export async function recentQuizAttempts(limit = 5): Promise<QuizAttempt[]> {
  const all = await db.attempts.orderBy("at").reverse().limit(limit).toArray();
  return all;
}

/**
 * The latest attempt per chapter, keyed `bookCode:chapter`, for the badges on
 * the chapter picker. Mixed attempts are excluded: they say nothing about any
 * one chapter's row.
 */
export async function latestByChapter(): Promise<Map<string, QuizAttempt>> {
  const all = await db.attempts.toArray();
  const out = new Map<string, QuizAttempt>();
  for (const a of all) {
    if (!a.bookCode || a.chapter === undefined) continue;
    const key = `${a.bookCode}:${a.chapter}`;
    const prev = out.get(key);
    if (!prev || a.at > prev.at) out.set(key, a);
  }
  return out;
}

export async function clearQuizAttempts(): Promise<void> {
  await db.attempts.clear();
}
