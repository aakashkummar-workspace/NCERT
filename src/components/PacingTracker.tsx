"use client";

import { useEffect, useState } from "react";
import type { PaperQuestion } from "@/lib/papers";
import type { QuestionScore } from "@/lib/attempts";
import {
  PACE_TOLERANCE_FLOOR_MS,
  fillRatio,
  formatPerMark,
  formatSpan,
  pacing,
} from "@/lib/pacing";

/**
 * The pacing tracker: one row under the clock, showing where the paper's time
 * has actually gone, section by section.
 *
 * Two rules shaped everything here.
 *
 * It is read by an anxious fifteen-year-old in the middle of a three-hour exam,
 * so it stays quiet while there is nothing to act on. On pace it states the
 * section and the rate that still finishes on time, and says nothing else — no
 * praise, no counter ticking towards a threshold, no colour that means danger.
 * It speaks up only when a section has drifted past the tolerance in pacing.ts,
 * and then it says how far and what rate recovers it, because a number a
 * student can act on is calming and a warning they cannot act on is not.
 *
 * And it asks for as little as possible. The student is writing on paper, not
 * looking at this; tapping through thirty-nine questions is not something
 * anyone would do mid-exam. So it asks once per section — five taps across a
 * whole paper — which is also the granularity the feature is specified at. The
 * clock, as always, is derived: the stamp is a wall-clock instant and every
 * reading here is recomputed from it against `Date.now()`.
 */

/**
 * Fifteen seconds. The numbers move at minutes-per-mark, so a faster tick would
 * buy nothing but a bar twitching in the corner of a student's eye.
 */
const TICK_MS = 15 * 1000;

interface Props {
  questions: PaperQuestion[];
  startedAt: number;
  durationMs: number;
  scores: QuestionScore[];
  /** Stamp the student as having reached question `n`. */
  onReach: (n: number) => void;
}

export default function PacingTracker({
  questions,
  startedAt,
  durationMs,
  scores,
  onReach,
}: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Same discipline as ExamTimer: a backgrounded tab's interval is throttled
    // hard, so re-read the wall clock the moment the page comes back rather
    // than waiting for a tick that may be minutes away.
    function sync() {
      setNow(Date.now());
    }

    sync();
    const id = window.setInterval(sync, TICK_MS);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("pageshow", sync);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  const p = pacing({ startedAt, durationMs, questions, scores }, now);

  // A paper whose mark grid could not be derived has no sections to pace, and
  // one single section has no boundary worth tracking.
  if (p.sections.length < 2) return null;

  const next = p.next;
  const rate =
    p.remainingMsPerMark === null ? null : `${formatPerMark(p.remainingMsPerMark)} per mark left`;
  /*
   * Asymmetric on purpose. Bad news is about the section in hand, because that
   * is the only thing still fixable; good news is the whole paper's, because
   * time banked in Section A is genuinely time in hand in Section D. And the
   * bad news is only ever stated once, as a quantity, never as a verdict.
   */
  const drift =
    p.current?.status === "behind"
      ? `${formatSpan(p.current.driftMs)} over`
      : p.driftMs <= -PACE_TOLERANCE_FLOOR_MS
        ? `${formatSpan(-p.driftMs)} in hand`
        : null;

  return (
    <div className="border-b border-border bg-paper/90 px-4 py-1.5 backdrop-blur">
      <div className="mx-auto max-w-3xl">
        <div
          className="flex items-end gap-1"
          role="group"
          aria-label="Time used in each section"
        >
          {p.sections.map((s) => {
            const used = fillRatio(s);
            return (
              <div
                key={`${s.label}-${s.from}`}
                // Marks, not question count, set the width: Section A is
                // eighteen questions but only a fifth of the paper's time, and
                // a bar that showed it as half would teach the wrong pacing.
                style={{ flexGrow: Math.max(s.marks, 1) }}
                className="min-w-0"
              >
                <span
                  className={`block text-[10px] font-medium tabular-nums ${
                    s.state === "current" ? "text-ink-soft" : "text-ink-faint"
                  }`}
                >
                  {s.label}
                </span>
                <div
                  className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-alt"
                  role="img"
                  aria-label={`Section ${s.label}: ${formatSpan(s.elapsedMs)} of ${formatSpan(
                    s.budgetMs,
                  )} used`}
                >
                  <div
                    className={`h-full rounded-full ${
                      s.state === "current"
                        ? "bg-accent"
                        : s.status === "behind"
                          ? "bg-accent/50"
                          : "bg-ink-faint"
                    }`}
                    style={{ width: `${used * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p className="min-w-0 flex-1 truncate text-xs text-ink-soft">
            {p.current ? `Section ${p.current.label}` : "Paper"}
            {drift ? ` · ${drift}` : ""}
            {rate ? ` · ${rate}` : ""}
          </p>
          {next && (
            <button
              type="button"
              onClick={() => onReach(next.from)}
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-accent hover:text-accent"
            >
              Start Section {next.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
