"use client";

/**
 * The CBSE rubric matcher: the student's own handwriting with green, orange and
 * red drawn over it, and the marking scheme beside it.
 *
 * Green is a confirmed core-curriculum keyword or step; orange is a step that
 * is there but losing fractional marks; red is filler that earns nothing. There
 * is deliberately **no fourth colour**. A step nobody has marked — a diagram, or
 * anything on a marking scheme a teacher has not signed off — produces no
 * rectangle at all, and appears only in the checklist with a dashed outline and
 * a sentence saying what it is waiting for. The database has no colourless span
 * for the same reason: a span with no colour is rendered red by the first
 * renderer that forgets to skip it, and red is an accusation.
 *
 * Boxes are stored as fractions of the page, not pixels, because the phone
 * decides the capture resolution and the reader decides the zoom. They are
 * turned back into pixels here, once, by a percentage layout that costs nothing
 * to reflow.
 */

import { useMemo, useState } from "react";
import GradedAnswer, { type AnswerDetail, type Highlight } from "@/components/GradedAnswer";

export interface SubmissionPageView {
  id: string;
  pageIndex: number;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  url: string | null;
}

export interface SubmissionDetail {
  id: string;
  paperSlug: string | null;
  subject: string;
  classNum: number;
  status: string;
  pageCount: number;
  failureReason: string | null;
  capturedAt: string | null;
  gradedAt: string | null;
  createdAt: string;
  pages: SubmissionPageView[];
  answers: AnswerDetail[];
}

const SPAN_STYLE: Record<Highlight["color"], string> = {
  GREEN: "border-emerald-500/90 bg-emerald-400/25",
  ORANGE: "border-amber-500/90 bg-amber-400/25",
  RED: "border-rose-500/90 bg-rose-400/25",
};

const STATUS_WORDS: Record<string, string> = {
  UPLOADING: "still uploading",
  QUEUED: "queued — nothing has been marked yet",
  OCR_RUNNING: "being read",
  AI_GRADING: "being marked",
  AWAITING_REVIEW: "marked, and waiting for a teacher to check the parts a machine would not",
  UNDER_REVIEW: "with a teacher now",
  GRADED: "marked",
  FAILED: "could not be marked",
};

export interface RubricMatcherProps {
  submission: SubmissionDetail;
}

export default function RubricMatcher({ submission }: RubricMatcherProps) {
  const [answerId, setAnswerId] = useState<string | null>(submission.answers[0]?.answerId ?? null);
  const [focused, setFocused] = useState<string | null>(null);

  const answer = submission.answers.find((a) => a.answerId === answerId) ?? submission.answers[0];

  const pages = useMemo(() => {
    if (!answer) return submission.pages;
    const wanted = new Map(answer.pages.map((p) => [p.submissionPageId, p.ordinal]));
    const chosen = submission.pages.filter((p) => wanted.has(p.id));
    // The pages of this answer, in reading order — which is `ordinal`, not the
    // page index, because one answer can start halfway down a sheet.
    return chosen.sort(
      (a, b) => (wanted.get(a.id) as number) - (wanted.get(b.id) as number),
    );
  }, [answer, submission.pages]);

  // Hovering a line of the scheme lights up the words that earned or lost it.
  // A span points at the `CriterionResult` row, not at the rubric criterion, so
  // the focused criterion is resolved to its result id first.
  const focusedResultId = useMemo(() => {
    if (!answer?.grade || !focused) return null;
    return answer.grade.criteria.find((c) => c.criterionId === focused)?.resultId ?? null;
  }, [answer, focused]);

  if (!submission.answers.length) {
    return (
      <p className="rounded-lg border border-border bg-surface p-4 text-sm text-ink-soft">
        This script is {STATUS_WORDS[submission.status] ?? submission.status.toLowerCase()}. No
        question has been declared on it yet, so there is nothing to mark against a scheme.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft">
        This script is {STATUS_WORDS[submission.status] ?? submission.status.toLowerCase()}.
        {submission.failureReason && (
          <span className="block text-accent">{submission.failureReason}</span>
        )}
      </p>

      {submission.answers.length > 1 && (
        <nav className="flex flex-wrap gap-2" aria-label="Questions on this script">
          {submission.answers.map((a) => (
            <button
              key={a.answerId}
              type="button"
              aria-current={a.answerId === answer?.answerId}
              onClick={() => setAnswerId(a.answerId)}
              className={`min-h-12 rounded-md border px-3 text-sm ${
                a.answerId === answer?.answerId
                  ? "border-accent bg-accent-soft"
                  : "border-border text-ink-soft"
              }`}
            >
              Q{a.questionNumber}
            </button>
          ))}
        </nav>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          {pages.map((page) => {
            const spans = (answer?.grade?.highlights ?? []).filter((h) => h.submissionPageId === page.id);
            return (
              <figure key={page.id} className="relative overflow-hidden rounded-lg border border-border">
                {page.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={page.url}
                    alt={`Page ${page.pageIndex + 1} of the script`}
                    className="block w-full"
                  />
                ) : (
                  <div className="flex aspect-[3/4] items-center justify-center bg-surface-alt text-sm text-ink-faint">
                    This page could not be loaded.
                  </div>
                )}
                {spans.map((span) => (
                  <span
                    key={span.id}
                    title={span.label ?? undefined}
                    className={`pointer-events-none absolute rounded-sm border-2 transition-opacity ${
                      SPAN_STYLE[span.color]
                    } ${
                      focusedResultId && span.criterionResultId !== focusedResultId
                        ? "opacity-25"
                        : "opacity-100"
                    }`}
                    style={{
                      left: `${span.x * 100}%`,
                      top: `${span.y * 100}%`,
                      width: `${span.width * 100}%`,
                      height: `${span.height * 100}%`,
                    }}
                  />
                ))}
                <figcaption className="flex flex-wrap gap-3 border-t border-border bg-surface px-3 py-2 text-xs text-ink-faint">
                  <span>Page {page.pageIndex + 1}</span>
                  <Key color="GREEN" label="earned" />
                  <Key color="ORANGE" label="part marks" />
                  <Key color="RED" label="earns nothing" />
                </figcaption>
              </figure>
            );
          })}

          {answer?.transcript && (
            <details className="rounded-lg border border-border bg-surface p-3">
              <summary className="cursor-pointer text-sm font-medium">
                What the marker read
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{answer.transcript}</p>
              <p className="mt-2 text-xs text-ink-faint">
                If this is not what you wrote, the photograph is the problem, not your answer.
                Re-shoot the page in better light and submit it again.
              </p>
            </details>
          )}
        </div>

        {answer && (
          <GradedAnswer
            answer={answer}
            focusedCriterionId={focused}
            onFocusCriterion={setFocused}
          />
        )}
      </div>
    </div>
  );
}

function Key({ color, label }: { color: Highlight["color"]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className={`h-3 w-3 rounded-sm border-2 ${SPAN_STYLE[color]}`} />
      {label}
    </span>
  );
}
