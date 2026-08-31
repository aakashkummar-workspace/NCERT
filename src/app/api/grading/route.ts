/**
 * POST /api/grading/   grade one submission now   (owner or ADMIN, idempotent)
 * GET  /api/grading/   what is waiting, and whether a grader is configured
 *
 * There is no cron and no job runner in this repository, so "enqueue" is a
 * status on the row and this route is the thing that drains it. That is a
 * deliberate small shape rather than a missing piece: the submission's status
 * *is* the queue, `@@index([status, createdAt])` is what makes polling it
 * cheap, and a real worker later calls exactly this function.
 *
 * ## With no key configured
 *
 * `gradeSubmission()` writes nothing, leaves the submission `QUEUED`, and comes
 * back `configured: false` with a sentence saying so. This route returns that
 * as a 200 rather than a 503, because nothing failed: the work is queued and
 * honestly unprocessed. What must never happen — and cannot, because there is
 * no code path to it — is a `GradingResult` with a number nobody computed.
 */
import { ApiError, route, v } from "@/lib/api";
import prisma from "@/lib/db";
import { gradeSubmission, isGradingConfigured } from "@/lib/grading";
import { requireVisibleSubmission } from "../submissions/access";

export const POST = route(
  {
    auth: "any",
    idempotent: true,
    body: v.object({
      submissionId: v.uuid(),
      /** Re-grade answers that already carry a verdict. Appends; never overwrites. */
      force: v.withDefault(v.boolean(), false),
    }),
  },
  async ({ user, body }) => {
    const submission = await prisma.submission.findUnique({
      where: { id: body.submissionId },
      select: { id: true, studentId: true, status: true },
    });
    // 404, not 403: a 403 here would tell a stranger which submission ids exist.
    if (!submission) throw ApiError.notFound("Submission");
    if (submission.studentId !== user.id && user.role !== "ADMIN") {
      await requireVisibleSubmission(user, body.submissionId); // throws 404 for everyone else
      throw ApiError.forbidden("Only the student or an administrator may start grading.");
    }
    if (submission.status === "UPLOADING") {
      throw new ApiError("CONFLICT", "This submission has not been submitted yet.");
    }

    // The idempotency key is required by the wrapper and the state machine does
    // the rest: an answer that already has a verdict is reported
    // `already-graded` and costs nothing, so a retry is free rather than double
    // billed.
    return gradeSubmission(body.submissionId, { force: body.force });
  },
);

export const GET = route({ auth: "any" }, async ({ user }) => {
  const where =
    user.role === "STUDENT"
      ? { studentId: user.id }
      : // An admin is an admin of a scope, not of the platform. Filter by it
        // even though every B2C row is on the nil UUID today: the day it is not,
        // the query that forgot is the one that shows one school another
        // school's marks.
        { student: { scopeId: user.scopeId } };

  const [queued, grading, awaitingReview, failed] = await Promise.all([
    prisma.submission.count({ where: { ...where, status: "QUEUED" } }),
    prisma.submission.count({ where: { ...where, status: "AI_GRADING" } }),
    prisma.submission.count({ where: { ...where, status: "AWAITING_REVIEW" } }),
    prisma.submission.count({ where: { ...where, status: "FAILED" } }),
  ]);

  const next = await prisma.submission.findMany({
    where: { ...where, status: { in: ["QUEUED", "AI_GRADING"] } },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, subject: true, classNum: true, paperSlug: true, status: true, createdAt: true },
  });

  return {
    gradingConfigured: isGradingConfigured(),
    counts: { queued, grading, awaitingReview, failed },
    next,
    ...(isGradingConfigured()
      ? {}
      : {
          notice:
            "ANTHROPIC_API_KEY is not configured. Submissions stay queued and unprocessed; no marks are produced.",
        }),
  };
});
