import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import DownloadButton from "@/components/DownloadButton";
import RecentAttempts from "@/components/RecentAttempts";
import {
  allPapers,
  formatDuration,
  isScorable,
  paperPdfPath,
  schemePdfPath,
  type Paper,
} from "@/lib/papers";

export const metadata = { title: "Practice papers — NCERT Quick" };

interface ClassGroup {
  cls: 9 | 10;
  /** Sittable: the app has a mark grid to score against. */
  scorable: Paper[];
  /** Readable only: the pipeline could not derive one. */
  reading: Paper[];
}

/**
 * Class ascending to match the home screen, and within a class the newest
 * session first — last year's paper is the one worth sitting.
 *
 * Scorable papers come first as a block rather than interleaved by session:
 * with 66 papers listed, a student looking for one to sit should not have to
 * open three read-only ones to find it.
 */
function groupByClass(papers: Paper[]): ClassGroup[] {
  const byClass = new Map<9 | 10, Paper[]>();
  for (const p of papers) {
    const list = byClass.get(p.class) ?? [];
    list.push(p);
    byClass.set(p.class, list);
  }

  const bySession = (a: Paper, b: Paper) =>
    b.session.localeCompare(a.session) || a.subject.localeCompare(b.subject);

  const groups = [...byClass.entries()].map(([cls, list]) => ({
    cls,
    scorable: list.filter(isScorable).sort(bySession),
    reading: list.filter((p) => !isScorable(p)).sort(bySession),
  }));
  groups.sort((a, b) => a.cls - b.cls);
  return groups;
}

/**
 * One paper in the list. A read-only row carries the pill and drops the
 * question count — how the paper divides into questions is precisely what is
 * not known about it, so a number there would be the one lie on the screen.
 */
function PaperRow({ paper, scorable }: { paper: Paper; scorable: boolean }) {
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-4">
      <Link
        href={`/practice/${paper.slug}`}
        className="min-w-0 flex-1 transition-colors hover:text-accent"
      >
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {paper.subject}
          {!scorable && (
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
              Read only
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-ink-faint">{paper.title}</p>
        {/* Built by filter rather than written out, because two of these facts
            can be missing on a harvested paper: one 2021-22 term paper carries
            no total at all, and the question count belongs to the grid. */}
        <p className="mt-2 text-xs tabular-nums text-ink-soft">
          {[
            paper.maxMarks > 0 ? `${paper.maxMarks} marks` : null,
            scorable ? `${paper.questionCount} questions` : null,
            formatDuration(paper.durationMinutes),
            paper.session,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Link>

      {/* Both PDFs are offered offline: a paper you cannot open on
          exam morning is no use, and the scheme is half the exercise. */}
      <div className="flex shrink-0 gap-2">
        <div className="flex flex-col items-center gap-1">
          <DownloadButton
            url={paperPdfPath(paper)}
            bytes={paper.paperBytes}
            label={`${paper.subject} question paper`}
          />
          <span className="text-[10px] text-ink-faint">Paper</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <DownloadButton
            url={schemePdfPath(paper)}
            bytes={paper.schemeBytes}
            label={`${paper.subject} marking scheme`}
          />
          <span className="text-[10px] text-ink-faint">Scheme</span>
        </div>
      </div>
    </li>
  );
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
          Papers marked <span className="font-medium text-ink">read only</span> come with their
          scheme too, but you mark those against a clock of your own.
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

                {g.scorable.length > 0 && (
                  <>
                    <p className="mb-2 text-xs text-ink-soft">
                      {g.scorable.length} to sit and score
                    </p>
                    <ul className="space-y-3">
                      {g.scorable.map((p) => (
                        <PaperRow key={p.slug} paper={p} scorable />
                      ))}
                    </ul>
                  </>
                )}

                {g.reading.length > 0 && (
                  <>
                    <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                      Read only
                    </h3>
                    <p className="mb-2 mt-1 text-xs text-ink-soft">
                      {g.reading.length} more, paper and scheme both complete. These print no mark
                      grid the app can read, so it does not offer to score them.
                    </p>
                    <ul className="space-y-3">
                      {g.reading.map((p) => (
                        <PaperRow key={p.slug} paper={p} scorable={false} />
                      ))}
                    </ul>
                  </>
                )}
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
