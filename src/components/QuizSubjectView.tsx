"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import QuizRunner from "@/components/QuizRunner";
import { latestByChapter, type QuizAttempt } from "@/lib/quiz-attempts";
import type { ChapterQuizGroup, QuizQuestion } from "@/lib/quiz";

/**
 * A subject's quiz: pick a chapter, then sit it, without leaving the page.
 *
 * The quiz runs in place rather than at its own route because the whole bank
 * for this subject is already in the page payload — navigating would fetch a
 * second document to show questions the browser is holding. It also means a
 * student who finishes a chapter is one tap from the next one.
 *
 * Only this subject's questions are ever shipped here. The server component
 * slices them per route, so a phone downloads Class 10 Science and nothing else.
 */

interface Run {
  questions: QuizQuestion[];
  bookCode?: string;
  chapter?: number;
  scopeLabel: string;
}

/** How many questions a mixed quiz draws. Long enough to be a test, short enough to finish. */
const MIXED_SIZE = 15;

/** Fisher–Yates. Called only from event handlers, so never during hydration. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A mixed quiz should not be 15 questions from whichever chapter happens to
 * have the most. Take them round-robin across chapters first, so every chapter
 * with questions is represented before any chapter contributes a second one.
 */
function spread(groups: ChapterQuizGroup[], size: number): QuizQuestion[] {
  const pools = groups.map((g) => shuffled(g.questions));
  const out: QuizQuestion[] = [];
  for (let round = 0; out.length < size; round++) {
    let took = 0;
    for (const pool of pools) {
      if (round >= pool.length) continue;
      out.push(pool[round]);
      took++;
      if (out.length === size) break;
    }
    if (took === 0) break;
  }
  return shuffled(out);
}

export default function QuizSubjectView({
  cls,
  subject,
  groups,
  loose,
}: {
  cls: 9 | 10;
  subject: string;
  groups: ChapterQuizGroup[];
  /** Questions in this subject that named no chapter we could resolve. */
  loose: QuizQuestion[];
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<Map<string, QuizAttempt>>(new Map());

  useEffect(() => {
    let live = true;
    // Never set state in the effect body; only from the promise callback.
    latestByChapter()
      .then((m) => live && setHistory(m))
      // A private window can refuse IndexedDB outright. No badges is the right
      // fallback — the quizzes themselves still work.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [run]);

  const total = groups.reduce((n, g) => n + g.questions.length, 0) + loose.length;

  if (run) {
    return (
      <QuizRunner
        questions={run.questions}
        classNum={cls}
        subject={subject}
        bookCode={run.bookCode}
        chapter={run.chapter}
        scopeLabel={run.scopeLabel}
        onExit={() => setRun(null)}
        onRestart={(questions) => setRun({ ...run, questions: shuffled(questions) })}
      />
    );
  }

  if (total === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-ink-soft">
          No {subject} questions have been written for Class {cls} yet.
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          NCERT publishes no answer keys, so nothing here can be extracted from the textbooks —
          questions are added to the bank by hand and appear after the next build.
        </p>
        <Link
          href={`/class/${cls}/${subjectSlugOf(subject)}`}
          className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-accent transition-colors hover:border-accent"
        >
          Read the chapters instead
        </Link>
      </div>
    );
  }

  return (
    <>
      {groups.length > 1 && (
        <button
          type="button"
          onClick={() =>
            setRun({
              questions: spread(groups, MIXED_SIZE),
              scopeLabel: `${subject} · mixed`,
            })
          }
          className="mb-6 flex w-full min-h-14 items-center gap-3 rounded-2xl bg-accent px-4 py-3 text-left text-accent-ink transition-opacity hover:opacity-90"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-ink/15">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h9M4 12h16M4 17h6M17 4l3 3-3 3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Mixed quiz</span>
            <span className="block text-xs opacity-90">
              {Math.min(MIXED_SIZE, total)} questions drawn across {groups.length} chapters
            </span>
          </span>
        </button>
      )}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
        By chapter
      </h2>
      <ul className="space-y-3">
        {groups.map((g) => {
          const last = history.get(`${g.bookCode}:${g.chapter}`);
          return (
            <li key={`${g.bookCode}:${g.chapter}`}>
              <button
                type="button"
                onClick={() =>
                  setRun({
                    questions: shuffled(g.questions),
                    bookCode: g.bookCode,
                    chapter: g.chapter,
                    scopeLabel: `Chapter ${g.chapter} · ${g.chapterTitle}`,
                  })
                }
                className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/50"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-alt text-xs font-semibold tabular-nums text-ink-soft">
                  {g.chapter}
                </span>
                <span className="min-w-0 flex-1">
                  {/* The chapter title is why the row exists, so it wraps. */}
                  <span className="block text-sm leading-snug font-medium break-words">
                    {g.chapterTitle}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-faint">
                    {g.questions.length} {g.questions.length === 1 ? "question" : "questions"}
                    {last && (
                      <>
                        {" · last time "}
                        <span className="tabular-nums text-ink-soft">
                          {last.correct}/{last.total}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M8 5l8 7-8 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {loose.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Not tied to a chapter
          </h2>
          <button
            type="button"
            onClick={() =>
              setRun({
                questions: shuffled(loose),
                scopeLabel: `${subject} · unsorted`,
              })
            }
            className="flex w-full min-h-14 items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/50"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {loose.length} {loose.length === 1 ? "question" : "questions"}
              </span>
              {/* Said plainly, because these do not feed the weak-area
                  dashboard and a student should know why. */}
              <span className="mt-0.5 block text-xs text-ink-faint">
                These name no chapter, so answering them will not update your progress
              </span>
            </span>
          </button>
        </section>
      )}
    </>
  );
}

/** Local copy of the manifest's slug rule; importing it would pull the manifest client-side. */
function subjectSlugOf(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
