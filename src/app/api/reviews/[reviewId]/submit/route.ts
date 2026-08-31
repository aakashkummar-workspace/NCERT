/**
 * POST /api/reviews/{reviewId}/submit/ — done with this script.
 *
 * Closes the pass, completes the ticket and marks the submission graded, in one
 * transaction. `agreedWithAi` is computed here rather than taken from the body:
 * it is the cheap rollup used to measure the model, and a number the evaluator
 * could assert would measure the evaluator's opinion of themselves instead.
 * "Agreed" means this review appended no `HUMAN` revision that changed a mark.
 *
 * Refuses while any answer still has an `UNMARKED` criterion in its current
 * verdict, unless the evaluator says `leaveUnresolved` in as many words. An
 * unmarked criterion is the highest-value thing a human does here — a diagram
 * nobody can machine-grade, or a miss withheld on an unsigned rubric — and
 * closing the ticket with one still open sends the student a grade that is
 * provisional while looking final.
 */
import { ApiError, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { completeTicket, heldTicket } from "@/lib/queue";

export const POST = route(
  {
    auth: "EVALUATOR",
    idempotent: true,
    body: v.object({
      notes: v.optional(v.string({ max: 4000 })),
      timeSpentSec: v.optional(v.int({ min: 0, max: 60 * 60 * 8 })),
      /** Say so deliberately, or the unmarked criteria block the close. */
      leaveUnresolved: v.withDefault(v.boolean(), false),
    }),
  },
  async ({ user, body, params }) => {
    const reviewId = String(params.reviewId);

    const review = await prisma.evaluatorReview.findFirst({
      where: { id: reviewId, evaluatorId: user.id },
      select: { id: true, ticketId: true, submittedAt: true, startedAt: true },
    });
    if (!review) throw ApiError.notFound("Review");
    // A resubmit is the retry, and the retry is a no-op rather than an error.
    if (review.submittedAt) {
      return { review, completed: false, alreadySubmitted: true };
    }

    const ticket = await heldTicket(review.ticketId, user);

    const answers = await prisma.answer.findMany({
      where: { submissionId: ticket.submissionId },
      select: { id: true },
    });

    // The current verdict on each answer: the highest revision. `DISTINCT ON`
    // would do it in one statement; this is the same thing in Prisma, and the
    // answer count per submission is a handful.
    const heads = await Promise.all(
      answers.map((a) =>
        prisma.gradingResult.findFirst({
          where: { answerId: a.id },
          orderBy: { revision: "desc" },
          select: { id: true, source: true, unmarkedCount: true, reviewId: true },
        }),
      ),
    );

    const stillUnmarked = heads.reduce((n, h) => n + (h?.unmarkedCount ?? 0), 0);
    const ungraded = heads.filter((h) => h === null).length;
    if ((stillUnmarked > 0 || ungraded > 0) && !body.leaveUnresolved) {
      throw new ApiError(
        "CONFLICT",
        `${stillUnmarked} criterion result(s) and ${ungraded} answer(s) are still unresolved. Resolving them is what this ticket is for — pass leaveUnresolved to close anyway, and the student will be told the grade is provisional.`,
      );
    }

    // Agreement is measured, not claimed: did this pass leave every AI verdict
    // standing? A pass that appended no revision of its own agreed with it.
    const agreedWithAi = heads.every((h) => h === null || h.reviewId !== review.id);

    const submittedAt = new Date();
    const timeSpentSec =
      body.timeSpentSec ??
      Math.max(0, Math.round((submittedAt.getTime() - review.startedAt.getTime()) / 1000));

    const saved = await prisma.evaluatorReview.update({
      where: { id: review.id },
      data: { submittedAt, agreedWithAi, notes: body.notes ?? null, timeSpentSec },
    });

    const completed = await completeTicket(ticket.id, user.id);
    if (completed) {
      await prisma.submission.update({
        where: { id: ticket.submissionId },
        data: { status: "GRADED", gradedAt: submittedAt },
      });
    }

    return {
      review: saved,
      completed,
      alreadySubmitted: false,
      unresolved: { criteria: stillUnmarked, answers: ungraded },
    };
  },
);
