import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import DownloadButton from "@/components/DownloadButton";
import RecentAttempts from "@/components/RecentAttempts";
import {
  allPapers,
  formatDuration,
  paperPdfPath,
  schemePdfPath,
  type Paper,
} from "@/lib/papers";

export const metadata = { title: "Practice papers — NCERT Quick" };

interface ClassGroup {
  cls: 9 | 10;
  papers: Paper[];
}

/**
 * Class ascending to match the home screen, and within a class the newest
 * session first — last year's paper is the one worth sitting.
 */
function groupByClass(papers: Paper[]): ClassGroup[] {
  const byClass = new Map<9 | 10, Paper[]>();
  for (const p of papers) {
    const list = byClass.get(p.class) ?? [];
    list.push(p);
    byClass.set(p.class, list);
  }

  const groups = [...byClass.entries()].map(([cls, list]) => ({
    cls,
    papers: list.sort(
      (a, b) => b.session.localeCompare(a.session) || a.subject.localeCompare(b.subject),
    ),
  }));
  groups.sort((a, b) => a.cls - b.cls);
  return groups;
}

export default function PracticePage() {
  const groups = groupByClass(allPapers());

  return (
    <>
      <AppHeader
        title="Practice papers"
        subtitle="Official CBSE sample papers, timed"
        back={{ href: "/", label: "home" }}
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <p className="mb-6 text-sm text-ink-soft">
          A real timed paper: the clock runs, you write your answers by hand as you would in the
          exam, and only then does the official marking scheme unlock so you can score yourself.
        </p>

        {/* A full paper is a two- or three-hour commitment. Offer the short form
            beside it rather than making a student find it under another tab. */}
        <Link
          href="/quiz"
          className="mb-6 flex min-h-14 items-center gap-3 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M9 11.5l2 2 4.5-4.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Chapter quizzes</span>
            <span className="mt-0.5 block text-xs text-ink-soft">
              Ten minutes instead of three hours, marked instantly
            </span>
          </span>
        </Link>

        <RecentAttempts />

        {groups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center">
            <p className="text-sm text-ink-soft">No sample papers are mirrored yet.</p>
            <p className="mt-1 text-xs text-ink-faint">
              CBSE publishes them at the start of each session; they appear here once the content
              pipeline has fetched them.
            </p>
            <Link
              href="/"
              className="mt-4 inline-block text-sm text-accent underline underline-offset-4"
            >
              Browse subjects
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.cls}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Class {g.cls}
                </h2>
                <ul className="space-y-3">
                  {g.papers.map((p) => (
                    <li
                      key={p.slug}
                      className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-4"
                    >
                      <Link
                        href={`/practice/${p.slug}`}
                        className="min-w-0 flex-1 transition-colors hover:text-accent"
                      >
                        <p className="text-sm font-medium">{p.subject}</p>
                        <p className="mt-0.5 text-xs text-ink-faint">{p.title}</p>
                        <p className="mt-2 text-xs tabular-nums text-ink-soft">
                          {p.maxMarks} marks · {p.questionCount} questions ·{" "}
                          {formatDuration(p.durationMinutes)} · {p.session}
                        </p>
                      </Link>

                      {/* Both PDFs are offered offline: a paper you cannot open on
                          exam morning is no use, and the scheme is half the exercise. */}
                      <div className="flex shrink-0 gap-2">
                        <div className="flex flex-col items-center gap-1">
                          <DownloadButton
                            url={paperPdfPath(p)}
                            bytes={p.paperBytes}
                            label={`${p.subject} question paper`}
                          />
                          <span className="text-[10px] text-ink-faint">Paper</span>
                        </div>
                        <div className="flex flex-col items-center gap-1">
                          <DownloadButton
                            url={schemePdfPath(p)}
                            bytes={p.schemeBytes}
                            label={`${p.subject} marking scheme`}
                          />
                          <span className="text-[10px] text-ink-faint">Scheme</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
