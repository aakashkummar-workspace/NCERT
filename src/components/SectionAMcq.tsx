"use client";

import type { TestMcqItem } from "@/lib/tests";
import type { McqResponse } from "@/lib/test-attempts";

/**
 * Section A of a dual-track test: the objective half, on screen.
 *
 * Deliberately not QuizRunner. A quiz marks each answer the instant it is given
 * and shows the explanation there and then, which is how a quiz teaches — but
 * this is an exam. Nothing is revealed while the clock runs, every question is
 * on one scrolling sheet, and an answer can be changed until the paper is
 * submitted, exactly as it can be on a real OMR-less CBSE Section A.
 *
 * After submission the same sheet is re-rendered with `review` set: the right
 * option is always marked, including where the student got it right, so the
 * page reads the same way every time.
 */

interface Props {
  items: TestMcqItem[];
  responses: McqResponse[];
  /** Marks are shown and options are frozen once the paper has been submitted. */
  review: boolean;
  onAnswer: (n: number, chosen: number | null) => void;
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export default function SectionAMcq({ items, responses, review, onAnswer }: Props) {
  const byNumber = new Map(responses.map((r) => [r.n, r]));

  return (
    <ol className="space-y-3">
      {items.map((item) => {
        const response = byNumber.get(item.n);
        const chosen = response?.chosen ?? null;
        const answer = item.question.answer;
        const right = review && chosen === answer;

        return (
          <li key={item.question.id} className="rounded-2xl border border-border bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-semibold tabular-nums text-ink-soft">
                A{item.n}
              </span>
              <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-medium text-ink-soft">
                {item.marks} {item.marks === 1 ? "mark" : "marks"}
              </span>
              {item.question.type === "assertion-reason" && (
                <span className="rounded-full bg-surface-alt px-2.5 py-1 text-[11px] font-medium text-ink-soft">
                  Assertion &amp; reason
                </span>
              )}
              {review && (
                <span
                  className={`ml-auto rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    right ? "bg-accent-soft text-accent" : "bg-surface-alt text-ink-soft"
                  }`}
                >
                  {right ? `${item.marks} / ${item.marks}` : `0 / ${item.marks}`}
                </span>
              )}
            </div>

            {/* The stem wraps freely and is never clamped: half a question is
                not a question. */}
            <p className="text-[15px] leading-relaxed font-medium break-words">
              {item.question.question}
            </p>

            <div className="mt-4 space-y-2" role="group" aria-label={`Question A${item.n} options`}>
              {item.question.options.map((option, i) => {
                const isChosen = chosen === i;
                const isAnswer = i === answer;

                let tone = "border-border bg-surface text-ink hover:border-accent/60";
                if (review && isAnswer) tone = "border-accent bg-accent-soft text-accent";
                else if (review && isChosen) tone = "border-ink-faint bg-surface-alt text-ink-soft";
                else if (review) tone = "border-border bg-surface text-ink-faint";
                else if (isChosen) tone = "border-accent bg-accent-soft text-accent";

                return (
                  <button
                    key={option}
                    type="button"
                    /* Tapping the chosen option again clears it. A blank is a
                       real answer in an exam and there is no other way back to
                       one once an option has been touched. */
                    onClick={() => onAnswer(item.n, isChosen ? null : i)}
                    disabled={review}
                    aria-pressed={isChosen}
                    className={`flex w-full min-h-14 items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-default ${tone}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${
                        (review && isAnswer) || (!review && isChosen)
                          ? "border-accent bg-accent text-accent-ink"
                          : "border-border text-ink-faint"
                      }`}
                    >
                      {LETTERS[i] ?? i + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-sm leading-snug break-words">
                      {option}
                    </span>
                    {review && isAnswer && (
                      <span className="shrink-0 text-xs font-semibold">Correct</span>
                    )}
                    {review && isChosen && !isAnswer && (
                      <span className="shrink-0 text-xs font-semibold">Yours</span>
                    )}
                  </button>
                );
              })}
            </div>

            {review && !right && (
              <div className="mt-4 rounded-xl bg-surface-alt p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  {chosen === null ? "Left blank" : "Not quite"}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft break-words">
                  {item.question.explanation ??
                    `The correct answer is ${LETTERS[answer] ?? answer + 1}. ${
                      item.question.options[answer]
                    }`}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
