/**
 * Human review of a grade — the append-only half of the grading tier.
 *
 * ## A human override is a new row, never an edit
 *
 * `docs/PLATFORM.md` §8 and `prisma/README.md` §7 both say it: **do not
 * `UPDATE` a `GradingResult`.** A grade is evidence. When a teacher disagrees
 * with the model, the model's verdict — its marks, its confidence, its model
 * version, its per-criterion results, its highlight spans — survives intact
 * beside the teacher's, and the student is shown
 *
 * > AI: 3/5 → your teacher: 4/5 — "gave the formula, so the working counts"
 *
 * rather than a mark that quietly changed between two screens. It is also the
 * only way the model's accuracy can be measured against human evaluators later
 * without a separate audit log.
 *
 * The chain is kept linear by the database, not by this file: `supersedesId` is
 * `@unique`, so if two evaluators both try to override revision 2, exactly one
 * insert succeeds and the other gets a unique violation, which
 * `appendHumanGrade` turns into a 409 rather than a 500. That is deliberate —
 * "someone else has already re-marked this" is a real answer, and a lost update
 * is not.
 *
 * ## The rubric's safety rules are the evaluator's job list
 *
 * `data/rubrics.schema.md` has a fourth outcome beside hit/partial/miss:
 * **unmarked**, which awards nothing and means "nobody has judged this yet".
 * It arises two ways, and both of them are precisely what a human is here for:
 *
 * - `NOT_AUTO_GRADABLE` — a diagram. A keyword matcher run over a photograph
 *   cannot honestly say whether a triangle was drawn correctly.
 * - `RUBRIC_NEEDS_REVIEW` — a miss withheld because the rubric is unsigned.
 *   Nothing is ever painted red on a rubric flagged `needsReview`: an unchecked
 *   conversion may accuse a student of writing nothing of value, which is the
 *   one mistake with no recovery.
 *
 * So `checklistFor` sorts unmarked criteria to the top. They are the
 * highest-value thing a human does here, and burying them under twelve criteria
 * the model already agreed with is how they stay unresolved.
 *
 * ## Why the verdicts are validated here as well as in the database
 *
 * `criterion_verdict_consistent` and friends are CHECK constraints, and a
 * violation of one arrives as a raw Postgres error, which `route()` correctly
 * refuses to leak and turns into a bare 500. A 500 tells the evaluator nothing.
 * `validateCriterionInput` re-states the same invariants so the caller gets a
 * 400 naming the field. The database stays the authority; this is the error
 * message.
 */
import { Prisma } from "@prisma/client";
import type {
  CriterionVerdict,
  GradingResult,
  HighlightColor,
  UnmarkedReason,
} from "@prisma/client";
import prisma from "@/lib/db";
import { ApiError, isUniqueViolation, type FieldIssue } from "@/lib/api";

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

/**
 * The current verdict on an answer: the highest revision.
 *
 * Equivalently, the row nothing supersedes — `@@unique([answerId, revision])`
 * and the unique on `supersedesId` mean the two definitions cannot disagree.
 */
export async function currentGradeFor(answerId: string): Promise<GradingResult | null> {
  return prisma.gradingResult.findFirst({
    where: { answerId },
    orderBy: { revision: "desc" },
  });
}

export interface GradeChainEntry {
  id: string;
  revision: number;
  source: "AI" | "HUMAN";
  awardedMarks: number;
  maxMarks: number;
  unmarkedCount: number;
  comment: string | null;
  confidence: number | null;
  modelName: string | null;
  evaluatorId: string | null;
  evaluatorName: string | null;
  createdAt: string;
  supersedesId: string | null;
  current: boolean;
}

/**
 * Every verdict ever given on this answer, oldest first — the thing the student
 * is shown as "AI: 3/5 → your teacher: 4/5".
 */
export async function gradeChainFor(answerId: string): Promise<GradeChainEntry[]> {
  const rows = await prisma.gradingResult.findMany({
    where: { answerId },
    orderBy: { revision: "asc" },
    include: { evaluator: { select: { id: true, displayName: true } } },
  });
  const top = rows.length ? rows[rows.length - 1].id : null;
  return rows.map((r) => ({
    id: r.id,
    revision: r.revision,
    source: r.source,
    awardedMarks: Number(r.awardedMarks),
    maxMarks: Number(r.maxMarks),
    unmarkedCount: r.unmarkedCount,
    comment: r.comment,
    confidence: r.confidence,
    modelName: r.modelName,
    evaluatorId: r.evaluatorId,
    evaluatorName: r.evaluator?.displayName ?? null,
    createdAt: r.createdAt.toISOString(),
    supersedesId: r.supersedesId,
    current: r.id === top,
  }));
}

/**
 * True when the chain is linear and complete: revisions 1..n with no gaps, each
 * superseding its predecessor and the first superseding nothing.
 *
 * The database already guarantees this through two uniques; this is here so the
 * queue test can assert the property directly rather than trusting the argument.
 */
export async function chainIsLinear(answerId: string): Promise<boolean> {
  const rows = await prisma.gradingResult.findMany({
    where: { answerId },
    orderBy: { revision: "asc" },
    select: { id: true, revision: true, supersedesId: true },
  });
  return rows.every(
    (r, i) => r.revision === i + 1 && r.supersedesId === (i === 0 ? null : rows[i - 1].id),
  );
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export type ChecklistUrgency = "NEEDS_YOUR_EYE" | "NEEDS_SIGN_OFF" | "REVIEW" | "SETTLED";

export interface ChecklistItem {
  rubricCriterionId: string;
  stepId: string;
  kind: string;
  awardFor: string;
  branchLabel: string | null;
  parentId: string | null;
  /** What the step is worth: `marks`, or `chooseAtLeast * marksEach` for a group. */
  worth: number;
  autoGradable: boolean;
  labels: string[];
  concepts: string[][];
  partialRules: { id: string; reason: string; award: number; note: string | null }[];
  /** The current verdict on this criterion, if anything has graded it. */
  verdict: CriterionVerdict | null;
  awarded: number | null;
  unmarkedReason: UnmarkedReason | null;
  note: string | null;
  urgency: ChecklistUrgency;
}

export interface Checklist {
  answerId: string;
  questionNumber: number;
  maxMarks: number;
  rubricId: string | null;
  /** Nothing may be painted red while this is true. See the module comment. */
  rubricNeedsReview: boolean;
  reviewNotes: string[];
  /** How many items are waiting on a human. The reason this ticket exists. */
  unresolvedCount: number;
  items: ChecklistItem[];
}

const URGENCY_ORDER: Record<ChecklistUrgency, number> = {
  NEEDS_YOUR_EYE: 0,
  NEEDS_SIGN_OFF: 1,
  REVIEW: 2,
  SETTLED: 3,
};

function urgencyOf(
  verdict: CriterionVerdict | null,
  unmarkedReason: UnmarkedReason | null,
  autoGradable: boolean,
): ChecklistUrgency {
  if (verdict === "UNMARKED" || verdict === null) {
    // An ungraded criterion is not settled either — the model skipped it, and
    // "the model said nothing" reads to a student exactly like "you got it
    // wrong" unless a person closes it.
    if (unmarkedReason === "RUBRIC_NEEDS_REVIEW") return "NEEDS_SIGN_OFF";
    return autoGradable && verdict !== null ? "NEEDS_SIGN_OFF" : "NEEDS_YOUR_EYE";
  }
  // A miss the model asserted is worth a second look before a student sees red.
  return verdict === "MISS" || verdict === "PARTIAL" ? "REVIEW" : "SETTLED";
}

/**
 * The rubric one answer is marked against: whatever the current grade already
 * used, else the newest version authored for this paper and question.
 *
 * There is exactly one of these because there must be exactly one. The canvas
 * resolves a rubric to draw the checklist, and `appendHumanGrade` resolves one
 * to record on the row; if those two rules ever differ, an evaluator ticks the
 * lines of rubric A and the grade claims rubric B.
 *
 * `currentRubricId` is passed in where the caller has already read the head, so
 * that a resolution inside a transaction does not re-read it.
 */
export async function rubricForAnswer(
  answerId: string,
  currentRubricId?: string | null,
): Promise<{ id: string } | null> {
  if (currentRubricId) return prisma.rubric.findUnique({ where: { id: currentRubricId } });
  const answer = await prisma.answer.findUnique({
    where: { id: answerId },
    select: { questionNumber: true, submission: { select: { paperSlug: true } } },
  });
  if (!answer?.submission.paperSlug) return null;
  return prisma.rubric.findFirst({
    where: {
      paperSlug: answer.submission.paperSlug,
      questionNumber: answer.questionNumber,
    },
    orderBy: { version: "desc" },
  });
}

/**
 * The right-hand panel of the grading canvas: every rubric line for this answer,
 * with the current verdict, **unmarked first**.
 *
 * The sort is stable within an urgency band and falls back to the authored
 * order, so the list does not reshuffle under the evaluator as they work.
 */
export async function checklistFor(answerId: string): Promise<Checklist> {
  const answer = await prisma.answer.findUnique({
    where: { id: answerId },
    include: { submission: { select: { paperSlug: true } } },
  });
  if (!answer) throw ApiError.notFound("Answer");

  const current = await currentGradeFor(answerId);
  const found = await rubricForAnswer(answerId, current?.rubricId ?? null);
  const rubric = found
    ? await prisma.rubric.findUnique({ where: { id: found.id } })
    : null;

  if (!rubric) {
    return {
      answerId,
      questionNumber: answer.questionNumber,
      maxMarks: Number(answer.maxMarks),
      rubricId: null,
      rubricNeedsReview: false,
      reviewNotes: [],
      // No rubric at all is the strongest possible "a human is needed here":
      // there is nothing to grade against, so nothing may be graded.
      unresolvedCount: 1,
      items: [],
    };
  }

  const criteria = await prisma.rubricCriterion.findMany({
    where: { rubricId: rubric.id },
    orderBy: { ordinal: "asc" },
    include: {
      concepts: { orderBy: { ordinal: "asc" } },
      partialRules: true,
    },
  });

  const results = current
    ? await prisma.criterionResult.findMany({ where: { gradingResultId: current.id } })
    : [];
  const byCriterion = new Map(results.map((r) => [r.rubricCriterionId, r]));

  const items: ChecklistItem[] = criteria.map((c) => {
    const r = byCriterion.get(c.id) ?? null;
    const worth =
      c.kind === "CHOOSE"
        ? Number(c.marksEach ?? 0) * (c.chooseAtLeast ?? 0)
        : Number(c.marks ?? 0);
    return {
      rubricCriterionId: c.id,
      stepId: c.stepId,
      kind: c.kind,
      awardFor: c.awardFor,
      branchLabel: c.branchLabel,
      parentId: c.parentId,
      worth,
      autoGradable: c.autoGradable,
      labels: c.labels,
      concepts: c.concepts.map((k) => k.phrasings),
      partialRules: c.partialRules.map((p) => ({
        id: p.id,
        reason: p.reason,
        award: Number(p.award),
        note: p.note,
      })),
      verdict: r?.verdict ?? null,
      awarded: r ? Number(r.awarded) : null,
      unmarkedReason: r?.unmarkedReason ?? null,
      note: r?.note ?? null,
      urgency: urgencyOf(r?.verdict ?? null, r?.unmarkedReason ?? null, c.autoGradable),
    };
  });

  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        URGENCY_ORDER[a.item.urgency] - URGENCY_ORDER[b.item.urgency] || a.index - b.index,
    )
    .map(({ item }) => item);

  return {
    answerId,
    questionNumber: answer.questionNumber,
    maxMarks: Number(answer.maxMarks),
    rubricId: rubric.id,
    rubricNeedsReview: rubric.needsReview,
    reviewNotes: rubric.reviewNotes,
    unresolvedCount: ordered.filter(
      (i) => i.urgency === "NEEDS_YOUR_EYE" || i.urgency === "NEEDS_SIGN_OFF",
    ).length,
    items: ordered,
  };
}

// ---------------------------------------------------------------------------
// Appending a human grade
// ---------------------------------------------------------------------------

export interface HighlightInput {
  submissionPageId: string;
  color: HighlightColor;
  /** Fractions of the page in [0, 1], not pixels. The phone picks the capture
   *  resolution and the viewer picks the zoom; a pixel box is correct for
   *  exactly one rendering. */
  x: number;
  y: number;
  width: number;
  height: number;
  transcriptStart?: number | null;
  transcriptEnd?: number | null;
  label?: string | null;
}

export interface CriterionInput {
  rubricCriterionId: string;
  verdict: CriterionVerdict;
  awarded: number;
  partialRuleId?: string | null;
  unmarkedReason?: UnmarkedReason | null;
  note?: string | null;
  highlights?: HighlightInput[];
}

export interface AppendGradeInput {
  answerId: string;
  evaluatorId: string;
  reviewId?: string | null;
  rubricId?: string | null;
  /** Omit to take the sum of the criterion awards, which is the honest default. */
  awardedMarks?: number;
  comment?: string | null;
  criteria: CriterionInput[];
}

function halfMark(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;
}

/**
 * The CHECK constraints, re-stated so a mistake comes back as a 400 naming the
 * field rather than as an opaque 500 from Postgres. Collects every problem
 * rather than throwing on the first, the same way the `v` validators do.
 */
export function validateCriterionInput(input: CriterionInput, path: string): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const awarded = input.awarded;

  if (!halfMark(awarded)) {
    issues.push({ path: `${path}.awarded`, message: "must be a non-negative multiple of 0.5" });
  }

  switch (input.verdict) {
    case "UNMARKED":
      if (awarded !== 0) issues.push({ path: `${path}.awarded`, message: "must be 0 when UNMARKED" });
      if (!input.unmarkedReason) {
        issues.push({
          path: `${path}.unmarkedReason`,
          message: "is required when UNMARKED — a human needs to know whether this waits on an eye or a signature",
        });
      }
      if (input.partialRuleId) {
        issues.push({ path: `${path}.partialRuleId`, message: "only a PARTIAL names a rule" });
      }
      if (input.highlights?.length) {
        issues.push({
          path: `${path}.highlights`,
          message:
            "an UNMARKED criterion paints nothing — a span with no honest colour is a red one waiting to happen",
        });
      }
      break;
    case "MISS":
      if (awarded !== 0) issues.push({ path: `${path}.awarded`, message: "must be 0 when MISS" });
      if (input.unmarkedReason) {
        issues.push({ path: `${path}.unmarkedReason`, message: "only an UNMARKED carries a reason" });
      }
      if (input.partialRuleId) {
        issues.push({ path: `${path}.partialRuleId`, message: "only a PARTIAL names a rule" });
      }
      break;
    case "PARTIAL":
      if (!(awarded > 0)) {
        issues.push({ path: `${path}.awarded`, message: "must be greater than 0 when PARTIAL" });
      }
      if (input.unmarkedReason) {
        issues.push({ path: `${path}.unmarkedReason`, message: "only an UNMARKED carries a reason" });
      }
      break;
    case "HIT":
      if (!(awarded > 0)) {
        issues.push({ path: `${path}.awarded`, message: "must be greater than 0 when HIT" });
      }
      if (input.unmarkedReason) {
        issues.push({ path: `${path}.unmarkedReason`, message: "only an UNMARKED carries a reason" });
      }
      if (input.partialRuleId) {
        issues.push({ path: `${path}.partialRuleId`, message: "only a PARTIAL names a rule" });
      }
      break;
  }

  for (const [i, h] of (input.highlights ?? []).entries()) {
    const hp = `${path}.highlights[${i}]`;
    if (!(h.x >= 0 && h.y >= 0 && h.width > 0 && h.height > 0)) {
      issues.push({ path: hp, message: "box must have a positive size at a non-negative origin" });
    } else if (!(h.x + h.width <= 1 && h.y + h.height <= 1)) {
      issues.push({ path: hp, message: "box must be fractions of the page in [0, 1], not pixels" });
    }
  }

  return issues;
}

export interface AppendGradeResult {
  gradingResult: GradingResult;
  /** What it replaced, or null when this is the first verdict on the answer. */
  supersededId: string | null;
  revision: number;
}

/**
 * Write a human verdict as a new revision.
 *
 * Never updates anything in `grading_results`. The previous row keeps its
 * marks, its criterion results and its highlight spans; this one gets its own
 * set, so the override is auditable line by line rather than only in total.
 *
 * Concurrency is resolved by `supersedesId @unique`: two evaluators overriding
 * the same revision race, one wins, and the loser is told so.
 */
export async function appendHumanGrade(input: AppendGradeInput): Promise<AppendGradeResult> {
  const issues: FieldIssue[] = [];
  input.criteria.forEach((c, i) => issues.push(...validateCriterionInput(c, `criteria[${i}]`)));

  const seen = new Set<string>();
  for (const [i, c] of input.criteria.entries()) {
    if (seen.has(c.rubricCriterionId)) {
      issues.push({ path: `criteria[${i}].rubricCriterionId`, message: "appears twice" });
    }
    seen.add(c.rubricCriterionId);
  }
  if (issues.length) throw ApiError.validation(issues);

  const answer = await prisma.answer.findUnique({
    where: { id: input.answerId },
    select: { id: true, maxMarks: true, attemptQuestionId: true },
  });
  if (!answer) throw ApiError.notFound("Answer");

  const maxMarks = Number(answer.maxMarks);
  const summed = input.criteria.reduce((total, c) => total + c.awarded, 0);
  const awardedMarks = input.awardedMarks ?? summed;

  if (!halfMark(awardedMarks) || awardedMarks > maxMarks) {
    throw ApiError.validation([
      {
        path: "awardedMarks",
        message: `must be a multiple of 0.5 between 0 and ${maxMarks}`,
      },
    ]);
  }

  const unmarkedCount = input.criteria.filter((c) => c.verdict === "UNMARKED").length;

  try {
    return await prisma.$transaction(async (tx) => {
      const head = await tx.gradingResult.findFirst({
        where: { answerId: input.answerId },
        orderBy: { revision: "desc" },
        select: { id: true, revision: true, rubricId: true },
      });

      // A human marking an answer the model never touched is the normal path
      // whenever no ANTHROPIC_API_KEY is configured — there is no head to
      // inherit a rubric from. Falling through to NULL there produced a grade
      // that named no scheme: the student's results screen drew the mark with
      // no marking scheme beside it, and the parent dashboard's chapter signal
      // (which joins grade -> rubric -> bookCode/chapter) stayed empty however
      // many answers were graded. Resolved the same way the canvas resolved the
      // checklist the evaluator just ticked, so the two cannot disagree.
      const rubricId =
        input.rubricId ??
        head?.rubricId ??
        (await rubricForAnswer(input.answerId))?.id ??
        null;

      const created = await tx.gradingResult.create({
        data: {
          answerId: input.answerId,
          rubricId,
          source: "HUMAN",
          revision: (head?.revision ?? 0) + 1,
          supersedesId: head?.id ?? null,
          awardedMarks: new Prisma.Decimal(awardedMarks),
          maxMarks: new Prisma.Decimal(maxMarks),
          unmarkedCount,
          // `grade_source_consistent` requires this on a HUMAN grade, and the
          // whole point of the row is that it names who disagreed.
          evaluatorId: input.evaluatorId,
          reviewId: input.reviewId ?? null,
          comment: input.comment ?? null,
        },
      });

      for (const c of input.criteria) {
        const criterionResult = await tx.criterionResult.create({
          data: {
            gradingResultId: created.id,
            rubricCriterionId: c.rubricCriterionId,
            verdict: c.verdict,
            awarded: new Prisma.Decimal(c.awarded),
            partialRuleId: c.partialRuleId ?? null,
            unmarkedReason: c.unmarkedReason ?? null,
            note: c.note ?? null,
          },
        });
        for (const h of c.highlights ?? []) {
          await tx.highlightSpan.create({
            data: {
              gradingResultId: created.id,
              criterionResultId: criterionResult.id,
              submissionPageId: h.submissionPageId,
              color: h.color,
              x: new Prisma.Decimal(h.x),
              y: new Prisma.Decimal(h.y),
              width: new Prisma.Decimal(h.width),
              height: new Prisma.Decimal(h.height),
              transcriptStart: h.transcriptStart ?? null,
              transcriptEnd: h.transcriptEnd ?? null,
              label: h.label ?? null,
            },
          });
        }
      }

      // The denormalised copy on the mark grid, so a results screen stays one
      // query. `GradingResult` remains the authority; this only ever follows it.
      if (answer.attemptQuestionId) {
        await tx.attemptQuestion.update({
          where: { id: answer.attemptQuestionId },
          data: { awardedMarks: new Prisma.Decimal(awardedMarks) },
        });
      }

      return { gradingResult: created, supersededId: head?.id ?? null, revision: created.revision };
    });
  } catch (err) {
    if (isUniqueViolation(err, "supersedesId") || isUniqueViolation(err, "revision")) {
      throw new ApiError(
        "CONFLICT",
        "Another evaluator has already re-marked this answer. Reload to see their verdict before overriding it.",
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Whether anything is configured that can turn a voice note into text.
 *
 * There is no transcription provider in this repo and this lane does not add
 * one. When none is configured, a voice note's `transcriptStatus` must say so
 * — `FAILED`, with the reason on the row's `transcript` left NULL — rather than
 * sitting on `PENDING` forever pretending a worker is coming, and emphatically
 * rather than filling `transcript` with anything at all. A fabricated
 * transcript under an evaluator's name is a sentence they did not say attached
 * to a mark they did award.
 */
export function transcriptionProvider(): string | null {
  const configured = process.env.TRANSCRIPTION_PROVIDER?.trim();
  return configured && configured.length > 0 ? configured : null;
}

export const NO_TRANSCRIPTION_MESSAGE =
  "No transcription provider is configured, so this note will not be transcribed. The audio plays as recorded.";
