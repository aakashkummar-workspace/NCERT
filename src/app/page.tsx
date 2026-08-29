"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ClassSwitcher from "@/components/ClassSwitcher";
import ContinueReading from "@/components/ContinueReading";
import DueBadge from "@/components/DueBadge";
import SubjectIcon from "@/components/SubjectIcon";
import { CLASSES, booksForClass, subjectsForClass, type ClassNum } from "@/lib/manifest";
import { allPapers } from "@/lib/papers";
import { getClass, setClass } from "@/lib/prefs";

/**
 * Home is a dashboard for one class, not a directory of the whole app.
 *
 * The stored class is read after mount, never in a `useState` initialiser: the
 * export is prerendered with no idea which class this phone belongs to, so
 * seeding state from storage would hydrate against different HTML. Until the
 * read lands we show a skeleton shaped like the dashboard, so the common case —
 * a returning student — settles into place instead of jumping.
 */

const SECONDARY = [
  {
    href: "/bookmarks",
    label: "Bookmarks",
    d: "M6.5 4.5h11v15l-5.5-3.7-5.5 3.7z",
  },
  {
    href: "/downloads",
    label: "Offline downloads",
    d: "M12 3.5v10m0 0 3.8-3.8M12 13.5 8.2 9.7M4.5 19h15",
  },
  {
    href: "/about",
    label: "About & sources",
    d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11.2V16.5M12 7.7h.01",
  },
];

export default function Home() {
  const [cls, setCls] = useState<ClassNum | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    // Resolved through a promise so state is never set in the effect body.
    Promise.resolve()
      .then(getClass)
      .then((stored) => {
        if (!live) return;
        setCls(stored);
        setReady(true);
      })
      .catch(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  function choose(next: ClassNum) {
    setClass(next);
    setCls(next);
  }

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-tight">NCERT Quick</h1>
            <p className="truncate text-xs text-ink-faint">Download once, read offline</p>
          </div>

          {/* Secondary destinations. Off the body so the primary ones stand out,
              but one tap away rather than buried. */}
          <nav aria-label="More" className="flex shrink-0 items-center">
            {SECONDARY.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                title={item.label}
                className="grid size-11 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d={item.d}
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-5">
        {!ready ? <Skeleton /> : cls === null ? <ClassPicker onPick={choose} /> : (
          <Dashboard cls={cls} onSwitch={choose} />
        )}
      </main>

      <footer className="border-t border-border px-4 py-5 text-center text-xs text-ink-faint">
        Textbook content © NCERT. This app links to and mirrors the official PDFs.
      </footer>
    </>
  );
}

/** Shaped like the dashboard it replaces, so nothing shifts when storage answers. */
function Skeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="h-8 w-32 rounded-lg bg-surface-alt" />
        <div className="h-9 w-40 rounded-full bg-surface-alt" />
      </div>
      <div className="h-4 w-24 rounded bg-surface-alt" />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[76px] rounded-2xl border border-border bg-surface" />
        ))}
      </div>
    </div>
  );
}

/** First launch only: nothing is stored yet, so ask once. */
function ClassPicker({ onPick }: { onPick: (cls: ClassNum) => void }) {
  return (
    <>
      <ContinueReading />

      <h2 className="mb-1 text-lg font-semibold tracking-tight">Choose your class</h2>
      <p className="mb-4 text-sm text-ink-soft">
        We&apos;ll remember it, and you can change it any time.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {CLASSES.map((cls) => {
          const books = booksForClass(cls);
          const chapters = books.reduce((n, b) => n + b.chapters.length, 0);
          return (
            <button
              key={cls}
              type="button"
              onClick={() => onPick(cls)}
              className="rounded-2xl border border-border bg-surface p-5 text-left transition-colors hover:border-accent/50"
            >
              <span className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight">{cls}</span>
                <span className="text-sm text-ink-soft">Class</span>
              </span>
              <span className="mt-3 block text-sm text-ink-soft">
                {subjectsForClass(cls).length} subjects · {books.length} books · {chapters}{" "}
                chapters
              </span>
              <span className="mt-1 block text-xs text-ink-faint">
                {subjectsForClass(cls)
                  .map((s) => s.name)
                  .join(" · ")}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function Dashboard({ cls, onSwitch }: { cls: ClassNum; onSwitch: (cls: ClassNum) => void }) {
  const subjects = subjectsForClass(cls);
  const books = booksForClass(cls);
  const chapters = books.reduce((n, b) => n + b.chapters.length, 0);
  const papers = allPapers().filter((p) => p.class === cls).length;

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Your class
          </p>
          <p className="truncate text-xs text-ink-soft">
            {subjects.length} subjects · {chapters} chapters
          </p>
        </div>
        <ClassSwitcher value={cls} onChange={onSwitch} />
      </div>

      <ContinueReading />

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">
          Your subjects
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {subjects.map((s) => (
            <li key={s.slug}>
              <Link
                href={`/class/${cls}/${s.slug}`}
                className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
              >
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                  <SubjectIcon slug={s.slug} className="size-6" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block text-xs text-ink-faint">
                    {s.books.length === 1 ? "1 book" : `${s.books.length} books`} ·{" "}
                    {s.chapterCount} chapters
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">
          Get exam ready
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* First of the three: a five-minute quiz is the thing a student will
              actually start on a phone, where a three-hour paper is not. */}
          <Link
            href="/quiz"
            className="rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50 sm:col-span-2"
          >
            {/* No question count here on purpose: home is a client component,
                so reading one would bundle the whole question bank into the
                first page every student loads. The count is on /quiz, which
                slices it per class anyway. */}
            <span className="block text-sm font-medium">Chapter quiz</span>
            <span className="mt-1 block text-xs text-ink-soft">
              Short multiple-choice quizzes, marked as you go, with the reason for every answer
            </span>
          </Link>

          <Link
            href="/practice"
            className="rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
          >
            <span className="block text-sm font-medium">Practice papers</span>
            <span className="mt-1 block text-xs text-ink-soft">
              {papers > 0
                ? `${papers} official CBSE ${papers === 1 ? "paper" : "papers"} for Class ${cls}, timed and self-scored`
                : `CBSE publishes no sample papers for Class ${cls} — Class 10's are still worth a look`}
            </span>
          </Link>

          <Link
            href="/revise"
            className="rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
          >
            <span className="flex items-center text-sm font-medium">
              Revise
              <DueBadge />
            </span>
            <span className="mt-1 block text-xs text-ink-soft">
              Questions you got wrong, resurfaced on schedule
            </span>
          </Link>
        </div>
      </section>
    </>
  );
}
