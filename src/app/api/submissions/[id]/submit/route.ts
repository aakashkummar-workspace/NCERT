/**
 * POST /api/submissions/{id}/submit/   stop uploading, join the queue
 *
 * Idempotent, and it has to be: this is the button a student presses on a
 * two-second connection, and pressing it twice must not enqueue two runs of a
 * grader that costs money per call. The `Idempotency-Key` is demanded by the
 * wrapper; the state machine does the rest — a submission already past
 * `UPLOADING` is left exactly where it is and reported back unchanged.
 */
import { ApiError, route } from "@/lib/api";
import prisma from "@/lib/db";
import { isGradingConfigured } from "@/lib/grading";
import { param, requireOwnSubmission } from "../../access";

export const POST = route({ auth: "STUDENT", idempotent: true }, async ({ user, params }) => {
  const submissionId = param(params, "id");
  await requireOwnSubmission(user, submissionId);

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      status: true,
      pageCount: true,
      _count: { select: { pages: true, answers: true } },
    },
  });
  if (!submission) throw ApiError.notFound("Submission");

  if (submission.status !== "UPLOADING") {
    // Already queued, already grading, already graded. A retry is a no-op, and
    // saying so is more useful than a 409 the client has to interpret.
    return {
      submissionId,
      status: submission.status,
      queued: false,
      gradingConfigured: isGradingConfigured(),
    };
  }

  if (submission._count.pages === 0) {
    throw ApiError.validation([{ path: "pages", message: "no photographs have been uploaded" }]);
  }
  if (submission._count.answers === 0) {
    throw ApiError.validation([
      { path: "answers", message: "no answer has been declared; POST to ../answers/ first" },
    ]);
  }

  const updated = await prisma.submission.update({
    where: { id: submissionId },
    data: {
      status: "QUEUED",
      // What was actually uploaded, not what the phone predicted before it
      // started. A student who abandoned two pages did not submit them.
      pageCount: submission._count.pages,
    },
    select: { status: true, pageCount: true },
  });

  return {
    submissionId,
    status: updated.status,
    pageCount: updated.pageCount,
    queued: true,
    // Said out loud rather than discovered later: with no key configured the
    // submission sits here, queued and unprocessed, and nothing invents a mark.
    gradingConfigured: isGradingConfigured(),
  };
});
