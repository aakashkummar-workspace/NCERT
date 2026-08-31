/**
 * POST /api/reviews/{reviewId}/grade/ — a human's verdict on one answer.
 *
 * **This never updates a grade. It appends one.** A `GradingResult` is
 * evidence: the model's marks, its confidence, its per-criterion verdicts and
 * its highlight spans all survive beside the teacher's, which is what lets the
 * student be shown
 *
 * > AI: 3/5 → your teacher: 4/5 — "gave the formula, so the working counts"
 *
 * rather than a mark that quietly changed between two screens. See
 * `src/lib/review.ts`, and `prisma/README.md` §7 for why.
 *
 * ## Concurrency, and why there is no Idempotency-Key here
 *
 * `supersedesId` is `@unique`, so the chain is linear by construction: two
 * evaluators cannot both override revision 2 and leave two rows each claiming
 * to be current. That also means a retry cannot duplicate a grade — the second
 * insert loses the unique and this route answers 409.
 *
 * `expectedRevision` makes that answer useful rather than mysterious. The
 * client sends the revision it was looking at; a mismatch means the chain moved
 * under it, and the response carries the current chain so the evaluator can see
 * what changed before deciding whether they still disagree. An `Idempotency-Key`
 * would need a column on `grading_results` to record it, the schema is frozen,
 * and inventing one in a comment field would be worse than this.
 *
 * ## The safety rules are enforced, not assumed
 *
 * `validateCriterionInput` re-states the CHECK constraints so a mistake comes
 * back as a 400 naming the field instead of a bare 500. In particular an
 * `UNMARKED` criterion must award 0, must carry a reason, and must paint
 * nothing: a span with no honest colour is a red one waiting for the first
 * renderer that forgets to skip it.
 */
import { ApiError, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { heldTicket } from "@/lib/queue";
import { appendHumanGrade, currentGradeFor, gradeChainFor } from "@/lib/review";

const highlight = v.object({
  submissionPageId: v.uuid(),
  color: v.enumOf(["GREEN", "ORANGE", "RED"] as const),
  x: v.number({ min: 0, max: 1 }),
  y: v.number({ min: 0, max: 1 }),
  width: v.number({ min: 0, max: 1 }),
  height: v.number({ min: 0, max: 1 }),
  transcriptStart: v.optional(v.int({ min: 0 })),
  transcriptEnd: v.optional(v.int({ min: 0 })),
  label: v.optional(v.string({ max: 200 })),
});

const criterion = v.object({
  rubricCriterionId: v.uuid(),
  verdict: v.enumOf(["HIT", "PARTIAL", "MISS", "UNMARKED"] as const),
  awarded: v.number({ min: 0, max: 100 }),
  partialRuleId: v.optional(v.uuid()),
  unmarkedReason: v.optional(v.enumOf(["NOT_AUTO_GRADABLE", "RUBRIC_NEEDS_REVIEW"] as const)),
  note: v.optional(v.string({ max: 1000 })),
  highlights: v.withDefault(v.array(highlight, { max: 40 }), []),
});

export const POST = route(
  {
    auth: "EVALUATOR",
    body: v.object({
      answerId: v.uuid(),
      /** The revision the evaluator was looking at. `0` means "nothing yet". */
      expectedRevision: v.int({ min: 0, max: 10_000 }),
      /** Omit to take the sum of the criterion awards, which is the honest default. */
      awardedMarks: v.optional(v.number({ min: 0, max: 100 })),
      comment: v.optional(v.string({ max: 4000 })),
      criteria: v.array(criterion, { max: 80 }),
    }),
  },
  async ({ user, body, params }) => {
    const reviewId = String(params.reviewId);

    const review = await prisma.evaluatorReview.findFirst({
      where: { id: reviewId, evaluatorId: user.id },
      select: { id: true, ticketId: true, submittedAt: true },
    });
    // Same answer whether the review belongs to someone else or does not exist.
    if (!review) throw ApiError.notFound("Review");
    if (review.submittedAt) {
      throw new ApiError("CONFLICT", "This review has already been submitted.");
    }

    // Re-checked on every write, not once when the canvas opened. A lease can
    // expire mid-review, and marking a script somebody else now holds is the
    // exact double-booking this lane exists to prevent.
    const ticket = await heldTicket(review.ticketId, user);

    const answer = await prisma.answer.findFirst({
      where: { id: body.answerId, submissionId: ticket.submissionId },
      select: { id: true },
    });
    // The answer must belong to *this* ticket's submission. Without this, a
    // held ticket is a licence to re-mark every answer in the database.
    if (!answer) throw ApiError.notFound("Answer");

    const head = await currentGradeFor(body.answerId);
    const actualRevision = head?.revision ?? 0;
    if (actualRevision !== body.expectedRevision) {
      throw new ApiError(
        "CONFLICT",
        `This answer is now at revision ${actualRevision}; you were looking at ${body.expectedRevision}. Reload to see the current verdict before overriding it.`,
      );
    }

    const result = await appendHumanGrade({
      answerId: body.answerId,
      evaluatorId: user.id,
      reviewId: review.id,
      awardedMarks: body.awardedMarks,
      comment: body.comment ?? null,
      criteria: body.criteria.map((c) => ({
        rubricCriterionId: c.rubricCriterionId,
        verdict: c.verdict,
        awarded: c.awarded,
        partialRuleId: c.partialRuleId ?? null,
        unmarkedReason: c.unmarkedReason ?? null,
        note: c.note ?? null,
        highlights: c.highlights.map((h) => ({
          submissionPageId: h.submissionPageId,
          color: h.color,
          x: h.x,
          y: h.y,
          width: h.width,
          height: h.height,
          transcriptStart: h.transcriptStart ?? null,
          transcriptEnd: h.transcriptEnd ?? null,
          label: h.label ?? null,
        })),
      })),
    });

    return {
      gradingResultId: result.gradingResult.id,
      revision: result.revision,
      supersededId: result.supersededId,
      /** The whole chain back, so the canvas can render "AI 3/5 → you 4/5". */
      chain: await gradeChainFor(body.answerId),
    };
  },
);
