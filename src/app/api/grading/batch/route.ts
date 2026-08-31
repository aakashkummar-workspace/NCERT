/**
 * POST /api/grading/batch/   grade many submissions at half price
 *
 * Two calls, not one:
 *
 *   POST { submissionIds }             -> { batchId, requested }
 *   POST { submissionIds, batchId }    -> { ended: false }  … poll …
 *                                      -> { ended: true, processed: [...] }
 *
 * The second call takes the same `submissionIds` because there is nowhere to
 * park a batch id: `prisma/schema.prisma` is frozen and has no column for one.
 * `collectBatchWork()` rebuilds byte-identical context from those ids, so a
 * span that said "page 0" on the way out lands on the same photograph on the
 * way back.
 *
 * Results are keyed by `custom_id`, never by position. Grading answer 7 against
 * answer 3's rubric would produce a plausible number and silently poison every
 * mark in the run, which is the one failure mode a batch adds over a loop.
 */
import { ApiError, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import {
  collectBatchWork,
  collectGradingBatch,
  createGradingBatch,
  isGradingConfigured,
} from "@/lib/grading";

export const POST = route(
  {
    auth: ["STUDENT", "ADMIN"],
    idempotent: true,
    body: v.object({
      submissionIds: v.array(v.uuid(), { min: 1, max: 50 }),
      /** Present on the collecting call, absent on the creating one. */
      batchId: v.optional(v.string({ max: 120 })),
    }),
  },
  async ({ user, body }) => {
    // Scoped to the caller before anything is read. A student batches their own
    // submissions; an admin batches their own scope's. Neither can name an id
    // and have it honoured just because they typed it.
    const visible = await prisma.submission.findMany({
      where:
        user.role === "ADMIN"
          ? { id: { in: body.submissionIds }, student: { scopeId: user.scopeId } }
          : { id: { in: body.submissionIds }, studentId: user.id },
      select: { id: true },
    });
    if (!visible.length) throw ApiError.notFound("Submission");
    const ids = visible.map((s) => s.id);

    if (!isGradingConfigured()) {
      // Honest degradation, the same as the single-answer path: nothing is
      // written, nothing is claimed, and the submissions stay where they are.
      return {
        configured: false,
        requested: ids.length,
        reason:
          "ANTHROPIC_API_KEY is not configured, so no batch was created. The submissions stay queued and unprocessed.",
      };
    }

    const { items, context, skipped } = await collectBatchWork(ids);

    if (body.batchId) {
      const collection = await collectGradingBatch(body.batchId, context);
      if (!collection.ended) {
        return { configured: true, batchId: body.batchId, ended: false, skipped };
      }
      // A batch that graded everything leaves each submission in the state its
      // verdicts imply. Recomputing here rather than in the collector keeps the
      // status rule in one place per entry point.
      for (const id of ids) {
        const outstanding = await prisma.answer.count({
          where: { submissionId: id, gradingResults: { none: {} } },
        });
        const unmarked = await prisma.gradingResult.count({
          where: { answer: { submissionId: id }, unmarkedCount: { gt: 0 } },
        });
        const student = await prisma.submission.findUnique({
          where: { id },
          select: { student: { select: { hitlEnabled: true } } },
        });
        await prisma.submission.update({
          where: { id },
          data: {
            status: unmarked > 0 || student?.student.hitlEnabled ? "AWAITING_REVIEW" : "GRADED",
            gradedAt: new Date(),
            failureReason: outstanding ? `${outstanding} answer(s) were not graded` : null,
          },
        });
      }
      return { configured: true, batchId: body.batchId, ended: true, processed: collection.processed, skipped };
    }

    if (!items.length) {
      return { configured: true, batchId: null, requested: 0, skipped };
    }
    await prisma.submission.updateMany({ where: { id: { in: ids } }, data: { status: "AI_GRADING" } });
    const batchId = await createGradingBatch(items);
    return { configured: true, batchId, requested: items.length, skipped };
  },
);
