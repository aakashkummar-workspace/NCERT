"use client";

import { useState } from "react";
import type { TestWrittenItem } from "@/lib/tests";
import { writtenMarks, type WrittenAnswer, type WrittenStatus } from "@/lib/test-attempts";

/**
 * Section B of a dual-track test: the descriptive half, written on paper.
 *
 * Nothing here grades anything, and nothing here photographs anything. CBSE's
 * descriptive questions are answered in a handwriting a browser cannot read, so
 * what this component collects is a **declaration**: which questions the student
 * actually wrote, and — once the marking scheme unlocks — what they gave
 * themselves against it. Each row is one `WrittenHandoff`, which is the record
 * another lane later attaches a photograph and a rubric grade to; where such a
 * grade already exists it supersedes the self-report and the row says so rather
 * than offering an input that would be ignored.
 *
 * A Class 10 Science paper leaves twenty of these, so a row has to survive a
 * 360px phone: the number, what the question is, one toggle, one input.
 *
 * ## Two toggles, because a blank row is not a blank answer
 *
 * "Written on paper" ticked is a page to photograph. "Left blank" is the
 * student saying they answered nothing, which is a real zero and is scored as
 * one. A row with neither is a row the student has not reached, and it scores
 * nothing at all — not zero. Only the first of those used to exist, so every
 * untouched row read as a declared blank and dragged the chapter it belongs to
 * down to nought; see `WrittenStatus` in src/lib/test-attempts.ts.
 */

/**
 * "3", "1.5" — never "3.0", which reads as a precision the marks have not got.
 * Copied rather than imported from src/lib/tests.ts, as ScoringGrid copies it
 * from src/lib/papers.ts: that module holds the whole paper and rubric corpus at
 * module scope, and a value import would ship all of it to the phone.
 */
function formatMarks(marks: number): string {
  return Number.isInteger(marks) ? String(marks) : marks.toFixed(1);
}

interface Props {
  items: TestWrittenItem[];
  answers: WrittenAnswer[];
  /** True once the paper is submitted and the marking scheme has unlocked. */
  scoring: boolean;
  onStatus: (n: number, status: WrittenStatus) => void;
  onMarks: (n: number, marks: number | null) => void;
}

const TYPE_LABEL: Record<TestWrittenItem["type"], string> = {
  mcq: "Objective",
  "assertion-reason": "Assertion & reason",
  vsa: "Very short",
  sa: "Short",
  la: "Long",
  "case-study": "Case study",
};

export default function SectionBWritten({
  items,
  answers,
  scoring,
  onStatus,
  onMarks,
}: Props) {
  /* The field holds its own text while it is being edited: committing "0" the
     instant someone types the "0" of "0.5" would fight them mid-keystroke. Only
     the display is local, and only until blur. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const byNumber = new Map(answers.map((a) => [a.n, a]));

  const written = answers.filter((a) => a.status === "written").length;
  /** Rows the student has said nothing about. They score nothing — not zero. */
  const untouched = answers.filter((a) => a.status !== "written" && a.status !== "skipped").length;
  const maxMarks = items.reduce((n, item) => n + item.maxMarks, 0);
  const total = answers.reduce((n, a) => n + (writtenMarks(a) ?? 0), 0);

  function setDraft(n: number, text: string | null) {
    setDrafts((prev) => {
      const next = { ...prev };
      if (text === null) delete next[n];
      else next[n] = text;
      return next;
    });
  }

  function onInput(item: TestWrittenItem, text: string) {
    setDraft(item.n, text);
    if (text.trim() === "") {
      onMarks(item.n, null);
      return;
    }
    const parsed = Number(text);
    if (Number.isFinite(parsed)) onMarks(item.n, parsed);
  }

  return (
    <div className="rounded-2xl border border-border bg-surface">
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const answer = byNumber.get(item.n);
          const attempted = answer?.status === "written";
          const skipped = answer?.status === "skipped";
          const grade = answer?.handoff.grade;
          const committed = answer?.selfMarks ?? null;
          const value = drafts[item.n] ?? (committed === null ? "" : formatMarks(committed));
          const inputId = `b-${item.n}-marks`;
          const metaId = `b-${item.n}-meta`;

          return (
            <li key={item.n} className="px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold tabular-nums">Q{item.n}</span>
                <span className="rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-medium text-ink-soft">
                  {TYPE_LABEL[item.type]}
                </span>
                <span className="text-xs tabular-nums text-ink-faint">
                  {item.maxMarks} {item.maxMarks === 1 ? "mark" : "marks"}
                </span>
                {item.rubrics.length > 0 && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                    {item.rubrics.some((r) => r.needsReview) ? "Draft rubric" : "Rubric"}
                  </span>
                )}
              </div>

              <p id={metaId} className="mt-1 text-xs text-ink-faint break-words">
                {item.topic ? `Section ${item.section} · ${item.topic}` : `Section ${item.section}`}
                {item.rubrics.length > 1
                  ? ` · ${item.rubrics.length} options in the paper`
                  : ""}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    checked={attempted}
                    aria-label={`Question ${item.n} written on paper`}
                    onChange={(e) => onStatus(item.n, e.target.checked ? "written" : "unmarked")}
                    className="size-4 accent-accent"
                  />
                  <span>Written on paper</span>
                </label>

                {/* The declared blank. Tapping it is the only thing in this app
                    that scores a written question zero — a row nobody touched
                    stays unscored, because silence is not an answer. */}
                <button
                  type="button"
                  aria-pressed={skipped}
                  aria-label={`Question ${item.n} left blank`}
                  onClick={() => onStatus(item.n, skipped ? "unmarked" : "skipped")}
                  className={`min-h-11 rounded-lg border px-3 text-xs transition-colors ${
                    skipped ? "border-accent bg-accent-soft text-ink" : "border-border text-ink-faint"
                  }`}
                >
                  Left blank
                </button>

                {scoring && (
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {grade ? (
                      <span className="rounded-lg bg-accent-soft px-2 py-1 text-xs font-semibold tabular-nums text-accent">
                        {formatMarks(grade.awarded)} / {item.maxMarks}
                      </span>
                    ) : (
                      <>
                        <label htmlFor={inputId} className="sr-only">
                          Marks for question {item.n}
                        </label>
                        <input
                          id={inputId}
                          type="number"
                          inputMode="decimal"
                          step={0.5}
                          min={0}
                          max={item.maxMarks}
                          value={value}
                          disabled={!attempted}
                          aria-describedby={metaId}
                          onChange={(e) => onInput(item, e.target.value)}
                          onBlur={() => setDraft(item.n, null)}
                          className="w-16 rounded-lg border border-border bg-paper px-2 py-1.5 text-right text-sm tabular-nums outline-none transition-colors focus:border-accent disabled:opacity-40"
                        />
                        <span className="w-8 text-xs tabular-nums text-ink-faint">
                          / {item.maxMarks}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* The handoff, said out loud. A student who ticked a question has
                  a page that can be photographed and graded later; saying so is
                  what makes the marks input feel provisional rather than final. */}
              {skipped && (
                <p className="mt-1.5 text-[11px] text-ink-faint">
                  Left blank — this one counts zero.
                </p>
              )}

              {attempted && (
                <p className="mt-1.5 text-[11px] text-ink-faint">
                  {grade
                    ? `Graded from the ${grade.source === "self" ? "self-report" : grade.source} scheme${
                        grade.needsReview ? " — draft rubric, marks may change" : ""
                      }`
                    : answer?.handoff.scanId
                      ? "Page attached — waiting to be graded"
                      : item.rubrics.length > 0
                        ? "Your page can be attached and graded against the rubric later"
                        : "Your page can be attached later; no rubric for this one yet"}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {/* Sticky rather than pinned to the end: with twenty rows the running
          total is only useful while you scroll. */}
      <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-2xl border-t border-border bg-surface/95 px-3 py-2.5 backdrop-blur">
        <span className="text-xs text-ink-faint">
          {scoring
            ? `${written} of ${items.length} attempted` +
              (untouched > 0 ? ` · ${untouched} not marked either way` : "")
            : `${written} of ${items.length} written`}
        </span>
        {scoring && (
          <span className="text-sm font-semibold tabular-nums">
            {formatMarks(total)}
            <span className="font-normal text-ink-faint"> / {maxMarks}</span>
          </span>
        )}
      </div>
    </div>
  );
}
