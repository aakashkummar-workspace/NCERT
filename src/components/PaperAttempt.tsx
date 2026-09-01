"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ExamTimer from "@/components/ExamTimer";
import PacingTracker from "@/components/PacingTracker";
import PaperViewer from "@/components/PaperViewer";
import ScoringGrid from "@/components/ScoringGrid";
import { syncPracticeAttempt } from "@/lib/handoff-sync";
import {
  formatDuration,
  paperPdfPath,
  schemePdfPath,
  type Paper,
  type PaperQuestion,
} from "@/lib/papers";
import {
  activeAttempt,
  attemptsFor,
  deleteAttempt,
  finaliseScoring,
  formatClock,
  isExpired,
  markReached,
  remainingMs,
  saveScore,
  startAttempt,
  submitAttempt,
  type Attempt,
} from "@/lib/attempts";

/**
 * The exam runner: pre-flight, running, scoring, done.
 *
 * The whole feature turns on one rule — the marking scheme does not exist until
 * the paper is submitted. In the running state it is not hidden with CSS or
 * rendered behind a flag; the component is never mounted, so there is nothing to
 * reveal with devtools and no PDF quietly downloading in the background.
 *
 * The clock's only source of truth is the attempt's `startedAt` in IndexedDB.
 * That is what makes a reload, a locked phone or a killed tab harmless: the
 * elapsed time is whatever the wall clock says it is, so an exam cannot be
 * paused by closing the app.
 */

type Phase = "loading" | "preflight" | "running" | "scoring" | "done";

interface Props {
  paper: Paper;
  questions: PaperQuestion[];
}

function formatMarks(marks: number): string {
  return Number.isInteger(marks) ? String(marks) : marks.toFixed(1);
}

export default function PaperAttempt({ paper, questions }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  /** An unfinished attempt found on load — offered, never silently resumed. */
  const [resumable, setResumable] = useState<Attempt | null>(null);
  const [expired, setExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pane, setPane] = useState<"scheme" | "marks">("scheme");

  const attemptId = attempt?.id;

  useEffect(() => {
    let live = true;

    (async () => {
      const active = await activeAttempt(paper.slug);
      if (active) {
        // The clock ran out while the tab was closed. An exam that has ended has
        // ended; go straight to scoring rather than handing back a dead timer.
        if (isExpired(active)) {
          const submitted = await submitAttempt(active.id);
          if (!live) return;
          setAttempt(submitted ?? active);
          setExpired(true);
          setPhase("scoring");
          return;
        }
        if (!live) return;
        setResumable(active);
        setPhase("preflight");
        return;
      }

      // A submitted attempt with no total is a scoring session that was walked
      // away from mid-way; every entered mark is already saved, so pick it up.
      const unfinished = (await attemptsFor(paper.slug)).find(
        (a) => a.status === "submitted" && a.totalScore === undefined,
      );
      if (!live) return;
      if (unfinished) {
        setAttempt(unfinished);
        setPhase("scoring");
      } else {
        setPhase("preflight");
      }
    })().catch(() => {
      if (live) setPhase("preflight");
    });

    return () => {
      live = false;
    };
  }, [paper.slug]);

  async function onStart() {
    setBusy(true);
    const started = await startAttempt({
      paperSlug: paper.slug,
      subject: paper.subject,
      classNum: paper.class,
      durationMinutes: paper.durationMinutes,
      maxMarks: paper.maxMarks,
      questions: questions.map((q) => ({ n: q.n, maxMarks: q.maxMarks })),
    });
    setAttempt(started);
    setResumable(null);
    setExpired(false);
    setPhase("running");
    setBusy(false);
  }

  function onResume() {
    if (!resumable) return;
    setAttempt(resumable);
    setResumable(null);
    setPhase("running");
  }

  async function onDiscard() {
    if (!resumable) return;
    setBusy(true);
    await deleteAttempt(resumable.id);
    setResumable(null);
    setBusy(false);
  }

  const endExam = useCallback(
    async (id: string, ranOut: boolean) => {
      const submitted = await submitAttempt(id);
      setAttempt((prev) => submitted ?? prev);
      if (ranOut) setExpired(true);
      setConfirming(false);
      setPane("scheme");
      setPhase("scoring");
    },
    [],
  );

  const onExpire = useCallback(() => {
    if (!attemptId) return;
    void endExam(attemptId, true);
  }, [attemptId, endExam]);

  /*
   * The grid is written to optimistically and the write is not awaited: 39 rows
   * of number inputs must not wait on IndexedDB between keystrokes. The store
   * stays the record of truth for a reload; this state is only the display.
   */
  const onScore = useCallback(
    (n: number, score: number | null, attempted: boolean) => {
      setAttempt((prev) =>
        prev
          ? { ...prev, scores: prev.scores.map((s) => (s.n === n ? { ...s, score, attempted } : s)) }
          : prev,
      );
      if (attemptId) void saveScore(attemptId, n, score, attempted);
    },
    [attemptId],
  );

  /*
   * Written the same way as a mark: optimistically, and not awaited. A tap in
   * the middle of an exam must not wait on IndexedDB, and the stamp is a
   * wall-clock instant taken here — so a slow write records the moment the
   * student tapped, not the moment the disk got round to it.
   */
  const onReach = useCallback(
    (n: number) => {
      const at = Date.now();
      setAttempt((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          scores: prev.scores.map((s) => {
            if (s.n === n) return { ...s, reachedAt: at };
            if (s.n > n && s.reachedAt !== undefined) {
              const rest = { ...s };
              delete rest.reachedAt;
              return rest;
            }
            return s;
          }),
        };
      });
      if (attemptId) void markReached(attemptId, n, at);
    },
    [attemptId],
  );

  async function onFinalise() {
    if (!attemptId) return;
    setBusy(true);
    const done = await finaliseScoring(attemptId);
    if (done) setAttempt(done);
    setPhase("done");
    setBusy(false);
    /*
     * Fire and forget, exactly as DualTrackTest does it. A self-marked paper is
     * worth a parent seeing and worth a teacher one day marking, so it goes up
     * — but a student on no network must still get their score screen, so
     * nothing above this line waits on it. `syncPracticeAttempt` swallows every
     * failure; the next `syncPending()` from /revise or /results retries.
     */
    if (done) void syncPracticeAttempt(done);
  }

  function onAttemptAgain() {
    setAttempt(null);
    setExpired(false);
    setPhase("preflight");
  }

  if (phase === "loading") {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <p className="text-sm text-ink-faint">Checking for an attempt in progress…</p>
      </main>
    );
  }

  // ── 1. Pre-flight ────────────────────────────────────────────────────────
  if (phase === "preflight") {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-lg font-semibold tracking-tight">{paper.title}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Class {paper.class} · {paper.subject}
            {paper.code ? ` · Code ${paper.code}` : ""} · {paper.session}
          </p>

          <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
            {[
              { label: "Marks", value: String(paper.maxMarks) },
              { label: "Questions", value: String(paper.questionCount) },
              { label: "Time", value: formatDuration(paper.durationMinutes) },
            ].map((item) => (
              <div key={item.label} className="rounded-xl bg-surface-alt px-2 py-3">
                <dt className="text-xs uppercase tracking-wider text-ink-faint">{item.label}</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-4 rounded-2xl border border-border bg-surface p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Before you start
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            <li>
              The clock starts the moment you tap Start and keeps running if you close the app,
              lock the phone or lose the connection.
            </li>
            <li>
              The marking scheme stays locked until you submit. It is not loaded at all while the
              paper is open.
            </li>
            <li>
              Write your answers on paper, exactly as you will in the exam. Nothing is typed here
              until it is time to mark yourself.
            </li>
            <li>When the time runs out the paper submits itself and scoring opens.</li>
          </ul>
        </div>

        {resumable ? (
          <div className="mt-4 rounded-2xl border border-accent/40 bg-accent-soft p-5">
            <p className="text-sm font-medium">You have an attempt already running.</p>
            <p className="mt-1 text-sm text-ink-soft">
              Started {new Date(resumable.startedAt).toLocaleString()} ·{" "}
              <span className="tabular-nums">{formatClock(remainingMs(resumable))}</span> left.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onResume}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={onDiscard}
                disabled={busy}
                className="rounded-xl border border-border px-4 py-2 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                Discard it
              </button>
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              Discarding deletes that attempt. Starting fresh is a new three-hour clock.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={busy}
            className="mt-4 w-full rounded-2xl bg-accent px-4 py-3.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Start — {formatDuration(paper.durationMinutes)}
          </button>
        )}
      </main>
    );
  }

  // ── 2. Running ───────────────────────────────────────────────────────────
  if (phase === "running" && attempt) {
    return (
      <div className="flex w-full flex-1 flex-col">
        {/* PaperViewer scrolls inside itself, so the clock never leaves the
            screen. `sticky` is the belt-and-braces case where it does not —
            an error state, or a viewport too short to bound the column. */}
        <div className="sticky top-0 z-30 shrink-0">
          <ExamTimer
            startedAt={attempt.startedAt}
            durationMs={attempt.durationMs}
            onExpire={onExpire}
          />
          <PacingTracker
            questions={questions}
            startedAt={attempt.startedAt}
            durationMs={attempt.durationMs}
            scores={attempt.scores}
            onReach={onReach}
          />
          <div className="border-b border-border bg-paper/90 px-4 py-2 backdrop-blur">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              {confirming ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">
                    Submit and unlock the marking scheme? You cannot go back.
                  </span>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-ink-soft transition-colors hover:text-ink"
                    >
                      Keep writing
                    </button>
                    <button
                      type="button"
                      onClick={() => void endExam(attempt.id, false)}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink"
                    >
                      Yes, submit
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                    {paper.subject} · {paper.maxMarks} marks · answer on paper
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
                  >
                    Submit and score
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 p-2">
          <PaperViewer url={paperPdfPath(paper)} label="question paper" className="flex-1" />
        </div>
      </div>
    );
  }

  // ── 3. Scoring ───────────────────────────────────────────────────────────
  if (phase === "scoring" && attempt) {
    return (
      <div className="flex w-full flex-1 flex-col">
        <div className="shrink-0 border-b border-border bg-paper px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Mark your own paper</p>
              <p className="truncate text-xs text-ink-faint">
                {expired
                  ? "Time ran out — the paper was submitted for you."
                  : "The marking scheme is unlocked. Marks save as you type."}
              </p>
            </div>
            <button
              type="button"
              onClick={onFinalise}
              disabled={busy}
              className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Finish scoring
            </button>
          </div>

          {/* A scoring grid squeezed beside a PDF is unusable at 360px, so below
              md the two are separate screens with a toggle instead of columns. */}
          <div className="mt-2 flex gap-1 rounded-xl bg-surface-alt p-1 md:hidden">
            {(["scheme", "marks"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setPane(key)}
                aria-pressed={pane === key}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  pane === key ? "bg-surface text-ink shadow-sm" : "text-ink-faint"
                }`}
              >
                {key === "scheme" ? "Scheme" : "My marks"}
              </button>
            ))}
          </div>
        </div>

        {/* Both panes are bounded by the column rather than by the page, so each
            one scrolls on its own — the scheme against the grid, side by side,
            is the whole point of this state. */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            className={`${pane === "scheme" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 p-2 md:flex`}
          >
            <PaperViewer url={schemePdfPath(paper)} label="marking scheme" className="flex-1" />
          </div>
          <div
            className={`${pane === "marks" ? "block" : "hidden"} min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3 md:block`}
          >
            <ScoringGrid questions={questions} scores={attempt.scores} onScore={onScore} />
          </div>
        </div>
      </div>
    );
  }

  // ── 4. Done ──────────────────────────────────────────────────────────────
  if (phase === "done" && attempt) {
    const total = attempt.totalScore ?? 0;
    const percent = paper.maxMarks > 0 ? Math.round((total / paper.maxMarks) * 100) : 0;
    const dropped = attempt.scores.filter((s) => s.score === null || s.score === 0).length;
    const partial = attempt.scores.filter(
      (s) => s.score !== null && s.score > 0 && s.score < s.maxMarks,
    ).length;
    const full = attempt.scores.filter((s) => s.score !== null && s.score >= s.maxMarks).length;

    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <div className="rounded-2xl border border-border bg-surface p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            {paper.subject} · {paper.session}
          </p>
          <p className="mt-3 text-4xl font-semibold tabular-nums tracking-tight">
            {formatMarks(total)}
            <span className="text-2xl font-normal text-ink-faint"> / {paper.maxMarks}</span>
          </p>
          <p className="mt-1 text-sm text-ink-soft tabular-nums">{percent}%</p>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
          {[
            { label: "Full marks", value: full },
            { label: "Part marks", value: partial },
            { label: "Dropped", value: dropped },
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-border bg-surface px-2 py-4">
              <dt className="text-xs uppercase tracking-wider text-ink-faint">{item.label}</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 rounded-2xl border border-border bg-surface p-5">
          <p className="text-sm text-ink-soft">
            Every question you scored is now a revision card. The {partial + dropped} you lost marks
            on come back soonest; the {full} you got right come back much later.
          </p>
          <Link
            href="/revise"
            className="mt-4 inline-block rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
          >
            Go to revision
          </Link>
        </div>

        <button
          type="button"
          onClick={onAttemptAgain}
          className="mt-4 w-full rounded-2xl border border-border px-4 py-3 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          Attempt again
        </button>
        <p className="mt-2 text-center text-xs text-ink-faint">
          A second attempt keeps this score in your history and does not reset the revision
          schedule.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <p className="text-sm text-ink-faint">This attempt could not be loaded.</p>
    </main>
  );
}
