"use client";

import { useState } from "react";
import type { PaperQuestion } from "@/lib/papers";
import type { QuestionScore } from "@/lib/attempts";

/**
 * The self-marking sheet: one row per question, filled in against the official
 * marking scheme.
 *
 * Nothing here grades anything. CBSE papers are descriptive, so the student is
 * the marker — which is the point, since reading the scheme and deciding what
 * your own answer earned is the exam skill being practised.
 *
 * A Class 10 Science paper is 39 questions, so the row has to survive a 360px
 * phone: number, what the question was, one input, one toggle, nothing else.
 * Half marks are allowed because CBSE awards them.
 */

interface Props {
  questions: PaperQuestion[];
  scores: QuestionScore[];
  onScore: (n: number, score: number | null, attempted: boolean) => void;
}

/** "3", "1.5" — never "3.0", which reads as a precision the marks don't have. */
function formatMarks(marks: number): string {
  return Number.isInteger(marks) ? String(marks) : marks.toFixed(1);
}

/** Clamp into 0..max and snap to the nearest half mark. */
function normalise(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value * 2) / 2));
}

export default function ScoringGrid({ questions, scores, onScore }: Props) {
  /*
   * Inputs are typed into, so the field holds its own text while it is being
   * edited: committing "0" the instant someone types the "0" of "0.5" would
   * fight them mid-keystroke. The parsed value is still committed on every
   * change — only the *display* is local, and only until blur.
   */
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const byNumber = new Map(scores.map((s) => [s.n, s]));
  const maxMarks = questions.reduce((sum, q) => sum + q.maxMarks, 0);
  const total = scores.reduce((sum, s) => sum + (s.score ?? 0), 0);
  const scored = scores.filter((s) => s.score !== null).length;

  function setDraft(n: number, text: string | null) {
    setDrafts((prev) => {
      const next = { ...prev };
      if (text === null) delete next[n];
      else next[n] = text;
      return next;
    });
  }

  function onInput(q: PaperQuestion, text: string) {
    setDraft(q.n, text);
    if (text.trim() === "") {
      onScore(q.n, null, true);
      return;
    }
    const parsed = Number(text);
    if (Number.isFinite(parsed)) onScore(q.n, normalise(parsed, q.maxMarks), true);
  }

  function onToggleAttempted(q: PaperQuestion, attempted: boolean) {
    setDraft(q.n, null);
    onScore(q.n, null, attempted);
  }

  return (
    <div className="rounded-2xl border border-border bg-surface">
      <ul className="divide-y divide-border">
        {questions.map((q) => {
          const entry = byNumber.get(q.n);
          const attempted = entry?.attempted ?? true;
          const committed = entry?.score ?? null;
          const value = drafts[q.n] ?? (committed === null ? "" : formatMarks(committed));
          const inputId = `q-${q.n}-marks`;
          const metaId = `q-${q.n}-meta`;

          return (
            <li key={q.n} className="flex items-center gap-2 px-3 py-2 sm:gap-3">
              <label
                htmlFor={inputId}
                className="w-9 shrink-0 text-sm font-medium tabular-nums text-ink-soft"
              >
                Q{q.n}
              </label>

              <span id={metaId} className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                {q.topic ? `${q.section} · ${q.topic}` : `Section ${q.section}`}
              </span>

              <div className="flex shrink-0 items-center gap-1">
                <input
                  id={inputId}
                  type="number"
                  inputMode="decimal"
                  step={0.5}
                  min={0}
                  max={q.maxMarks}
                  value={value}
                  disabled={!attempted}
                  aria-describedby={metaId}
                  onChange={(e) => onInput(q, e.target.value)}
                  onBlur={() => setDraft(q.n, null)}
                  className="w-14 rounded-lg border border-border bg-paper px-2 py-1 text-right text-sm tabular-nums outline-none transition-colors focus:border-accent disabled:opacity-40"
                />
                <span className="w-8 text-xs tabular-nums text-ink-faint">/ {q.maxMarks}</span>
              </div>

              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-ink-faint">
                <input
                  type="checkbox"
                  checked={!attempted}
                  aria-label={`Question ${q.n} not attempted`}
                  onChange={(e) => onToggleAttempted(q, !e.target.checked)}
                  className="size-4 accent-accent"
                />
                <span className="hidden sm:inline">Not attempted</span>
                <span className="sm:hidden">n/a</span>
              </label>
            </li>
          );
        })}
      </ul>

      {/* Sticky rather than pinned to the end of the list: with 39 rows the
          running total is only useful if it is on screen while you scroll. */}
      <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-2xl border-t border-border bg-surface/95 px-3 py-2.5 backdrop-blur">
        <span className="text-xs text-ink-faint">
          {scored} of {questions.length} scored
        </span>
        <span className="text-sm font-semibold tabular-nums">
          {formatMarks(total)}
          <span className="font-normal text-ink-faint"> / {maxMarks}</span>
        </span>
      </div>
    </div>
  );
}
