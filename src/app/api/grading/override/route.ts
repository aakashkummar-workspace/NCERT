/**
 * POST /api/grading/override/   a person disagreeing with the machine
 *
 * An INSERT, always. The AI's verdict survives underneath the new one with its
 * own `CriterionResult` rows and its own highlights, because "the AI's grade is
 * evidence, and so is the fact that a human disagreed with it". A student is
 * entitled to see "AI: 3/5 -> your teacher: 4/5" rather than a mark that
 * silently changed, and `docs/PLATFORM.md` lists `UPDATE`ing a `GradingResult`
 * among the things not to do.
 *
 * `expectedRevision` is optimistic concurrency, and it is here because two
 * evaluators reviewing one script is a real queue state, not a hypothetical:
 * without it the second one's save would append on top of a verdict they never
 * read. There is no column to hold an idempotency key on this table, so the
 * `Idempotency-Key` header is demanded for the retry to be *declared*, and
 * `@@unique([answerId, revision])` plus `supersedesId @unique` are what
 * actually stop a retry becoming two revisions.
 */
import { ApiError, isUniqueViolation, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { persistHumanOverride, type OverrideCriterion } from "@/lib/grading";
import { requireVisibleSubmission } from "../../submissions/access";

const PARTIAL_REASONS = [
  "UNIT_MISSING",
  "UNIT_WRONG",
  "ORDER_BROKEN",
  "KEYWORDS_PARTIAL",
  "ARITHMETIC_SLIP",
  "FORMULA_ONLY",
  "SIGN_ERROR",
  "UNROUNDED",
] as const;

export const POST = route(
  {
    auth: ["EVALUATOR", "ADMIN"],
    idempotent: true,
    body: v.object({
      answerId: v.uuid(),
      /** The revision the evaluator was looking at. 409 if it has moved. */
      expectedRevision: v.optional(v.int({ min: 1, max: 1000 })),
      reviewId: v.optional(v.uuid()),
      comment: v.optional(v.string({ max: 2000 })),
      criteria: v.array(
        v.object({
          criterionId: v.uuid(),
          verdict: v.enumOf(["HIT", "PARTIAL", "MISS", "UNMARKED"] as const),
          awarded: v.number({ min: 0, max: 30 }),
          partialReason: v.optional(v.enumOf(PARTIAL_REASONS)),
          note: v.optional(v.string({ max: 500 })),
        }),
        { min: 1, max: 40 },
      ),
    }),
  },
  async ({ user, body }) => {
    const answer = await prisma.answer.findUnique({
      where: { id: body.answerId },
      select: { id: true, submissionId: true },
    });
    if (!answer) throw ApiError.notFound("Answer");
    // The evaluator must have this script in front of them through the queue —
    // claimed, assigned, or already reviewed. Not "any evaluator": one who can
    // grade everything by id has no queue.
    await requireVisibleSubmission(user, answer.submissionId);

    const current = await prisma.gradingResult.findFirst({
      where: { answerId: body.answerId },
      orderBy: { revision: "desc" },
      select: { revision: true, source: true },
    });
    if (!current) {
      throw new ApiError(
        "CONFLICT",
        "There is nothing to override yet: this answer has no grade to supersede.",
      );
    }
    if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) {
      throw new ApiError(
        "CONFLICT",
        `This answer has been graded again since you opened it (now revision ${current.revision}). Reload and re-check before saving.`,
      );
    }

    // A review, if one was named, must belong to this evaluator. `reviewId` is
    // a foreign key on a row that records who did the work, and one taken on
    // trust would file this override under someone else's name.
    let reviewId: string | null = null;
    if (body.reviewId) {
      const review = await prisma.evaluatorReview.findFirst({
        where: { id: body.reviewId, evaluatorId: user.id },
        select: { id: true },
      });
      if (!review) throw ApiError.validation([{ path: "reviewId", message: "is not your review" }]);
      reviewId = review.id;
    }

    try {
      const result = await persistHumanOverride({
        answerId: body.answerId,
        // From the session. There is no evaluatorId in this body.
        evaluatorId: user.id,
        reviewId,
        comment: body.comment ?? null,
        criteria: body.criteria as OverrideCriterion[],
      });
      return {
        ...result,
        revision: current.revision + 1,
        supersededRevision: current.revision,
        supersededSource: current.source,
      };
    } catch (err) {
      if (isUniqueViolation(err, "revision") || isUniqueViolation(err, "supersedesId")) {
        // Two saves raced. The chain stays linear by construction; the loser is
        // told to reload rather than silently appending a third revision.
        throw new ApiError(
          "CONFLICT",
          "Another grade was appended to this answer at the same moment. Reload and re-check before saving.",
        );
      }
      throw err;
    }
  },
);
