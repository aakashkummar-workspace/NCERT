"use client";

/**
 * One graded answer, in the marking scheme's own words.
 *
 * Three decisions here are the product, not the styling:
 *
 * 1. **Unmarked marks are never folded into the total.** "You scored 3 out of
 *    5" and "of the 4 marks anyone has checked, you scored 3" are different
 *    claims, and when a diagram step is waiting for a teacher only the second
 *    one is true. So the headline number is out of what was actually checked,
 *    and the marks nobody has judged are named separately, in their own words.
 * 2. **The scheme's own text is always shown.** Reading a marking scheme is an
 *    exam skill in its own right, and printing what the mark was for is what
 *    makes a wrong grade arguable rather than authoritative: a student who can
 *    see the line can say "but I did write that". Never a paraphrase.
 * 3. **An unmarked step is not a wrong step.** It gets a grey dash, never a
 *    red cross, and it says which of the two reasons it is: waiting on a human
 *    eye (a diagram), or waiting on a human signature (an unreviewed rubric).
 *    Showing it as a loss is the one mistake with no recovery.
 */

export type Verdict = "HIT" | "PARTIAL" | "MISS" | "UNMARKED";

export interface SchemeLine {
  criterionId: string;
  stepId: string;
  kind: string;
  awardFor: string;
  branchLabel: string | null;
  marks: number;
  chooseAtLeast: number | null;
  marksEach: number | null;
  unitRequired: boolean;
  unitAccepted: string[];
  labels: string[];
  tags: string[];
  tagDemands: { tag: string; minCount: number }[];
  autoGradable: boolean;
  partialRules: { reason: string; award: number; note: string | null }[];
  children: SchemeLine[];
}

export interface CriterionOutcome {
  /** The CriterionResult row id. A HighlightSpan points at this. */
  resultId: string;
  criterionId: string;
  stepId: string;
  kind: string;
  awardFor: string;
  verdict: Verdict;
  awarded: number;
  unmarkedReason: string | null;
  partialReason: string | null;
  partialNote: string | null;
  note: string | null;
}

export interface Highlight {
  id: string;
  criterionResultId: string | null;
  submissionPageId: string;
  color: "GREEN" | "ORANGE" | "RED";
  x: number;
  y: number;
  width: number;
  height: number;
  transcriptStart: number | null;
  transcriptEnd: number | null;
  label: string | null;
}

export interface AnswerDetail {
  answerId: string;
  questionNumber: number;
  maxMarks: number;
  type: string;
  transcript: string | null;
  pages: { submissionPageId: string; ordinal: number }[];
  rubric: {
    id: string;
    externalId: string | null;
    prompt: string | null;
    maxMarks: number;
    ordering: string;
    acceptEquivalentWording: boolean;
    needsReview: boolean;
    reviewNotes: string[];
    schemeFile: string | null;
    schemePage: number | null;
    scheme: SchemeLine[];
  } | null;
  grade: {
    id: string;
    source: "AI" | "HUMAN";
    revision: number;
    awardedMarks: number;
    maxMarks: number;
    unmarkedCount: number;
    unmarkedMarks: number;
    checkedMarks: number;
    confidence: number | null;
    modelName: string | null;
    evaluator: string | null;
    comment: string | null;
    createdAt: string;
    criteria: CriterionOutcome[];
    highlights: Highlight[];
  } | null;
  history: {
    id: string;
    source: "AI" | "HUMAN";
    revision: number;
    awardedMarks: number;
    maxMarks: number;
    unmarkedCount: number;
    evaluator: string | null;
    createdAt: string;
  }[];
}

const PARTIAL_WORDS: Record<string, string> = {
  UNIT_MISSING: "the value is right, no unit was written",
  UNIT_WRONG: "a unit was written and it is the wrong one",
  ORDER_BROKEN: "present, but out of sequence on a step that is ordered",
  KEYWORDS_PARTIAL: "some of the ideas appeared, not all",
  ARITHMETIC_SLIP: "the method is right, the number that comes out is not",
  FORMULA_ONLY: "the formula is quoted and never substituted into",
  SIGN_ERROR: "magnitude right, sign wrong",
  UNROUNDED: "to more or fewer figures than the scheme asks",
};

const UNMARKED_WORDS: Record<string, string> = {
  NOT_AUTO_GRADABLE: "waiting for a teacher's eye — a drawing cannot be marked from a photograph",
  RUBRIC_NEEDS_REVIEW: "waiting for a teacher to sign this marking scheme off",
};

const SWATCH: Record<Verdict, string> = {
  HIT: "bg-emerald-500",
  PARTIAL: "bg-amber-500",
  MISS: "bg-rose-500",
  // Deliberately not a colour. An unmarked step is not an outcome the student
  // is being told anything about yet.
  UNMARKED: "bg-transparent border border-dashed border-ink-faint",
};

const marks = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}`;

export interface GradedAnswerProps {
  answer: AnswerDetail;
  /** Highlight this criterion's spans on the scan while it is hovered. */
  onFocusCriterion?: (criterionId: string | null) => void;
  focusedCriterionId?: string | null;
}

export default function GradedAnswer({
  answer,
  onFocusCriterion,
  focusedCriterionId,
}: GradedAnswerProps) {
  const { grade, rubric } = answer;

  if (!grade) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h3 className="text-base font-semibold">Question {answer.questionNumber}</h3>
        <p className="mt-2 text-sm text-ink-soft">
          Not marked yet. Nothing has been guessed at in the meantime.
        </p>
      </section>
    );
  }

  const outcomeByCriterion = new Map(grade.criteria.map((c) => [c.criterionId, c]));
  const hasUnmarked = grade.unmarkedMarks > 0;

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">Question {answer.questionNumber}</h3>
        <p className="text-sm">
          <span className="text-xl font-semibold">{marks(grade.awardedMarks)}</span>
          <span className="text-ink-soft">
            {" "}
            of {marks(hasUnmarked ? grade.checkedMarks : grade.maxMarks)}
          </span>
        </p>
      </header>

      {hasUnmarked && (
        // The honest denominator, spelled out rather than implied by a number.
        <p className="mt-1 text-xs text-ink-soft">
          Out of the {marks(grade.checkedMarks)} mark
          {grade.checkedMarks === 1 ? "" : "s"} anyone has checked. The other{" "}
          {marks(grade.unmarkedMarks)} on this question{" "}
          {grade.unmarkedMarks === 1 ? "is" : "are"} not marked yet — not lost.
        </p>
      )}

      {rubric?.needsReview && (
        <p className="mt-3 rounded-md bg-surface-alt p-3 text-xs text-ink-soft">
          This marking scheme has not been checked by a teacher yet, so nothing you wrote has been
          marked <em>wrong</em> here. Anything the scheme and your answer did not obviously agree on
          is left unmarked until a teacher signs the scheme off.
          {rubric.reviewNotes.length > 0 && (
            <span className="mt-1 block">Open question: {rubric.reviewNotes.join("; ")}</span>
          )}
        </p>
      )}

      {rubric?.prompt && (
        <p className="mt-3 text-sm text-ink-soft">
          <span className="font-medium text-ink">Asked: </span>
          {rubric.prompt}
        </p>
      )}

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        The marking scheme, line by line
      </h4>
      <ul className="mt-2 flex flex-col gap-2">
        {(rubric?.scheme ?? []).map((line) => {
          const outcome = outcomeByCriterion.get(line.criterionId);
          const verdict: Verdict = outcome?.verdict ?? "UNMARKED";
          return (
            <li
              key={line.criterionId}
              className={`rounded-md border p-3 ${
                focusedCriterionId === line.criterionId ? "border-accent" : "border-border"
              }`}
              onMouseEnter={() => onFocusCriterion?.(line.criterionId)}
              onMouseLeave={() => onFocusCriterion?.(null)}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${SWATCH[verdict]}`}
                />
                <div className="min-w-0 flex-1">
                  {/* The scheme's own words. Never a paraphrase. */}
                  <p className="text-sm">{line.awardFor}</p>

                  {line.kind === "CHOOSE" && (
                    <p className="mt-1 text-xs text-ink-faint">
                      Any {line.chooseAtLeast} of the following, {marks(line.marksEach ?? 0)} mark
                      {line.marksEach === 1 ? "" : "s"} each
                      {line.tagDemands.length > 0 &&
                        ` — at least ${line.tagDemands
                          .map((t) => `${t.minCount} ${t.tag}`)
                          .join(", ")}`}
                    </p>
                  )}
                  {line.unitRequired && (
                    <p className="mt-1 text-xs text-ink-faint">
                      The unit is required: {line.unitAccepted.join(", ")}
                    </p>
                  )}
                  {line.labels.length > 0 && (
                    <p className="mt-1 text-xs text-ink-faint">
                      The figure must show: {line.labels.join(", ")}
                    </p>
                  )}

                  {line.children.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1 border-l border-border pl-3">
                      {line.children.map((child) => (
                        <li key={child.criterionId} className="text-xs text-ink-soft">
                          {child.branchLabel ? `${child.branchLabel}. ` : ""}
                          {child.awardFor}
                          {child.tags.length > 0 && (
                            <span className="text-ink-faint"> [{child.tags.join(", ")}]</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {verdict === "PARTIAL" && outcome?.partialReason && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                      Part marks: {outcome.partialNote ?? PARTIAL_WORDS[outcome.partialReason] ?? outcome.partialReason}
                    </p>
                  )}
                  {verdict === "UNMARKED" && (
                    <p className="mt-2 text-xs text-ink-faint">
                      Not marked — {UNMARKED_WORDS[outcome?.unmarkedReason ?? ""] ?? "waiting for a person"}
                    </p>
                  )}
                  {outcome?.note && verdict !== "UNMARKED" && (
                    <p className="mt-2 text-xs text-ink-soft">{outcome.note}</p>
                  )}
                </div>
                <p className="shrink-0 text-xs tabular-nums text-ink-soft">
                  {verdict === "UNMARKED" ? "—" : marks(outcome?.awarded ?? 0)} / {marks(line.marks)}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <footer className="mt-4 border-t border-border pt-3 text-xs text-ink-faint">
        <p>
          {grade.source === "HUMAN"
            ? `Marked by ${grade.evaluator ?? "a teacher"}`
            : `Marked by ${grade.modelName ?? "the automatic marker"}`}
          {grade.source === "AI" && grade.confidence !== null && (
            <> · confidence {Math.round(grade.confidence * 100)}%</>
          )}
          {rubric?.schemeFile && (
            <>
              {" "}
              · from {rubric.schemeFile}
              {rubric.schemePage ? `, page ${rubric.schemePage}` : ""}
            </>
          )}
        </p>
        {grade.comment && <p className="mt-1 text-ink-soft">{grade.comment}</p>}
        {answer.history.length > 0 && (
          // The chain, not a mark that silently changed.
          <p className="mt-2">
            {[...answer.history]
              .reverse()
              .concat(grade)
              .map(
                (g) =>
                  `${g.source === "AI" ? "automatic" : (g.evaluator ?? "teacher")}: ${marks(g.awardedMarks)}`,
              )
              .join(" → ")}
          </p>
        )}
      </footer>
    </section>
  );
}
