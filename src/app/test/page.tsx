import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import { formatDuration } from "@/lib/papers";
import { formatMarks, testIndex, totalTests, type DualTrackTest } from "@/lib/tests";

export const metadata = { title: "Tests — NCERT Quick" };

/**
 * The dual-track test index.
 *
 * Only the assembled *summaries* reach the client here — counts, marks and
 * slugs, never the questions themselves. The bank is sliced per test on its own
 * route, so this page costs the same however large the bank grows.
 *
 * Class ascending, then subject, then newest session first: the same reading
 * order /practice uses, so a student who knows one list knows the other.
 */
function TestRow({ test }: { test: DualTrackTest }) {
  return (
    <li>
      <Link
        href={`/test/${test.slug}`}
        className="block rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
      >
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-medium">
          {test.session}
          <span className="text-xs font-normal text-ink-faint">{test.title}</span>
        </p>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-ink-soft">
          <span>
            <span className="font-medium text-ink">A</span> {test.sectionA.length} objective ·{" "}
            {formatMarks(test.sectionAMarks)}
          </span>
          <span>
            <span className="font-medium text-ink">B</span> {test.sectionB.length} written ·{" "}
            {formatMarks(test.sectionBMarks)}
          </span>
        </p>
        <p className="mt-1 text-xs tabular-nums text-ink-faint">
          {[
            `${formatMarks(test.maxMarks)} marks`,
            formatDuration(test.durationMinutes),
            test.rubricCount > 0 ? `${test.rubricCount} rubrics` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Link>
    </li>
  );
}

export default function TestPage() {
  const groups = testIndex();

  return (
    <>
      <AppHeader
        title="Tests"
        subtitle={`${totalTests()} dual-track sittings`}
        back={{ href: "/", label: "home" }}
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <p className="mb-6 text-sm text-ink-soft">
          A whole CBSE paper in one sitting. Section A is objective and the app marks it; Section B
          is the descriptive half, written by hand out of the question paper. One clock covers
          both, and one score comes out at the end.
        </p>

        {groups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center">
            <p className="text-sm text-ink-soft">No dual-track tests can be assembled yet.</p>
            <p className="mt-1 text-xs text-ink-faint">
              A test needs both halves: a sample paper with a readable mark grid, and quiz
              questions in the same subject for Section A.
            </p>
            <Link
              href="/practice"
              className="mt-4 inline-block text-sm text-accent underline underline-offset-4"
            >
              Browse practice papers
            </Link>
          </div>
        ) : (
          <div className="space-y-8">
            {groups.map((group) => (
              <section key={group.cls}>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Class {group.cls}
                </h2>
                <div className="space-y-6">
                  {group.subjects.map((s) => (
                    <div key={s.subject}>
                      <h3 className="mb-2 text-sm font-medium">{s.subject}</h3>
                      <ul className="space-y-3">
                        {s.tests.map((test) => (
                          <TestRow key={test.slug} test={test} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <div className="mt-8 rounded-2xl border border-border bg-surface p-4">
          <p className="text-xs text-ink-soft">
            Section A is drawn from the same question bank as{" "}
            <Link href="/quiz" className="text-accent underline underline-offset-4">
              the chapter quizzes
            </Link>
            ; Section B is the descriptive half of the sample paper you can also sit on its own
            under{" "}
            <Link href="/practice" className="text-accent underline underline-offset-4">
              practice papers
            </Link>
            . A test scores both together.
          </p>
        </div>
      </main>
    </>
  );
}
