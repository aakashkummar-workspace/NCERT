"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ClassSwitcher from "@/components/ClassSwitcher";
import SubjectIcon from "@/components/SubjectIcon";
import { getClass, setClass } from "@/lib/prefs";
import type { ClassQuizSummary } from "@/lib/quiz";

/**
 * The class-wise quiz index.
 *
 * One class at a time, not both stacked: a Class 10 student scrolling past
 * every Class 9 subject to reach their own is the whole problem this screen
 * exists to avoid. The class comes from the same stored preference the home
 * screen uses, so it is already right on the first visit for a returning
 * student, and the switcher writes back to that same key — changing class here
 * changes it everywhere.
 *
 * The stored value is read after mount, never in a `useState` initialiser: the
 * page is prerendered with no idea which class this phone belongs to, so
 * seeding from storage would hydrate against different HTML.
 */
export default function QuizIndex({ index }: { index: ClassQuizSummary[] }) {
  const [cls, setCls] = useState<9 | 10 | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(getClass)
      .then((stored) => {
        if (!live) return;
        // No stored class yet: show Class 10 rather than an empty screen, and
        // do not write it — the home screen owns that first choice.
        setCls(stored ?? 10);
        setReady(true);
      })
      .catch(() => {
        if (live) {
          setCls(10);
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  function choose(next: 9 | 10) {
    setClass(next);
    setCls(next);
  }

  if (!ready || cls === null) {
    return (
      <div aria-hidden="true" className="animate-pulse">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="h-5 w-28 rounded bg-surface-alt" />
          <div className="h-9 w-40 rounded-full bg-surface-alt" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-[76px] rounded-2xl border border-border bg-surface" />
          ))}
        </div>
      </div>
    );
  }

  const summary = index.find((c) => c.cls === cls);
  const subjects = summary?.subjects ?? [];

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Class {cls}
          </p>
          <p className="text-xs text-ink-soft">
            {summary?.questionCount ?? 0} questions across {subjects.length} subjects
          </p>
        </div>
        <ClassSwitcher value={cls} onChange={choose} />
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {subjects.map((s) => {
          const empty = s.questionCount === 0;
          return (
            <li key={s.slug}>
              {/*
                A subject with no questions is still listed, greyed and not
                tappable. Hiding it would read as "not in my syllabus" when the
                truth is "nobody has written these yet", and the second is worth
                saying — especially for Class 9, where there is no sample paper
                either.
              */}
              {empty ? (
                <div className="flex min-h-[76px] items-center gap-4 rounded-2xl border border-dashed border-border p-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-alt text-ink-faint">
                    <SubjectIcon slug={s.slug} className="size-6" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-ink-soft break-words">{s.name}</span>
                    <span className="block text-xs text-ink-faint">No questions yet</span>
                  </span>
                </div>
              ) : (
                <Link
                  href={`/quiz/${cls}/${s.slug}`}
                  className="flex min-h-[76px] items-center gap-4 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
                >
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                    <SubjectIcon slug={s.slug} className="size-6" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium break-words">{s.name}</span>
                    <span className="block text-xs text-ink-faint">
                      {s.questionCount} {s.questionCount === 1 ? "question" : "questions"}
                      {s.chapterCount > 0 && ` · ${s.chapterCount} chapters`}
                    </span>
                  </span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>

      {subjects.every((s) => s.questionCount === 0) && (
        <div className="mt-6 rounded-2xl border border-dashed border-border p-5">
          <p className="text-sm text-ink-soft">
            Nothing has been written for Class {cls} yet.
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            NCERT ships no answer keys with the textbooks, so quiz questions cannot be extracted
            from them — they are authored into <code>data/questions.json</code> and appear here
            after the next build.
          </p>
          <Link
            href="/practice"
            className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-accent transition-colors hover:border-accent"
          >
            Sit a full sample paper instead
          </Link>
        </div>
      )}
    </>
  );
}
