"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ExamTimer from "@/components/ExamTimer";
import PaperViewer from "@/components/PaperViewer";
import SectionAMcq from "@/components/SectionAMcq";
import SectionBWritten from "@/components/SectionBWritten";
import type { DualTrackTest as Test } from "@/lib/tests";
import {
  activeTestAttempt,
  answerMcq,
  deleteTestAttempt,
  finaliseTest,
  formatClock,
  isExpired,
  markSectionA,
  remainingMs,
  saveWrittenMarks,
  scoreTest,
  setWrittenStatus,
  startTestAttempt,
  submitTestAttempt,
  testAttemptsFor,
  type TestAttempt,
  type WrittenAnswer,
} from "@/lib/test-attempts";

/**
 * The dual-track runner: pre-flight, running, scoring, done.
 *
 * One sitting, one clock, two tracks. Section A is answered on screen and marked
 * by the app; Section B is written on paper out of the mirrored question paper,
 * as in the exam hall. Neither is a separate exercise the student starts and
 * stops — the clock spans both, which is the whole point of the feature and the
 * one thing /quiz and /practice between them could not do.
 *
 * Two rules are inherited wholesale from PaperAttempt, and for the same reasons:
 *
 *  - **The marking scheme does not exist until the paper is submitted.** In the
 *    running state it is not hidden behind a flag; the component is never
 *    mounted, so there is nothing to find in devtools and no PDF quietly
 *    downloading in the background.
 *  - **The clock's only source of truth is `startedAt` in IndexedDB.** A reload,
 *    a locked phone or a killed tab is harmless, and an exam cannot be paused by
 *    closing the app.
 */

/**
 * "3", "1.5" — never "3.0". Copied rather than imported from src/lib/tests.ts,
 * and the duration label arrives as a prop rather than through `formatDuration`,
 * for the same reason: src/lib/tests.ts and src/lib/papers.ts each hold a whole
 * content corpus at module scope, and one value import would ship all of it to
 * the phone. Everything this component needs from them is plain data already.
 */
function formatMarks(marks: number): string {
  return Number.isInteger(marks) ? String(marks) : marks.toFixed(1);
}

type Phase = "loading" | "preflight" | "running" | "scoring" | "done";
type RunPane = "a" | "b" | "paper";
type MarkPane = "scheme" | "marks";

interface Props {
  test: Test;
  /** Mirrored on our own origin; cbseacademic.nic.in sends no CORS header. */
  paperUrl: string;
  schemeUrl: string;
  /** "2 hr 30 min", formatted by the route so papers.json stays server-side. */
  durationLabel: string;
}

export default function DualTrackTest({
  test,
  paperUrl,
  schemeUrl,
  durationLabel,
}: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [attempt, setAttempt] = useState<TestAttempt | null>(null);
  /** An unfinished sitting found on load — offered, never silently resumed. */
  const [resumable, setResumable] = useState<TestAttempt | null>(null);
  const [expired, setExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runPane, setRunPane] = useState<RunPane>("a");
  const [markPane, setMarkPane] = useState<MarkPane>("scheme");

  const attemptId = attempt?.id;

  useEffect(() => {
    let live = true;

    (async () => {
      const active = await activeTestAttempt(test.slug);
      if (active) {
        // The clock ran out while the tab was closed. An exam that has ended has
        // ended; go straight to marking rather than handing back a dead timer.
        if (isExpired(active)) {
          const submitted = await submitTestAttempt(active.id);
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

      // A submitted sitting with no total is a marking session that was walked
      // away from; every mark entered is already saved, so pick it up.
      const unfinished = (await testAttemptsFor(test.slug)).find(
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
  }, [test.slug]);

  async function onStart() {
    setBusy(true);
    const started = await startTestAttempt(test);
    setAttempt(started);
    setResumable(null);
    setExpired(false);
    setRunPane("a");
    setPhase("running");
    setBusy(false);
  }

  function onResume() {
    if (!resumable) return;
    setAttempt(resumable);
    setResumable(null);
    setRunPane("a");
    setPhase("running");
  }

  async function onDiscard() {
    if (!resumable) return;
    setBusy(true);
    await deleteTestAttempt(resumable.id);
    setResumable(null);
    setBusy(false);
  }

  const endExam = useCallback(async (id: string, ranOut: boolean) => {
    const submitted = await submitTestAttempt(id);
    setAttempt((prev) => submitted ?? prev);
    if (ranOut) setExpired(true);
    setConfirming(false);
    setMarkPane("scheme");
    setPhase("scoring");
  }, []);

  const onExpire = useCallback(() => {
    if (!attemptId) return;
    void endExam(attemptId, true);
  }, [attemptId, endExam]);

  /*
   * The three writers below are optimistic and un-awaited: forty controls must
   * not wait on IndexedDB between taps. The store stays the record of truth for
   * a reload; this state is only the display.
   */
  const onAnswer = useCallback(
    (n: number, chosen: number | null) => {
      setAttempt((prev) =>
        prev
          ? { ...prev, sectionA: prev.sectionA.map((r) => (r.n === n ? { ...r, chosen } : r)) }
          : prev,
      );
      if (attemptId) void answerMcq(attemptId, n, chosen);
    },
    [attemptId],
  );

  const onStatus = useCallback(
    (n: number, status: WrittenAnswer["status"]) => {
      setAttempt((prev) =>
        prev
          ? {
              ...prev,
              sectionB: prev.sectionB.map((w) =>
                w.n === n
                  ? { ...w, status, selfMarks: status === "unattempted" ? null : w.selfMarks }
                  : w,
              ),
            }
          : prev,
      );
      if (attemptId) void setWrittenStatus(attemptId, n, status);
    },
    [attemptId],
  );

  const onMarks = useCallback(
    (n: number, marks: number | null) => {
      setAttempt((prev) =>
        prev
          ? {
              ...prev,
              sectionB: prev.sectionB.map((w) =>
                w.n === n
                  ? { ...w, selfMarks: marks, status: marks === null ? w.status : "written" }
                  : w,
              ),
            }
          : prev,
      );
      if (attemptId) void saveWrittenMarks(attemptId, n, marks);
    },
    [attemptId],
  );

  async function onFinalise() {
    if (!attemptId) return;
    setBusy(true);
    const done = await finaliseTest(attemptId);
    if (done) setAttempt(done);
    setPhase("done");
    setBusy(false);
  }

  function onAttemptAgain() {
    setAttempt(null);
    setExpired(false);
    setPhase("preflight");
  }

  if (phase === "loading") {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <p className="text-sm text-ink-faint">Checking for a test in progress…</p>
      </main>
    );
  }

  // ── 1. Pre-flight ────────────────────────────────────────────────────────
  if (phase === "preflight") {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-lg font-semibold tracking-tight">{test.title}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Class {test.classNum} · {test.paperSubject} · {test.session}
          </p>

          <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
            {[
              { label: "Marks", value: formatMarks(test.maxMarks) },
              {
                label: "Questions",
                value: String(test.sectionA.length + test.sectionB.length),
              },
              { label: "Time", value: durationLabel },
            ].map((item) => (
              <div key={item.label} className="rounded-xl bg-surface-alt px-2 py-3">
                <dt className="text-xs uppercase tracking-wider text-ink-faint">{item.label}</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-surface p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Section A · on screen
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {test.sectionA.length}
              <span className="text-sm font-normal text-ink-faint">
                {" "}
                / {formatMarks(test.sectionAMarks)} marks
              </span>
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              Objective questions, answered here and marked the moment you submit.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Section B · on paper
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {test.sectionB.length}
              <span className="text-sm font-normal text-ink-faint">
                {" "}
                / {formatMarks(test.sectionBMarks)} marks
              </span>
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              Written by hand from the question paper.{" "}
              {test.rubricCount > 0
                ? `${test.rubricCount} of them carry a marking rubric.`
                : "You mark these against the official scheme."}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-border bg-surface p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Before you start
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-ink-soft">
            <li>
              One clock covers both sections. It starts the moment you tap Start and keeps running
              if you close the app, lock the phone or lose the connection.
            </li>
            <li>
              Section A is answered on screen. You can change an answer until you submit; nothing
              is marked before then.
            </li>
            <li>
              Section B is written on paper out of the question paper, exactly as in the exam.
              Tick each one you answer so it can be marked — and photographed and graded — later.
            </li>
            <li>
              The marking scheme stays locked until you submit. It is not loaded at all while the
              test is open.
            </li>
          </ul>
        </div>

        {resumable ? (
          <div className="mt-4 rounded-2xl border border-accent/40 bg-accent-soft p-5">
            <p className="text-sm font-medium">You have a test already running.</p>
            <p className="mt-1 text-sm text-ink-soft">
              Started {new Date(resumable.startedAt).toLocaleString()} ·{" "}
              <span className="tabular-nums">{formatClock(remainingMs(resumable))}</span> left.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onResume}
                className="min-h-11 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={onDiscard}
                disabled={busy}
                className="min-h-11 rounded-xl border border-border px-4 py-2 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                Discard it
              </button>
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              Discarding deletes that sitting. Starting fresh is a new clock.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={busy}
            className="mt-4 w-full rounded-2xl bg-accent px-4 py-3.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Start — {durationLabel}
          </button>
        )}
      </main>
    );
  }

  // ── 2. Running ───────────────────────────────────────────────────────────
  if (phase === "running" && attempt) {
    const answered = attempt.sectionA.filter((r) => r.chosen !== null).length;
    const written = attempt.sectionB.filter((w) => w.status === "written").length;

    const panes: { key: RunPane; label: string; hint: string }[] = [
      { key: "a", label: "Section A", hint: `${answered}/${attempt.sectionA.length}` },
      { key: "b", label: "Section B", hint: `${written}/${attempt.sectionB.length}` },
      { key: "paper", label: "Paper", hint: "" },
    ];

    return (
      <div className="flex w-full flex-1 flex-col">
        <div className="sticky top-0 z-30 shrink-0">
          <ExamTimer
            startedAt={attempt.startedAt}
            durationMs={attempt.durationMs}
            onExpire={onExpire}
          />
          <div className="border-b border-border bg-paper/90 px-4 py-2 backdrop-blur">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              {confirming ? (
                <>
                  <span className="min-w-0 flex-1 text-xs text-ink-soft">
                    Submit both sections and unlock the marking scheme? You cannot go back.
                  </span>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="min-h-11 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-soft transition-colors hover:text-ink"
                    >
                      Keep writing
                    </button>
                    <button
                      type="button"
                      onClick={() => void endExam(attempt.id, false)}
                      className="min-h-11 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink"
                    >
                      Yes, submit
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                    {test.paperSubject} · {formatMarks(test.maxMarks)} marks
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="min-h-11 shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
                  >
                    Submit and score
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="border-b border-border bg-paper/90 px-4 py-2 backdrop-blur">
            <div className="mx-auto flex max-w-3xl gap-1 rounded-xl bg-surface-alt p-1">
              {panes.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setRunPane(p.key)}
                  aria-pressed={runPane === p.key}
                  className={`min-h-11 flex-1 rounded-lg px-2 text-xs font-medium transition-colors ${
                    runPane === p.key ? "bg-surface text-ink shadow-sm" : "text-ink-faint"
                  }`}
                >
                  {p.label}
                  {p.hint && <span className="ml-1 tabular-nums opacity-70">{p.hint}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* The paper pane is bounded by the column so the PDF scrolls inside
            itself and the clock never leaves the screen. The other two are
            ordinary page scroll. */}
        {runPane === "paper" ? (
          <div className="flex min-h-0 flex-1 p-2">
            <PaperViewer url={paperUrl} label="question paper" className="flex-1" />
          </div>
        ) : (
          <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-4">
            {runPane === "a" ? (
              <>
                <p className="mb-3 text-xs text-ink-soft">
                  Answer on screen. Tap a chosen option again to clear it.
                </p>
                <SectionAMcq
                  items={test.sectionA}
                  responses={attempt.sectionA}
                  review={false}
                  onAnswer={onAnswer}
                />
              </>
            ) : (
              <>
                <p className="mb-3 text-xs text-ink-soft">
                  Read these from the Paper tab and write them by hand. Tick each one you answer.
                </p>
                <SectionBWritten
                  items={test.sectionB}
                  answers={attempt.sectionB}
                  scoring={false}
                  onStatus={onStatus}
                  onMarks={onMarks}
                />
              </>
            )}
          </main>
        )}
      </div>
    );
  }

  // ── 3. Scoring ───────────────────────────────────────────────────────────
  if (phase === "scoring" && attempt) {
    const a = markSectionA(attempt.sectionA);

    return (
      <div className="flex w-full flex-1 flex-col">
        <div className="shrink-0 border-b border-border bg-paper px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                Section A marked: {a.marks} / {a.maxMarks}
              </p>
              <p className="truncate text-xs text-ink-faint">
                {expired
                  ? "Time ran out — the test was submitted for you."
                  : "The scheme is unlocked. Mark Section B; marks save as you type."}
              </p>
            </div>
            <button
              type="button"
              onClick={onFinalise}
              disabled={busy}
              className="min-h-11 shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Finish
            </button>
          </div>

          {/* A marking sheet squeezed beside a PDF is unusable at 360px, so
              below md the two are separate screens with a toggle. */}
          <div className="mt-2 flex gap-1 rounded-xl bg-surface-alt p-1 md:hidden">
            {(["scheme", "marks"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setMarkPane(key)}
                aria-pressed={markPane === key}
                className={`min-h-11 flex-1 rounded-lg px-3 text-xs font-medium transition-colors ${
                  markPane === key ? "bg-surface text-ink shadow-sm" : "text-ink-faint"
                }`}
              >
                {key === "scheme" ? "Scheme" : "My marks"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            className={`${markPane === "scheme" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 p-2 md:flex`}
          >
            <PaperViewer url={schemeUrl} label="marking scheme" className="flex-1" />
          </div>
          <div
            className={`${markPane === "marks" ? "block" : "hidden"} min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3 md:block`}
          >
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Section B — mark yourself
            </h3>
            <SectionBWritten
              items={test.sectionB}
              answers={attempt.sectionB}
              scoring
              onStatus={onStatus}
              onMarks={onMarks}
            />

            <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Section A — already marked
            </h3>
            <SectionAMcq
              items={test.sectionA}
              responses={attempt.sectionA}
              review
              onAnswer={onAnswer}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── 4. Done ──────────────────────────────────────────────────────────────
  if (phase === "done" && attempt) {
    const s = scoreTest(attempt);
    const percent = s.maxMarks > 0 ? Math.round((s.total / s.maxMarks) * 100) : 0;
    const graded = attempt.sectionB.filter((w) => w.handoff.grade).length;
    const awaiting = attempt.sectionB.filter(
      (w) => w.status === "written" && !w.handoff.grade,
    ).length;

    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <div className="rounded-2xl border border-border bg-surface p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
            {test.paperSubject} · {test.session}
          </p>
          <p className="mt-3 text-4xl font-semibold tabular-nums tracking-tight">
            {formatMarks(s.total)}
            <span className="text-2xl font-normal text-ink-faint"> / {formatMarks(s.maxMarks)}</span>
          </p>
          <p className="mt-1 text-sm tabular-nums text-ink-soft">{percent}%</p>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-center">
          {[
            {
              label: "Section A",
              value: `${formatMarks(s.sectionAMarks)} / ${formatMarks(s.sectionAMax)}`,
              note: "marked by the app",
            },
            {
              label: "Section B",
              value: `${formatMarks(s.sectionBMarks)} / ${formatMarks(s.sectionBMax)}`,
              note: graded > 0 ? `${graded} graded from a rubric` : "marked by you",
            },
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-border bg-surface px-3 py-4">
              <dt className="text-xs uppercase tracking-wider text-ink-faint">{item.label}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{item.value}</dd>
              <p className="mt-0.5 text-[11px] text-ink-faint">{item.note}</p>
            </div>
          ))}
        </dl>

        <div className="mt-4 rounded-2xl border border-border bg-surface p-5">
          <p className="text-sm text-ink-soft">
            Both sections have been folded into your revision schedule, one card per chapter — the
            chapters you dropped marks in come back soonest.
            {s.unscored > 0 &&
              ` ${s.unscored} Section B ${s.unscored === 1 ? "question is" : "questions are"} still unmarked and count nothing yet.`}
          </p>
          {awaiting > 0 && (
            <p className="mt-2 text-xs text-ink-faint">
              {awaiting} written {awaiting === 1 ? "answer" : "answers"} can still be photographed
              and graded against the marking rubric; a grade that arrives later replaces the mark
              you gave yourself and updates this score.
            </p>
          )}
          <Link
            href="/revise"
            className="mt-4 inline-block min-h-11 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90"
          >
            Go to revision
          </Link>
        </div>

        <button
          type="button"
          onClick={onAttemptAgain}
          className="mt-4 w-full rounded-2xl border border-border px-4 py-3 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          Sit it again
        </button>
        <p className="mt-2 text-center text-xs text-ink-faint">
          A second sitting keeps this score in your history and does not reset the revision
          schedule.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <p className="text-sm text-ink-faint">This test could not be loaded.</p>
    </main>
  );
}
