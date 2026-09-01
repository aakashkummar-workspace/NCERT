"use client";

/**
 * What this student has sat, and honestly what became of it.
 *
 * `GET /api/attempts/` had no caller at all: the route listed a student's
 * sittings and nothing on the device ever asked. This is that consumer, and it
 * exists because the two exam flows end in different places — a practice paper
 * ends on its own score screen, a dual-track sitting on its own done screen,
 * and neither is a list. "Which papers have I sat, and which of them is anybody
 * still marking?" had no screen to be answered on.
 *
 * ## The four states are four states, not a progress bar
 *
 * A sitting can be self-marked and never sent; sent and not yet marked; partly
 * marked; or sat and not marked at all. Only the first of those is a *finished*
 * sitting in the flow most students use, and it is the one a "0 marked" badge
 * would make look broken. So each row says which of them it is in words, and
 * `ResultsList` next door is the precedent: the distinction between "queued"
 * and "marked" is the whole point of the sentence.
 *
 * ## The sync happens before the list is drawn
 *
 * A practice paper finished offline is on the device and not on the server, so
 * asking the server first would show a student a list missing the paper they
 * just sat. `syncPending()` pushes whatever is outstanding, then the list is
 * fetched. It never throws and never blocks: with no network the push does
 * nothing, the fetch fails, and the screen says it could not reach the server
 * rather than claiming there are no sittings.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { syncPending } from "@/lib/handoff-sync";
import { getPaper } from "@/lib/papers";

interface Sitting {
  id: string;
  clientAttemptId: string;
  paperSlug: string;
  subject: string;
  classNum: number;
  status: string;
  maxMarks: number;
  totalScore: number | null;
  startedAt: string;
  submittedAt: string | null;
  /** Rows in the mark grid — the size of the paper. */
  questions: number;
  /** How many the student marked themselves against the scheme. */
  selfMarked: number;
  /** How many were photographed and submitted for somebody else to mark. */
  sent: number;
  /** How many have a mark back, from a rubric or a teacher. */
  marked: number;
  submissions: number;
}

// Client-only, so there is no server render to mismatch on hydration.
const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "3", "1.5" — never "3.0", which reads as a precision the marks do not have. */
function formatMarks(marks: number): string {
  return Number.isInteger(marks) ? String(marks) : marks.toFixed(1);
}

/**
 * Where this sitting came from, and so where "sit it again" goes.
 *
 * Both flows write `${slug}:${startedAt}` as their Dexie key, but the slug is
 * the *test's* for a dual-track sitting and the *paper's* for a practice one —
 * and a dual-track test names a paper, so `paperSlug` alone cannot tell them
 * apart. The prefix can, and it is the client's own id rather than anything
 * this screen guessed. A key in neither shape (an older sitting, a hand-written
 * one) is left unlinked rather than sent somewhere plausible.
 */
function origin(s: Sitting): { href: string; label: string } | null {
  const prefix = s.clientAttemptId.slice(0, s.clientAttemptId.lastIndexOf(":"));
  if (!prefix) return null;
  if (prefix === s.paperSlug) return { href: `/practice/${s.paperSlug}`, label: "Practice paper" };
  return { href: `/test/${prefix}`, label: "Dual-track test" };
}

/**
 * What happened to this sitting, said plainly.
 *
 * A sitting with nothing sent for marking is not a sitting that failed — it is
 * the ordinary end of a self-marked paper, and it says so. Nothing here reports
 * a mark that has not been awarded.
 */
function state(s: Sitting): string {
  if (s.status !== "SUBMITTED") return "still running — the clock has not stopped";
  if (s.marked > 0 && s.marked === s.sent) {
    return `marked — ${s.marked} of your written answer${s.marked === 1 ? "" : "s"} came back`;
  }
  if (s.marked > 0) return `${s.marked} of ${s.sent} sent for marking have come back`;
  if (s.sent > 0) {
    return `${s.sent} answer${s.sent === 1 ? "" : "s"} sent for marking — nothing back yet`;
  }
  if (s.selfMarked > 0) {
    return `self-marked, ${s.selfMarked} of ${s.questions} scored · nothing sent for marking`;
  }
  return "sat, and not marked by anyone yet";
}

export default function SittingsList() {
  const [rows, setRows] = useState<Sitting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    /* `.then` with a `live` guard rather than an async effect body — the same
       shape as RevisionQueue and GradeSync, for the same reason: a resolve
       after the student has left must be a no-op, not a state update on a dead
       tree. */
    syncPending()
      .then(() => fetch("/api/attempts/"))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { attempts?: Sitting[] }) => {
        if (live) setRows(data.attempts ?? []);
      })
      .catch(() => {
        if (live) setError("Could not reach the server.");
      });

    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-4">
        <p className="text-sm text-ink-soft">
          {error} Your papers are safe on this phone — this list is the copy the server holds, and
          it needs a connection and a signed-in account.
        </p>
        <Link
          href="/signin"
          className="mt-3 inline-flex min-h-12 items-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-ink"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!rows) return <p className="text-sm text-ink-faint">Loading…</p>;

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-ink-soft">No sittings have reached the server yet.</p>
        <p className="mt-1 text-xs text-ink-faint">
          A paper appears here once you have finished it. Papers sat offline arrive the next time
          this screen is opened with a connection.
        </p>
        <Link
          href="/practice"
          className="mt-4 inline-flex min-h-12 items-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-ink"
        >
          Sit a paper
        </Link>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {rows.map((s) => {
        const paper = getPaper(s.paperSlug);
        const from = origin(s);
        const percent =
          s.totalScore === null || !s.maxMarks
            ? null
            : Math.round((s.totalScore / s.maxMarks) * 100);

        return (
          <li
            key={s.id}
            className="rounded-2xl border border-border bg-surface p-4"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {paper?.title ?? `${s.subject}, class ${s.classNum}`}
                </p>
                <p className="mt-0.5 text-xs text-ink-faint tabular-nums">
                  {[from?.label, s.subject, DATE.format(new Date(s.startedAt))]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="mt-2 text-xs text-ink-soft">{state(s)}</p>
              </div>

              {/* A missing total is not a zero. A sitting nobody has scored says
                  so where the number would be, rather than reading 0/80. */}
              <span className="shrink-0 text-right text-xs tabular-nums">
                {s.totalScore === null ? (
                  <span className="text-ink-faint">not scored</span>
                ) : (
                  <>
                    <span className="font-medium">
                      {formatMarks(s.totalScore)}/{s.maxMarks}
                    </span>
                    <span className="block text-ink-faint">{percent}%</span>
                  </>
                )}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {from && (
                <Link
                  href={from.href}
                  className="inline-flex min-h-12 items-center rounded-xl border border-border px-4 text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
                >
                  Sit it again
                </Link>
              )}
              {/* Only offered where there is something to look at. A student
                  told to "see the marked script" of a paper they never
                  photographed has been sent to an empty screen. */}
              {s.submissions > 0 && (
                <Link
                  href="/results"
                  className="inline-flex min-h-12 items-center rounded-xl border border-border px-4 text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
                >
                  See the script
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
